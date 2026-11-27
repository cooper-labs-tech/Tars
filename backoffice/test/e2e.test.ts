// E2E: the real server against a real Postgres, in a throwaway setup, driven over HTTP only
// (and the CLI an operator runs). Each step names what a user of the back-office relies on.
//
// Run: npm run test:e2e   (PG_BIN=<folder of initdb> when initdb is not found by itself)
// Artefact: .runs/<time>/ holds asserted.json (every value checked), server.log and reproduce.txt.
//
// A request's side mark (the owner's decision of 26/11): the ways it can fail, written before the code.
// S1. A request sent with `side` is refused as an unknown field, so a Tars that marks its side
//     requests cannot upload at all.
// S2. `side: true` or `false` is not stored, or not returned by a read route that returns requests
//     (the session detail, the join by upstream request id).
// S3. A request sent without `side` (a Tars before the mark) reads back as `false`. A side request
//     would then pass as a main one, unseen. It must read back as `null`: unknown, which readers
//     treat as side (fail closed).
// S4. `side` is left out of a read instead of `null`, so a reader cannot tell unknown from a
//     server before the field.
// S5. A request sent again without `side` erases the mark it had.
//
// Migration 002 over a database that already holds requests (QA, written before the step): the
// suite's own migrations above run on an empty database, where neither of these can show.
// M1. Its up gives the requests from before it a mark: `false` would pass a side request off as a
//     main one. They must read back `null`, every other value as it was.
// M2. Its down loses a request, or a value of one, along with the marks it is meant to drop.
//
// One session deleted on its install's word (DELETE /v1/sessions/{sessionId}, 27/11: a session Tars sent and then
// deleted, by its user or by its own retention, is deleted here too). The ways it can fail, written before the code:
// D1. The session stays readable, or its turns, its requests, or a blob only it used stay.
// D2. A blob another session still uses goes with it: one of the same install, or one another install sent too.
// D3. Readers are not told: no tombstone, one without the session's id, or one under a reason they do not know.
// D4. Asked again (a retry after a lost answer), it fails, or tells readers twice.
// D5. An install deletes a session of another install that has the same id, or an id it never sent answers anything
//     but 200 with nothing deleted, which would tell it what others hold.
// D6. Without the install's token (none, a reader's) something is deleted.
// D7. The operator's deletion log has no receipt for it, or the install's stored bytes still count what went.
//
// A session's environment and power events, a request's live count (27/11, the first trace wave): the ways it
// can fail, written before the code.
// E1. A session sent with `environment` or `events`, or a request with `liveSessions`, is refused as an unknown field,
//     so every upload of a Tars that sends them fails.
// E2. They are not stored, or not read back: the session on the list (§ 6.1) and in the detail (§ 6.2), the request
//     in the detail and on the join (§ 6.5), each with the shape it was sent in.
// E3. A session or request sent without them (an older Tars) reads back other than `null`, or without the key.
// E4. Sent again without them, a session or request loses the ones it had.
// E5. A malformed one is taken: an environment key it does not know (a serial number), a wrong type, a kind of
//     event it does not know, a negative count. The batch must be refused whole (422), and nothing of it stored.
// E6. A deleted session leaves its environment, its events or its requests' counts in any table.
// E7. The environment reaches the operator's deletion log, or the server's own log.
// E8. Migration 003 over a database that holds them: its down loses a row or a value other than the three new
//     ones, or its up gives the rows from before it a value other than `null`.
//
// What started a session, the demand it never served, and a request's cancel (27/11, the second trace wave): the
// ways it can fail, written before the code.
// L1. A session sent with `start` or `lostDemand`, a turn with `taskRef`, or a request with `cancel`, is refused as an unknown field.
// L2. They are not stored, or not read back with the shape they were sent in: the session on the list and in the
//     detail, the request in the detail and on the join.
// L3. Sent without them (an older Tars), they read back other than `null`, or without the key.
// L4. Sent again without them, a session or request loses them.
// L5. A malformed one is taken (a key not in the shape, a name where a word belongs, a negative time); the batch
//     must be refused whole.
// L6. A deleted session leaves them in any table; migration 004's down loses anything else, its up reads them null.
//
// How a session was masked, and what was done to each turn (27/11, the third trace wave): the ways it can fail,
// written before the code.
// K1. A session sent with `maskingVersion` or `maskCounts`, or a turn with `interventions`, is refused as unknown.
// K2. They are not stored, or not read back with their shape: the session on the list and in the detail, the turn
//     in the detail.
// K3. Sent without them (an older Tars), they read back other than `null`, or without the key.
// K4. Sent again without them, a session or turn loses them.
// K5. A malformed one is taken (a seventh count, a missing one, a name where a kind belongs, `during` outside its
//     two); the batch must be refused whole.
// K6. A deleted session leaves them in any table; migration 005's down loses anything else, its up reads them null.
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
// A session's environment as Tars reads it (exact values), and its power events.
const ENV = {
  osName: 'macOS', osVersion: '15.6.1', kernel: '24.6.0', arch: 'arm64', machineModel: 'Mac15,3', chip: 'Chip-E2E-7731', cpuCores: 8,
  ramBytes: 17179869184, tarsVersion: '2.0.7', tarsArch: 'arm64', locale: 'de-DE', timeZone: 'Europe/Berlin', utcOffsetMinutes: 60, onBattery: false,
};
const EVENTS = [{ at: T0 + 1000, kind: 'sleep' }, { at: T0 + 2000, kind: 'wake' }];
// What started a session, the tasks it lost, and a request cut while held.
const START = {
  trigger: 'task', via: 'api', taskRef: 't-0e2e0001', taskId: 'task-e2e-1', requesterAgentId: 'agent-0', queuedAt: T0 - 5000, handedAt: T0 - 4000,
  firstRequestAt: T0, commit: '0123456789abcdef0123456789abcdef01234567', branch: 'feat/e2e', redelegatedFrom: 'tr_before',
};
const LOST = [{ kind: 'queue_drop', ref: 't-0e2e0002', queuedAt: T0 - 3000, at: T0 + 500, reason: 'cancelled' }];
const CANCEL = { by: 'harness', cause: 'abandoned_while_held', at: T0 + 3000, deliveredBytes: 0 };
// How a session was masked, and what was done to a turn.
const MASK = { maskingVersion: 'tars-scrub-2', maskCounts: { SECRET: 2, EMAIL: 1, IP: 0, PERSON: 3, HOME: 4, PHONE: 0 } };
const INTERVENTIONS = {
  interrupted: { at: T0 + 2500, by: 'esc', during: 'answer' }, restarted: { at: T0 + 2600, by: 'restart' }, next: { by: 'user', delaySec: 12.5 },
  corrected: true, redelegated: { to: 'tr_later', at: T0 + 9000 },
};

function session(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1', agentId: 'agent-1', projectKey: PROJECT, harness: 'codex', harnessVersion: '0.163.0',
    endpointKey: 'e'.repeat(16), endpointName: 'Lab', model: 'open-model-a', startedAt: T0, finalStatus: 'open',
    turnCount: 1, requestCount: 2, tokensIn: 300, tokensCached: 100, tokensOut: 40, mixed: false, unknownTurns: 0, ...over,
  };
}
const turn = { turnId: 'turn-1', sessionId: 'sess-1', index: 0, startedAt: T0, endedAt: T0 + 5000, requestCount: 2, toolCallCount: 1, toolErrorCount: 0,
  toolMs: 900, modelMs: 3100, tokensIn: 300, tokensCached: 100, tokensOut: 40, finalStatus: 'done', finalFinishReason: 'stop', author: 'orchestrator', authorDetail: 'agent-0' };
const requests = [
  { requestId: 'req-1', sessionId: 'sess-1', turnId: 'turn-1', seq: 0, upstreamRequestId: 'up-111', surface: 'openai_chat', modelRequested: 'open-model-a',
    modelServed: 'open-model-a', params: { temperature: 0.2 }, toolsHash, startedAt: T0, ttftMs: 200, totalMs: 1500, tokensIn: 120, tokensCached: 0,
    tokensOut: 20, status: 200, finishReason: 'tool_calls', streamed: true, side: false, reqBytes: 900, respBytes: 300,
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
  const reader = { id: '', token: '' };
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

  it('keeps registration closed until the owner, signed in, opens it', async () => {
    // A fresh deploy takes no anonymous install (the Audit's M1 on #597).
    const closed = await call('POST', '/v1/installs', { body: { client: { name: 'tars' } } });
    assert.deepEqual(note('register.byDefault', [closed.status, closed.json.error]), [403, 'registration_closed']);
    const outside = await page('/admin');
    assert.equal(note('admin.withoutLogin', outside.status), 303);
    const login = await page('/admin/login');
    const bad = await form('/admin/login', { password: 'wrong', csrf: csrfOf(login.html) });
    assert.equal(note('admin.badPassword', bad.status), 401);
    const ok = await form('/admin/login', { password: OWNER_PASSWORD, csrf: csrfOf(login.html) });
    assert.equal(ok.status, 303);
    const s = await page('/admin/settings');
    assert.equal(s.status, 200);
    assert.match(s.html, /<option value="closed" selected>/);
    const noCsrf = await form('/admin/settings', { registration: 'open' });
    assert.equal(note('admin.postWithoutCsrf', noCsrf.status), 403);
    const open = await form('/admin/settings', { csrf: csrfOf(s.html), registration: 'open' });
    assert.equal(open.status, 303);
  });

  it('registers two installs, each with a token shown once and kept only as a hash', async () => {
    const a = await call('POST', '/v1/installs', { body: { client: { name: 'tars', version: '2.0.7', platform: 'darwin' } } });
    assert.equal(a.status, 201);
    assert.match(a.json.token, /^tbi_[A-Za-z0-9_-]{43}$/);
    installA = { id: a.json.installId, token: a.json.token };
    const b = await call('POST', '/v1/installs', { body: { client: { name: 'tars', version: '2.0.7', platform: 'linux' } } });
    installB = { id: b.json.installId, token: b.json.token };
    const client = new pg.Client({ host: db.env.PGHOST, port: Number(db.env.PGPORT), user: db.env.PGUSER, database: db.env.PGDATABASE });
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
    // An agent's name is free text a person typed: not taken (the Audit's I1 on #597).
    const named = await call('PUT', '/v1/batches/batch-z', { token: installA.token, body: { schema: 1, sessions: [{ ...session(), agentName: 'Someone' }] } });
    assert.deepEqual(note('batch.agentNameRefused', [named.status, named.json.error]), [422, 'invalid_batch']);
    const t = await call('PUT', `/v1/blobs/${toolsHash}`, { token: installA.token, raw: zstdCompressSync(tools), encoding: 'zstd' });
    assert.equal(t.status, 201);
    const me = await call('GET', '/v1/installs/me', { token: installA.token });
    assert.deepEqual([me.json.usage.sessions, me.json.usage.requests, me.json.usage.blobs], [1, 2, 6]);
    note('install.me.usage', me.json.usage);
  });

  it('issues a reader token, shown once, to the signed-in owner', async () => {
    const readers = await page('/admin/readers');
    assert.equal(readers.status, 200);
    const noCsrf = await form('/admin/readers', { name: 'lab reader' });
    assert.equal(note('admin.readerPostWithoutCsrf', noCsrf.status), 403);
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
    // S2, S3, S4: req-1 was sent with side: false, req-2 without it.
    assert.deepEqual(note('side.asSent', d.json.requests.map((r: any) => [r.requestId, 'side' in r, r.side])), [['req-1', true, false], ['req-2', true, null]]);
    assert.deepEqual(j.json.requests.map((r: any) => ['side' in r, r.side]), [[true, null]]);
    // S1, S2: a side request (a title request with no tools) is taken and read back as one.
    const title = { requestId: 'req-t', sessionId: 'sess-1', turnId: 'turn-1', seq: 2, upstreamRequestId: 'up-333', surface: 'openai_chat', startedAt: T0 + 4100,
      side: true, messages: [{ position: 0, hash: h.user, direction: 'input' }] };
    const marked = await call('PUT', '/v1/batches/batch-side', { token: installA.token, body: { schema: 1, requests: [title, { ...requests[1], side: true }] } });
    assert.equal(marked.status, 200, String(marked.buf));
    // S5: req-2 sent again without the mark keeps it.
    const resent = await call('PUT', '/v1/batches/batch-side-2', { token: installA.token, body: { schema: 1, requests: [requests[1]] } });
    assert.equal(resent.status, 200, String(resent.buf));
    const d2 = await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token });
    assert.deepEqual(note('side.afterMarks', d2.json.requests.map((r: any) => [r.requestId, r.side])), [['req-1', false], ['req-2', true], ['req-t', true]]);
    const jt = await call('GET', '/v1/read/requests?upstreamRequestId=up-333', { token: reader.token });
    assert.deepEqual(jt.json.requests.map((r: any) => [r.requestId, r.side]), [['req-t', true]]);
    const blob = await call('GET', `/v1/read/blobs/${h.answer}`, { token: reader.token });
    assert.equal(blob.status, 200);
    assert.ok(blob.buf.equals(msgs.answer), 'the blob comes back byte for byte');
    const res = await fetch(`${srv.base}/v1/read/blobs/${h.result}`, { headers: { authorization: `Bearer ${reader.token}`, 'accept-encoding': 'zstd' } });
    assert.equal(note('read.blob.zstd', res.headers.get('content-encoding')), 'zstd');
  });

  it('takes a session\'s environment and power events and a request\'s live count, reads them back, and refuses them malformed', async () => {
    const detail = async () => (await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token })).json;
    // E3. Sent without them: null, never absent.
    const before = await detail();
    assert.deepEqual(note('env.before', [before.session.environment, before.session.events, before.requests.map((r: any) => ['liveSessions' in r, r.liveSessions])]),
      [null, null, [[true, null], [true, null], [true, null]]]);
    assert.ok('environment' in before.session && 'events' in before.session);
    // E1, E2. Sent with them.
    const sent = await call('PUT', '/v1/batches/batch-env', { token: installA.token, body: {
      schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000, environment: ENV, events: EVENTS, nativeSessionId: 'native-1' })],
      requests: [{ ...requests[0], liveSessions: 3 }],
    } });
    assert.equal(sent.status, 200, String(sent.buf));
    const after = await detail();
    assert.deepEqual(after.session.environment, ENV);
    assert.deepEqual(after.session.events, EVENTS);
    assert.equal(after.session.nativeSessionId, 'native-1');
    assert.deepEqual(note('env.liveSessions', after.requests.map((r: any) => [r.requestId, r.liveSessions])), [['req-1', 3], ['req-2', null], ['req-t', null]]);
    const listed = (await call('GET', '/v1/read/sessions?agent=agent-1', { token: reader.token })).json.sessions;
    assert.deepEqual(note('env.list', listed.map((s: any) => [s.sessionId, s.environment?.chip, s.events?.length])), [['sess-1', ENV.chip, EVENTS.length]]);
    assert.deepEqual(listed[0].environment, ENV);
    const joined = (await call('GET', '/v1/read/requests?upstreamRequestId=up-111', { token: reader.token })).json.requests;
    assert.deepEqual(joined.map((r: any) => r.liveSessions), [3]);
    // E4. Sent again without them: kept.
    const older = await call('PUT', '/v1/batches/batch-env-older', { token: installA.token, body: {
      schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000 })], requests: [requests[0]],
    } });
    assert.equal(older.status, 200, String(older.buf));
    const kept = await detail();
    assert.deepEqual(note('env.keptAfterOlder', [kept.session.environment?.chip, kept.session.events?.length, kept.requests[0].liveSessions]), [ENV.chip, EVENTS.length, 3]);
    // E5. Malformed: refused whole, nothing of it stored.
    const bad: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['serial', { environment: { ...ENV, serialNumber: 'C02-NOT-SENT' } }, {}],
      ['coresAsText', { environment: { ...ENV, cpuCores: '8' } }, {}],
      ['eventKind', { events: [{ at: T0, kind: 'reboot' }] }, {}],
      ['negativeLive', {}, { liveSessions: -1 }],
    ];
    const codes: Array<[string, number, string]> = [];
    for (const [name, s, r] of bad) {
      const put = await call('PUT', `/v1/batches/batch-bad-${name}`, { token: installA.token, body: {
        schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000, environment: { ...ENV, chip: 'Never stored' }, ...s })],
        requests: [{ ...requests[0], liveSessions: 99, ...r }],
      } });
      codes.push([name, put.status, put.json.error]);
    }
    assert.deepEqual(note('env.malformed', codes), bad.map(([n]) => [n, 422, 'invalid_batch']));
    const still = await detail();
    assert.deepEqual([still.session.environment?.chip, still.requests[0].liveSessions], [ENV.chip, 3]);
  });

  it('takes what started a session, the demand it lost and a request\'s cancel, reads them back, and refuses them malformed', async () => {
    const detail = async () => (await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token })).json;
    // L3. Sent without them: null, never absent.
    const before = await detail();
    assert.deepEqual(note('start.before', [('start' in before.session), before.session.start, ('lostDemand' in before.session), before.session.lostDemand,
      before.requests.map((r: any) => ['cancel' in r, r.cancel]), before.turns.map((t: any) => ['taskRef' in t, t.taskRef])]),
      [true, null, true, null, [[true, null], [true, null], [true, null]], [[true, null]]]);
    // L1, L2. Sent with them, and the turn's task.
    const sent = await call('PUT', '/v1/batches/batch-start', { token: installA.token, body: {
      schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000, start: START, lostDemand: LOST })],
      turns: [{ ...turn, taskRef: START.taskRef }], requests: [{ ...requests[1], cancel: CANCEL }],
    } });
    assert.equal(sent.status, 200, String(sent.buf));
    const after = await detail();
    assert.deepEqual(after.session.start, START);
    assert.deepEqual(after.session.lostDemand, LOST);
    assert.deepEqual(note('start.turnTaskRef', after.turns.map((t: any) => t.taskRef)), [START.taskRef]);
    assert.deepEqual(note('start.cancels', after.requests.map((r: any) => [r.requestId, r.cancel])), [['req-1', null], ['req-2', CANCEL], ['req-t', null]]);
    const listed = (await call('GET', '/v1/read/sessions?agent=agent-1', { token: reader.token })).json.sessions;
    assert.deepEqual(note('start.list', listed.map((s: any) => [s.sessionId, s.start?.trigger, s.lostDemand?.length])), [['sess-1', 'task', 1]]);
    const joined = (await call('GET', '/v1/read/requests?upstreamRequestId=up-222', { token: reader.token })).json.requests;
    assert.deepEqual(joined.map((r: any) => r.cancel), [CANCEL]);
    // L4. Sent again without them: kept.
    const older = await call('PUT', '/v1/batches/batch-start-older', { token: installA.token, body: {
      schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000 })], turns: [turn], requests: [requests[1]],
    } });
    assert.equal(older.status, 200, String(older.buf));
    const kept = await detail();
    assert.deepEqual(note('start.keptAfterOlder', [kept.session.start?.taskRef, kept.session.lostDemand?.length, kept.requests[1].cancel?.cause, kept.turns[0].taskRef]),
      [START.taskRef, 1, CANCEL.cause, START.taskRef]);
    // L5. Malformed: refused whole.
    const bad: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['startKey', { start: { ...START, requester: 'Someone' } }, {}],
      ['triggerName', { start: { ...START, trigger: 'Some Person' } }, {}],
      ['triggerOutsideList', { start: { ...START, trigger: 'reboot' } }, {}],
      ['causeOfAnother', {}, { cancel: { ...CANCEL, by: 'tars', cause: 'esc' } }],
      ['lostKind', { lostDemand: [{ ...LOST[0], kind: 'crash' }] }, {}],
      ['cancelTime', {}, { cancel: { ...CANCEL, at: -1 } }],
    ];
    const codes: Array<[string, number, string]> = [];
    for (const [name, s, r] of bad) {
      const put = await call('PUT', `/v1/batches/batch-bad-start-${name}`, { token: installA.token, body: {
        schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000, start: { trigger: 'owner' }, ...s })], requests: [{ ...requests[1], ...r }],
      } });
      codes.push([name, put.status, put.json.error]);
    }
    assert.deepEqual(note('start.malformed', codes), bad.map(([n]) => [n, 422, 'invalid_batch']));
    const still = await detail();
    assert.deepEqual([still.session.start?.trigger, still.requests[1].cancel?.at], [START.trigger, CANCEL.at]);
  });

  it('takes how a session was masked and what was done to each turn, reads them back, and refuses them malformed', async () => {
    const detail = async () => (await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token })).json;
    // K3. Sent without them: null, never absent.
    const before = await detail();
    assert.deepEqual(note('mask.before', [('maskingVersion' in before.session), before.session.maskingVersion, ('maskCounts' in before.session),
      before.session.maskCounts, before.turns.map((t: any) => ['interventions' in t, t.interventions])]), [true, null, true, null, [[true, null]]]);
    // K1, K2. Sent with them.
    const sent = await call('PUT', '/v1/batches/batch-mask', { token: installA.token, body: {
      schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000, ...MASK })], turns: [{ ...turn, interventions: INTERVENTIONS }],
    } });
    assert.equal(sent.status, 200, String(sent.buf));
    const after = await detail();
    assert.deepEqual([after.session.maskingVersion, after.session.maskCounts], [MASK.maskingVersion, MASK.maskCounts]);
    assert.deepEqual(note('mask.interventions', after.turns[0].interventions), INTERVENTIONS);
    const listed = (await call('GET', '/v1/read/sessions?agent=agent-1', { token: reader.token })).json.sessions;
    assert.deepEqual(note('mask.list', listed.map((s: any) => [s.sessionId, s.maskingVersion, s.maskCounts?.PERSON])), [['sess-1', MASK.maskingVersion, 3]]);
    // K4. Sent again without them: kept.
    const older = await call('PUT', '/v1/batches/batch-mask-older', { token: installA.token, body: {
      schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000 })], turns: [turn],
    } });
    assert.equal(older.status, 200, String(older.buf));
    const kept = await detail();
    assert.deepEqual(note('mask.keptAfterOlder', [kept.session.maskingVersion, kept.session.maskCounts?.HOME, kept.turns[0].interventions?.next?.delaySec]),
      [MASK.maskingVersion, 4, 12.5]);
    // K5. Malformed: refused whole.
    const five: Record<string, number> = { ...MASK.maskCounts };
    delete five.PHONE;
    const bad: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['seventhCount', { maskCounts: { ...MASK.maskCounts, NAME: 1 } }, {}],
      ['missingCount', { maskCounts: five }, {}],
      ['duringOutside', {}, { interventions: { interrupted: { ...INTERVENTIONS.interrupted, during: 'thinking' } } }],
      ['nameAsKind', {}, { interventions: { next: { by: 'Some Person', delaySec: 1 } } }],
    ];
    const codes: Array<[string, number, string]> = [];
    for (const [name, s, t] of bad) {
      const put = await call('PUT', `/v1/batches/batch-bad-mask-${name}`, { token: installA.token, body: {
        schema: 1, sessions: [session({ finalStatus: 'done', endedAt: T0 + 6000, maskingVersion: 'never-stored', ...s })], turns: [{ ...turn, ...t }],
      } });
      codes.push([name, put.status, put.json.error]);
    }
    assert.deepEqual(note('mask.malformed', codes), bad.map(([n]) => [n, 422, 'invalid_batch']));
    const still = await detail();
    assert.deepEqual([still.session.maskingVersion, still.turns[0].interventions?.interrupted?.by], [MASK.maskingVersion, 'esc']);
  });

  it('migrates a database that holds requests: down keeps every row but the marks, up reads them back unknown', async () => {
    // M1, M2. The server stopped, as an operator migrates; what it logged so far is kept for the artefact.
    const earlier = srv.log.slice();
    await srv.stop();
    const client = new pg.Client({ host: db.env.PGHOST, port: Number(db.env.PGPORT), user: db.env.PGUSER, database: db.env.PGDATABASE });
    await client.connect();
    try {
      // Every table's rows, compared without the columns 002 and 003 add: a count and a digest per table.
      const rows = async () => {
        const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.tablename as string);
        const out: Record<string, string> = {};
        for (const t of tables) {
          const r = (await client.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS d FROM (SELECT (to_jsonb(t) - 'side' - 'environment' - 'events' - 'live_sessions' - 'start' - 'lost_demand' - 'cancel' - 'task_ref' - 'masking_version' - 'mask_counts' - 'interventions')::text AS x FROM "${t}" t) s`)).rows[0];
          out[t] = `${r.n}:${r.d}`;
        }
        return out;
      };
      const marks = async () => (await client.query('SELECT request_id, side FROM requests ORDER BY request_id')).rows.map((r) => [r.request_id, r.side]);
      const waveOne = async () => [
        (await client.query("SELECT session_id, environment->>'chip' AS chip, jsonb_array_length(events) AS n FROM sessions WHERE environment IS NOT NULL OR events IS NOT NULL ORDER BY 1")).rows.map((r) => [r.session_id, r.chip, r.n]),
        (await client.query('SELECT request_id, live_sessions FROM requests WHERE live_sessions IS NOT NULL ORDER BY 1')).rows.map((r) => [r.request_id, r.live_sessions]),
      ];
      const before = note('migrate.withData.before', await rows());
      assert.deepEqual(note('migrate.withData.marksBefore', await marks()), [['req-1', false], ['req-2', true], ['req-t', true]]);
      assert.deepEqual(note('migrate.withData.waveOneBefore', await waveOne()), [[['sess-1', ENV.chip, EVENTS.length]], [['req-1', 3]]]);
      const waveTwo = async () => [
        (await client.query("SELECT session_id, start->>'trigger' AS t, jsonb_array_length(lost_demand) AS n FROM sessions WHERE start IS NOT NULL OR lost_demand IS NOT NULL ORDER BY 1")).rows.map((r) => [r.session_id, r.t, r.n]),
        (await client.query("SELECT request_id, cancel->>'cause' AS c FROM requests WHERE cancel IS NOT NULL ORDER BY 1")).rows.map((r) => [r.request_id, r.c]),
      ];
      assert.deepEqual(note('migrate.withData.waveTwoBefore', await waveTwo()), [[['sess-1', 'task', 1]], [['req-2', CANCEL.cause]]]);
      const waveThree = async () => [
        (await client.query('SELECT session_id, masking_version, mask_counts->>\'PERSON\' AS p FROM sessions WHERE masking_version IS NOT NULL OR mask_counts IS NOT NULL ORDER BY 1')).rows.map((r) => [r.session_id, r.masking_version, r.p]),
        (await client.query("SELECT turn_id, interventions->'interrupted'->>'by' AS b FROM turns WHERE interventions IS NOT NULL ORDER BY 1")).rows.map((r) => [r.turn_id, r.b]),
      ];
      assert.deepEqual(note('migrate.withData.waveThreeBefore', await waveThree()), [[['sess-1', MASK.maskingVersion, '3']], [['turn-1', 'esc']]]);
      // K6, L6, E8, M2. Down through 005, 004, 003, then 002.
      note('migrate.withData.down005', runCli(['migrate', 'down'], env).trim());
      assert.deepEqual(note('migrate.withData.afterDown005', await rows()), before, 'the down of 005 kept every row and value but its own');
      note('migrate.withData.down004', runCli(['migrate', 'down'], env).trim());
      assert.deepEqual(note('migrate.withData.afterDown004', await rows()), before, 'the down of 004 kept every row and value but its own');
      note('migrate.withData.down003', runCli(['migrate', 'down'], env).trim());
      assert.deepEqual(note('migrate.withData.afterDown003', await rows()), before, 'the down of 003 kept every row and value but its own');
      note('migrate.withData.down002', runCli(['migrate', 'down'], env).trim());
      assert.deepEqual(note('migrate.withData.afterDown', await rows()), before, 'the down of 002 kept every request and value but the marks');
      note('migrate.withData.up', runCli(['migrate', 'up'], env).trim());
      assert.deepEqual(await rows(), before, 'the up kept every request and value');
      assert.deepEqual(note('migrate.withData.marksAfterUp', await marks()), [['req-1', null], ['req-2', null], ['req-t', null]]);
      assert.deepEqual(note('migrate.withData.waveOneAfterUp', await waveOne()), [[], []]);
      assert.deepEqual(note('migrate.withData.waveTwoAfterUp', await waveTwo()), [[], []]);
      assert.deepEqual(note('migrate.withData.waveThreeAfterUp', await waveThree()), [[], []]);
    } finally {
      // Up again and serving whatever this step found, so a failure here is this step's alone.
      runCli(['migrate', 'up'], env);
      await client.end();
      srv = await startServer(env);
      srv.log.unshift(...earlier, '--- restarted after the migration step ---\n');
    }
    const d = await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token });
    assert.deepEqual(note('migrate.withData.read', d.json.requests.map((r: any) => [r.requestId, 'side' in r, r.side])), [['req-1', true, null], ['req-2', true, null], ['req-t', true, null]]);
    // An older Tars sends req-2 again, without the mark: still unknown.
    const older = await call('PUT', '/v1/batches/batch-older', { token: installA.token, body: { schema: 1, requests: [requests[1]] } });
    assert.equal(older.status, 200, String(older.buf));
    const d2 = await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token });
    assert.deepEqual(d2.json.requests.map((r: any) => [r.requestId, r.side]), [['req-1', null], ['req-2', null], ['req-t', null]]);
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

  it('refuses every write under the free-disk floor, says why, and keeps reading', async () => {
    // The floor is set above what the disk has free (1 TiB), as a disk filled to its floor would be.
    const s = await page('/admin/settings');
    assert.match(s.html, /name="minFreeMiB"/);
    await form('/admin/settings', { csrf: csrfOf(s.html), minFreeMiB: String(1024 * 1024) });
    const extra = Buffer.from('{"role":"user","content":"floor"}');
    const blob = await call('PUT', `/v1/blobs/${sha(extra)}`, { token: installB.token, raw: extra });
    const batch = await call('PUT', '/v1/batches/floor-1', { token: installB.token, body: { schema: 1 } });
    const reg = await call('POST', '/v1/installs', { body: { client: { name: 'tars' } } });
    const codes = note('floor.writes', [blob.status, blob.json.error, batch.status, batch.json.error, reg.status, reg.json.error]);
    assert.deepEqual(codes, [507, 'disk_full', 507, 'disk_full', 507, 'disk_full']);
    assert.ok(Number(blob.headers.get('retry-after')) > 0, 'a Retry-After tells the uploader when to try again');
    assert.equal((await call('GET', '/v1/read/sessions', { token: reader.token })).status, 200);
    const s2 = await page('/admin/settings');
    await form('/admin/settings', { csrf: csrfOf(s2.html), minFreeMiB: '1' });
    assert.equal((await call('PUT', `/v1/blobs/${sha(extra)}`, { token: installB.token, raw: extra })).status, 201);
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

  it('deletes one session on its install\'s word, with what only it used, tells readers once, and nothing of anyone else\'s', async () => {
    // B sends two sessions: b-del names a blob only it uses, one it shares with b-del2, and A's system prompt.
    const only = Buffer.from(JSON.stringify({ role: 'assistant', content: 'Only b-del said this.' }));
    const twice = Buffer.from(JSON.stringify({ role: 'user', content: 'b-del and b-del2 both asked this.' }));
    for (const [hash, raw] of [[sha(only), only], [sha(twice), twice], [h.system, msgs.system]] as const) {
      assert.ok([200, 201].includes((await call('PUT', `/v1/blobs/${hash}`, { token: installB.token, raw })).status));
    }
    const req = (sessionId: string, refs: string[]) => ({
      requestId: `${sessionId}-r`, sessionId, turnId: `${sessionId}-t`, seq: 0, surface: 'openai_chat', startedAt: T0, totalMs: 100,
      tokensIn: 1, tokensCached: 0, tokensOut: 1, status: 200, finishReason: 'stop', streamed: false, side: false,
      messages: refs.map((hash, position) => ({ position, hash, direction: position === refs.length - 1 ? 'output' : 'input' })),
    });
    const meta = (hash: string, raw: Buffer, role: string) => ({ hash, role, createdAt: T0, size: raw.length });
    for (const [id, refs] of [['b-del', [h.system, sha(twice), sha(only)]], ['b-del2', [sha(twice)]]] as const) {
      const put = await call('PUT', `/v1/batches/${id}.1`, { token: installB.token, body: {
        schema: 1, sessions: [session({ sessionId: id, finalStatus: 'done', endedAt: T0 + 10_000, turnCount: 1, requestCount: 1, environment: { ...ENV, chip: `Chip-${id}-7731` }, events: EVENTS,
          start: { ...START, branch: `Chip-${id}-7731-branch` }, lostDemand: LOST, ...MASK, maskingVersion: `Chip-${id}-7731` })],
        turns: [{ ...turn, turnId: `${id}-t`, sessionId: id, interventions: { redelegated: { to: `Chip-${id}-7731-to`, at: T0 } } }], requests: [{ ...req(id, [...refs]), liveSessions: 5, cancel: CANCEL }],
        messages: [meta(h.system, msgs.system, 'system'), meta(sha(twice), twice, 'user'), meta(sha(only), only, 'assistant')].filter((m) => (refs as readonly string[]).includes(m.hash)),
      } });
      assert.equal(put.status, 200, String(put.buf));
    }
    const storedBefore = (await call('GET', '/v1/installs/me', { token: installB.token })).json.usage.storedBytes;
    const tombstones = async () => (await call('GET', '/v1/read/deletions', { token: reader.token })).json.deletions
      .filter((x: any) => x.sessionId === 'b-del' || x.sessionId === 'sess-1').map((x: any) => [x.install, x.sessionId, x.reason]);

    // D6. No token, a reader's: nothing.
    note('sessionDelete.noToken', (await call('DELETE', '/v1/sessions/b-del')).status);
    note('sessionDelete.readerToken', (await call('DELETE', '/v1/sessions/b-del', { token: reader.token })).status);
    assert.equal(asserted['sessionDelete.noToken'], 401);
    assert.equal(asserted['sessionDelete.readerToken'], 401);
    // D5. B asks for A's sess-1, an id B never sent: 200, nothing deleted, A's session still there.
    const foreign = await call('DELETE', '/v1/sessions/sess-1', { token: installB.token });
    assert.equal(note('sessionDelete.foreign.status', foreign.status), 200, String(foreign.buf));
    assert.equal(note('sessionDelete.foreign.sessions', foreign.json.deleted.sessions), 0);
    assert.equal((await call('GET', `/v1/read/sessions/${installA.id}/sess-1`, { token: reader.token })).status, 200);

    // D1, D2, D7. B deletes b-del.
    const filesBefore = filesUnder(blobDir).length;
    const d = await call('DELETE', '/v1/sessions/b-del', { token: installB.token });
    assert.equal(d.status, 200, String(d.buf));
    assert.deepEqual(note('sessionDelete.counts', [d.json.deleted.sessions, d.json.deleted.turns, d.json.deleted.requests, d.json.deleted.blobs]), [1, 1, 1, 2]);
    assert.match(d.json.receipt, /^del_/);
    assert.equal((await call('GET', `/v1/read/sessions/${installB.id}/b-del`, { token: reader.token })).status, 404);
    assert.equal(note('sessionDelete.blob.only', (await call('GET', `/v1/read/blobs/${sha(only)}`, { token: reader.token })).status), 404);
    assert.equal(note('sessionDelete.blob.twice', (await call('GET', `/v1/read/blobs/${sha(twice)}`, { token: reader.token })).status), 200);
    assert.equal(note('sessionDelete.blob.system', (await call('GET', `/v1/read/blobs/${h.system}`, { token: reader.token })).status), 200);
    // The reader's 404 reads the references only: the file of the blob only b-del used is gone from disk too.
    assert.deepEqual(note('sessionDelete.blobFiles', [filesBefore, filesUnder(blobDir).length]), [filesBefore, filesBefore - 1]);
    assert.equal((await call('GET', `/v1/read/sessions/${installB.id}/b-del2`, { token: reader.token })).status, 200);
    const storedAfter = (await call('GET', '/v1/installs/me', { token: installB.token })).json.usage.storedBytes;
    note('sessionDelete.storedBytes', [storedBefore, storedAfter]);
    assert.ok(storedAfter < storedBefore, 'the stored bytes count what went');
    assert.ok((await page('/admin/deletions')).html.includes(d.json.receipt), 'the receipt is in the owner\'s deletion log');
    // E6, E7. Nothing of b-del's environment, events or counts is left in any table, its log line holds none of it,
    // and neither does the server's own log.
    const client = new pg.Client({ host: db.env.PGHOST, port: Number(db.env.PGPORT), user: db.env.PGUSER, database: db.env.PGDATABASE });
    await client.connect();
    try {
      const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename as string);
      const holding: string[] = [];
      for (const t of tables) {
        const n = (await client.query(`SELECT count(*)::int AS n FROM "${t}" x WHERE to_jsonb(x)::text LIKE '%Chip-b-del-7731%'`)).rows[0].n;
        if (n) holding.push(t);
      }
      assert.deepEqual(note('env.afterSessionDelete.tablesHolding', holding), []);
      const b2 = (await client.query("SELECT environment->>'chip' AS chip, jsonb_array_length(events) AS n FROM sessions WHERE session_id = 'b-del2'")).rows;
      assert.deepEqual(b2.map((r) => [r.chip, r.n]), [['Chip-b-del2-7731', EVENTS.length]], 'the session kept keeps its own');
      const log = JSON.stringify((await client.query('SELECT * FROM deletion_log')).rows);
      assert.ok(!/Chip-|Mac15,3|Europe\/Berlin/.test(log), 'the operator\'s deletion log holds no environment');
    } finally {
      await client.end();
    }
    assert.ok(!/Chip-|Mac15,3|Europe\/Berlin/.test(srv.log.join('')), 'the server\'s log holds no environment');

    // D3, D4. Readers are told once, with the id, under a reason they know; a retry deletes nothing and tells no one.
    const again = await call('DELETE', '/v1/sessions/b-del', { token: installB.token });
    assert.equal(again.status, 200);
    assert.equal(note('sessionDelete.again.sessions', again.json.deleted.sessions), 0);
    assert.deepEqual(note('sessionDelete.tombstones', await tombstones()), [[installB.id, 'b-del', 'install_deleted']]);

    // The last session using `twice` goes, and the blob with it.
    assert.equal((await call('DELETE', '/v1/sessions/b-del2', { token: installB.token })).status, 200);
    assert.equal(note('sessionDelete.blob.twiceAfterBoth', (await call('GET', `/v1/read/blobs/${sha(twice)}`, { token: reader.token })).status), 404);
    assert.equal(filesUnder(blobDir).length, filesBefore - 2);
  });

  it('deletes everything an install sent in one call, says so, and keeps what another install still holds', async () => {
    const blobsBefore = filesUnder(blobDir).length;
    const d = await call('DELETE', '/v1/installs/me', { token: installA.token });
    assert.equal(d.status, 200);
    assert.deepEqual(note('delete.counts', [d.json.deleted.sessions, d.json.deleted.turns, d.json.deleted.requests, d.json.deleted.blobs]), [1, 1, 3, 6]);
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
