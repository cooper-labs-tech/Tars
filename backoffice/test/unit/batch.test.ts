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
// 9. A request's `side` mark (the owner's decision of 26/11) is refused when it is a boolean, or
//    taken when it is anything else ("yes", 1, "true"), or required, which would refuse every
//    upload from a Tars before the mark.
// 10. A session's `environment` (27/11: the machine and the system, exact values) takes a key it does
//     not know (a serial number, a host name would pass), a value of the wrong type, a string over
//     200, cores, memory or a UTC offset out of range, or is not an object; or a valid one, all
//     values null included, is refused.
// 11. A session's `events` (power events) takes something other than an array of {at, kind}, a
//     kind other than sleep, wake, battery or ac, a key besides those two, or more than 10,000;
//     or a valid list, the empty one included, is refused.
// 12. A request's `liveSessions` takes a negative, fractional or absurd count, or a valid one is
//     refused.
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
  const noModel: Record<string, unknown> = { ...session };
  delete noModel.model;
  assert.ok(errs({ ...ok, sessions: [noModel] }).length);
  const noMessages: Record<string, unknown> = { ...request };
  delete noMessages.messages;
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

test('9. side: a boolean or nothing', () => {
  for (const side of [true, false]) {
    const r = validateBatch({ ...ok, requests: [{ ...request, side }] });
    assert.ok(!('errors' in r), `side ${side}: ${JSON.stringify(r)}`);
    assert.equal(r.requests[0]!.side, side);
  }
  assert.ok(!('errors' in validateBatch(ok)), 'a request without side, from a Tars before the mark, is taken');
  for (const side of ['yes', 'true', 1, 0, {}]) assert.ok(errs({ ...ok, requests: [{ ...request, side }] }).length, String(side));
});

const environment = {
  osName: 'macOS', osVersion: '15.6.1', kernel: '24.6.0', arch: 'arm64', machineModel: 'Mac15,3', chip: 'Apple M3', cpuCores: 8,
  ramBytes: 17179869184, tarsVersion: '2.0.7', tarsArch: 'arm64', locale: 'de-DE', timeZone: 'Europe/Berlin', utcOffsetMinutes: 60, onBattery: false,
};
const withSession = (over: Record<string, unknown>) => ({ ...ok, sessions: [{ ...session, ...over }] });

test('10. environment: the known keys, each of its type', () => {
  const r = validateBatch(withSession({ environment, nativeSessionId: 'n-1' }));
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.sessions[0]!.environment, environment);
  const nulls = Object.fromEntries(Object.keys(environment).map((k) => [k, k === 'tarsArch' ? 'x64' : null]));
  assert.ok(!('errors' in validateBatch(withSession({ environment: nulls }))), 'every value unknown is still an environment');
  assert.ok(!('errors' in validateBatch(withSession({ environment: {} }))), 'an empty environment');
  const bad: Array<Record<string, unknown> | unknown> = [
    'macOS', [], { ...environment, serialNumber: 'C02XYZ' }, { ...environment, hostName: 'my-mac' }, { ...environment, cpuCores: '8' },
    { ...environment, cpuCores: -1 }, { ...environment, cpuCores: 1.5 }, { ...environment, cpuCores: 100_000 }, { ...environment, ramBytes: -1 },
    { ...environment, utcOffsetMinutes: 1000 }, { ...environment, utcOffsetMinutes: 30.5 }, { ...environment, onBattery: 'no' },
    { ...environment, chip: 'x'.repeat(201) }, { ...environment, locale: 5 }, { ...environment, tarsArch: null },
  ];
  for (const e of bad) assert.ok(errs(withSession({ environment: e })).length, JSON.stringify(e).slice(0, 80));
});

test('11. events: a list of {at, kind}', () => {
  const events = [{ at: 1, kind: 'sleep' }, { at: 2, kind: 'wake' }, { at: 3, kind: 'battery' }, { at: 4, kind: 'ac' }];
  const r = validateBatch(withSession({ events }));
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.sessions[0]!.events, events);
  assert.ok(!('errors' in validateBatch(withSession({ events: [] }))), 'no event yet');
  const bad: unknown[] = [
    {}, 'sleep', [{ at: 1, kind: 'reboot' }], [{ at: 1, kind: 'sleep', by: 'lid' }], [{ at: -1, kind: 'sleep' }], [{ at: 1.5, kind: 'wake' }],
    [{ kind: 'wake' }], [{ at: 1 }], ['sleep'], Array.from({ length: 10_001 }, (_, i) => ({ at: i, kind: 'sleep' })),
  ];
  for (const e of bad) assert.ok(errs(withSession({ events: e })).length, JSON.stringify(e).slice(0, 80));
});

test('12. liveSessions: a count', () => {
  for (const n of [0, 1, 40]) assert.ok(!('errors' in validateBatch({ ...ok, requests: [{ ...request, liveSessions: n }] })), String(n));
  for (const n of [-1, 1.5, '3', true, 1_000_001]) assert.ok(errs({ ...ok, requests: [{ ...request, liveSessions: n }] }).length, String(n));
});
