import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { TraceStore } from '../../electron/services/trace-store';
import { TraceUploader, type UploaderDeps } from '../../electron/services/trace-upload';

/**
 * The per-session delete the uploader owes the back-office: a session it sent, then deleted here by the user or by
 * retention, is deleted there too (`DELETE /v1/sessions/{sessionId}`, the install's token), so the back-office's own
 * deletions feed carries it to its readers.
 *
 * How it fails, written before the code (27/11):
 * 1. A session sent and then deleted here (by the user, or by retention) is never deleted at the back-office.
 * 2. One never sent, or one the cap deleted, is asked for there: the back-office is told of a session it never had,
 *    or of this disk's room.
 * 3. The delete goes without the install's token, to another address than the install's, or with the id unescaped.
 * 4. A failure (the back-office down, a 503 with Retry-After, a 500) drops the delete, or retries it at once in a
 *    loop: it stays owed, waits as the upload's other calls wait, and goes on a later pass.
 * 5. A 401 (the back-office no longer knows this install) is retried for ever, or registers again: it is the other
 *    calls' 401, the install forgotten and nothing more sent.
 * 6. A delete the back-office took (200) is asked again on the next pass.
 * 7. An owed delete waits behind the uploads, or is lost when a batch fails: it goes first in a pass.
 * 8. With sharing off (no consent) an owed delete never goes, though the install is still registered at the address
 *    set; or it goes to an address the user has changed or emptied since.
 * 9. A whole deletion owed, or under way, sends per-session deletes as well (the whole one covers them, and its
 *    token may be gone).
 * 10. After "delete everything" went through, a per-session delete owed before it is still sent (with a token the
 *     back-office revoked).
 * Added before their code after the Audit's M1 and I-2 at 98e921347 (27/11):
 * 11. A session deleted while its first upload is under way (its batches landing after the delete) is owed nothing:
 *     the copy stays at the back-office.
 * 12. The same when a pass fails after some of its batches landed: a partial copy stays there, owed nothing, whether
 *     the session is deleted during the pass or after it.
 * 13. A session gone is marked uploaded once its batches land: a row for a session that no longer exists.
 * 14. The mark of a session whose first upload is under way counts it as sent in the window, or takes it out of the
 *     queue, so a pass that failed never sends it again.
 * 15. A delete owed to an install that is gone (the back-office answered 401, or its file was removed) stays owed for
 *     good: nothing can ever send it.
 * Added before its code after the Audit's Low at 9a1e9e8c4 (27/11):
 * 16. An install file that is there but cannot be read for a moment (its JSON caught mid-write, a read refused) is taken
 *     for gone, and every delete owed to it is forgotten for good.
 * Added before its code after the Audit's pre-existing Low at fff13140c (27/11):
 * 17. The same with a whole deletion the user asked for ("delete everything sent", owed while its DELETE has not gone
 *     through): a moment's bad read forgets it, and sharing may start again with the copy still there. Only a file
 *     truly gone (ENOENT) forgets it.
 * Added after the fixes of 16 and 17, which the task asked for and those two left out (27/11), shown red on the code
 * before each fix:
 * 18. A read of the install file refused (its permission), with deletes owed per session: forgotten for good.
 * 19. The same with a whole deletion owed.
 */

type Seen = { method: string; url: string; auth?: string };

class BackOffice {
  server!: http.Server;
  base = '';
  seen: Seen[] = [];
  tokens = new Set<string>();
  sessions = new Set<string>();
  failNext: Array<{ status: number; retryAfter?: string; code?: string }> = [];
  /** Fail only the per-session deletes, the uploads going through. */
  failDeletes: Array<{ status: number; retryAfter?: string; code?: string }> = [];
  /** How many batch uploads to refuse (500) before taking them again. */
  failBatches = 0;
  /** Run as each batch arrives, before it is answered: the user's delete while an upload is under way. */
  onBatch?: (batchId: string, nth: number) => void;
  /** The answers to the next batches, in order (200 when the list is used up). */
  batchPlan: number[] = [];
  batchesSeen = 0;
  down = false;
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => this.handle(req, res));
    });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise(r => this.server.close(() => r(undefined))); }
  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (this.down) { req.socket.destroy(); return; }
    const url = req.url ?? '';
    const auth = String(req.headers.authorization ?? '');
    this.seen.push({ method: req.method ?? '', url, auth });
    const fail = this.failNext.shift();
    if (fail) { this.send(res, fail.status, { error: fail.code ?? 'unavailable' }, fail.retryAfter ? { 'Retry-After': fail.retryAfter } : {}); return; }
    if (req.method === 'POST' && url === '/v1/installs') {
      const token = `tbi_${this.tokens.size + 1}`;
      this.tokens.add(token);
      this.send(res, 201, { installId: `inst-${this.tokens.size}`, token });
      return;
    }
    const token = auth.replace(/^Bearer /, '');
    if (!this.tokens.has(token)) { this.send(res, 401, { error: 'unauthorized' }); return; }
    if (req.method === 'POST' && url === '/v1/blobs/missing') this.send(res, 200, { missing: [] });
    else if (req.method === 'PUT' && url.startsWith('/v1/batches/')) {
      this.batchesSeen++;
      this.onBatch?.(decodeURIComponent(url.slice('/v1/batches/'.length)), this.batchesSeen);
      const planned = this.batchPlan.shift();
      if (planned !== undefined && planned !== 200) { this.send(res, planned, { error: 'internal' }); return; }
      if (this.failBatches > 0) { this.failBatches--; this.send(res, 500, { error: 'internal' }); return; }
      this.sessions.add(decodeURIComponent(url.slice('/v1/batches/'.length)).split('.')[0]);
      this.send(res, 200, { missingBlobs: [] });
    } else if (req.method === 'DELETE' && url.startsWith('/v1/sessions/')) {
      const f = this.failDeletes.shift();
      if (f) { this.send(res, f.status, { error: f.code ?? 'unavailable' }, f.retryAfter ? { 'Retry-After': f.retryAfter } : {}); return; }
      const id = decodeURIComponent(url.slice('/v1/sessions/'.length));
      const had = this.sessions.delete(id);
      this.send(res, 200, { deleted: { sessions: had ? 1 : 0 }, deletedAt: 1 });
    } else if (req.method === 'DELETE' && url === '/v1/installs/me') {
      this.tokens.delete(token);
      this.sessions.clear();
      this.send(res, 200, { deleted: { sessions: 0 } });
    } else this.send(res, 404, { error: 'not_found' });
  }
  deletesOf(): string[] {
    return this.seen.filter(s => s.method === 'DELETE' && s.url.startsWith('/v1/sessions/')).map(s => decodeURIComponent(s.url.slice('/v1/sessions/'.length)));
  }
}

const PROJECT = '/p/project-a';
let dir: string;
let store: TraceStore;
let bo: BackOffice;
let clock: number;
let settings: { url: string; consentAt?: string };
let deletion: { owed: boolean; since?: number };

/** A session; a time under 1e9 is that many ms into the 1000 s before the clock, so retention leaves it alone. */
function seed(traceId: string, started: number, ended?: number) {
  const at = (v: number) => (v < 1e9 ? clock - 1_000_000 + v : v);
  const startedAt = at(started);
  const endedAt = ended === undefined ? undefined : at(ended);
  store.openTrace({ traceId, projectPath: PROJECT, agentId: 'agent-1', harness: 'qwen-code', endpointId: 'ep-000001', model: 'open-coder-1', startedAt });
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  store.ingest({
    traceId, agentId: 'agent-1', surface: 'openai_chat', startedAt, endedAt: startedAt + 100, status: 200, contentType: 'application/json',
    requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `the task of ${traceId}` }], tools: [{ type: 'function', function: { name: 'bash' } }] }),
    responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    attempts: 1, heldMs: 0,
  });
  if (endedAt !== undefined) store.endTrace(traceId, endedAt);
}

function uploader(over: Partial<UploaderDeps> = {}) {
  return new TraceUploader({
    store,
    installFile: path.join(dir, 'private', 'traces-install.json'),
    settings: () => ({ url: settings.url, consentAt: settings.consentAt, since: deletion.since, deletionOwed: deletion.owed }),
    setDeletion: (d) => { deletion = d; },
    eligible: () => true,
    scrubContext: () => ({ homeDirs: [os.homedir()], knownSecrets: [], envValues: [] }),
    client: { name: 'tars', version: '0.0.0-test', platform: process.platform },
    withdrawConsent: (d?: { owed: boolean; since?: number }) => { settings.consentAt = undefined; if (d) deletion = d; },
    // The training switch (trace feature A5, its own tests in trace-training.test.ts): on, nothing owed.
    training: () => ({ value: true, owed: false }),
    trainingSent: () => {},
    now: () => clock,
    ...over,
  });
}

/** A session of `n` requests, each its own turn: with a small batch limit, its upload goes in `n` batches. */
function seedLong(traceId: string, n: number) {
  seed(traceId, 1000);
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  for (let i = 1; i < n; i++) {
    const at = clock - 1_000_000 + 1000 + i * 10;
    store.ingest({
      traceId, agentId: 'agent-1', surface: 'openai_chat', startedAt: at, endedAt: at + 5, status: 200, contentType: 'application/json',
      requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `${traceId} step ${i} ${'x'.repeat(200)}` }], tools: [{ type: 'function', function: { name: 'bash' } }] }),
      responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      attempts: 1, heldMs: 0,
    });
  }
  store.endTrace(traceId, clock - 1_000_000 + 5000);
}

/** The store's upload marks, read beside it. */
function uploadRows(): Array<{ trace_id: string; uploaded_seq: number }> {
  const db = new Database(path.join(dir, 'traces.db'), { readonly: true });
  try {
    return db.prepare('SELECT trace_id, uploaded_seq FROM uploads ORDER BY trace_id').all() as Array<{ trace_id: string; uploaded_seq: number }>;
  } finally {
    db.close();
  }
}

/** Sessions sent by a first pass, then the ones named deleted here by the user. */
async function sendThenDelete(u: TraceUploader, sent: string[], deleted: string[]) {
  for (const id of sent) seed(id, 1000 + sent.indexOf(id), 2000);
  expect(await u.runOnce()).toMatchObject({ sent: sent.length, failed: 0 });
  store.remove({ traceIds: deleted }, clock);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-upload-deletions-'));
  store = new TraceStore(path.join(dir, 'traces.db'));
  bo = new BackOffice();
  await bo.start();
  clock = 1_800_000_000_000;
  deletion = { owed: false };
  settings = { url: bo.base, consentAt: '2026-11-27T00:00:00Z' };
});
afterEach(async () => {
  store.close();
  await bo.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the per-session delete owed to the back-office', () => {
  it('1 and 6: a session sent and then deleted here by the user, or by retention, is deleted there once', async () => {
    const u = uploader();
    seed('s-user', 1000, 2000);
    seed('s-expired', clock - 41 * 86_400_000, clock - 40 * 86_400_000);
    seed('s-kept', 1002, 2000);
    expect(await u.runOnce()).toMatchObject({ sent: 3, failed: 0 });
    store.remove({ traceIds: ['s-user'] }, clock);
    store.sweep({ capBytes: 1024 ** 3, retentionDays: 30, now: clock });
    expect(store.hasTrace('s-expired')).toBe(false);
    await u.runOnce();
    expect(bo.deletesOf().sort()).toEqual(['s-expired', 's-user']);
    expect([...bo.sessions]).toEqual(['s-kept']);
    await u.runOnce();
    expect(bo.deletesOf()).toHaveLength(2);
    expect(store.owedDeletes(10)).toEqual([]);
  });

  it('2: one never sent, or one the cap took, is not asked for there', async () => {
    const u = uploader();
    seed('s-kept', 3000, 4000);
    const cap = store.stats().bytes + 100;
    seed('s-capped', 1000, 2000);
    expect(await u.runOnce()).toMatchObject({ sent: 2, failed: 0 });
    seed('s-local', 5000, 6000);
    store.remove({ traceIds: ['s-local'] }, clock);
    store.sweep({ capBytes: cap, retentionDays: 3650, now: clock });
    expect(store.hasTrace('s-capped')).toBe(false);
    expect(store.hasTrace('s-kept')).toBe(true);
    await u.runOnce();
    expect(bo.deletesOf()).toEqual([]);
  });

  it('3: with the install\'s token, to the install\'s address, the id escaped', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s:a.b-1'], ['s:a.b-1']);
    await u.runOnce();
    const del = bo.seen.find(s => s.method === 'DELETE')!;
    expect(del.url).toBe(`/v1/sessions/${encodeURIComponent('s:a.b-1')}`);
    expect(del.auth).toBe('Bearer tbi_1');
  });

  it('4: a failure keeps it owed and waits as the other calls do; it goes on a later pass', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1'], ['s-1']);
    bo.failDeletes.push({ status: 503, retryAfter: '120' });
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-1']);
    expect(u.state().nextTryAt).toBe(clock + 120_000);
    expect(await u.runOnce()).toMatchObject({ skipped: 'waiting' });
    expect(bo.deletesOf()).toEqual(['s-1']);
    clock += 121_000;
    bo.down = true;
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-1']);
    bo.down = false;
    clock += 31 * 60_000;
    await u.runOnce();
    expect(store.owedDeletes(10)).toEqual([]);
    expect(bo.sessions.has('s-1')).toBe(false);
  });

  it('5: a 401 forgets the install, as on the other calls, and nothing more is asked', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1'], ['s-1']);
    bo.tokens.clear();
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(u.state().notice).toBe('forgotten');
    const asked = bo.seen.length;
    await u.runOnce();
    expect(bo.seen.length).toBe(asked);
  });

  it('7: an owed delete goes first in a pass, before the uploads, so a failing upload does not hold it back', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1'], ['s-1']);
    seed('s-2', 3000, 4000);
    bo.failBatches = 1;
    const from = bo.seen.length;
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(bo.seen.slice(from)[0].method).toBe('DELETE');
    expect(bo.deletesOf()).toEqual(['s-1']);
    expect(store.owedDeletes(10)).toEqual([]);
  });

  it('8: with sharing off it still goes while the install is registered at the address set; never to an address changed since', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1', 's-2'], ['s-1']);
    settings.consentAt = undefined;
    expect(await u.runOnce()).toMatchObject({ sent: 0 });
    expect(bo.deletesOf()).toEqual(['s-1']);
    store.remove({ traceIds: ['s-2'] }, clock);
    settings.url = 'http://127.0.0.1:9/elsewhere';
    await u.runOnce();
    settings.url = '';
    await u.runOnce();
    expect(bo.deletesOf()).toEqual(['s-1']);
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-2']);
  });

  it('9: a whole deletion owed, or under way, sends no per-session delete', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1', 's-2'], ['s-1']);
    deletion = { owed: true, since: clock };
    await u.runOnce();
    expect(bo.deletesOf()).toEqual([]);
  });

  it('11 and 13: a session deleted while its first upload lands is owed a delete, and no row is left for it', async () => {
    const u = uploader();
    seed('s-race', 1000, 2000);
    bo.onBatch = () => { if (store.hasTrace('s-race')) store.remove({ traceIds: ['s-race'] }, clock); };
    expect(await u.runOnce()).toMatchObject({ failed: 0 });
    expect(bo.sessions.has('s-race'), 'the copy landed').toBe(true);
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-race']);
    expect(uploadRows(), 'a row for a session that is gone').toEqual([]);
    bo.onBatch = undefined;
    await u.runOnce();
    expect(bo.deletesOf()).toEqual(['s-race']);
    expect(bo.sessions.has('s-race')).toBe(false);
  });

  it('12: a pass that fails after a first batch landed leaves a delete owed, the session deleted during it or after', async () => {
    const u = uploader({ maxBatchBytes: 300 });
    seedLong('s-during', 3);
    bo.batchPlan = [200, 500];
    bo.onBatch = (_id, nth) => { if (nth === 1) store.remove({ traceIds: ['s-during'] }, clock); };
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(bo.sessions.has('s-during'), 'a partial copy landed').toBe(true);
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-during']);
    bo.onBatch = undefined;
    clock += 31 * 60_000;
    await u.runOnce();
    expect(bo.deletesOf()).toEqual(['s-during']);

    seedLong('s-after', 3);
    bo.batchPlan = [200, 500];
    clock += 31 * 60_000;
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(bo.sessions.has('s-after'), 'a partial copy landed').toBe(true);
    store.remove({ traceIds: ['s-after'] }, clock);
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-after']);
  });

  it('14: a session whose first upload is under way is not counted sent, and a failed pass sends it again', async () => {
    const u = uploader({ maxBatchBytes: 300 });
    seedLong('s-1', 3);
    let sentDuring = -1;
    bo.onBatch = (_id, nth) => { if (nth === 1) sentDuring = u.state().sentSessions; };
    bo.batchPlan = [200, 500];
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(sentDuring).toBe(0);
    expect(u.state().sentSessions).toBe(0);
    expect(store.uploadQueue(10).map(q => q.traceId)).toContain('s-1');
    clock += 31 * 60_000;
    expect(await u.runOnce()).toMatchObject({ sent: 1, failed: 0 });
    expect(u.state().sentSessions).toBe(1);
  });

  it('15: a delete owed to an install that is gone is owed no more', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1', 's-2'], ['s-1']);
    bo.tokens.clear();
    expect(await u.runOnce()).toMatchObject({ failed: 1 });
    expect(u.state().notice).toBe('forgotten');
    expect(store.owedDeletes(10)).toEqual([]);

    // Another install, whose file is then removed by hand.
    const v = uploader();
    settings.consentAt = '2026-11-27T02:00:00Z';
    seed('s-3', 3000, 4000);
    await v.runOnce();
    store.remove({ traceIds: ['s-3'] }, clock);
    expect(store.owedDeletes(10).map(o => o.traceId)).toEqual(['s-3']);
    // Sharing off, so no pass registers again (which would forget it anyway): the file's absence alone must.
    settings.consentAt = undefined;
    fs.rmSync(path.join(dir, 'private', 'traces-install.json'));
    await v.runOnce();
    expect(store.owedDeletes(10)).toEqual([]);
  });

  it('16: an install file that cannot be read for a moment keeps the deletes owed to it', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1', 's-2'], ['s-1']);
    const file = path.join(dir, 'private', 'traces-install.json');
    const whole = fs.readFileSync(file, 'utf8');
    // Sharing off, so no pass registers anew over the file: what it does with the debt is the file's read alone.
    settings.consentAt = undefined;
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    await u.runOnce();
    expect(store.owedDeletes(10).map(o => o.traceId), 'a file caught mid-write').toEqual(['s-1']);
    fs.writeFileSync(file, whole);
    await u.runOnce();
    expect(bo.deletesOf()).toEqual(['s-1']);
    expect(store.owedDeletes(10)).toEqual([]);
  });

  it('17: a whole deletion owed survives a bad read of the install file, goes once it reads again, and only a file gone forgets it', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1'], []);
    bo.failNext.push({ status: 503 });
    expect(await u.deleteEverywhere()).toMatchObject({ ok: false });
    expect(deletion.owed, 'owed after the refused DELETE').toBe(true);
    const file = path.join(dir, 'private', 'traces-install.json');
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    expect(u.isDeletionOwed(), 'a file caught mid-write').toBe(true);
    expect(deletion.owed).toBe(true);
    fs.writeFileSync(file, whole);
    expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
    expect(bo.seen.filter(s => s.method === 'DELETE' && s.url === '/v1/installs/me')).toHaveLength(2);
    // Owed again, then the file truly gone: forgotten, the deletion's moment kept.
    seed('s-2', 5000, 6000);
    settings.consentAt = '2026-11-27T03:00:00Z';
    await u.runOnce();
    bo.failNext.push({ status: 503 });
    await u.deleteEverywhere();
    expect(deletion.owed).toBe(true);
    fs.rmSync(file);
    expect(u.isDeletionOwed()).toBe(false);
    expect(deletion.owed).toBe(false);
    expect(deletion.since).toBeDefined();
  });

  /** The install file made unreadable for `run`, then readable again; skipped where a mode cannot refuse a read. */
  async function withReadRefused(ctx: { skip: () => void }, run: () => Promise<void>) {
    const file = path.join(dir, 'private', 'traces-install.json');
    if (process.platform === 'win32') ctx.skip(); // a file mode refuses no read there; a lock does, which Node cannot take
    fs.chmodSync(file, 0o000);
    try {
      let refused = false;
      try { fs.readFileSync(file); } catch { refused = true; }
      if (!refused) ctx.skip(); // root reads it anyway
      await run();
    } finally {
      fs.chmodSync(file, 0o600);
    }
  }

  it('18: a refused read of the install file keeps the deletes owed per session, and they go at the next good pass', async (ctx) => {
    const u = uploader();
    await sendThenDelete(u, ['s-1', 's-2'], ['s-1']);
    settings.consentAt = undefined;
    await withReadRefused(ctx, async () => {
      await u.runOnce();
      expect(store.owedDeletes(10).map(o => o.traceId), 'a read refused').toEqual(['s-1']);
    });
    await u.runOnce();
    expect(bo.deletesOf()).toEqual(['s-1']);
    expect(store.owedDeletes(10)).toEqual([]);
  });

  it('19: a refused read of the install file keeps a whole deletion owed, and it goes once the file reads again', async (ctx) => {
    const u = uploader();
    await sendThenDelete(u, ['s-1'], []);
    bo.failNext.push({ status: 503 });
    expect(await u.deleteEverywhere()).toMatchObject({ ok: false });
    expect(deletion.owed).toBe(true);
    await withReadRefused(ctx, async () => {
      expect(u.isDeletionOwed(), 'a read refused').toBe(true);
      expect(deletion.owed).toBe(true);
    });
    expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
    expect(deletion.owed).toBe(false);
  });

  it('10: after "delete everything" went through, a delete owed before it is never sent', async () => {
    const u = uploader();
    await sendThenDelete(u, ['s-1', 's-2'], ['s-1']);
    expect(await u.deleteEverywhere()).toMatchObject({ ok: true });
    settings.consentAt = '2026-11-27T01:00:00Z';
    await u.runOnce();
    expect(bo.deletesOf()).toEqual([]);
    expect(store.owedDeletes(10)).toEqual([]);
  });
});
