// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

/**
 * The gap before each request, split by cause (trace feature C1, 27/11). Until now a request's `toolMs` was the whole
 * time since the previous reply ended, so a session that waited three hours for the owner looked like a three-hour tool
 * call. Each main request that reached the endpoint now says how the time since the previous reply's end divides:
 * - its tools' run, read from the harness's own log, call by call, keyed by the call's id;
 * - the wait for typed words, with their author, #680's attribution (the typed input the turn was matched to);
 * - the proxy's hold (`heldMs`, which the endpoint sees in the gap);
 * - the rest, the harness's own work.
 * And each tool call, by its id: its exit code, how long it ran, whether it was denied, timed out or failed, and how
 * many bytes of its output the harness cut before sending it back. Never its command, never its output.
 *
 * What the harnesses write, measured or read (27/11):
 * - codex 0.170.0, run for real in an isolated bench against a stand-in: each command's end is an `event_msg`
 *   `item_completed` of type `CommandExecution` (`started_at_ms`, `completed_at_ms`, `exit_code`, `status`, the output it
 *   kept, at most 64 KiB); what it sends back is a `function_call_output` line ("Wall time: X seconds", then "Process
 *   exited with code N", or "Process running with session ID N" for a call that returned while its process ran, which
 *   later ends as exit -1, then "Original token count: N"). A response's calls run at once (two 0.91 s calls took
 *   1.11 s), and their outputs are written together at the batch's end.
 * - pi 1.3.0 and 1.5.2, read in their code: a `toolResult` message line with `durationMs` (timed around the tool's
 *   run), `isError`, its text (bash: "Command exited with code N", "Command timed out after N seconds", "Command
 *   aborted"), and `details.truncation` (`totalBytes`, `outputBytes`); a call blocked before it ran has no durationMs.
 *   A response's calls run at once by default, all started once the assistant line that asked for them is written.
 *
 * How it fails, written before the code:
 *  1. The gap is measured wrong: from a side request's end, or from a request given up while held (it never reached
 *     the endpoint: #680's rule, `givenUpWhileHeld`, an Esc, a Ctrl-C or Tars cutting a held request included), or
 *     from the session's start for its first request, which has no previous reply and so no gap; or the hold is left
 *     out, though the endpoint sees it in the gap.
 *  2. A request carrying tool results whose records are missing (the log not read yet, missing, or no reader for its
 *     harness) reads 0 tool time, not null; a request carrying no tool result reads null, not 0.
 *  3. Two calls run at once are summed, their overlap counted twice, not their union; a call partly outside the gap
 *     counts beyond it.
 *  4. A call with no end (codex: it returned while its process ran) is lost, or reads codex's exit -1, or its time runs
 *     to when codex later killed it rather than to when it returned.
 *  5. The input wait: a turn opened by typed words is not split at the time they were typed, or loses their author
 *     (#680's, never a second attribution); a turn whose words no typing record matches reads 0, not null; a request
 *     inside a turn reads null, not 0.
 *  6. The parts do not add up: the rest is not the gap less the others; an unknown part still gives a rest; parts that
 *     exceed the gap by more than the tolerance (25 ms) give a negative rest instead of null.
 *  7. Tool records: one from another session (its time outside the session's) is taken; a late one (read after its
 *     request, or after the session ended) is lost, or does not move the session's change sequence, so it is never
 *     sent; the same call read twice is stored twice; one half of a codex call (its command's end, its output line)
 *     overwrites what the other said.
 *  8. codex 0.170's lines are not read: the command's start, end, exit and status, the output it kept, the output line's
 *     wall time and exit; the output it cut is not counted (bytes kept less bytes sent back); a declined command is not
 *     denied; an apply_patch output ("Exit code: N") is not read.
 *  9. pi's lines are not read: durationMs, isError, the bash text's exit code and time-out, details.truncation; a call
 *     blocked before it ran is not denied; calls are not placed at the assistant line that asked for them.
 * 10. What leaves: a command or an output leaves (only ids, numbers, exit codes and flags may); the gap and the calls
 *     are missing from the export, the upload or its preview; a request with hundreds of calls is not bounded.
 * 11. A line that is no tool line, or is not JSON, throws or is read as a call.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

vi.mock('../../../electron/services/endpoint-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/endpoint-proxy')>()),
  startEndpointProxy: vi.fn(),
  stopEndpointProxy: vi.fn(),
}));

import {
  TRACES_DB_FILE, TRACES_INSTALL_FILE, closeEndpointSession, configureTraces, liveTraceOf, noteToolCall, openEndpointSession,
  stopTracesRuntime, traceStore, traceUploader,
} from '../../../electron/services/traces-runtime';
import { oneTaskQueue } from '../../../electron/core/one-task';
import { sessionDocument } from '../../../electron/services/trace-export';
import { GAP_TOLERANCE_MS } from '../../../electron/services/trace-store';
import { codexToolPartOf, piToolLineOf, toolCallRecordOf, TOOL_CALLS_PER_REQUEST_MAX } from '../../../electron/services/tool-calls';

const EP = 'ep-c1test';
let home: string;
let project: string;
let fleet: Map<string, AgentStatus>;
let settings: AppSettings;

function agent(id: string): AgentStatus {
  const a = {
    id, name: id.toUpperCase(), status: 'idle', provider: 'qwen-code', model: 'open-model-1', endpointId: EP, traces: true,
    projectPath: project, skills: [], output: [], lastActivity: '',
  } as unknown as AgentStatus;
  fleet.set(id, a);
  return a;
}

function open(agentId: string): { traceId: string; token: string } {
  const s = openEndpointSession(agentId);
  expect(s.token, 'no endpoint session').toBeTruthy();
  return { traceId: liveTraceOf(agentId)!, token: s.token! };
}

const TOOLS = [{ type: 'function', function: { name: 'sh', parameters: {} } }];
const asks = (ids: string[]) => ({ role: 'assistant', content: null, tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'sh', arguments: '{}' } })) });
const answers = (ids: string[]) => ids.map(id => ({ role: 'tool', tool_call_id: id, content: 'ran' }));

/**
 * A request as the proxy records it, ending 10 ms after it starts: `messages` is what the harness sent, `calls` the
 * calls its reply asks for (none: a final answer); `side` sends no tools (a title call).
 */
function request(traceId: string, startedAt: number, messages: unknown[], over: { calls?: string[]; side?: boolean; heldMs?: number; cancel?: unknown; status?: number } = {}): void {
  const body = Buffer.from(JSON.stringify({ model: 'open-model-1', stream: false, ...(over.side ? {} : { tools: TOOLS }), messages }));
  const message = over.calls?.length ? asks(over.calls) : { role: 'assistant', content: 'done' };
  const reply = Buffer.from(JSON.stringify({ id: 'c1', choices: [{ index: 0, message, finish_reason: over.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  expect(traceStore().ingest({
    traceId, agentId: 'q', surface: 'openai_chat', startedAt, firstByteAt: startedAt + 5, endedAt: startedAt + 10, status: over.status ?? 200,
    contentType: 'application/json', requestBody: body, responseBody: reply, attempts: 1, heldMs: over.heldMs ?? 0,
    ...(over.cancel ? { cancel: over.cancel } : {}),
  } as never)).toBeTruthy();
}

const requestsOf = (traceId: string) => traceStore().session(traceId)!.turns.flatMap(t => t.requests);
const lastRequest = (traceId: string) => requestsOf(traceId).at(-1)!;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-c1-'));
  project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  fleet = new Map();
  settings = {
    inferenceEndpoints: [{ id: EP, name: 'Remote', baseUrl: 'http://127.0.0.1:9/v1', approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, models: ['open-model-1'] }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: '*', models: '*' }], excludeClosedModels: true, uploadUrl: '' },
  } as unknown as AppSettings;
  configureTraces({
    getSettings: () => settings, setSettings: (s) => { settings = s; }, writeSettings: () => {},
    getAgent: (id) => fleet.get(id), emit: () => {}, queue: oneTaskQueue,
  });
});

afterEach(() => {
  stopTracesRuntime();
  vi.useRealTimers();
  fs.rmSync(path.dirname(TRACES_DB_FILE), { recursive: true, force: true });
  fs.rmSync(TRACES_INSTALL_FILE, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the gap', () => {
  it('1: the first request has none; the next runs from the previous reply to when it left for the endpoint, its hold included, past a side request and one given up while held', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'list the files' };
    request(traceId, t0, [said], { calls: ['a'] });
    request(traceId, t0 + 300, [{ role: 'system', content: 'Generate a title.' }, said], { side: true });
    request(traceId, t0 + 500, [said, asks(['a']), ...answers(['a'])], { cancel: { by: 'harness', cause: 'abandoned_while_held', at: t0 + 900, deliveredBytes: 0 }, status: 499 });
    // An Esc that cut a request the proxy held and never answered: given up while held too (#680's rule).
    request(traceId, t0 + 700, [said, asks(['a']), ...answers(['a'])], { cancel: { by: 'harness', cause: 'esc', at: t0 + 950, deliveredBytes: 0 }, status: 499, heldMs: 150 });
    request(traceId, t0 + 1010, [said, asks(['a']), ...answers(['a'])], { heldMs: 200 });
    const [first, ...rest] = requestsOf(traceId).filter(r => !r.side);
    expect(first.gap).toBeUndefined();
    const given = rest.filter(r => r.cancel);
    expect(given.length).toBe(2);
    for (const g of given) expect(g.gap, `a request that never reached the endpoint (${g.cancel!.cause}) has no gap`).toBeUndefined();
    const last = lastRequest(traceId);
    expect(last.gap).toMatchObject({ ms: 1000 + 200, heldMs: 200 });
  });

  it('2 and 3: tool time is null until every call it carries is known, then the union of calls run at once, cut to the gap', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'run both' };
    request(traceId, t0, [said], { calls: ['a', 'b'] });
    request(traceId, t0 + 2010, [said, asks(['a', 'b']), ...answers(['a', 'b'])]);
    expect(lastRequest(traceId).gap).toMatchObject({ ms: 2000, toolMs: null, harnessMs: null });
    noteToolCall('q', { callId: 'a', itemStartedAt: t0 + 100, itemEndedAt: t0 + 1300 });
    expect(lastRequest(traceId).gap!.toolMs, 'one call of two still unknown').toBeNull();
    noteToolCall('q', { callId: 'b', itemStartedAt: t0 + 150, itemEndedAt: t0 + 1250 });
    // Their union, 100 to 1300: never 1200 + 1100.
    expect(lastRequest(traceId).gap).toMatchObject({ ms: 2000, toolMs: 1200, inputWaitMs: 0, heldMs: 0, harnessMs: 800 });
    expect(lastRequest(traceId).toolCalls!.map(c => c.toolCallId).sort()).toEqual(['a', 'b']);
  });

  it('3: a call reaching back before the previous reply counts from it', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'go' };
    request(traceId, t0, [said], { calls: ['a'] });
    request(traceId, t0 + 1010, [said, asks(['a']), ...answers(['a'])], { calls: ['b'] });
    request(traceId, t0 + 2010, [said, asks(['a']), ...answers(['a']), asks(['b']), ...answers(['b'])]);
    noteToolCall('q', { callId: 'a', itemStartedAt: t0 + 20, itemEndedAt: t0 + 1000 });
    // b's record says it began before the reply that asked for it ended: only its part inside the gap counts.
    noteToolCall('q', { callId: 'b', itemStartedAt: t0 + 900, itemEndedAt: t0 + 1500 });
    const [, second, third] = requestsOf(traceId);
    expect(second.gap).toMatchObject({ ms: 1000, toolMs: 980, harnessMs: 20 });
    expect(third.gap).toMatchObject({ ms: 2010 - 1020, toolMs: 1500 - 1020 });
  });

  it('4: a codex call that returned while its process ran counts until it returned, with no exit, whatever codex wrote later', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'start the server' };
    request(traceId, t0, [said], { calls: ['call_d'] });
    request(traceId, t0 + 1010, [said, asks(['call_d']), ...answers(['call_d'])]);
    noteToolCall('q', codexToolPartOf(outputLine(t0 + 400, 'call_d', 'Chunk ID: 34ce09\nWall time: 0.3018 seconds\nProcess running with session ID 32998\nOriginal token count: 0\nOutput:\n'))!);
    // Codex later ends the process (at its quit, or when it finishes) and logs it as failed, exit -1.
    noteToolCall('q', codexToolPartOf(commandLine(t0 + 9000, 'call_d', { started: t0 + 98, completed: t0 + 9000, exit: -1, status: 'failed', output: '' }))!);
    const r = lastRequest(traceId);
    expect(r.toolCalls).toEqual([{ toolCallId: 'call_d', exit: null, ms: 302, denied: false, timedOut: false, failed: false }]);
    expect(r.gap).toMatchObject({ ms: 1000, toolMs: 302 });
  });
});

describe('the input wait', () => {
  it('5: a turn opened by typed words waits until they were typed, with their author; words nobody typed: null; inside a turn: 0', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    request(traceId, t0, [{ role: 'user', content: 'first' }]);
    traceStore().noteTypedInput({ agentId: 'q', at: t0 + 3010, author: 'orchestrator', authorDetail: 'Lead (claude)', text: 'now the second', closed: true });
    request(traceId, t0 + 3100, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now the second' }]);
    expect(lastRequest(traceId).gap).toMatchObject({ ms: 3090, toolMs: 0, inputWaitMs: 3000, inputBy: 'orchestrator', heldMs: 0, harnessMs: 90 });
    request(traceId, t0 + 5000, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'words nobody typed through Tars' }]);
    const blind = lastRequest(traceId).gap!;
    expect(blind).toMatchObject({ ms: 1890, inputWaitMs: null, harnessMs: null });
    expect(blind.inputBy).toBeUndefined();
  });
});

describe('the parts add up', () => {
  it(`6: the rest is the gap less the parts; parts beyond the gap by more than ${25} ms leave it null, within it 0`, () => {
    expect(GAP_TOLERANCE_MS).toBe(25);
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    // The owner types new words while the tools run, and the harness sends both at once: the parts overlap.
    const said = { role: 'user', content: 'go' };
    request(traceId, t0, [said], { calls: ['x'] });
    traceStore().noteTypedInput({ agentId: 'q', at: t0 + 1000, author: 'user', text: 'and then stop', closed: false });
    request(traceId, t0 + 1100, [said, asks(['x']), ...answers(['x']), { role: 'user', content: 'and then stop' }], { calls: ['y'] });
    noteToolCall('q', { callId: 'x', itemStartedAt: t0 + 20, itemEndedAt: t0 + 1020 });
    expect(lastRequest(traceId).gap).toMatchObject({ ms: 1090, toolMs: 1000, inputWaitMs: 990, harnessMs: null });
    // Within the tolerance: 600 + 510 is 10 ms over the 1100 ms gap, and reads 0.
    traceStore().noteTypedInput({ agentId: 'q', at: t0 + 1710, author: 'user', text: 'one more', closed: false });
    request(traceId, t0 + 2210, [said, asks(['x']), ...answers(['x']), { role: 'user', content: 'and then stop' }, asks(['y']), ...answers(['y']), { role: 'user', content: 'one more' }]);
    noteToolCall('q', { callId: 'y', itemStartedAt: t0 + 1700, itemEndedAt: t0 + 2210 });
    expect(lastRequest(traceId).gap).toMatchObject({ ms: 1100, toolMs: 510, inputWaitMs: 600, harnessMs: 0 });
  });
});

describe('tool records', () => {
  it('7: one from outside the session is dropped; a late one lands and moves the change sequence; the same call read twice is one', () => {
    agent('q');
    const { traceId, token } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'go' };
    request(traceId, t0, [said], { calls: ['a'] });
    request(traceId, t0 + 1010, [said, asks(['a']), ...answers(['a'])]);
    // Another session's line: the same id, ten minutes before this session began.
    noteToolCall('q', { callId: 'a', itemStartedAt: t0 - 600_000, itemEndedAt: t0 - 599_000 });
    expect(lastRequest(traceId).toolCalls).toBeUndefined();
    // The session ends after its requests (their times are ahead of the real clock here).
    vi.useFakeTimers({ now: t0 + 5000, toFake: ['Date'] });
    closeEndpointSession(token);
    const cursor = traceStore().changes({}).nextCursor;
    // Read after the session ended, the call ran inside it: it lands, and the session is changed.
    noteToolCall('q', { callId: 'a', itemStartedAt: t0 + 100, itemEndedAt: t0 + 900 });
    noteToolCall('q', { callId: 'a', itemStartedAt: t0 + 100, itemEndedAt: t0 + 900 });
    expect(lastRequest(traceId).toolCalls).toEqual([{ toolCallId: 'a', exit: null, ms: 800, denied: false, timedOut: false, failed: false }]);
    expect(traceStore().changes({ cursor }).sessions.map(s => s.traceId)).toEqual([traceId]);
    // Read a third time, nothing new: no change.
    const after = traceStore().changes({}).nextCursor;
    noteToolCall('q', { callId: 'a', itemStartedAt: t0 + 100, itemEndedAt: t0 + 900 });
    expect(traceStore().changes({ cursor: after }).sessions).toEqual([]);
  });

  it("7 and 8: a codex call's two halves complete each other, whichever is read first", () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'go' };
    request(traceId, t0, [said], { calls: ['call_c', 'call_e'] });
    request(traceId, t0 + 1010, [said, asks(['call_c', 'call_e']), ...answers(['call_c', 'call_e'])]);
    const big = 'x'.repeat(911);
    noteToolCall('q', codexToolPartOf(outputLine(t0 + 600, 'call_c', `Chunk ID: d887b6\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 87224\nOutput:\n${big}`))!);
    noteToolCall('q', codexToolPartOf(commandLine(t0 + 598, 'call_c', { started: t0 + 595, completed: t0 + 597, exit: 0, status: 'completed', output: 'y'.repeat(65536) }))!);
    noteToolCall('q', codexToolPartOf(commandLine(t0 + 300, 'call_e', { started: t0 + 100, completed: t0 + 300, exit: 3, status: 'failed', output: 'B-fail\n' }))!);
    noteToolCall('q', codexToolPartOf(outputLine(t0 + 601, 'call_e', 'Chunk ID: a2793c\nWall time: 0.2000 seconds\nProcess exited with code 3\nOriginal token count: 2\nOutput:\nB-fail\n'))!);
    // A later line contradicting what is known (another exit, another span) adds nothing: a fact said first is kept.
    noteToolCall('q', { callId: 'call_e', itemStartedAt: t0 + 150, itemEndedAt: t0 + 900, exit: 9 });
    const byId = Object.fromEntries(lastRequest(traceId).toolCalls!.map(c => [c.toolCallId, c]));
    expect(byId.call_c).toEqual({ toolCallId: 'call_c', exit: 0, ms: 2, denied: false, timedOut: false, failed: false, truncatedBytes: 65536 - 911 });
    expect(byId.call_e).toEqual({ toolCallId: 'call_e', exit: 3, ms: 200, denied: false, timedOut: false, failed: true });
  });
});

/** codex 0.170's lines, in the shapes measured on 27/11 (bench run tools-c1). */
function commandLine(at: number, callId: string, c: { started: number; completed: number; exit: number; status: string; output: string }): string {
  const secs = Math.floor((c.completed - c.started) / 1000);
  return JSON.stringify({
    timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: {
      type: 'item_completed', thread_id: 't', turn_id: 'u', started_at_ms: c.started, completed_at_ms: c.completed,
      item: {
        type: 'CommandExecution', id: callId, process_id: '83005', command: ['/bin/zsh', '-lc', 'echo secret-command'], cwd: '/somewhere',
        parsed_cmd: [], source: 'unified_exec_startup', status: c.status, aggregated_output: c.output, exit_code: c.exit,
        duration: { secs, nanos: ((c.completed - c.started) % 1000) * 1e6 },
      },
    },
  });
}
function outputLine(at: number, callId: string, output: string, type = 'function_call_output'): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { type, id: 'fco_1', call_id: callId, output } });
}

describe('codex 0.170 lines', () => {
  it('8: a command\'s end and its output line are read; nothing of its command or output is kept', () => {
    const t = Date.parse('2026-11-27T15:44:08.679Z');
    const item = codexToolPartOf(commandLine(t, 'call_5d7c', { started: t - 1, completed: t, exit: 3, status: 'failed', output: 'B-fail\n' }))!;
    expect(item).toEqual({ callId: 'call_5d7c', itemStartedAt: t - 1, itemEndedAt: t, exit: 3, failed: true, keptBytes: 7 });
    const out = codexToolPartOf(outputLine(t + 1190, 'call_5d7c', 'Chunk ID: a2793c\nWall time: 0.0000 seconds\nProcess exited with code 3\nOriginal token count: 2\nOutput:\nB-fail\n'))!;
    expect(out).toEqual({ callId: 'call_5d7c', outputAt: t + 1190, wallMs: 0, exit: 3, sentBytes: 7 });
    expect(JSON.stringify([item, out])).not.toMatch(/B-fail|secret-command|somewhere/);
  });

  it('8: a declined command is denied; apply_patch\'s output is read; a call that returned while running has no exit', () => {
    const t = Date.now();
    expect(codexToolPartOf(commandLine(t, 'call_n', { started: t, completed: t, exit: -1, status: 'declined', output: '' }))).toMatchObject({ callId: 'call_n', denied: true });
    expect(codexToolPartOf(outputLine(t, 'call_p', 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM notes.txt\n', 'custom_tool_call_output')))
      .toEqual({ callId: 'call_p', outputAt: t, wallMs: 0, exit: 0, sentBytes: Buffer.byteLength('Success. Updated the following files:\nM notes.txt\n') });
    const running = codexToolPartOf(outputLine(t, 'call_r', 'Chunk ID: 34ce09\nWall time: 0.3018 seconds\nProcess running with session ID 32998\nOriginal token count: 0\nOutput:\n'))!;
    expect(running).toEqual({ callId: 'call_r', outputAt: t, wallMs: 302, running: true, sentBytes: 0 });
    expect(toolCallRecordOf(running)).toEqual({ toolCallId: 'call_r', exit: null, ms: 302, denied: false, timedOut: false, failed: false });
  });

  it('11: any other line, or one that is not JSON, is no call', () => {
    for (const line of [
      '', 'not json', '[]', JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'u', last_agent_message: 'done' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [] } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'no call id' } }),
    ]) expect(codexToolPartOf(line), line).toBeNull();
  });
});

/** pi's lines, in the shapes of its session format (1.3.0 and 1.5.2). */
const piResult = (at: number, m: Record<string, unknown>) => JSON.stringify({ type: 'message', id: 'r1', parentId: 'a1', timestamp: new Date(at).toISOString(), message: { role: 'toolResult', toolName: 'bash', content: [], isError: false, timestamp: at, ...m } });

describe('pi lines', () => {
  it('9: the assistant line that asks for calls starts their batch; a result gives its run, exit, time-out and cut output', () => {
    const t = Date.parse('2026-11-27T16:00:00.000Z');
    const asking = JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date(t).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'make' } }], stopReason: 'toolUse', timestamp: t - 2000 } });
    expect(piToolLineOf(asking)).toEqual({ batchAt: t });
    expect(piToolLineOf(piResult(t + 1500, { toolCallId: 'tc1', durationMs: 1480, isError: true, content: [{ type: 'text', text: 'make: *** [all] Error 2\n\nCommand exited with code 2' }] })))
      .toEqual({ part: { callId: 'tc1', wallMs: 1480, exit: 2, failed: true } });
    expect(piToolLineOf(piResult(t, { toolCallId: 'tc2', durationMs: 40, content: [{ type: 'text', text: 'ok' }] })))
      .toEqual({ part: { callId: 'tc2', wallMs: 40, exit: 0 } });
    expect(piToolLineOf(piResult(t, { toolCallId: 'tc3', durationMs: 5003, isError: true, content: [{ type: 'text', text: 'partial\n\nCommand timed out after 5 seconds' }] })))
      .toEqual({ part: { callId: 'tc3', wallMs: 5003, timedOut: true, failed: true } });
    expect(piToolLineOf(piResult(t, { toolCallId: 'tc4', durationMs: 12, content: [{ type: 'text', text: 'last lines' }], details: { truncation: { truncated: true, totalBytes: 120_000, outputBytes: 51_200, totalLines: 9000, outputLines: 2000 } } })))
      .toEqual({ part: { callId: 'tc4', wallMs: 12, exit: 0, truncatedBytes: 120_000 - 51_200 } });
    // A tool that is no shell has no exit code.
    expect(piToolLineOf(piResult(t, { toolName: 'read', toolCallId: 'tc5', durationMs: 3, content: [{ type: 'text', text: 'file text' }] })))
      .toEqual({ part: { callId: 'tc5', wallMs: 3 } });
  });

  it('9: a call blocked before it ran is denied, and took no time', () => {
    const t = Date.now();
    const blocked = piToolLineOf(piResult(t, { toolCallId: 'tc6', isError: true, content: [{ type: 'text', text: 'Tool execution was blocked' }] }));
    expect(blocked).toEqual({ part: { callId: 'tc6', denied: true, failed: true } });
    expect(toolCallRecordOf({ ...(blocked as { part: { callId: string } }).part, startedAt: t })).toEqual({ toolCallId: 'tc6', exit: null, ms: 0, denied: true, timedOut: false, failed: true });
  });

  it('11: any other line is no call', () => {
    for (const line of ['', '{', JSON.stringify({ type: 'session', id: 's' }), JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [] } })]) expect(piToolLineOf(line), line).toBeNull();
  });
});

describe('what leaves', () => {
  it('10: the export and the upload carry the gap and the calls, ids, numbers and flags only', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const said = { role: 'user', content: 'go' };
    request(traceId, t0, [said], { calls: ['call_e'] });
    request(traceId, t0 + 1010, [said, asks(['call_e']), ...answers(['call_e'])]);
    noteToolCall('q', codexToolPartOf(commandLine(t0 + 300, 'call_e', { started: t0 + 100, completed: t0 + 300, exit: 3, status: 'failed', output: 'B-fail\n' }))!);
    const doc = sessionDocument(traceStore(), traceId)!;
    const row = doc.requests.at(-1)!;
    expect(row.gap).toEqual({ ms: 1000, toolMs: 200, inputWaitMs: 0, heldMs: 0, harnessMs: 800 });
    expect(row.tool_calls).toEqual([{ toolCallId: 'call_e', exit: 3, ms: 200, denied: false, timedOut: false, failed: true }]);
    const body = traceUploader().preview(traceId)!.document.batches[0].body as { requests: Array<Record<string, unknown>> };
    const sent = body.requests.at(-1)!;
    expect(sent.gap).toEqual({ ms: 1000, toolMs: 200, inputWaitMs: 0, heldMs: 0, harnessMs: 800 });
    expect(sent.toolCalls).toEqual([{ toolCallId: 'call_e', exit: 3, ms: 200, denied: false, timedOut: false, failed: true }]);
    expect(body.requests[0].gap).toBeUndefined();
    expect(JSON.stringify([row.gap, row.tool_calls, sent.gap, sent.toolCalls])).not.toMatch(/B-fail|secret-command|somewhere/);
  });

  it(`10: a request carrying more calls than ${64} sends the first ones and counts the rest`, () => {
    expect(TOOL_CALLS_PER_REQUEST_MAX).toBe(64);
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() + 1000;
    const ids = Array.from({ length: 70 }, (_, i) => `c${i}`);
    const said = { role: 'user', content: 'fan out' };
    request(traceId, t0, [said], { calls: ids });
    request(traceId, t0 + 1010, [said, asks(ids), ...answers(ids)]);
    for (const id of ids) noteToolCall('q', { callId: id, itemStartedAt: t0 + 100, itemEndedAt: t0 + 200 });
    const body = traceUploader().preview(traceId)!.document.batches[0].body as { requests: Array<Record<string, unknown>> };
    const sent = body.requests.at(-1)!;
    expect((sent.toolCalls as unknown[]).length).toBe(64);
    expect(sent.toolCallsOmitted).toBe(6);
    expect(sent.gap).toMatchObject({ toolMs: 100 });
  });
});
