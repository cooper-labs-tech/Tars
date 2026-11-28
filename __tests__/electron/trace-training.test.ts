import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../../electron/services/trace-store';
import { sessionDocument } from '../../electron/services/trace-export';
import { TraceUploader, type UploaderDeps } from '../../electron/services/trace-upload';

/**
 * Trace feature A5 (27/11): whether a session may be used to train models. The owner's switch, "May be used to train
 * models", stands beside sharing; each session carries `consent: { training }` as the switch stood while it ran, and
 * the install carries its current value at the back-office, which covers the sessions already sent. The back-office's
 * side is #678's: per session `consent: { "training": boolean }` and nothing else; `PUT /v1/installs/me/consent` with
 * `{ "training": boolean }` and nothing else, the install token only, answered 200 `{ training, at }`, a repeat
 * harmless; `POST /v1/installs` takes an optional `"consent": { "training": boolean }`, recorded as the first change.
 *
 * How it fails, written before the code:
 * The store and the export
 * 1. A session opened while the switch is off is stored as true, or one opened while on as false.
 * 2. A session the switch was turned off for while it ran keeps true; or turning it on again brings it back to true
 *    (once off at any moment, the session is false for good); or the change does not make the session go again (its
 *    change sequence does not move), so the back-office keeps true for it.
 * 3. A session recorded with no stamp (before the switch existed) is read as true.
 * 4. The session document (the export, the read API, the upload's source) has no `consent`.
 * The upload
 * 5. A session goes with no `consent`, with one other than as stamped, or with a field besides `training`.
 * 6. A registration does not carry the switch's value as `consent: { training }`, or leaves a change owed after it.
 * 7. A change owed is not sent as `PUT /v1/installs/me/consent` with `{ training }` alone and the install token, or is
 *    sent after the sessions (a session could then go before the install says no), or is cleared without a 2xx.
 * 8. A change owed that failed (503) is not sent again at the next pass, or not by a new uploader reading it (a
 *    restart); or a change whose value moved while its PUT was out is cleared, so the newer value never goes.
 * 9. With sharing off and an install registered, a change owed does not go (turning training off must reach the
 *    sessions already sent); or sessions go with it.
 * 10. With no install, a change owed is sent anywhere, or registers an install on its own.
 * Added before its fix (the Audit's M1 on #690 at 050c79fd9): the store is under ~/.tars, which every agent is handed.
 * 11. A session the private list denies, whose stamp an agent set back to 1 in the store, goes as trainable, in the
 *     upload or in the preview.
 */

const HOME = os.homedir();
const PROJECT = path.join(HOME, 'projects', 'project-a');

class BackOffice {
  server!: http.Server;
  base = '';
  seen: Array<{ method: string; url: string; auth: string; body: string }> = [];
  failNext: number[] = [];
  /** Held answers for the consent PUT: resolved by the test, to change the switch while one is out. */
  holdConsent?: Promise<void>;
  private n = 0;
  private tokens = new Set<string>();
  sessions: Array<Record<string, unknown>> = [];
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks);
        const enc = req.headers['content-encoding'];
        const zstd = zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer };
        const body = (enc === 'zstd' ? zstd.zstdDecompressSync(raw) : enc === 'gzip' ? zlib.gunzipSync(raw) : raw).toString();
        const url = req.url ?? '';
        const auth = String(req.headers.authorization ?? '');
        this.seen.push({ method: req.method ?? '', url, auth, body });
        const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        const fail = this.failNext.shift();
        if (fail) return send(fail, { error: 'unavailable' });
        if (req.method === 'POST' && url === '/v1/installs') {
          const token = `tok_${++this.n}`;
          this.tokens.add(token);
          return send(201, { installId: `0b0e0000-0000-4000-8000-00000000000${this.n}`, token });
        }
        if (!this.tokens.has(auth.replace(/^Bearer /, ''))) return send(401, { error: 'unauthorized' });
        if (req.method === 'PUT' && url === '/v1/installs/me/consent') {
          if (this.holdConsent) await this.holdConsent;
          return send(200, { training: JSON.parse(body).training, at: 1 });
        }
        if (req.method === 'POST' && url === '/v1/blobs/missing') return send(200, { missing: [] });
        if (req.method === 'PUT' && url.startsWith('/v1/batches/')) {
          const batch = JSON.parse(body);
          for (const s of batch.sessions ?? []) this.sessions.push(s);
          return send(200, { replayed: false, missingBlobs: [] });
        }
        return send(200, {});
      });
    });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise(r => this.server.close(() => r(undefined))); }
  calls(method: string, url: string) { return this.seen.filter(s => s.method === method && s.url === url); }
}

let dir: string;
let store: TraceStore;
let bo: BackOffice;
let consentAt: string | undefined;
let training: { value: boolean; owed: boolean };
let denied = new Set<string>();

function seed(traceId: string, opts: { training?: boolean } = {}, startedAt = 1000) {
  store.openTrace({ traceId, projectPath: PROJECT, agentId: 'agent-1', agentName: 'Q', harness: 'qwen-code', endpointId: 'ep-000001', model: 'open-coder-1', startedAt, ...(opts.training !== undefined ? { training: opts.training } : {}) });
  const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'user', content: traceId }] }));
  const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  store.ingest({ traceId, agentId: 'agent-1', surface: 'openai_chat', startedAt, endedAt: startedAt + 10, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0 });
}

function uploader(over: Partial<UploaderDeps> = {}) {
  return new TraceUploader({
    store,
    installFile: path.join(dir, 'private', 'traces-install.json'),
    settings: () => ({ url: bo.base, consentAt }),
    setDeletion: () => {},
    eligible: () => true,
    scrubContext: () => ({ homeDirs: [HOME], knownSecrets: [], envValues: [] }),
    client: { name: 'tars', version: '0.0.0-test', platform: process.platform },
    withdrawConsent: () => { consentAt = undefined; },
    training: () => ({ ...training }),
    trainingSent: (value: boolean) => { if (training.value === value) training = { value, owed: false }; },
    trainingDenied: (traceId: string) => denied.has(traceId),
    now: () => 1_000_000,
    ...over,
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-training-'));
  store = new TraceStore(path.join(dir, 'traces.db'));
  bo = new BackOffice();
  await bo.start();
  consentAt = '2026-11-27T00:00:00Z';
  training = { value: true, owed: false };
  denied = new Set();
});
afterEach(async () => {
  store.close();
  await bo.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store and the export', () => {
  it('1 and 4: a session carries the switch as it stood when it opened, in its document', () => {
    seed('on', { training: true });
    seed('off', { training: false });
    expect(store.session('on')?.session.consent).toEqual({ training: true });
    expect(store.session('off')?.session.consent).toEqual({ training: false });
    expect(sessionDocument(store, 'on')?.trace.consent).toEqual({ training: true });
    expect(sessionDocument(store, 'off')?.trace.consent).toEqual({ training: false });
  });

  it('2: turned off while it ran, a session is false for good, and goes again', () => {
    seed('run', { training: true });
    const before = store.uploadQueue(10).find(q => q.traceId === 'run')!.seq;
    store.markUploaded('run', before, 5000);
    store.denyTraining(['run']);
    expect(store.session('run')?.session.consent).toEqual({ training: false });
    const again = store.uploadQueue(10).find(q => q.traceId === 'run');
    expect(again?.seq, 'the session goes again').toBeGreaterThan(before);
    store.openTrace({ traceId: 'run', projectPath: PROJECT, agentId: 'agent-1', harness: 'qwen-code', endpointId: 'ep-000001', model: 'open-coder-1', startedAt: 1000, training: true });
    expect(store.session('run')?.session.consent, 'never back to true').toEqual({ training: false });
  });

  it('3: a session with no stamp reads false', () => {
    seed('old');
    expect(store.session('old')?.session.consent).toEqual({ training: false });
  });
});

describe('the upload', () => {
  it('5: each session goes with consent { training } as stamped, and nothing else in it', async () => {
    seed('on', { training: true });
    seed('off', { training: false }, 2000);
    await uploader().runOnce();
    const consent = Object.fromEntries(bo.sessions.map(s => [s.sessionId, s.consent]));
    expect(consent).toEqual({ on: { training: true }, off: { training: false } });
  });

  it('6: the registration carries the value, and leaves nothing owed', async () => {
    training = { value: false, owed: true };
    seed('s', { training: false });
    await uploader().runOnce();
    const reg = bo.calls('POST', '/v1/installs');
    expect(reg).toHaveLength(1);
    expect(JSON.parse(reg[0].body).consent).toEqual({ training: false });
    expect(training.owed).toBe(false);
    expect(bo.calls('PUT', '/v1/installs/me/consent'), 'nothing else to send').toHaveLength(0);
  });

  it('7: a change owed goes as PUT /v1/installs/me/consent with { training } alone and the token, before any session', async () => {
    seed('a', { training: true });
    const u = uploader();
    await u.runOnce();
    training = { value: false, owed: true };
    seed('b', { training: false }, 3000);
    await u.runOnce();
    const puts = bo.calls('PUT', '/v1/installs/me/consent');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].body)).toEqual({ training: false });
    expect(puts[0].auth).toMatch(/^Bearer tok_1$/);
    const putAt = bo.seen.indexOf(puts[0]);
    const batchB = bo.seen.findIndex(s => s.method === 'PUT' && s.url.startsWith('/v1/batches/b.'));
    expect(putAt, 'before the session').toBeLessThan(batchB);
    expect(training.owed).toBe(false);
  });

  it('8: a change that failed goes again, and from a new uploader; a value moved while out stays owed', async () => {
    seed('a', { training: true });
    await uploader().runOnce();
    training = { value: false, owed: true };
    bo.failNext.push(503);
    const r = await uploader().runOnce();
    expect(r.failed).toBe(1);
    expect(training.owed, 'kept after a 503').toBe(true);
    await uploader().runOnce();
    expect(bo.calls('PUT', '/v1/installs/me/consent').map(p => JSON.parse(p.body).training)).toEqual([false, false]);
    expect(training.owed).toBe(false);
    // The switch moves while a PUT is out: the newer value stays owed, and goes next.
    let release!: () => void;
    bo.holdConsent = new Promise<void>(r => { release = r; });
    training = { value: true, owed: true };
    const u = uploader();
    const pass = u.runOnce();
    await new Promise(r => setTimeout(r, 100));
    training = { value: false, owed: true };
    release();
    await pass;
    bo.holdConsent = undefined;
    expect(training, 'the newer value still owed').toEqual({ value: false, owed: true });
    await u.runOnce();
    expect(bo.calls('PUT', '/v1/installs/me/consent').map(p => JSON.parse(p.body).training).slice(-2)).toEqual([true, false]);
    expect(training.owed).toBe(false);
  });

  it('9: with sharing off, a change owed still reaches a registered install, and no session goes', async () => {
    seed('a', { training: true });
    await uploader().runOnce();
    consentAt = undefined;
    training = { value: false, owed: true };
    seed('b', { training: false }, 3000);
    await uploader().runOnce();
    expect(bo.calls('PUT', '/v1/installs/me/consent').map(p => JSON.parse(p.body))).toEqual([{ training: false }]);
    expect(bo.sessions.map(s => s.sessionId), 'no session with sharing off').toEqual(['a']);
    expect(training.owed).toBe(false);
  });

  it('11: a session the private list denies goes as false, its stamp set back to 1 or not, in the upload and the preview', async () => {
    seed('forged', { training: true });
    seed('fair', { training: true }, 2000);
    denied.add('forged');
    const u = uploader();
    const preview = u.preview('forged') as { consent: unknown; document: { batches: Array<{ body: { sessions?: Array<{ consent?: unknown }> } }> } };
    expect(preview.consent).toEqual({ training: false });
    expect(preview.document.batches[0].body.sessions?.[0].consent).toEqual({ training: false });
    await u.runOnce();
    const consent = Object.fromEntries(bo.sessions.map(s => [s.sessionId, s.consent]));
    expect(consent).toEqual({ forged: { training: false }, fair: { training: true } });
  });

  it('10: with no install, a change owed goes nowhere and registers nothing', async () => {
    consentAt = undefined;
    training = { value: false, owed: true };
    await uploader().runOnce();
    expect(bo.seen).toEqual([]);
    expect(training.owed).toBe(true);
  });
});
