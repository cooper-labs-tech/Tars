// E2E: the real server against a real Postgres, in a throwaway setup, driven over HTTP only
// (and the CLI an operator runs). Each step names what a user of the back-office relies on.
//
// Run: npm run test:e2e   (PG_BIN=<folder of initdb> when initdb is not found by itself)
// Artefact: .runs/<time>/ holds asserted.json (every value checked), server.log and reproduce.txt.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { startPostgres, startServer, runCli, filesUnder, ROOT, type Pg, type Server } from './harness.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const asserted: Record<string, unknown> = {};
const note = (k: string, v: unknown) => { asserted[k] = v; return v; };

let db: Pg;
let srv: Server;
let env: Record<string, string>;
let blobDir: string;
const OWNER_PASSWORD = 'correct horse battery staple';

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: Buffer; encoding?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: Buffer | undefined;
  if (opts.raw) { body = opts.raw; headers['content-type'] ??= 'application/octet-stream'; }
  else if (opts.body !== undefined) {
    body = Buffer.from(JSON.stringify(opts.body));
    headers['content-type'] = 'application/json';
    if (opts.encoding === 'gzip') body = gzipSync(body);
    if (opts.encoding === 'zstd') body = zstdCompressSync(body);
  }
  if (opts.encoding) headers['content-encoding'] = opts.encoding;
  const res = await fetch(srv.base + path, { method, headers, body, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any;
  try { json = JSON.parse(buf.toString()); } catch { json = undefined; }
  return { status: res.status, json, buf, headers: res.headers };
}

// The messages of one small session: a system prompt, a task, a tool call, its result, an answer.
const msgs = {
  system: Buffer.from(JSON.stringify({ role: 'system', content: 'You are a coding agent.' })),
  user: Buffer.from(JSON.stringify({ role: 'user', content: 'List the files.' })),
  call: Buffer.from(JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"command":"ls"}' } }] })),
  result: Buffer.from(JSON.stringify({ role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.txt' })),
  answer: Buffer.from(JSON.stringify({ role: 'assistant', content: 'Two files: a.txt and b.txt.' })),
};
const tools = Buffer.from(JSON.stringify([{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }]));
const h = Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, sha(v)])) as Record<keyof typeof msgs, string>;
const toolsHash = sha(tools);
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
const PROJECT = 'a'.repeat(64);

function session(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1', agentId: 'agent-1', agentName: 'Worker', projectKey: PROJECT, harness: 'codex', harnessVersion: '0.163.0',
    endpointKey: 'e'.repeat(16), endpointName: 'Lab', model: 'open-model-a', startedAt: T0, finalStatus: 'open',
    turnCount: 1, requestCount: 2, tokensIn: 300, tokensCached: 100, tokensOut: 40, mixed: false, unknownTurns: 0, ...over,
  };
}
const turn = { turnId: 'turn-1', sessionId: 'sess-1', index: 0, startedAt: T0, endedAt: T0 + 5000, requestCount: 2, toolCallCount: 1, toolErrorCount: 0,
  toolMs: 900, modelMs: 3100, tokensIn: 300, tokensCached: 100, tokensOut: 40, finalStatus: 'done', finalFinishReason: 'stop', author: 'orchestrator', authorDetail: 'agent-0' };
const requests = [
  { requestId: 'req-1', sessionId: 'sess-1', turnId: 'turn-1', seq: 0, upstreamRequestId: 'up-111', surface: 'openai_chat', modelRequested: 'open-model-a',
    modelServed: 'open-model-a', params: { temperature: 0.2 }, toolsHash, startedAt: T0, ttftMs: 200, totalMs: 1500, tokensIn: 120, tokensCached: 0,
    tokensOut: 20, status: 200, finishReason: 'tool_calls', streamed: true, reqBytes: 900, respBytes: 300,
    messages: [{ position: 0, hash: h.system, direction: 'input' }, { position: 1, hash: h.user, direction: 'input' }, { position: 2, hash: h.call, direction: 'output' }] },
  { requestId: 'req-2', sessionId: 'sess-1', turnId: 'turn-1', seq: 1, upstreamRequestId: 'up-222', surface: 'openai_chat', startedAt: T0 + 2400,
    totalMs: 1600, tokensIn: 180, tokensCached: 100, tokensOut: 20, status: 200, finishReason: 'stop', streamed: true,
    messages: [{ position: 0, hash: h.system, direction: 'input' }, { position: 1, hash: h.user, direction: 'input' }, { position: 2, hash: h.call, direction: 'input' },
      { position: 3, hash: h.result, direction: 'input' }, { position: 4, hash: h.answer, direction: 'output' }] },
];
const messages = [
  { hash: h.system, role: 'system', createdAt: T0, size: msgs.system.length },
  { hash: h.user, role: 'user', createdAt: T0, size: msgs.user.length },
  { hash: h.call, role: 'assistant', createdAt: T0, size: msgs.call.length, toolCallCount: 1 },
  { hash: h.result, role: 'tool', createdAt: T0, size: msgs.result.length },
  { hash: h.answer, role: 'assistant', createdAt: T0, size: msgs.answer.length },
];

// The owner's browser: a cookie jar of one, and the CSRF token read from each page.
let cookie = '';
async function page(path: string) {
  const res = await fetch(srv.base + path, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, html: await res.text(), location: res.headers.get('location') };
}
async function form(path: string, fields: Record<string, string>) {
  const res = await fetch(srv.base + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: srv.base },
    body: new URLSearchParams(fields).toString(),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  return { status: res.status, html: await res.text(), location: res.headers.get('location') };
}
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

describe('trace back-office, end to end', () => {
  let installA = { id: '', token: '' };
  let installB = { id: '', token: '' };
  let reader = { id: '', token: '' };
  let cursor = '';

  before(async () => {
    db = await startPostgres();
    blobDir = mkdtempSync(join(tmpdir(), 'tbo-blobs-'));
    const hash = runCli(['hash-password'], {}, OWNER_PASSWORD).trim();
    env = { ...db.env, BACKOFFICE_DATA_DIR: blobDir, BACKOFFICE_OWNER_PASSWORD_HASH: hash, BACKOFFICE_RETENTION_SWEEP_MS: '0' };
    // A server whose schema is behind refuses to start.
    await assert.rejects(startServer(env), /schema/);
    note('start.schemaBehind', 'refused');
    // Migrations are reversible: up, down to nothing, up again.
    runCli(['migrate', 'up'], env);
    runCli(['migrate', 'down', '--all'], env);
    note('migrate.status.afterDown', runCli(['migrate', 'status'], env).trim());
    runCli(['migrate', 'up'], env);
    srv = await startServer(env);
  });

  after(async () => {
    const run = process.env.BACKOFFICE_E2E_RUN_DIR ?? join(ROOT, '.runs', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'asserted.json'), JSON.stringify(asserted, null, 2));
    writeFileSync(join(run, 'server.log'), srv?.log.join('') ?? '');
    writeFileSync(join(run, 'reproduce.txt'), `cd backoffice && BACKOFFICE_E2E_RUN_DIR=${run} npm run test:e2e\n`);
    await srv?.stop();
    db?.stop();
  });

  it('answers health once its schema is current', async () => {
    const r = await call('GET', '/healthz');
    assert.equal(note('health.status', r.status), 200);
  });

  it('registers two installs, each with a token shown once and kept only as a hash', async () => {
    const a = await call('POST', '/v1/installs', { body: { client: { name: 'tars', version: '2.0.7', platform: 'darwin' } } });
    assert.equal(a.status, 201);
    assert.match(a.json.token, /^tbi_[A-Za-z0-9_-]{43}$/);
    installA = { id: a.json.installId, token: a.json.token };
    const b = await call('POST', '/v1/installs', { body: { client: { name: 'tars', version: '2.0.7', platform: 'linux' } } });
    installB = { id: b.json.installId, token: b.json.token };
    const client = new pg.Client(db.env);
    await client.connect();
    const dump = JSON.stringify((await client.query('SELECT * FROM installs')).rows);
    await client.end();
    assert.ok(!dump.includes(installA.token.slice(4)) && !dump.includes(installB.token.slice(4)), 'a plain token is stored');
    note('register.tokenPlainInDb', false);
  });

  it('refuses every write without the right token', async () => {
    assert.equal((await call('PUT', '/v1/batches/b1', { body: { schema: 1 } })).status, 401);
    assert.equal((await call('PUT', '/v1/batches/b1', { token: 'tbi_' + 'x'.repeat(43), body: { schema: 1 } })).status, 401);
    assert.equal((await call('PUT', `/v1/blobs/${h.user}`, { raw: msgs.user })).status, 401);
    assert.equal((await call('DELETE', '/v1/installs/me')).status, 401);
    note('auth.writesWithoutToken', 401);
  });

  it('stores blobs once, checks each against its hash, and answers per install', async () => {
    const all = [...Object.values(h), toolsHash];
    const miss = await call('POST', '/v1/blobs/missing', { token: installA.token, body: { hashes: all } });
    assert.deepEqual(new Set(miss.json.missing), new Set(all));
    // zstd, gzip and plain bodies are all accepted
    for (const [k, v] of Object.entries(msgs)) {
      const enc = k === 'user' ? 'gzip' : k === 'call' ? undefined : 'zstd';
      const raw = enc === 'gzip' ? gzipSync(v) : enc === 'zstd' ? zstdCompressSync(v) : v;
      const r = await call('PUT', `/v1/blobs/${sha(v)}`, { token: installA.token, raw, encoding: enc });
      assert.equal(r.status, 201, `${k}: ${r.buf}`);
    }
    // The answer blob is held back: the batch will report it.
    const wrong = await call('PUT', `/v1/blobs/${toolsHash}`, { token: installA.token, raw: msgs.user });
    assert.equal(note('blob.hashMismatch', wrong.status), 422);
    assert.equal(wrong.json.error, 'hash_mismatch');
    const again = await call('PUT', `/v1/blobs/${h.user}`, { token: installA.token, raw: msgs.user });
    assert.deepEqual([again.status, again.json.stored], [200, false]);
    // B asks about content A sent: the answer says nothing about A.
    const missB = await call('POST', '/v1/blobs/missing', { token: installB.token, body: { hashes: [h.user] } });
    assert.deepEqual(note('blob.otherInstallSeesMissing', missB.json.missing), [h.user]);
  });

  it('applies a batch once, replays it, refuses a different body under the same id, and reports missing blobs', async () => {
    const body = { schema: 1, sessions: [session()], turns: [turn], requests, messages };
    const r = await call('PUT', '/v1/batches/batch-1', { token: installA.token, body, encoding: 'gzip' });
    assert.equal(r.status, 200, String(r.buf));
    assert.deepEqual(r.json.applied, { sessions: 1, turns: 1, requests: 2, messages: 5 });
    assert.deepEqual(note('batch.missingBlobs', r.json.missingBlobs), [toolsHash]);
    const replay = await call('PUT', '/v1/batches/batch-1', { token: installA.token, body, encoding: 'zstd' });
    assert.deepEqual([replay.status, replay.json.replayed], [200, true]);
    const conflict = await call('PUT', '/v1/batches/batch-1', { token: installA.token, body: { ...body, turns: [] } });
    assert.equal(note('batch.conflict', conflict.status), 409);
    const orphan = await call('PUT', '/v1/batches/batch-x', { token: installA.token, body: { schema: 1, turns: [{ ...turn, sessionId: 'nope' }] } });
    assert.deepEqual([orphan.status, orphan.json.error], [422, 'unknown_session']);
    const unknownField = await call('PUT', '/v1/batches/batch-y', { token: installA.token, body: { schema: 1, sessions: [{ ...session(), projectPath: '/Users/someone/secret' }] } });
    assert.deepEqual(note('batch.unknownField', [unknownField.status, unknownField.json.error]), [422, 'invalid_batch']);
    const t = await call('PUT', `/v1/blobs/${toolsHash}`, { token: installA.token, raw: zstdCompressSync(tools), encoding: 'zstd' });
    assert.equal(t.status, 201);
    const me = await call('GET', '/v1/installs/me', { token: installA.token });
    assert.deepEqual([me.json.usage.sessions, me.json.usage.requests, me.json.usage.blobs], [1, 2, 6]);
    note('install.me.usage', me.json.usage);
  });

  it('lets the owner in through the login only, and issues a reader token shown once', async () => {
    const outside = await page('/admin');
    assert.equal(note('admin.withoutLogin', outside.status), 303);
    const login = await page('/admin/login');
    const bad = await form('/admin/login', { password: 'wrong', csrf: csrfOf(login.html) });
    assert.equal(note('admin.badPassword', bad.status), 401);
    const ok = await form('/admin/login', { password: OWNER_PASSWORD, csrf: csrfOf(login.html) });
    assert.equal(ok.status, 303);
    const readers = await page('/admin/readers');
    assert.equal(readers.status, 200);
    const noCsrf = await form('/admin/readers', { name: 'lab reader' });
    assert.equal(note('admin.postWithoutCsrf', noCsrf.status), 403);
    const made = await form('/admin/readers', { name: 'lab reader', csrf: csrfOf(readers.html) });
    assert.equal(made.status, 200);
    const token = /<code id="new-token">(tbr_[A-Za-z0-9_-]{43})<\/code>/.exec(made.html)?.[1];
    assert.ok(token, 'the new token is shown');
    reader.token = token;
    reader.id = /data-reader="([0-9a-f-]{36})"/.exec(made.html)?.[1] ?? '';
    const list = await page('/admin/readers');
    assert.ok(list.html.includes('lab reader') && !list.html.includes(token), 'the token is shown once only');
  });

  it('serves readers by cursor, with filters, and keeps every token to its own prefix', async () => {
    assert.equal((await call('GET', '/v1/read/sessions', { token: installA.token })).status, 401);
    assert.equal((await call('PUT', '/v1/batches/z', { token: reader.token, body: { schema: 1 } })).status, 401);
    const first = await call('GET', '/v1/read/sessions', { token: reader.token });
    assert.equal(first.status, 200);
    assert.equal(first.json.sessions.length, 1);
    const s = first.json.sessions[0];
    assert.deepEqual([s.install, s.sessionId, s.agentId, s.harness, s.model, s.projectKey], [installA.id, 'sess-1', 'agent-1', 'codex', 'open-model-a', PROJECT]);
    cursor = first.json.nextCursor;
    const empty = await call('GET', `/v1/read/sessions?cursor=${cursor}`, { token: reader.token });
    assert.deepEqual(empty.json.sessions, []);
    assert.equal(empty.json.nextCursor, cursor);
    // The session grows: it comes back once.
    const grow = await call('PUT', '/v1/batches/batch-2', { token: installA.token, body: { schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000 })] } });
    assert.equal(grow.status, 200);
    const again = await call('GET', `/v1/read/sessions?cursor=${cursor}`, { token: reader.token });
    assert.deepEqual(again.json.sessions.map((x: any) => [x.sessionId, x.finalStatus]), [['sess-1', 'done']]);
    cursor = again.json.nextCursor;
    // Filters: each one that should miss, misses.
    for (const q of ['harness=pi', 'model=other', `install=${installB.id}`, `project=${'b'.repeat(64)}`, `from=${T0 + 1}`, `to=${T0}`, 'agent=agent-9']) {
      const r = await call('GET', `/v1/read/sessions?${q}`, { token: reader.token });
      assert.equal(r.json.sessions.length, 0, q);
    }
    for (const q of ['harness=codex', 'model=open-model-a', `install=${installA.id}`, `project=${PROJECT}`, `from=${T0}`, `to=${T0 + 1}`, 'agent=agent-1']) {
      const r = await call('GET', `/v1/read/sessions?${q}`, { token: reader.token });
      assert.equal(r.json.sessions.length, 1, q);
    }
    assert.equal((await call('GET', '/v1/read/sessions?cursor=%%%', { token: reader.token })).status, 400);
    note('read.filters', 'each filter misses and hits');
  });

  it('gives a reader the whole session and joins on an upstream request id', async () => {
    const d = await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token });
    assert.equal(d.status, 200);
    assert.deepEqual(d.json.requests.map((r: any) => [r.requestId, r.seq, r.upstreamRequestId, r.messages.length]), [['req-1', 0, 'up-111', 3], ['req-2', 1, 'up-222', 5]]);
    assert.equal(d.json.turns[0].author, 'orchestrator');
    assert.equal(d.json.messages.length, 5);
    const j = await call('GET', '/v1/read/requests?upstreamRequestId=up-222', { token: reader.token });
    assert.deepEqual(note('read.join', j.json.requests.map((r: any) => [r.install, r.sessionId, r.turnId, r.requestId])), [[installA.id, 'sess-1', 'turn-1', 'req-2']]);
    const blob = await call('GET', `/v1/read/blobs/${h.answer}`, { token: reader.token });
    assert.equal(blob.status, 200);
    assert.ok(blob.buf.equals(msgs.answer), 'the blob comes back byte for byte');
    const res = await fetch(`${srv.base}/v1/read/blobs/${h.result}`, { headers: { authorization: `Bearer ${reader.token}`, 'accept-encoding': 'zstd' } });
    assert.equal(note('read.blob.zstd', res.headers.get('content-encoding')), 'zstd');
  });

  it('holds each install to its quota and its rate', async () => {
    // The owner lowers the quota to what A already stores.
    const s = await page('/admin/settings');
    const r = await form('/admin/settings', { csrf: csrfOf(s.html), retentionDays: '90', registration: 'open', maxStoredMiB: '0', ratePerMinute: '120', burst: '60' });
    assert.equal(r.status, 303);
    const extra = Buffer.from('{"role":"user","content":"more"}');
    const q = await call('PUT', `/v1/blobs/${sha(extra)}`, { token: installA.token, raw: extra });
    assert.deepEqual(note('quota', [q.status, q.json.error]), [429, 'quota_exceeded']);
    const s2 = await page('/admin/settings');
    await form('/admin/settings', { csrf: csrfOf(s2.html), retentionDays: '90', registration: 'open', maxStoredMiB: '2048', ratePerMinute: '1', burst: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call('GET', '/v1/installs/me', { token: installB.token })).status);
    assert.ok(codes.includes(429), `codes ${codes}`);
    note('rate.codes', codes);
    const s3 = await page('/admin/settings');
    await form('/admin/settings', { csrf: csrfOf(s3.html), retentionDays: '90', registration: 'open', maxStoredMiB: '2048', ratePerMinute: '600', burst: '600' });
  });

  it('applies the retention the owner set, and tells readers what went', async () => {
    // B uploads an old session, and one that shares A's user message.
    await call('PUT', `/v1/blobs/${h.user}`, { token: installB.token, raw: msgs.user });
    const old = { ...session({ sessionId: 'old-1', startedAt: T0 - 200 * 86_400_000, endedAt: T0 - 199 * 86_400_000, finalStatus: 'done' }) };
    const b = await call('PUT', '/v1/batches/b-1', { token: installB.token, body: { schema: 1, sessions: [old, session({ sessionId: 'b-new' })], messages: [messages[1]] } });
    assert.equal(b.status, 200, String(b.buf));
    const s = await page('/admin/settings');
    await form('/admin/settings', { csrf: csrfOf(s.html), retentionDays: '30', registration: 'open', maxStoredMiB: '2048', ratePerMinute: '600', burst: '600' });
    const run = await form('/admin/retention/run', { csrf: csrfOf(s.html) });
    assert.equal(run.status, 303);
    const del = await call('GET', '/v1/read/deletions', { token: reader.token });
    assert.deepEqual(note('retention.deletions', del.json.deletions.map((d: any) => [d.install, d.sessionId, d.reason])), [[installB.id, 'old-1', 'retention']]);
    const gone = await call('GET', `/v1/read/sessions/${installB.id}/old-1`, { token: reader.token });
    assert.equal(gone.status, 404);
  });

  it('deletes everything an install sent in one call, says so, and keeps what another install still holds', async () => {
    const blobsBefore = filesUnder(blobDir).length;
    const d = await call('DELETE', '/v1/installs/me', { token: installA.token });
    assert.equal(d.status, 200);
    assert.deepEqual(note('delete.counts', [d.json.deleted.sessions, d.json.deleted.turns, d.json.deleted.requests, d.json.deleted.blobs]), [1, 1, 2, 6]);
    assert.match(d.json.receipt, /^del_/);
    assert.equal((await call('GET', '/v1/installs/me', { token: installA.token })).status, 401);
    // A's own blobs are gone from disk; the user message B also sent is still there.
    assert.equal((await call('GET', `/v1/read/blobs/${h.answer}`, { token: reader.token })).status, 404);
    assert.equal((await call('GET', `/v1/read/blobs/${h.user}`, { token: reader.token })).status, 200);
    note('delete.blobFiles', [blobsBefore, filesUnder(blobDir).length]);
    assert.equal(filesUnder(blobDir).length, blobsBefore - 5);
    const dels = await call('GET', '/v1/read/deletions', { token: reader.token });
    assert.ok(dels.json.deletions.some((x: any) => x.install === installA.id && x.sessionId === null && x.reason === 'install_deleted'));
    const log = await page('/admin/deletions');
    assert.ok(log.html.includes(d.json.receipt), 'the receipt is in the owner\'s deletion log');
    const left = await call('GET', '/v1/read/sessions', { token: reader.token });
    assert.deepEqual(left.json.sessions.map((x: any) => x.sessionId), ['b-new']);
  });

  it('revokes a reader token at once, and shows installs and volumes to the owner', async () => {
    const installs = await page('/admin/installs');
    assert.ok(installs.html.includes(installB.id) && !installs.html.includes(installA.id));
    const overview = await page('/admin');
    assert.equal(overview.status, 200);
    const readers = await page('/admin/readers');
    const rv = await form(`/admin/readers/${reader.id}/revoke`, { csrf: csrfOf(readers.html) });
    assert.equal(rv.status, 303);
    assert.equal(note('reader.afterRevoke', (await call('GET', '/v1/read/sessions', { token: reader.token })).status), 401);
    await form('/admin/logout', { csrf: csrfOf(readers.html) });
    assert.equal((await page('/admin/installs')).status, 303);
    assert.ok(existsSync(blobDir));
  });
});
