// batch.ts: validating a batch before it touches the database.
//
// Ways it can fail, written before the code:
// 1. An unknown field, at the top or in a row, is accepted (a client mistake that sends a project
//    path or an environment slips into storage).
// 2. An id outside ^[A-Za-z0-9._:-]{1,128}$ or a hash that is not 64 lowercase hex gets through.
// 3. A value of the wrong type, a negative count, a non-integer time or an out-of-range enum
//    gets through.
// 4. A string over its limit, or an outcome or params object over 16 KiB, gets through.
// 5. A required field is missing and the batch is accepted.
// 6. A schema other than 1 is accepted.
// 7. More rows than the per-batch limits are accepted.
// 8. A valid batch is refused, or its optional fields are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch } from '../../src/batch.ts';

const H = 'f'.repeat(64);
const session = { sessionId: 's-1', harness: 'codex', model: 'm', startedAt: 1, finalStatus: 'open', turnCount: 0, requestCount: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0 };
const turn = { turnId: 't-1', sessionId: 's-1', index: 0, startedAt: 1, requestCount: 1, toolCallCount: 0, toolErrorCount: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0 };
const request = { requestId: 'r-1', sessionId: 's-1', turnId: 't-1', seq: 0, surface: 'openai_chat', startedAt: 1, messages: [{ position: 0, hash: H, direction: 'input' }] };
const message = { hash: H, role: 'user', createdAt: 1, size: 3 };
const ok = { schema: 1, sessions: [session], turns: [turn], requests: [request], messages: [message] };
const errs = (b: unknown) => { const r = validateBatch(b); return 'errors' in r ? r.errors : []; };

test('1. unknown fields are refused, at any level', () => {
  assert.ok(errs({ ...ok, extra: 1 }).length);
  assert.ok(errs({ ...ok, sessions: [{ ...session, projectPath: '/Users/x' }] }).length);
  assert.ok(errs({ ...ok, requests: [{ ...request, messages: [{ ...request.messages[0], text: 'x' }] }] }).length);
});

test('2. ids and hashes are checked', () => {
  for (const id of ['', 'a b', 'a/b', 'é', 'x'.repeat(129)]) assert.ok(errs({ ...ok, sessions: [{ ...session, sessionId: id }] }).length, id);
  for (const h of ['F'.repeat(64), 'f'.repeat(63), 'g'.repeat(64)]) assert.ok(errs({ ...ok, messages: [{ ...message, hash: h }] }).length, h);
});

test('3. types, ranges and enums', () => {
  assert.ok(errs({ ...ok, sessions: [{ ...session, tokensIn: -1 }] }).length);
  assert.ok(errs({ ...ok, sessions: [{ ...session, startedAt: 1.5 }] }).length);
  assert.ok(errs({ ...ok, sessions: [{ ...session, finalStatus: 'weird' }] }).length);
  assert.ok(errs({ ...ok, sessions: [{ ...session, mixed: 'yes' }] }).length);
  assert.ok(errs({ ...ok, requests: [{ ...request, surface: 'grpc' }] }).length);
  assert.ok(errs({ ...ok, requests: [{ ...request, messages: [{ position: 0, hash: H, direction: 'sideways' }] }] }).length);
  assert.ok(errs({ ...ok, messages: [{ ...message, role: 'robot' }] }).length);
  assert.ok(errs({ ...ok, turns: 'no' }).length);
});

test('4. lengths and sizes', () => {
  assert.ok(errs({ ...ok, sessions: [{ ...session, model: 'm'.repeat(201) }] }).length);
  assert.ok(errs({ ...ok, sessions: [{ ...session, outcome: { x: 'y'.repeat(17 * 1024) } }] }).length);
  assert.ok(errs({ ...ok, requests: [{ ...request, params: { x: 'y'.repeat(17 * 1024) } }] }).length);
  assert.ok(errs({ ...ok, requests: [{ ...request, error: 'e'.repeat(2001) }] }).length);
});

test('5. required fields', () => {
  const { model: _m, ...noModel } = session;
  assert.ok(errs({ ...ok, sessions: [noModel] }).length);
  const { messages: _x, ...noMessages } = request;
  assert.ok(errs({ ...ok, requests: [noMessages] }).length);
});

test('6. schema 1 only', () => {
  assert.ok(errs({ ...ok, schema: 2 }).length);
  assert.ok(errs({ sessions: [] }).length);
  assert.ok(errs(null).length);
  assert.ok(errs([]).length);
});

test('7. per-batch limits', () => {
  assert.ok(errs({ schema: 1, sessions: Array.from({ length: 1001 }, (_, i) => ({ ...session, sessionId: `s-${i}` })) }).length);
});

test('8. a valid batch passes whole, optional fields kept, absent arrays empty', () => {
  const full = { ...ok, sessions: [{ ...session, agentId: 'a-1', projectKey: 'ab12', outcome: { branch: 'b' }, mixed: true, endedAt: 9 }] };
  const r = validateBatch(full);
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.sessions[0], full.sessions[0]);
  const empty = validateBatch({ schema: 1 });
  assert.ok(!('errors' in empty));
  assert.deepEqual([empty.sessions, empty.turns, empty.requests, empty.messages], [[], [], [], []]);
});
