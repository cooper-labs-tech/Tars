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
// 13. A session's `start` (27/11, what started it) takes a key it does not know, a trigger or a via
//     outside the client's closed lists, a task ref not of the form t- and 8 hex, a commit that is
//     not 40 or 64 hex, an id over its bound, a branch over 255 bytes, or a time of the wrong form,
//     or goes without its trigger; or a valid one, the trigger alone included, is refused.
// 14. A session's `lostDemand` takes an item other than {kind: queue_drop, ref, queuedAt, at, reason},
//     a reason outside the client's six, a key besides those, or more than 1,000; or a valid list is
//     refused.
// 15. A request's `cancel` takes a `by` other than harness, tars, proxy or endpoint, a cause that is
//     not one of that `by`'s, or anything but {by, cause, at, deliveredBytes} of their types; or a
//     valid one is refused.
// 16. A turn's `taskRef` (the task its instruction came from) takes something other than t- and 8
//     hex, or a valid one is refused.
// 17. A session's `maskingVersion` takes something other than a string of at most 40, or its
//     `maskCounts` takes a key other than SECRET, EMAIL, IP, PERSON, HOME and PHONE, goes without
//     one of them, or takes a count that is not an int >= 0; or valid ones are refused.
// 18. A turn's `interventions` takes a key other than interrupted, restarted, next, corrected and
//     redelegated, one of them in another shape (a `during` other than answer or tools, a name
//     where a kind belongs, a negative delay, `corrected` other than true, a `to` over 64), or a
//     valid one is refused: every key alone, all together, and a fractional delay.
// 19. The timings (27/11, from the endpoint's Server-Timing): a session's `rttMedianMs` and
//     `clockOffsetMs`, a request's `rttMs`, `clockOffsetMs`, `queueMs` and `upstreamMs`, each in
//     milliseconds and fractional. A negative round trip, queue or upstream, a value that is not a
//     finite number, or one over 10^10 is taken; or a valid one, a negative clock offset and a
//     fraction included, is refused.
// 20. A turn's workspace (27/11): `startHead`, `endHead`, `startTree`, `endTree` take something other
//     than 40 or 64 lowercase hex; `filesChanged`, `linesAdded`, `linesRemoved`, `changedLines`,
//     `survivedLines` take a negative or fractional count; `reverted` a non-boolean; `survivalBasis`
//     a value other than session_end, merged or deleted; or valid ones are refused.
// 21. A session's `consent` (27/11, the training consent it was recorded under) takes anything but
//     {training: boolean}, or a valid one is refused.
// 10 again (the client's own contract, 27/11): every environment value may be null, the
//     architecture Tars runs as included, and a negative UTC offset is valid.
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
  const nulls = Object.fromEntries(Object.keys(environment).map((k) => [k, null]));
  assert.ok(!('errors' in validateBatch(withSession({ environment: nulls }))), 'every value unknown is still an environment, tarsArch included');
  assert.ok(!('errors' in validateBatch(withSession({ environment: {} }))), 'an empty environment');
  assert.ok(!('errors' in validateBatch(withSession({ environment: { ...environment, utcOffsetMinutes: -300, ramBytes: 2 ** 36 } }))), 'west of UTC, and memory over 2^31');
  const bad: Array<Record<string, unknown> | unknown> = [
    'macOS', [], { ...environment, serialNumber: 'C02XYZ' }, { ...environment, hostName: 'my-mac' }, { ...environment, cpuCores: '8' },
    { ...environment, cpuCores: -1 }, { ...environment, cpuCores: 1.5 }, { ...environment, cpuCores: 100_000 }, { ...environment, ramBytes: -1 },
    { ...environment, utcOffsetMinutes: 1000 }, { ...environment, utcOffsetMinutes: 30.5 }, { ...environment, onBattery: 'no' },
    { ...environment, chip: 'x'.repeat(201) }, { ...environment, locale: 5 }, { ...environment, tarsArch: 64 },
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

const start = {
  trigger: 'task', via: 'api', taskRef: 't-0a1b2c3d', taskId: 'task-1', requesterAgentId: 'agent-0', queuedAt: 10, handedAt: 12,
  firstRequestAt: 15, commit: '0123456789abcdef0123456789abcdef01234567', branch: 'feat/x', redelegatedFrom: 'tr_old',
};

test('13. start: what started the session', () => {
  const r = validateBatch(withSession({ start }));
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.sessions[0]!.start, start);
  assert.ok(!('errors' in validateBatch(withSession({ start: { trigger: 'unknown' } }))), 'the trigger alone');
  for (const trigger of ['owner', 'task', 'channel', 'restart', 'start', 'wake', 'redelegation', 'unknown']) {
    assert.ok(!('errors' in validateBatch(withSession({ start: { trigger } }))), trigger);
  }
  for (const via of ['window', 'chat', 'api', 'telegram', 'slack', 'discord', 'hermes', 'relay', 'settings', 'asked', 'tars']) {
    assert.ok(!('errors' in validateBatch(withSession({ start: { trigger: 'owner', via } }))), via);
  }
  assert.ok(!('errors' in validateBatch(withSession({ start: { ...start, commit: 'a'.repeat(64) } }))), 'a sha-256 commit');
  assert.ok(!('errors' in validateBatch(withSession({ start: { ...start, taskId: 'x'.repeat(200), branch: 'é'.repeat(127) } }))), 'at the bounds');
  const bad: unknown[] = [
    'task', [], {}, { ...start, trigger: undefined }, { ...start, who: 'someone' }, { ...start, trigger: 'Owner Name' }, { ...start, trigger: 'reboot' },
    { ...start, via: 'fax' }, { ...start, queuedAt: -1 }, { ...start, handedAt: '12' }, { ...start, branch: 'é'.repeat(128) },
    { ...start, taskRef: 7 }, { ...start, taskRef: 'ref-1' }, { ...start, taskRef: 't-0A1B2C3D' }, { ...start, commit: '<SECRET_1>' },
    { ...start, commit: 'abc123' }, { ...start, taskId: 'x'.repeat(201) }, { ...start, requesterAgentId: 'x'.repeat(201) },
    { ...start, redelegatedFrom: 'x'.repeat(65) },
  ];
  for (const s of bad) assert.ok(errs(withSession({ start: s })).length, JSON.stringify(s).slice(0, 80));
});

test('14. lostDemand: tasks that left the queue unstarted', () => {
  const lost = [{ kind: 'queue_drop', ref: 't-00000002', queuedAt: 20, at: 30, reason: 'cancelled' }];
  const r = validateBatch(withSession({ lostDemand: lost }));
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.sessions[0]!.lostDemand, lost);
  for (const reason of ['cancelled', 'taken_back', 'dropped_with_stop', 'queue_cleared', 'agent_removed', 'not_handed_again']) {
    assert.ok(!('errors' in validateBatch(withSession({ lostDemand: [{ ...lost[0], reason }] }))), reason);
  }
  const bad: unknown[] = [
    {}, [{ ...lost[0], kind: 'crash' }], [{ ...lost[0], by: 'x' }], [{ ...lost[0], reason: 'Not A Word' }], [{ ...lost[0], reason: 'forgotten' }],
    [{ ...lost[0], at: -1 }], [{ ...lost[0], ref: 'ref-2' }], [{ kind: 'queue_drop', ref: 't-00000002', queuedAt: 1, at: 2 }],
    Array.from({ length: 1001 }, () => lost[0]),
  ];
  for (const l of bad) assert.ok(errs(withSession({ lostDemand: l })).length, JSON.stringify(l).slice(0, 80));
});

test('15. cancel: who cut a request, why, when, what reached the harness', () => {
  const cancel = { by: 'harness', cause: 'abandoned_while_held', at: 40, deliveredBytes: 0 };
  const r = validateBatch({ ...ok, requests: [{ ...request, cancel }] });
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.requests[0]!.cancel, cancel);
  const causes: Record<string, string[]> = {
    harness: ['esc', 'ctrl_c', 'cli_interrupt', 'abandoned_while_held', 'unknown'],
    tars: ['stop', 'restart', 'sleep', 'remove', 'quit', 'replace'],
    proxy: ['hold_ceiling'],
    endpoint: ['stream_cut'],
  };
  for (const [by, list] of Object.entries(causes)) {
    for (const cause of list) assert.ok(!('errors' in validateBatch({ ...ok, requests: [{ ...request, cancel: { ...cancel, by, cause } }] })), `${by} ${cause}`);
  }
  const bad: unknown[] = [
    'harness', { ...cancel, by: 'Some One' }, { ...cancel, by: 'user' }, { ...cancel, cause: '' }, { ...cancel, cause: 'teleport' },
    { ...cancel, by: 'tars', cause: 'esc' }, { ...cancel, by: 'endpoint', cause: 'hold_ceiling' }, { ...cancel, at: 1.5 },
    { ...cancel, deliveredBytes: -1 }, { ...cancel, note: 'x' }, { by: 'harness', cause: 'abandoned_while_held', at: 40 },
  ];
  for (const c of bad) assert.ok(errs({ ...ok, requests: [{ ...request, cancel: c }] }).length, JSON.stringify(c).slice(0, 80));
});

test('17. masking: the version and the six counts', () => {
  const maskCounts = { SECRET: 2, EMAIL: 1, IP: 0, PERSON: 3, HOME: 4, PHONE: 0 };
  const r = validateBatch(withSession({ maskingVersion: 'tars-scrub-2', maskCounts }));
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual([r.sessions[0]!.maskingVersion, r.sessions[0]!.maskCounts], ['tars-scrub-2', maskCounts]);
  const five: Record<string, number> = { ...maskCounts };
  delete five.PHONE;
  const bad: Array<Record<string, unknown>> = [
    { maskingVersion: 2 }, { maskingVersion: 'v'.repeat(41) }, { maskCounts: five }, { maskCounts: { ...maskCounts, NAME: 1 } },
    { maskCounts: { ...maskCounts, EMAIL: -1 } }, { maskCounts: { ...maskCounts, IP: 1.5 } }, { maskCounts: { ...maskCounts, HOME: '4' } }, { maskCounts: [] },
  ];
  for (const b of bad) assert.ok(errs(withSession(b)).length, JSON.stringify(b).slice(0, 80));
});

test('18. a turn\'s interventions', () => {
  const all = {
    interrupted: { at: 5, by: 'esc', during: 'answer' }, restarted: { at: 6, by: 'restart' }, next: { by: 'user', delaySec: 12.5 },
    corrected: true, redelegated: { to: 'tr_later', at: 7 },
  };
  const r = validateBatch({ ...ok, turns: [{ ...turn, interventions: all }] });
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual(r.turns[0]!.interventions, all);
  for (const [k, v] of Object.entries(all)) {
    assert.ok(!('errors' in validateBatch({ ...ok, turns: [{ ...turn, interventions: { [k]: v } }] })), `${k} alone`);
  }
  assert.ok(!('errors' in validateBatch({ ...ok, turns: [{ ...turn, interventions: { interrupted: { ...all.interrupted, during: 'tools', by: 'cli' } } }] })), 'during tools');
  const bad: unknown[] = [
    [], 'interrupted', { paused: { at: 1 } }, { interrupted: { ...all.interrupted, during: 'thinking' } }, { interrupted: { ...all.interrupted, by: 'Some One' } },
    { interrupted: { at: 5, by: 'esc' } }, { restarted: { at: -1, by: 'stop' } }, { next: { by: 'user', delaySec: -1 } }, { next: { by: 'user' } },
    { corrected: false }, { corrected: 'yes' }, { redelegated: { to: 'x'.repeat(65), at: 7 } }, { redelegated: { to: 'tr_later' } },
    { next: { ...all.next, note: 'x' } },
  ];
  for (const b of bad) assert.ok(errs({ ...ok, turns: [{ ...turn, interventions: b }] }).length, JSON.stringify(b).slice(0, 80));
});

test('19. the timings', () => {
  const s = { rttMedianMs: 41.5, clockOffsetMs: -12.25 };
  const q = { rttMs: 40.75, clockOffsetMs: -3.5, queueMs: 0, upstreamMs: 812.3 };
  const r = validateBatch({ ...ok, sessions: [{ ...session, ...s }], requests: [{ ...request, ...q }] });
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.deepEqual([r.sessions[0]!.rttMedianMs, r.sessions[0]!.clockOffsetMs], [41.5, -12.25]);
  assert.deepEqual([r.requests[0]!.rttMs, r.requests[0]!.clockOffsetMs, r.requests[0]!.queueMs, r.requests[0]!.upstreamMs], [40.75, -3.5, 0, 812.3]);
  for (const [k, v] of [['rttMedianMs', -1], ['rttMedianMs', '41'], ['clockOffsetMs', 1e11], ['clockOffsetMs', -1e11], ['clockOffsetMs', true]] as const) {
    assert.ok(errs({ ...ok, sessions: [{ ...session, [k]: v }] }).length, `session ${k} ${v}`);
  }
  for (const [k, v] of [['rttMs', -0.5], ['queueMs', -1], ['upstreamMs', 1e11], ['upstreamMs', '812'], ['clockOffsetMs', {}], ['rttMs', []]] as const) {
    assert.ok(errs({ ...ok, requests: [{ ...request, [k]: v }] }).length, `request ${k} ${v}`);
  }
});

test('20. a turn\'s workspace', () => {
  const w = {
    startHead: 'a'.repeat(40), endHead: 'b'.repeat(40), startTree: 'c'.repeat(64), endTree: 'd'.repeat(64), filesChanged: 3, linesAdded: 120,
    linesRemoved: 7, changedLines: 127, survivedLines: 100, reverted: false, survivalBasis: 'merged',
  };
  const r = validateBatch({ ...ok, turns: [{ ...turn, ...w }] });
  assert.ok(!('errors' in r), JSON.stringify(r));
  for (const [k, v] of Object.entries(w)) assert.equal((r.turns[0] as Record<string, unknown>)[k], v, k);
  for (const basis of ['session_end', 'merged', 'deleted']) assert.ok(!('errors' in validateBatch({ ...ok, turns: [{ ...turn, survivalBasis: basis }] })), basis);
  const bad: Array<[string, unknown]> = [
    ['startHead', 'abc'], ['endHead', 'A'.repeat(40)], ['startTree', 'c'.repeat(63)], ['endTree', 7], ['filesChanged', -1], ['linesAdded', 1.5],
    ['linesRemoved', '7'], ['changedLines', -3], ['survivedLines', true], ['reverted', 'no'], ['survivalBasis', 'rebased'],
  ];
  for (const [k, v] of bad) assert.ok(errs({ ...ok, turns: [{ ...turn, [k]: v }] }).length, `${k} ${String(v)}`);
});

test('21. a session\'s consent', () => {
  for (const training of [true, false]) {
    const r = validateBatch(withSession({ consent: { training } }));
    assert.ok(!('errors' in r), JSON.stringify(r));
    assert.deepEqual(r.sessions[0]!.consent, { training });
  }
  for (const c of [true, {}, { training: 'yes' }, { training: 1 }, { training: true, resale: true }, []]) {
    assert.ok(errs(withSession({ consent: c })).length, JSON.stringify(c));
  }
});

test('16. a turn\'s taskRef', () => {
  const r = validateBatch({ ...ok, turns: [{ ...turn, taskRef: 't-0a1b2c3d' }] });
  assert.ok(!('errors' in r), JSON.stringify(r));
  assert.equal(r.turns[0]!.taskRef, 't-0a1b2c3d');
  for (const taskRef of ['ref-1', 't-0a1b2c3', 't-0a1b2c3d4', 7]) assert.ok(errs({ ...ok, turns: [{ ...turn, taskRef }] }).length, String(taskRef));
});
