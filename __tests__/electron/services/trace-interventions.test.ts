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
 * A traced session's interventions, per turn (trace feature B3, 27/11): what a person, an orchestrator or Tars did to
 * the agent's work, the labels a reader trains and evaluates on.
 * - `interrupted`: an Esc or a Ctrl-C from the window into a turn, while the model answered or while its tools ran;
 *   the terminal ended by a stop, a removal or the quit while a turn was open; or the CLI's own log saying the turn
 *   was interrupted (codex's turn_aborted, pi's).
 * - `restarted`: the agent restarted (asked, for its settings, or its terminal replaced).
 * - `corrected`: the next instruction came from the owner or an orchestrator within 10 minutes of a turn that ended
 *   done; `next` keeps who typed it and the raw delay in seconds, whatever the threshold.
 * - `redelegated`: a later session took this session's task, as A3 links them (start.redelegatedFrom), never a second
 *   copy of that link.
 *
 * How it fails, written before the code:
 *  1. An Esc or a Ctrl-C into a running answer is not on its turn; one into an idle prompt is (it cut nothing); one
 *     while the tools run is not, or is said to be during the answer; an arrow key is taken for an Esc.
 *  2. The cut it caused is not named on the request (cutOf): the request's cancel stays `unknown`; or a key typed
 *     before the request started, or long before the cut, is taken for its cause.
 *  3. A stop while a turn is open is no interruption, or a stop at an idle prompt is one; Tars ending the terminal is
 *     not the cause of the cut, or a key wins over it; a note of Tars's names the cause of a later session's cut.
 *  4. A restart, or a terminal replaced, is not on the turn it cut or followed.
 *  5. A correction is missed: the owner's words typed into the pane are not theirs (an `unknown` turn), so none of
 *     their corrections is ever seen; or one after 10 minutes, from an agent, or after a turn that did not end done,
 *     is marked corrected; or the delay and the author are missing for those.
 *  6. A re-delegation is not on the earlier session's last turn, is stored twice, or leaves that session's change
 *     sequence where it was, so it is never sent again with the link.
 *  7. An intervention lands on the wrong turn: the one before, or none while the request opening the turn is in flight.
 *  8. A CLI's own log saying the turn was interrupted is not tied to the request it cut (its cause stays `unknown`),
 *     or is tied to another session's request or one minutes old, or adds a second interruption to one a key made.
 *  9. The counts: a request the harness or Tars cut counts as an endpoint error; one the endpoint or the proxy cut does
 *     not; `abandonedWhileHeld` counts any cancel.
 * 10. What leaves: a turn's interventions are missing from the export and the upload's preview, or carry free text
 *     (a correction's words go as the message they are, scrubbed, never in a field); the notice has no line for them.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

vi.mock('../../../electron/services/endpoint-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/endpoint-proxy')>()),
  startEndpointProxy: vi.fn(),
  stopEndpointProxy: vi.fn(),
}));

import {
  TRACES_DB_FILE, TRACES_INSTALL_FILE, closeEndpointSession, configureTraces, cutOf, liveTraceOf, noteCliInterrupt,
  noteTarsEnding, noteTypedForTraces, noteWindowKeys, openEndpointSession, requestInFlight, stopTracesRuntime, traceStore,
  traceUploader, CORRECTION_WINDOW_MS,
} from '../../../electron/services/traces-runtime';
import { noteSessionStart } from '../../../electron/core/session-start';
import { oneTaskQueue } from '../../../electron/core/one-task';
import { ESC_WAIT_MS } from '../../../electron/core/interrupt-keys';
import { sessionDocument } from '../../../electron/services/trace-export';
import { rememberTerminalOwner, writeHumanInput, resetTerminalInput } from '../../../electron/core/pty-manager';

const EP = 'ep-b3test';
let home: string;
let project: string;
let fleet: Map<string, AgentStatus>;
let settings: AppSettings;

function agent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  const a = {
    id, name: id.toUpperCase(), status: 'idle', provider: 'qwen-code', model: 'open-model-1', endpointId: EP, traces: true,
    projectPath: project, skills: [], output: [], lastActivity: '', ...over,
  } as AgentStatus;
  fleet.set(id, a);
  return a;
}

function open(agentId: string): { traceId: string; token: string } {
  const s = openEndpointSession(agentId);
  expect(s.token, 'no endpoint session').toBeTruthy();
  return { traceId: liveTraceOf(agentId)!, token: s.token! };
}

/** A request as the proxy records it: a new instruction opens a turn; `tools` leaves the turn open. */
function request(traceId: string, agentId: string, startedAt: number, over: { said?: string; tools?: boolean; history?: unknown[]; cancel?: unknown; error?: string; status?: number; attempts?: number } = {}): void {
  const said = over.said ?? `go ${startedAt}`;
  const messages = over.history ?? [{ role: 'user', content: said }];
  const body = Buffer.from(JSON.stringify({ model: 'open-model-1', stream: false, tools: [{ type: 'function', function: { name: 'sh', parameters: {} } }], messages }));
  const message = over.tools
    ? { role: 'assistant', content: null, tool_calls: [{ id: `c${startedAt}`, type: 'function', function: { name: 'sh', arguments: '{}' } }] }
    : { role: 'assistant', content: 'done' };
  const reply = Buffer.from(JSON.stringify({ id: 'c1', choices: [{ index: 0, message, finish_reason: over.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  expect(traceStore().ingest({
    traceId, agentId, surface: 'openai_chat', startedAt, firstByteAt: startedAt + 5, endedAt: startedAt + 10, status: over.status ?? 200,
    contentType: 'application/json', requestBody: body, responseBody: reply, attempts: over.attempts ?? 1, heldMs: 0,
    ...(over.cancel ? { cancel: over.cancel } : {}), ...(over.error ? { error: over.error } : {}),
  } as never)).toBeTruthy();
}

const turnsOf = (traceId: string) => traceStore().session(traceId)!.turns;
const waitEsc = () => new Promise(r => setTimeout(r, ESC_WAIT_MS + 30));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-b3-'));
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
  for (const t of oneTaskQueue.snapshot().items) oneTaskQueue.cancel(t.ref, 'test over');
  vi.useRealTimers();
  fs.rmSync(path.dirname(TRACES_DB_FILE), { recursive: true, force: true });
  fs.rmSync(TRACES_INSTALL_FILE, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('interrupted', () => {
  it('1, 2 and 7: an Esc into a running answer is on its turn, and names the cut of its request', async () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now();
    requestInFlight('q', 1);
    noteWindowKeys('q', '\x1b[A', t0 + 1);
    noteWindowKeys('q', '\x1b', t0 + 20);
    // The harness hangs up at once, before the Esc's wait is over: the cut is named all the same.
    expect(cutOf('q', t0, t0 + 25)).toEqual({ by: 'harness', cause: 'esc' });
    requestInFlight('q', -1);
    await waitEsc();
    request(traceId, 'q', t0, { cancel: { by: 'harness', cause: 'esc', at: t0 + 25, deliveredBytes: 12 } });
    expect(turnsOf(traceId)[0].interventions).toEqual({ interrupted: { at: t0 + 20, by: 'esc', during: 'answer' } });
    // A key before the request started, or long before the cut, is not its cause.
    expect(cutOf('q', t0 + 21, t0 + 30)).toBeUndefined();
    expect(cutOf('q', t0, t0 + 20 + 60_000)).toBeUndefined();
  });

  it('1: a Ctrl-C while the tools run is during the tools; an Esc at an idle prompt is nothing', async () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() - 10_000;
    request(traceId, 'q', t0, { tools: true });
    noteWindowKeys('q', '\x03', t0 + 1000);
    expect(turnsOf(traceId)[0].interventions).toEqual({ interrupted: { at: t0 + 1000, by: 'ctrl_c', during: 'tools' } });

    agent('r');
    const other = open('r').traceId;
    request(other, 'r', t0);
    noteWindowKeys('r', '\x1b', t0 + 1000);
    await waitEsc();
    expect(turnsOf(other)[0].interventions).toBeUndefined();
  });

  it('3: a stop while a turn is open interrupts it and names the cut, over a key; a stop at an idle prompt does not', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() - 10_000;
    request(traceId, 'q', t0, { tools: true });
    noteWindowKeys('q', '\x03', t0 + 100);
    noteTarsEnding('q', 'stop', t0 + 200);
    expect(cutOf('q', t0 + 150, t0 + 210)).toEqual({ by: 'tars', cause: 'stop' });
    expect(turnsOf(traceId)[0].interventions?.interrupted).toEqual({ at: t0 + 100, by: 'ctrl_c', during: 'tools' });

    agent('r');
    const idle = open('r').traceId;
    request(idle, 'r', t0);
    noteTarsEnding('r', 'stop', t0 + 500);
    expect(turnsOf(idle)[0].interventions).toBeUndefined();

    // A later session of the same agent: Tars's note of the earlier stop names none of its cuts.
    expect(cutOf('r', t0 + 600, t0 + 700)).toBeUndefined();
  });

  it('8: a CLI\'s own log saying the turn was interrupted is tied to the request it cut, once', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() - 5000;
    request(traceId, 'q', t0, { cancel: { by: 'harness', cause: 'unknown', at: t0 + 300, deliveredBytes: 40 } });
    agent('r');
    const other = open('r').traceId;
    request(other, 'r', t0, { cancel: { by: 'harness', cause: 'unknown', at: t0 + 300, deliveredBytes: 40 } });
    noteCliInterrupt('q', t0 + 2000);
    const cut = turnsOf(traceId)[0];
    expect(cut.requests[0].cancel).toMatchObject({ by: 'harness', cause: 'cli_interrupt' });
    expect(cut.interventions).toEqual({ interrupted: { at: t0 + 300, by: 'cli', during: 'answer' } });
    expect(turnsOf(other)[0].requests[0].cancel).toMatchObject({ cause: 'unknown' });

    // A request minutes old is not the one cut.
    agent('s');
    const old = open('s').traceId;
    request(old, 's', t0 - 600_000, { cancel: { by: 'harness', cause: 'unknown', at: t0 - 599_000, deliveredBytes: 1 } });
    noteCliInterrupt('s', t0 + 2000);
    expect(turnsOf(old)[0].requests[0].cancel).toMatchObject({ cause: 'unknown' });
  });

  it('8: an Esc then the CLI\'s log of it: one interruption, the cause the key\'s', async () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now();
    requestInFlight('q', 1);
    noteWindowKeys('q', '\x1b', t0 + 10);
    requestInFlight('q', -1);
    await waitEsc();
    request(traceId, 'q', t0, { cancel: { by: 'harness', cause: 'esc', at: t0 + 15, deliveredBytes: 5 } });
    noteCliInterrupt('q', t0 + 1500);
    expect(turnsOf(traceId)[0].interventions).toEqual({ interrupted: { at: t0 + 10, by: 'esc', during: 'answer' } });
    expect(turnsOf(traceId)[0].requests[0].cancel).toMatchObject({ cause: 'esc' });
  });
});

describe('restarted', () => {
  it('4: a restart, or a terminal replaced, is on the turn it cut or followed', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() - 10_000;
    request(traceId, 'q', t0);
    request(traceId, 'q', t0 + 1000, { said: 'next step' });
    noteTarsEnding('q', 'restart', t0 + 5000);
    expect(turnsOf(traceId).map(t => t.interventions?.restarted)).toEqual([undefined, { at: t0 + 5000, by: 'restart' }]);
    expect(cutOf('q', t0 + 4000, t0 + 5050)).toEqual({ by: 'tars', cause: 'restart' });

    agent('r');
    const replaced = open('r').traceId;
    request(replaced, 'r', t0);
    noteTarsEnding('r', 'replace', t0 + 2000);
    expect(turnsOf(replaced)[0].interventions).toEqual({ restarted: { at: t0 + 2000, by: 'replace' } });
  });
});

describe('corrected', () => {
  it('5: the owner\'s words typed into the pane are theirs, and a correction within 10 minutes of a done turn is marked', () => {
    agent('q');
    const { traceId } = open('q');
    const pty = { write: () => {}, pid: 4242 } as unknown as Parameters<typeof writeHumanInput>[0];
    rememberTerminalOwner(pty, 'q');
    const t0 = Date.now() - 3600_000;
    request(traceId, 'q', t0, { said: 'build the parser' });
    for (const ch of 'no, the other one') writeHumanInput(pty, ch);
    writeHumanInput(pty, '\r');
    const typedAt = Date.now();
    resetTerminalInput(pty);
    const opened = typedAt + 2000;
    request(traceId, 'q', opened, { said: 'no, the other one' });
    const [first, second] = turnsOf(traceId);
    expect(second.author).toBe('user');
    expect(first.interventions?.next?.by).toBe('user');
    // The raw delay: from the done turn's end to the words typed, in seconds.
    expect(first.interventions?.next?.delaySec).toBeCloseTo((typedAt - (t0 + 10)) / 1000, 0);
    // An hour later: no correction, the delay and author kept.
    expect(first.interventions?.corrected).toBeUndefined();
  });

  it('5: within the window, from the owner or an orchestrator, after a done turn; not from an agent, not after a failed turn', () => {
    agent('q');
    agent('w', { role: 'worker' } as Partial<AgentStatus>);
    agent('lead', { role: 'orchestrator', provider: 'claude', endpointId: undefined } as Partial<AgentStatus>);
    const { traceId } = open('q');
    vi.useFakeTimers({ toFake: ['Date'] });
    let at = Date.now() - 3600_000;
    /** Words typed into the session `after` ms past `at`, then the turn they open, which ends 10 ms on. */
    const next = (after: number, said: string, sender: Parameters<typeof noteTypedForTraces>[0], over: { error?: string } = {}) => {
      at += after;
      vi.setSystemTime(at);
      noteTypedForTraces(sender, said);
      at += 500;
      request(traceId, 'q', at, { said, ...over });
      at += 10;
    };
    request(traceId, 'q', at, { said: 'first task' });
    at += 10;
    next(120_000, 'fix the test', { agentId: 'q', sender: { kind: 'user', via: 'window' } });
    next(60_000, 'also the docs', { agentId: 'q', sender: { kind: 'agent', id: 'w', name: 'W' } });
    next(30_000, 'and the changelog', { agentId: 'q', sender: { kind: 'agent', id: 'lead', name: 'Lead' } }, { error: 'engine error' });
    next(45_000, 'try that again', { agentId: 'q', sender: { kind: 'user', via: 'window' } });
    next(CORRECTION_WINDOW_MS + 1000, 'one more thing', { agentId: 'q', sender: { kind: 'user', via: 'window' } });
    const t = turnsOf(traceId).map(x => x.interventions);
    // Done, then the owner 120 s later: corrected, with the raw delay and the author.
    expect(t[0]).toEqual({ next: { by: 'user', delaySec: 120 }, corrected: true });
    // Done, then an agent: not corrected, the delay and the author kept.
    expect(t[1]).toEqual({ next: { by: 'agent', delaySec: 60 } });
    // Done, then an orchestrator: corrected.
    expect(t[2]).toEqual({ next: { by: 'orchestrator', delaySec: 30 }, corrected: true });
    // Failed, then the owner within the window: not corrected.
    expect(t[3]).toEqual({ next: { by: 'user', delaySec: 45 } });
    // Done, then the owner past the window: not corrected, whatever the threshold the delay kept.
    expect(t[4]).toEqual({ next: { by: 'user', delaySec: (CORRECTION_WINDOW_MS + 1000) / 1000 } });
  });
});

describe('redelegated, and what leaves', () => {
  it('6: a later session that took this session\'s task is on its last turn, once, and the earlier session goes again', async () => {
    agent('q');
    agent('r');
    const ref = oneTaskQueue.enqueue('q', { requesterId: 'lead', title: 'Run the probe' }).ref;
    expect(oneTaskQueue.takeTurn('q', ref)).toBe(true);
    noteSessionStart('q', { trigger: 'task', via: 'api', taskRef: ref, requesterAgentId: 'lead' });
    const first = open('q');
    const t0 = Date.now() - 10_000;
    request(first.traceId, 'q', t0);
    request(first.traceId, 'q', t0 + 1000, { said: 'continue' });
    closeEndpointSession(first.token);
    await expect.poll(() => traceStore().session(first.traceId)?.session.endedAt, { timeout: 5000 }).toBeTypeOf('number');
    const seqBefore = traceStore().seqOf(first.traceId)!;
    noteSessionStart('r', { trigger: 'task', via: 'api', taskRef: ref, requesterAgentId: 'lead' });
    const second = open('r');
    expect(traceStore().session(second.traceId)?.start?.redelegatedFrom).toBe(first.traceId);
    const turns = turnsOf(first.traceId);
    expect(turns[0].interventions?.redelegated).toBeUndefined();
    expect(turns[1].interventions?.redelegated).toEqual({ to: second.traceId, at: expect.any(Number) });
    // A3's link is read, never kept twice: the later session's start still holds it, alone.
    expect(JSON.stringify(traceStore().session(first.traceId)!.outcome ?? {})).not.toContain(second.traceId);
    expect(traceStore().seqOf(first.traceId)!).toBeGreaterThan(seqBefore);
  });

  it('9: a cut by the harness or Tars is no endpoint error; the endpoint\'s and the proxy\'s are; abandoned counts the held ones', () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() - 10_000;
    request(traceId, 'q', t0, { cancel: { by: 'harness', cause: 'esc', at: t0 + 5, deliveredBytes: 3 } });
    request(traceId, 'q', t0 + 100, { said: 'b', cancel: { by: 'tars', cause: 'stop', at: t0 + 105, deliveredBytes: 0 } });
    request(traceId, 'q', t0 + 200, { said: 'c', cancel: { by: 'endpoint', cause: 'stream_cut', at: t0 + 205, deliveredBytes: 9 }, error: 'the endpoint closed the stream' });
    request(traceId, 'q', t0 + 300, { said: 'd', status: 503, attempts: 3, cancel: { by: 'proxy', cause: 'hold_ceiling', at: t0 + 305, deliveredBytes: 0 } });
    request(traceId, 'q', t0 + 400, { said: 'e', status: 499, attempts: 2, cancel: { by: 'harness', cause: 'abandoned_while_held', at: t0 + 405, deliveredBytes: 0 } });
    expect(traceStore().requestCounts(traceId)).toEqual({ held: 2, errors: 2, abandoned: 1 });
    expect(turnsOf(traceId).map(t => t.finalStatus)).toEqual(['abandoned', 'abandoned', 'failed', 'failed', 'abandoned']);
    expect(turnsOf(traceId)[2].requests[0].error).toBe('the endpoint closed the stream');
  });

  it('10: the turns\' interventions are in the export and the preview, with no free text', async () => {
    agent('q');
    const { traceId } = open('q');
    const t0 = Date.now() - 10_000;
    request(traceId, 'q', t0, { tools: true });
    noteWindowKeys('q', '\x03', t0 + 100);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0 + 1500);
    noteTypedForTraces({ agentId: 'q', sender: { kind: 'user', via: 'window' } }, 'PRIVATE-CORRECTION-WORDS try again');
    request(traceId, 'q', t0 + 2000, { said: 'PRIVATE-CORRECTION-WORDS try again' });
    const doc = sessionDocument(traceStore(), traceId)!;
    expect(doc.turns[0].interventions).toEqual({ interrupted: { at: t0 + 100, by: 'ctrl_c', during: 'tools' }, next: { by: 'user', delaySec: expect.any(Number) } });
    const preview = traceUploader().preview(traceId)!;
    const turns = (preview.document.batches[0].body as { turns: Array<{ interventions?: unknown }> }).turns;
    expect(turns[0].interventions).toEqual(doc.turns[0].interventions);
    expect(JSON.stringify(turns)).not.toContain('PRIVATE-CORRECTION-WORDS');
  });
});
