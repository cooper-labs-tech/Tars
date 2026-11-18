import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../../electron/services/trace-store';
import { TraceUploader, type UploaderDeps } from '../../electron/services/trace-upload';
import { hasPosixModes } from '../setup/platform-limits';

/**
 * Uploading opted-in traces to a back-office (the trace back-office's HTTP API v1, backoffice/API.md): register the
 * install, then per session the blobs it is missing and one batch of rows, compressed, idempotent, resumable.
 *
 * How it fails, written before the code (19/11):
 * 1. Something is sent without an address, or before the user read the notice (consent).
 * 2. A session not opted in now (its project or its agent switched off since) is sent.
 * 3. A secret, the home path, a project path or an endpoint address reaches the server, in a blob or a row; a
 *    person's name goes as authorDetail; the agent's or the endpoint's name goes as typed (the Audit's L1 on #596).
 * 4. A blob's hash is not the SHA-256 of the bytes sent (the local hash of the unscrubbed content), so the server
 *    refuses it; or a blob the server has is sent again.
 * 5. A field the API does not know is sent (the server refuses the batch), or a required one is missing.
 * 6. The server down: the session is lost, or retried at once in a loop; back up, it is sent once.
 * 7. A 429 or 503: Retry-After is not honoured.
 * 8. A 401 (the install forgotten by the server): the uploader stops for good instead of registering again.
 * 9. A restart sends every session again, or forgets the install and registers anew.
 * 10. A session that grew is not sent again; one that did not change is.
 * 11. Deleting everything does not call the server's delete, keeps the token, or keeps the progress.
 * 12. The install file is readable by others, or the token is in the state the window gets.
 * 13. A 507 disk_full (the server under its free-disk floor) is not waited out as Retry-After says.
 * 15. (The re-audit's I2 on #596.) A redirect is followed, and the install token hops to another address.
 * 14. A back-office closed to new installs (403 registration_closed), or one that blocked this install
 *     (403 install_blocked), reads as an error retried soon, instead of a state the window says plainly.
 */

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };

class FakeBackOffice {
  server!: http.Server;
  base = '';
  seen: Seen[] = [];
  installs = new Map<string, string>(); // token -> installId
  blobs = new Map<string, Buffer>();
  batches = new Map<string, string>();
  sessions = new Map<string, Record<string, unknown>>();
  rows: Array<Record<string, unknown>> = [];
  failNext: Array<{ status: number; retryAfter?: string; code?: string }> = [];
  down = false;
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise(r => this.server.close(() => r(undefined))); }
  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }
  private decode(req: http.IncomingMessage, body: Buffer): Buffer {
    const enc = req.headers['content-encoding'];
    if (enc === 'zstd') return (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(body);
    if (enc === 'gzip') return zlib.gunzipSync(body);
    return body;
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
    if (this.down) { req.socket.destroy(); return; }
    const url = req.url ?? '';
    this.seen.push({ method: req.method ?? '', url, headers: req.headers, body: raw });
    const fail = this.failNext.shift();
    if (fail) { this.send(res, fail.status, { error: fail.code ?? 'rate_limited' }, fail.retryAfter ? { 'Retry-After': fail.retryAfter } : {}); return; }
    if (req.method === 'POST' && url === '/v1/installs') {
      const token = `tbi_${this.installs.size + 1}`;
      this.installs.set(token, `inst-${this.installs.size + 1}`);
      this.send(res, 201, { installId: this.installs.get(token), token, limits: {}, retentionDays: 90 });
      return;
    }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.installs.has(token)) { this.send(res, 401, { error: 'unauthorized' }); return; }
    const body = this.decode(req, raw);
    if (req.method === 'POST' && url === '/v1/blobs/missing') {
      const { hashes } = JSON.parse(body.toString());
      this.send(res, 200, { missing: hashes.filter((h: string) => !this.blobs.has(h)) });
    } else if (req.method === 'PUT' && url.startsWith('/v1/blobs/')) {
      const hash = url.slice('/v1/blobs/'.length);
      if (createHash('sha256').update(body).digest('hex') !== hash) { this.send(res, 422, { error: 'hash_mismatch' }); return; }
      const had = this.blobs.has(hash);
      this.blobs.set(hash, body);
      this.send(res, had ? 200 : 201, { stored: !had });
    } else if (req.method === 'PUT' && url.startsWith('/v1/batches/')) {
      const id = url.slice('/v1/batches/'.length);
      const digest = createHash('sha256').update(body).digest('hex');
      if (this.batches.has(id)) { this.send(res, this.batches.get(id) === digest ? 200 : 409, this.batches.get(id) === digest ? { replayed: true, missingBlobs: [] } : { error: 'batch_conflict' }); return; }
      const batch = JSON.parse(body.toString());
      this.batches.set(id, digest);
      for (const s of batch.sessions ?? []) this.sessions.set(s.sessionId, s);
      this.rows.push(batch);
      const named = (batch.requests ?? []).flatMap((r: { messages: Array<{ hash: string }>; toolsHash?: string }) => [...r.messages.map(m => m.hash), ...(r.toolsHash ? [r.toolsHash] : [])]);
      this.send(res, 200, { batchId: id, replayed: false, applied: {}, missingBlobs: [...new Set(named)].filter(h => !this.blobs.has(h as string)) });
    } else if (req.method === 'DELETE' && url === '/v1/installs/me') {
      this.installs.delete(token);
      const n = this.sessions.size;
      this.sessions.clear();
      this.send(res, 200, { deleted: { sessions: n }, deletedAt: 1, receipt: 'del_1' });
    } else {
      this.send(res, 404, { error: 'not_found' });
    }
  }
}

const HOME = os.homedir();
const PROJECT = path.join(HOME, 'projects', 'project-a');
const SECRET = 'sk-proj-' + 'z'.repeat(30);
let dir: string;
let store: TraceStore;
let bo: FakeBackOffice;
let clock: number;
let settings: { url: string; consentAt?: string; projects: string[]; agentsTraced: Set<string> };

function seed(traceId: string, text: string, startedAt = 1000) {
  store.openTrace({ traceId, projectPath: PROJECT, agentId: 'agent-1', agentName: 'Q', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'Remote host', endpointBaseUrl: 'http://192.0.2.10:9000/v1', model: 'open-coder-1', startedAt });
  const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'system', content: `You work in ${PROJECT}` }, { role: 'user', content: text }], tools: [{ type: 'function', function: { name: 'bash' } }] }));
  const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `done, key ${SECRET}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  store.noteTypedInput({ agentId: 'agent-1', at: startedAt - 1, author: 'orchestrator', authorDetail: 'Lead (claude)', text, closed: true });
  store.ingest({ traceId, agentId: 'agent-1', surface: 'openai_chat', startedAt, endedAt: startedAt + 100, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0, upstreamRequestId: 'req_up_1' });
}

function uploader(over: Partial<UploaderDeps> = {}) {
  return new TraceUploader({
    store,
    installFile: path.join(dir, 'private', 'traces-install.json'),
    settings: () => ({ url: settings.url, consentAt: settings.consentAt }),
    eligible: (s) => settings.projects.includes(s.projectPath) && settings.agentsTraced.has(s.agentId),
    scrubContext: () => ({ homeDirs: [HOME], knownSecrets: [SECRET], envValues: [] }),
    client: { name: 'tars', version: '0.0.0-test', platform: process.platform },
    now: () => clock,
    ...over,
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-upload-'));
  store = new TraceStore(path.join(dir, 'traces.db'));
  bo = new FakeBackOffice();
  await bo.start();
  clock = 1_000_000;
  settings = { url: bo.base, consentAt: '2026-11-19T00:00:00Z', projects: [PROJECT], agentsTraced: new Set(['agent-1']) };
});
afterEach(async () => {
  store.close();
  await bo.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the trace uploader', () => {
  it('1: nothing without an address or consent', async () => {
    seed('t1', 'list the files');
    settings.url = '';
    expect((await uploader().runOnce()).sent).toBe(0);
    settings.url = bo.base;
    settings.consentAt = undefined;
    expect((await uploader().runOnce()).sent).toBe(0);
    expect(bo.seen).toEqual([]);
  });

  it('2: a session no longer opted in is not sent', async () => {
    seed('t1', 'list the files');
    settings.agentsTraced.clear();
    expect((await uploader().runOnce()).sent).toBe(0);
    settings.agentsTraced.add('agent-1');
    settings.projects = [];
    expect((await uploader().runOnce()).sent).toBe(0);
    expect(bo.sessions.size).toBe(0);
  });

  it('3, 4 and 5: sent once, scrubbed, keyed not named, every blob matching its hash, API fields only', async () => {
    seed('t1', `look at ${PROJECT}/src`);
    const r = await uploader().runOnce();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    const everything = [...bo.blobs.values()].map(b => b.toString()).join('\n') + JSON.stringify(bo.rows);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(HOME);
    expect(everything).not.toContain('192.0.2.10');
    expect(everything).not.toContain('Lead');
    // Names are free labels that often say a host or a person (the Audit's L1 on #596): never sent.
    expect(everything).not.toContain('Remote host');
    expect(bo.sessions.get('t1')!.agentName).toBeUndefined();
    expect(bo.sessions.get('t1')!.endpointName).toBeUndefined();
    expect(everything).toContain('<REDACTED:known_secret>');
    const session = bo.sessions.get('t1')!;
    expect(session.projectKey).toMatch(/^[0-9a-f]{64}$/);
    expect(session.endpointKey).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(session).sort()).toEqual(expect.arrayContaining(['sessionId', 'harness', 'model', 'startedAt', 'finalStatus', 'turnCount', 'requestCount', 'tokensIn', 'tokensCached', 'tokensOut']));
    const allowed = { session: ['sessionId', 'agentId', 'agentName', 'projectKey', 'harness', 'harnessVersion', 'nativeSessionId', 'endpointKey', 'endpointName', 'model', 'startedAt', 'endedAt', 'finalStatus', 'turnCount', 'requestCount', 'tokensIn', 'tokensCached', 'tokensOut', 'mixed', 'unknownTurns', 'outcome'],
      turn: ['turnId', 'sessionId', 'index', 'startedAt', 'endedAt', 'gapBeforeMs', 'requestCount', 'toolCallCount', 'toolErrorCount', 'toolMs', 'modelMs', 'tokensIn', 'tokensCached', 'tokensOut', 'finalStatus', 'finalFinishReason', 'author', 'authorDetail'],
      request: ['requestId', 'sessionId', 'turnId', 'seq', 'upstreamRequestId', 'surface', 'modelRequested', 'modelServed', 'params', 'toolsHash', 'startedAt', 'ttftMs', 'totalMs', 'tokensIn', 'tokensCached', 'tokensOut', 'status', 'error', 'finishReason', 'streamed', 'reqBytes', 'respBytes', 'messages'],
      message: ['hash', 'role', 'createdAt', 'size', 'toolCallCount', 'hasThinking'] };
    const batch = bo.rows[0] as { schema: number; sessions: object[]; turns: object[]; requests: Array<{ messages: Array<{ hash: string }>; toolsHash?: string; upstreamRequestId?: string }>; messages: Array<{ hash: string; role: string }> };
    expect(batch.schema).toBe(1);
    for (const [rows, keys] of [[batch.sessions, allowed.session], [batch.turns, allowed.turn], [batch.requests, allowed.request], [batch.messages, allowed.message]] as const) {
      for (const row of rows) for (const k of Object.keys(row)) expect(keys, k).toContain(k);
    }
    expect(batch.requests[0].upstreamRequestId).toBe('req_up_1');
    for (const h of [...batch.requests.flatMap(q => q.messages.map(m => m.hash)), ...batch.requests.map(q => q.toolsHash!)]) expect(bo.blobs.has(h), h).toBe(true);
    for (const m of batch.messages) expect(['system', 'user', 'assistant', 'tool', 'developer']).toContain(m.role);
    const putBlobs = bo.seen.filter(s => s.method === 'PUT' && s.url.startsWith('/v1/blobs/')).length;
    expect(putBlobs).toBe(bo.blobs.size);
  });

  it('4 and 10: a session that grew is sent again, with only its new blobs; one unchanged is not', async () => {
    seed('t1', 'first');
    await uploader().runOnce();
    const blobsBefore = bo.seen.filter(s => s.url.startsWith('/v1/blobs/') && s.method === 'PUT').length;
    expect((await uploader().runOnce()).sent).toBe(0);
    store.endTrace('t1', 5000, { branch: 'feat/x' });
    const again = await uploader().runOnce();
    expect(again.sent).toBe(1);
    expect(bo.sessions.get('t1')!.endedAt).toBe(5000);
    expect(bo.seen.filter(s => s.url.startsWith('/v1/blobs/') && s.method === 'PUT').length).toBe(blobsBefore);
  });

  it('6 and 9: the server down, the session waits with backoff, then goes once; a restart keeps the install', async () => {
    seed('t1', 'first');
    bo.down = true;
    const u = uploader();
    const r1 = await u.runOnce();
    expect(r1.sent).toBe(0);
    expect(u.state().nextTryAt).toBeGreaterThan(clock);
    expect((await u.runOnce()).skipped).toBe('waiting');
    bo.down = false;
    clock = u.state().nextTryAt! + 1;
    const restarted = uploader();
    expect((await restarted.runOnce()).sent).toBe(1);
    expect(bo.installs.size).toBe(1);
    expect((await uploader().runOnce()).sent).toBe(0);
    expect(bo.sessions.size).toBe(1);
  });

  it('7: a 429 waits as Retry-After says', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    seed('t2', 'second', 2000);
    bo.failNext.push({ status: 429, retryAfter: '42' });
    const r = await u.runOnce();
    expect(r.sent).toBe(0);
    expect(u.state().nextTryAt).toBe(clock + 42_000);
  });

  it('13: a 507 waits as Retry-After says', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    seed('t2', 'second', 2000);
    bo.failNext.push({ status: 507, retryAfter: '120' });
    expect((await u.runOnce()).sent).toBe(0);
    expect(u.state().nextTryAt).toBe(clock + 120_000);
    expect(u.state().notice).toBeUndefined();
  });

  it('14: a back-office closed to new installs, or one that blocked this one, is a state, not an error retried soon', async () => {
    seed('t1', 'first');
    bo.failNext.push({ status: 403, code: 'registration_closed' });
    const u = uploader();
    expect((await u.runOnce()).sent).toBe(0);
    expect(u.state().notice).toBe('registration_closed');
    expect(u.state().nextTryAt).toBeGreaterThanOrEqual(clock + 6 * 3600_000);
    clock = u.state().nextTryAt! + 1;
    expect((await u.runOnce()).sent).toBe(1);
    expect(u.state().notice).toBeUndefined();
    seed('t2', 'second', 2000);
    bo.failNext.push({ status: 403, code: 'install_blocked' });
    await u.runOnce();
    expect(u.state().notice).toBe('install_blocked');
  });

  it('15: no call follows a redirect, and a redirect answer is a failure', async () => {
    seed('t1', 'first');
    const inits: Array<RequestInit | undefined> = [];
    const spy = ((u: string, init?: RequestInit) => { inits.push(init); return fetch(u, init); }) as typeof fetch;
    expect((await uploader({ fetch: spy }).runOnce()).sent).toBe(1);
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(init?.redirect).toBe('manual');
    const moved = (async () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example/v1/installs' } })) as unknown as typeof fetch;
    fs.rmSync(path.join(dir, 'private', 'traces-install.json'), { force: true });
    const r = await uploader({ fetch: moved }).runOnce();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
  });

  it('8: a 401 registers the install again, once, and sends everything again under it', async () => {
    seed('t1', 'first');
    await uploader().runOnce();
    bo.installs.clear();
    seed('t2', 'second', 2000);
    const r = await uploader().runOnce();
    expect(r.sent).toBe(2);
    expect(bo.sessions.has('t2')).toBe(true);
    expect(bo.seen.filter(s => s.url === '/v1/installs').length).toBe(2);
  });

  it('11 and 12: delete everywhere calls the server, forgets the token and the progress; the file is private, the state token-free', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    const file = path.join(dir, 'private', 'traces-install.json');
    if (hasPosixModes()) expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(JSON.stringify(u.state())).not.toMatch(/tbi_/);
    expect(u.state()).toMatchObject({ registered: true, sentSessions: 1, pendingSessions: 0 });
    const d = await u.deleteEverywhere();
    expect(d).toMatchObject({ ok: true });
    expect(bo.seen.some(s => s.method === 'DELETE' && s.url === '/v1/installs/me')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(u.state()).toMatchObject({ registered: false, sentSessions: 0 });
    expect(await u.deleteEverywhere()).toMatchObject({ ok: false });
  });
});
