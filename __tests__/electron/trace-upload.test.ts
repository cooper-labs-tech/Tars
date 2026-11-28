import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 * 8. A 401 (the back-office no longer knows this install: the user deleted it, or its operator did) registers again
 *    on its own and sends everything back, undoing a deletion. It must stop, keep the local data, say "this
 *    back-office no longer knows this Tars", and leave registering again to the user's own consent (the
 *    orchestrator's decision on #596).
 * 19. A consent withdrawn (sharing turned off, no deletion) while a pass runs: the pass sends the next sessions.
 * 20. (L1 at 36690e547.) Sharing again after a deletion sends the deleted sessions back: a deletion is the user's
 *     word, and only sessions started after it may go.
 * 21. The consent is withdrawn only once the DELETE succeeded, so sending goes on meanwhile; a DELETE that fails or
 *     never goes leaves sharing on, or says nothing of the deletion still owed.
 * 22. Two deletions at once clear each other's stop: a pass starts while the second is still deleting.
 * 23. (L1 at ee4d55975.) A deletion owed for ever locks sharing out: the install file lost, or an old back-office gone
 *     for good, and consent is refused even to a new back-office.
 * 24. (L2.) A clock moved backward between the sessions and the deletion lets them through on re-consent.
 * 25. (L at e50e78564.) Giving up a deletion when none is owed forgets a live install: the next pass registers anew,
 *     sends everything again, and leaves the old copy out of reach of "delete everything sent".
 * 26. An owed deletion that clears itself (its install file gone) says nothing; or its word is consumed by a read the
 *     window did not make (the consent check), or masked by another notice.
 * 27. (QA's gate on #596.) The preview the user consents on is not what leaves: the local document with paths and
 *     names, where the back-office gets HMAC keys and no names. It must be the very batches and blobs sent.
 * 18. A deletion that lands while a pass runs: the pass goes on with the consent it read at its start, and sends
 *     after the deletion (the re-audit's M1 at ec6951aa5).
 * 9. A restart sends every session again, or forgets the install and registers anew.
 * 10. A session that grew is not sent again; one that did not change is.
 * 11. Deleting everything does not call the server's delete, keeps the token, or keeps the progress.
 * 12. The install file is readable by others, or the token is in the state the window gets.
 * 13. A 507 disk_full (the server under its free-disk floor) is not waited out as Retry-After says.
 * 15. (The re-audit's I2 on #596.) A redirect is followed, and the install token hops to another address.
 * 16. After the user deleted everything sent, the next pass registers again and sends it all back, undoing the
 *     deletion: the consent must be withdrawn with it.
 * 17. A long session goes as one batch over the size limit (the request metadata grows with the square of the
 *     requests), or is split into parts that lose a request, share a batch id, or name a turn not yet sent.
 * 14. A back-office closed to new installs (403 registration_closed), or one that blocked this install
 *     (403 install_blocked), reads as an error retried soon, instead of a state the window says plainly.
 * Added before their code after the Audit's re-read at a3c07fbfa (its L4, 24/11). A private folder that may not be
 * written (0500, measured on macOS 26) refuses the install file's unlink, and takes its truncate:
 * 28. A 401 then: the unlink throws before the consent is withdrawn, so sharing stays on and the pass rejects (an
 *     unhandled rejection in main) instead of saying the back-office forgot this Tars.
 * 29. A DELETE that went through then: the unlink throws after it, and the window is told nothing was deleted.
 * 30. Giving up an owed deletion then: the unlink throws out of abandonDeletion.
 * Added before their code after the Audit's re-read at 965cfced0 (its L2, 24/11). Forgetting the progress after a
 * DELETE that went through is a database write, which a full disk refuses:
 * 31. A DELETE answered 200, then that write throws: the window is told nothing was deleted, and the deletion stays
 *     owed until it clears by itself.
 * 32. A DELETE answered 401 (the token already gone), then that write throws: the deletion throws out of its catch.
 * 33. (Added before its code, 24/11.) Giving up an owed deletion makes the same write: it throws out of
 *     abandonDeletion, the deletion still owed, and the window gets no answer.
 * 34. (Added before its code, 24/11.) A trace store whose read throws: "delete everything" reads the newest session
 *     before it withdraws, so it throws first, and the user cannot revoke on a broken store.
 * Added before their code after the Frontend's read for #599 and the Audit's I-2 there (24/11): the window shows the
 * counts as main sends them.
 * 35. The pending count counts every session with a change not sent: those of a project or an agent not opted in, and
 *     those recorded before a deletion, which will never be sent.
 * 36. After a deletion whose progress could not be forgotten (a full disk), the sent count still counts the sessions
 *     sent before it, which the back-office deleted.
 * Added before their code after the Audit's re-read at c447c1ceb (its L2, 25/11). A pass read the 5000 oldest
 * queued sessions and stopped when none of them could be sent, so past 5000 that never can (recorded before a
 * deletion, or of a project or agent opted out), nothing was ever sent again:
 * 37. 5001 sessions recorded before the deletion's moment and 1 after: one pass does not send that 1.
 * 38. 5001 sessions of a project not opted in and 1 of one that is: the same.
 * Added before its code, the owner's decision of 26/11:
 * 39. A side request (a title or a memory call) goes up like a main one: the request carries no `side`, the export's
 *     own mark, so the back-office counts it as a step of the turn.
 * 40. A back-office older than the `side` field refuses the batch (422 invalid_batch, it refuses unknown fields), and
 *     the uploader sends it again without the mark, or with a side request marked false; or it marks the session
 *     sent; or it never sends it once the back-office knows the field. The order is the back-office first (SPECS).
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
  /** Request fields this back-office does not know: a batch carrying one is refused, 422 invalid_batch (API.md § 8). */
  unknownRequestFields: string[] = [];
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
      if ((batch.requests ?? []).some((q: object) => Object.keys(q).some(k => this.unknownRequestFields.includes(k)))) { this.send(res, 422, { error: 'invalid_batch' }); return; }
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
let withdrawn = 0;
let deletion: { owed: boolean; since?: number } = { owed: false };

function seed(traceId: string, text: string, startedAt = 1000, projectPath = PROJECT) {
  store.openTrace({ traceId, projectPath, agentId: 'agent-1', agentName: 'Q', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'Remote host', endpointBaseUrl: 'http://192.0.2.10:9000/v1', model: 'open-coder-1', startedAt });
  const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'system', content: `You work in ${PROJECT}` }, { role: 'user', content: text }], tools: [{ type: 'function', function: { name: 'bash' } }] }));
  const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `done, key ${SECRET}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  store.noteTypedInput({ agentId: 'agent-1', at: startedAt - 1, author: 'orchestrator', authorDetail: 'Lead (claude)', text, closed: true });
  store.ingest({ traceId, agentId: 'agent-1', surface: 'openai_chat', startedAt, endedAt: startedAt + 100, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0, upstreamRequestId: 'req_up_1' });
}

function uploader(over: Partial<UploaderDeps> = {}) {
  return new TraceUploader({
    store,
    installFile: path.join(dir, 'private', 'traces-install.json'),
    settings: () => ({ url: settings.url, consentAt: settings.consentAt, since: deletion.since, deletionOwed: deletion.owed }),
    setDeletion: (d) => { deletion = d; },
    eligible: (s) => settings.projects.includes(s.projectPath) && settings.agentsTraced.has(s.agentId),
    scrubContext: () => ({ homeDirs: [HOME], knownSecrets: [SECRET], envValues: [] }),
    client: { name: 'tars', version: '0.0.0-test', platform: process.platform },
    // A deletion's bookkeeping may come with the withdrawal, in the same write (the Audit's I-1 at 965cfced0).
    withdrawConsent: (d?: { owed: boolean; since?: number }) => { withdrawn++; settings.consentAt = undefined; if (d) deletion = d; },
    // The training switch (trace feature A5, its own tests in trace-training.test.ts): on, nothing owed.
    training: () => ({ value: true, owed: false }),
    trainingSent: () => {},
    trainingDenied: () => false,
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
  withdrawn = 0;
  deletion = { owed: false };
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
    const allowed = { session: ['sessionId', 'agentId', 'agentName', 'projectKey', 'harness', 'harnessVersion', 'nativeSessionId', 'endpointKey', 'endpointName', 'model', 'startedAt', 'endedAt', 'finalStatus', 'turnCount', 'requestCount', 'tokensIn', 'tokensCached', 'tokensOut', 'mixed', 'unknownTurns', 'outcome', 'consent'],
      turn: ['turnId', 'sessionId', 'index', 'startedAt', 'endedAt', 'gapBeforeMs', 'requestCount', 'toolCallCount', 'toolErrorCount', 'toolMs', 'modelMs', 'tokensIn', 'tokensCached', 'tokensOut', 'finalStatus', 'finalFinishReason', 'author', 'authorDetail'],
      request: ['requestId', 'sessionId', 'turnId', 'seq', 'side', 'upstreamRequestId', 'surface', 'modelRequested', 'modelServed', 'params', 'toolsHash', 'startedAt', 'ttftMs', 'totalMs', 'tokensIn', 'tokensCached', 'tokensOut', 'status', 'error', 'finishReason', 'streamed', 'reqBytes', 'respBytes', 'messages'],
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

  it('16: deleting everything withdraws the consent, so nothing is registered or sent again', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
    expect(withdrawn).toBe(1);
    const installsBefore = bo.seen.filter(x => x.url === '/v1/installs').length;
    expect((await u.runOnce()).skipped).toBe('off');
    expect(bo.seen.filter(x => x.url === '/v1/installs').length).toBe(installsBefore);
  });

  it('17: a session over the batch limit goes in parts, each under it, with every request, its turns and distinct ids', async () => {
    store.openTrace({ traceId: 'long', projectPath: PROJECT, agentId: 'agent-1', harness: 'qwen-code', endpointId: 'ep-000001', model: 'open-coder-1', startedAt: 1000 });
    const history: unknown[] = [{ role: 'user', content: 'start the long task' }];
    for (let i = 0; i < 40; i++) {
      const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'system', content: 'S' }, ...history], tools: [{ type: 'function', function: { name: 'bash' } }] }));
      const call = { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: `{"n":${i}}` } }] };
      const resp = Buffer.from(JSON.stringify({ choices: [{ message: call, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      store.ingest({ traceId: 'long', agentId: 'agent-1', surface: 'openai_chat', startedAt: 1000 + i * 10, endedAt: 1005 + i * 10, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0 });
      history.push(call, { role: 'tool', tool_call_id: `c${i}`, content: `out ${i}` });
    }
    const r = await uploader({ maxBatchBytes: 3000 }).runOnce();
    expect(r.sent).toBe(1);
    const puts = bo.seen.filter(x => x.method === 'PUT' && x.url.startsWith('/v1/batches/'));
    expect(puts.length).toBeGreaterThan(1);
    // Every part is under the limit, but a part of one request: a request cannot be cut, and the back-office's own
    // ceiling (10,000 refs, about 0.9 MB) is far under its 8 MiB.
    puts.forEach((p, i) => {
      const n = (bo.rows[i] as { requests: unknown[] }).requests.length;
      if (n > 1) expect(p.body.length, `${p.url}, ${n} requests`).toBeLessThanOrEqual(3000);
    });
    expect(new Set(puts.map(p => p.url)).size).toBe(puts.length);
    const requests = bo.rows.flatMap(b => (b as { requests?: Array<{ requestId: string; turnId: string }> }).requests ?? []);
    expect(new Set(requests.map(q => q.requestId)).size).toBe(40);
    for (const b of bo.rows as Array<{ sessions: unknown[]; turns: Array<{ turnId: string }>; requests: Array<{ turnId: string }> }>) {
      expect(b.sessions).toHaveLength(1);
      for (const q of b.requests ?? []) expect(b.turns.map(t => t.turnId)).toContain(q.turnId);
    }
  });

  it('8: a 401 stops the uploads, keeps the local data, says so, and registers nothing until the user consents again', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    bo.installs.clear();
    seed('t2', 'second', 2000);
    const r = await u.runOnce();
    expect(r.sent).toBe(0);
    expect(bo.seen.filter(x => x.url === '/v1/installs').length).toBe(1);
    expect(u.state()).toMatchObject({ notice: 'forgotten', registered: false });
    expect(withdrawn).toBe(1);
    expect(store.list({}).sessions.map(x => x.traceId).sort()).toEqual(['t1', 't2']);
    expect((await u.runOnce()).skipped).toBe('off');
    // The user consents again: a new install, and everything goes under it.
    settings.consentAt = '2026-11-19T06:00:00Z';
    clock += 7 * 3600_000;
    expect((await u.runOnce()).sent).toBe(2);
    expect(bo.seen.filter(x => x.url === '/v1/installs').length).toBe(2);
  });

  it('19: a consent withdrawn while a pass runs stops it before the next session', async () => {
    for (const id of ['a', 'b', 'c']) seed(id, `task ${id}`, id.charCodeAt(0) * 1000);
    const spy = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/v1/batches/')) settings.consentAt = undefined;
      return fetch(url, init);
    }) as typeof fetch;
    await uploader({ fetch: spy }).runOnce();
    expect(bo.seen.filter(x => x.method === 'PUT' && x.url.startsWith('/v1/batches/'))).toHaveLength(1);
  });

  it('20: sharing again after a deletion sends only the sessions started after it', async () => {
    seed('old', 'before the deletion', 1000);
    const u = uploader();
    await u.runOnce();
    clock = 2_000_000;
    expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
    expect(deletion.since).toBe(2_000_000);
    seed('new', 'after the deletion', 2_500_000);
    settings.consentAt = '2026-11-19T07:00:00Z';
    const r = await u.runOnce();
    expect(r.sent).toBe(1);
    expect([...bo.sessions.keys()]).toEqual(['new']);
  });

  it('21: the consent goes before the DELETE; a DELETE that fails leaves sharing off and the deletion owed', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    const order: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { order.push(`DELETE (consent ${settings.consentAt ? 'on' : 'off'})`); return new Response('{"error":"unavailable"}', { status: 503 }); }
      return fetch(url, init);
    }) as typeof fetch;
    const failing = uploader({ fetch: spy });
    const d = await failing.deleteEverywhere();
    expect(d.ok).toBe(false);
    expect(order).toEqual(['DELETE (consent off)']);
    expect(deletion.owed).toBe(true);
    expect(failing.state()).toMatchObject({ deletionOwed: true });
    expect((await failing.runOnce()).skipped).toBe('off');
    expect(await uploader().deleteEverywhere()).toMatchObject({ ok: true });
    expect(deletion.owed).toBe(false);
  });

  it('22: two deletions at once: no pass starts until the last one is done', async () => {
    seed('t1', 'first');
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>(r => { releaseSecond = r; });
    let deletes = 0;
    const spy = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE' && ++deletes === 1) await secondHeld;
      return fetch(url, init);
    }) as typeof fetch;
    const u = uploader({ fetch: spy });
    await u.runOnce();
    // The first click's DELETE is slow; the second click's goes through at once and ends first.
    const first = u.deleteEverywhere();
    const second = u.deleteEverywhere();
    await second;
    settings.consentAt = '2026-11-19T08:00:00Z';
    seed('t2', 'second', clock + 1);
    expect((await u.runOnce()).skipped).toBe('off');
    releaseSecond();
    await first;
  });

  it('23: an owed deletion with no install file left is no longer owed; and the user can give up an old one', async () => {
    seed('t1', 'first');
    deletion = { owed: true, since: 5000 };
    const u = uploader();
    expect(u.state().deletionOwed).toBe(false);
    expect(deletion).toEqual({ owed: false, since: 5000 });
    // An old back-office gone for good, its install file still here: the user gives its deletion up.
    await u.runOnce();
    deletion = { owed: true, since: 5000 };
    expect(u.state().deletionOwed).toBe(true);
    expect(u.abandonDeletion()).toEqual({ ok: true });
    expect(deletion).toEqual({ owed: false, since: 5000 });
    expect(fs.existsSync(path.join(dir, 'private', 'traces-install.json'))).toBe(false);
    expect(u.state()).toMatchObject({ deletionOwed: false, registered: false });
  });

  it('25: giving up a deletion when none is owed is refused, and the install and its marks stay', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    const r = u.abandonDeletion();
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'private', 'traces-install.json'))).toBe(true);
    expect(u.state()).toMatchObject({ registered: true, sentSessions: 1 });
    clock += 1;
    expect((await u.runOnce()).sent).toBe(0);
    expect(bo.seen.filter(x => x.url === '/v1/installs')).toHaveLength(1);
  });

  it('26: an owed deletion that clears itself is said until the window acknowledges it, whatever else is read', () => {
    deletion = { owed: true, since: 5000 };
    const u = uploader();
    // The consent check reads the owed state, not the window's state: nothing is consumed.
    expect(u.isDeletionOwed()).toBe(false);
    expect(u.state().deletionCleared).toBe(true);
    expect(u.state().deletionCleared).toBe(true);
    u.ackDeletionCleared();
    expect(u.state().deletionCleared).toBe(false);
  });

  it('24: a clock moved backward does not let sessions present at the deletion through', async () => {
    seed('present', 'recorded at a later clock', 5_000_000);
    const u = uploader();
    await u.runOnce();
    clock = 1_000_000;
    expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
    expect(deletion.since).toBeGreaterThanOrEqual(5_000_000);
    settings.consentAt = '2026-11-19T09:00:00Z';
    expect((await u.runOnce()).sent).toBe(0);
    expect(bo.sessions.size).toBe(0);
  });

  it('27: the preview is exactly what the back-office receives for that session, batches and blobs', async () => {
    seed('t1', `look at ${PROJECT}/src`);
    const u = uploader();
    const preview = u.preview('t1')!;
    expect(preview).not.toBeNull();
    expect(JSON.stringify(preview.document)).not.toContain(HOME);
    expect(JSON.stringify(preview.document)).not.toContain('Remote host');
    await u.runOnce();
    const sent = bo.seen.filter(x => x.method === 'PUT' && x.url.startsWith('/v1/batches/'));
    const decode = (raw: Buffer, enc?: string | string[]) => enc === 'zstd' ? (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(raw) : raw;
    expect(preview.document.batches.map(b => b.batchId)).toEqual(sent.map(x => x.url.slice('/v1/batches/'.length)));
    expect(preview.document.batches.map(b => b.body)).toEqual(sent.map(x => JSON.parse(decode(x.body, x.headers['content-encoding']).toString())));
    const blobsSent = new Map([...bo.blobs.entries()].map(([h, b]) => [h, JSON.parse(b.toString())]));
    expect(Object.keys(preview.document.blobs).sort()).toEqual([...blobsSent.keys()].sort());
    for (const [h, content] of Object.entries(preview.document.blobs)) expect(content).toEqual(blobsSent.get(h));
  });

  it('18: a deletion landing while a pass runs stops it, and nothing is sent after the deletion', async () => {
    for (const id of ['a', 'b', 'c', 'd']) seed(id, `task ${id}`, id.charCodeAt(0) * 1000);
    let deletion: Promise<unknown> | undefined;
    // The spy reads `u` only when the pass calls it, once `u` is set.
    const spy = (async (url: string, init?: RequestInit) => {
      // The user presses "delete everything sent" while the pass is at its first batch.
      if (!deletion && String(url).includes('/v1/batches/')) deletion = u.deleteEverywhere();
      return fetch(url, init);
    }) as typeof fetch;
    const u = uploader({ fetch: spy });
    await u.runOnce();
    await deletion;
    const at = bo.seen.findIndex(x => x.method === 'DELETE');
    expect(at).toBeGreaterThan(-1);
    expect(bo.seen.slice(at + 1), JSON.stringify(bo.seen.slice(at + 1).map(x => `${x.method} ${x.url}`))).toEqual([]);
    expect(withdrawn).toBe(1);
    expect((await u.runOnce()).skipped).toBe('off');
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

describe('the install file in a private folder that may not be written (the Audit\'s L4 at a3c07fbfa)', () => {
  const posix = process.platform !== 'win32';
  const privateDir = () => path.join(dir, 'private');
  const locked = async <T>(run: () => Promise<T> | T): Promise<T> => {
    fs.chmodSync(privateDir(), 0o500);
    try { return await run(); } finally { fs.chmodSync(privateDir(), 0o700); }
  };

  it.skipIf(!posix)('28: a 401 withdraws the consent first, resolves, says the back-office forgot this Tars, and keeps no install', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    bo.installs.clear();
    seed('t2', 'second', 2000);
    const r = await locked(() => u.runOnce());
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(withdrawn).toBe(1);
    expect(u.state()).toMatchObject({ notice: 'forgotten', registered: false });
  });

  it.skipIf(!posix)('29: a DELETE that went through is said so, and the install is forgotten', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    const d = await locked(() => u.deleteEverywhere());
    expect(d).toMatchObject({ ok: true, deleted: 1 });
    expect(bo.seen.some(s => s.method === 'DELETE' && s.url === '/v1/installs/me')).toBe(true);
    expect(deletion.owed).toBe(false);
    expect(u.state()).toMatchObject({ registered: false, sentSessions: 0 });
  });

  it.skipIf(!posix)('30: giving up an owed deletion throws nothing, and its install is forgotten', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    deletion = { owed: true, since: 5000 };
    let r: ReturnType<TraceUploader['abandonDeletion']> | undefined;
    await locked(() => { r = u.abandonDeletion(); });
    expect(r).toEqual({ ok: true });
    expect(deletion).toEqual({ owed: false, since: 5000 });
    expect(u.state()).toMatchObject({ deletionOwed: false, registered: false });
  });
});

describe('forgetting the progress after a DELETE that went through, on a full disk (the Audit\'s L2 at 965cfced0)', () => {
  const full = () => { throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); };

  it('31: a DELETE answered 200 is said so, and the deletion is no longer owed, whatever the database says', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'resetUploads').mockImplementation(full);
    try {
      const d = await u.deleteEverywhere();
      expect(d).toMatchObject({ ok: true, deleted: 1 });
      expect(deletion.owed).toBe(false);
      expect(log.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/SQLITE_FULL|database or disk is full/);
      expect(u.state()).toMatchObject({ registered: false, deletionOwed: false });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('32: a DELETE answered 401 (nothing left there) resolves ok, and the deletion is no longer owed', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    bo.installs.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'resetUploads').mockImplementation(full);
    try {
      await expect(u.deleteEverywhere()).resolves.toMatchObject({ ok: true });
      expect(deletion.owed).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Sessions that only open (no request): queued, never sendable here.
  const many = (n: number, startedAt: number, projectPath = PROJECT) => {
    for (let i = 0; i < n; i++) {
      store.openTrace({ traceId: `old-${projectPath.length}-${i}`, projectPath, agentId: 'agent-1', agentName: 'Q', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'Remote host', endpointBaseUrl: 'http://192.0.2.10:9000/v1', model: 'open-coder-1', startedAt });
    }
  };

  it('37: 5001 sessions before the deletion and 1 after: one pass sends that 1', async () => {
    many(5001, 1000);
    deletion = { owed: false, since: 5000 };
    seed('after', 'after the deletion', 9000);
    const r = await uploader().runOnce();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(bo.sessions.has('after')).toBe(true);
  }, 60_000);

  it('38: 5001 sessions of a project not opted in and 1 of one that is: one pass sends that 1', async () => {
    many(5001, 9000, path.join(HOME, 'projects', 'project-b'));
    seed('in', 'opted in', 9000);
    const r = await uploader().runOnce();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(bo.sessions.has('in')).toBe(true);
  }, 60_000);

  it('35: pending counts only what would be sent: opted in now, started after the deletion, a change not sent', async () => {
    seed('in', 'opted in', 9000);
    seed('other-project', 'not opted in', 9000, path.join(HOME, 'projects', 'project-b'));
    seed('before', 'before the deletion', 2000);
    deletion = { owed: false, since: 5000 };
    const u = uploader();
    expect(u.state().pendingSessions).toBe(1);
    // The agent switched off: nothing of it would go.
    settings.agentsTraced.clear();
    expect(u.state().pendingSessions).toBe(0);
    settings.agentsTraced.add('agent-1');
    // What the pass sends is what the count said.
    expect((await u.runOnce()).sent).toBe(1);
    expect(u.state().pendingSessions).toBe(0);
  });

  it('36: after a deletion whose progress could not be forgotten, sent counts only what went after it', async () => {
    seed('t1', 'first', 1000);
    const u = uploader();
    await u.runOnce();
    expect(u.state().sentSessions).toBe(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The disk stays full: forgetting the progress fails at the deletion, and again at the next registration.
    vi.spyOn(store, 'resetUploads').mockImplementation(() => { throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); });
    try {
      expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
      expect(u.state().sentSessions, 'nothing is on the back-office after its deletion').toBe(0);
      // Consent again, and one session started after the deletion goes, once the registration's retry is due.
      settings.consentAt = '2026-11-19T06:00:00Z';
      seed('t2', 'after', (deletion.since ?? clock) + 1000);
      expect((await u.runOnce()).failed).toBe(1);
      clock += 60_000;
      expect((await u.runOnce()).sent).toBe(1);
      expect(u.state().sentSessions).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('34: a store whose read throws: "delete everything" still withdraws, the deletion owed from no earlier than the click', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'newestStartedAt').mockImplementation(() => { throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }); });
    // The back-office does not answer the DELETE, so the deletion stays owed.
    bo.failNext.push({ status: 503, code: 'unavailable' });
    const clicked = clock;
    try {
      const d = await u.deleteEverywhere();
      expect(d.ok).toBe(false);
      expect(withdrawn).toBe(1);
      expect(settings.consentAt).toBeUndefined();
      expect(deletion.owed).toBe(true);
      expect(deletion.since).toBeGreaterThanOrEqual(clicked);
      expect(log.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/SQLITE_CORRUPT|malformed/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('33: giving up an owed deletion holds, is answered ok, and the reason is logged', async () => {
    seed('t1', 'first');
    const u = uploader();
    await u.runOnce();
    deletion = { owed: true, since: 5000 };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'resetUploads').mockImplementation(full);
    try {
      let r: ReturnType<TraceUploader['abandonDeletion']> | undefined;
      expect(() => { r = u.abandonDeletion(); }).not.toThrow();
      expect(r).toEqual({ ok: true });
      expect(deletion).toEqual({ owed: false, since: 5000 });
      expect(log.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/SQLITE_FULL|database or disk is full/);
      expect(u.state()).toMatchObject({ deletionOwed: false, registered: false });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('39: a side request goes up marked side: true, and a main one side: false', async () => {
    seed('t1', 'list the files');
    // A title call: no tools and its own system prompt, which the store reads as a side request.
    const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'system', content: 'Title generator' }, { role: 'user', content: 'list the files' }] }));
    const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Listing files' }, finish_reason: 'stop' }] }));
    store.ingest({ traceId: 't1', agentId: 'agent-1', surface: 'openai_chat', startedAt: 1200, endedAt: 1250, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0 });
    expect((await uploader().runOnce()).sent).toBe(1);
    const requests = bo.rows.flatMap(b => (b as { requests?: Array<{ side?: unknown }> }).requests ?? []);
    expect(requests.map(r => r.side).sort()).toEqual([false, true]);
  });

  it('40: a back-office that does not know side refuses the batch: nothing is sent without the mark, and it goes once it knows', async () => {
    seed('t1', 'list the files');
    const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'system', content: 'Title generator' }, { role: 'user', content: 'list the files' }] }));
    const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Listing files' }, finish_reason: 'stop' }] }));
    store.ingest({ traceId: 't1', agentId: 'agent-1', surface: 'openai_chat', startedAt: 1200, endedAt: 1250, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0 });
    bo.unknownRequestFields = ['side'];
    const u = uploader();
    expect(await u.runOnce()).toMatchObject({ sent: 0, failed: 1 });
    expect(bo.rows).toHaveLength(0);
    expect(u.state().lastError).toMatch(/422/);
    expect(u.state().pendingSessions).toBe(1);
    // Every batch it tried carries the mark, the side request's true.
    const decode = (s: Seen) => {
      const enc = s.headers['content-encoding'];
      return JSON.parse((enc === 'zstd' ? (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(s.body) : enc === 'gzip' ? zlib.gunzipSync(s.body) : s.body).toString());
    };
    const tried = bo.seen.filter(s => s.method === 'PUT' && s.url.startsWith('/v1/batches/')).flatMap(s => decode(s).requests as Array<{ side?: unknown }>);
    expect(tried.length).toBeGreaterThan(0);
    expect(tried.every(q => typeof q.side === 'boolean')).toBe(true);
    expect(tried.filter(q => q.side === true).length).toBeGreaterThan(0);
    // The back-office updated: the next try sends the session, marks and all.
    bo.unknownRequestFields = [];
    clock += 60 * 60_000;
    expect(await u.runOnce()).toMatchObject({ sent: 1, failed: 0 });
    const sent = bo.rows.flatMap(b => (b as { requests?: Array<{ side?: unknown }> }).requests ?? []);
    expect(sent.map(r => r.side).sort()).toEqual([false, true]);
  });
});
