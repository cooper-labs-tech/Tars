// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

/**
 * A traced session's task, its trigger, its queue times, its start commit, its pull request's end, and the demand that
 * never reached the endpoint (27/11, trace feature A3; the reader's notes on what an arrival model and a split by task
 * need from Tars).
 *
 * A trace is one terminal of one agent on an inference endpoint (openEndpointSession at its spawn,
 * closeEndpointSession at its exit). What started it is said by the path that starts it, just before the spawn
 * (core/session-start.ts), since the spawn itself does not know.
 *
 * How it fails, written before the code:
 *
 * At the session's start:
 *  1. The trigger is missing or guessed. A session started for a delegated task reads `task`, with its ref and who
 *     asked; one the owner started from the window `owner`; a channel's `channel`, with which; one started again
 *     after a restart (the agent's or Tars's) `restart`; one an agent or Tars opened with no task `start`; an agent
 *     asleep at its spawn `wake`, whatever woke it, the task it woke for kept; and a start nobody named `unknown`,
 *     never one of the others.
 *  2. A start's note leaks: one left by a start that opened no terminal is read by a later start past its window, or
 *     one agent's note is read by another's spawn.
 *  3. The queue times are wrong or guessed: `queuedAt` is not when the task entered the agent's line, `handedAt` not
 *     when its turn was taken, `firstRequestAt` not the session's first request at the endpoint. A time not known is
 *     written anyway (it must be absent).
 *  4. The start commit and branch are not those of the folder the agent works in (its worktree when it has one), or a
 *     folder that is no git checkout keeps the session from opening (they are absent then).
 *  5. A re-delegation is not linked: a task ref already handed to another session, handed again, does not read
 *     `redelegation` naming that session.
 *
 * At its end:
 *  6. `outcome.task` is empty or not the ledger's: the session's own task (the one it started for, else the first it
 *     ran) with its id, source, parentTaskId, requesterAgentId, final status, start and end. `outcome.tasks` lists a
 *     task of another agent, or one that ran entirely outside the session.
 *  7. A task's queue times are missing: from the queue for a delegated task (queued, then handed when its turn came),
 *     from the hand-off for a task handed without the queue, and from its turn for a task the owner typed; its first
 *     request is not the first after it was handed.
 *  8. The same task in two sessions is not linked both ways, or the link leaves the earlier session's change sequence
 *     where it was, so a reader or the upload never sees it.
 *
 * Its pull request:
 *  9. A pull request merged or closed is not written into the ended sessions whose branch it was; or it is written
 *     into a session of another repository, a session on another branch, a session still open, or one that started
 *     after the pull request closed; or writing it leaves the change sequence where it was; or writing the same state
 *     again moves it (an unchanged session sent again).
 *
 * The demand that never arrived:
 * 10. A task taken out of an agent's queue (task_cancel, taken back in the window, dropped with a stop, the queue
 *     cleared, its agent removed, not handed over again) leaves no record in the agent's live session, or its reason
 *     is free text rather than a kind; one for an agent with no traced session is written somewhere.
 * 11. A request the harness gave up while the proxy held it ends its turn `failed` and counts as an endpoint error
 *     (it ends it `abandoned`, and counts apart). The proxy's side of it: endpoint-proxy-held-abandoned.test.ts.
 *
 * What leaves:
 * 12. A new field is missing from the upload's preview (what the user consents on): the start (its trigger, queue
 *     times, commit and branch), the tasks, the pull request's end, the lost demand, a request's cancel; or a name
 *     leaves with them (who woke or started the session, a task's text).
 *
 * The outcome's size, and the task on each turn (27/11, the back office's needs on #675):
 * 13. `outcome.tasks` grows without bound: a permanent agent's long session serves many tasks, and the back office
 *     refuses an outcome over 16 KiB, its whole batch with it. The last 50 are kept and `tasksOmitted` counts the
 *     rest; fewer when 50 would still pass the cap (every field filled, links to other sessions), the oldest first.
 *     At 0 tasks: neither key. At 50: all, no count. At 51: the last 50, one omitted. The session's own task stays.
 * 14. A task dropped from that list loses its link to the turns that served it: a turn opened by a message that
 *     handed a task over (its ref, core/task-requests.ts) does not carry that ref; the first turn of a session started
 *     on a task does not carry the start's ref; a turn with neither carries one anyway.
 *
 * The Audit's NO-MERGE at 0346e9a65:
 * 15. (M1) A long session is refused whole by the back office and holds every later upload back. Its outcome (a
 *     permanent agent's 200 tasks) passes the 16 KiB cap, or its lost demand (hundreds of queue drops) grows without
 *     bound. The lost demand must keep its last 50 within its budget, with `lostDemandOmitted` counting the rest; the
 *     session must upload to a back office that refuses an outcome over 16 KiB.
 * 16. (L1) gh is asked for good. Asked about a session ended more than 14 days ago, or one on its repository's default
 *     branch (origin's HEAD, else main or master), which never gets a pull request.
 * 17. (L2) A request given up while held counts as one that reached the endpoint: it adds to its turn's and its
 *     session's request count and to its turn's model time, or it is the session's or a task's first request.
 * 18. (Info) A start that opened no terminal leaves its note for the agent's next spawn to read.
 *
 * The negative witness is feat/traces-window at 69c8f3f08, which records none of it; for 13 and 14, #675 at
 * 0346e9a65, which lists every task and puts none on a turn; for 15 to 18, #675 at 77463aad7.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

// The proxy binds a port of its own at the first session: not in a unit test.
vi.mock('../../../electron/services/endpoint-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/endpoint-proxy')>()),
  startEndpointProxy: vi.fn(),
  stopEndpointProxy: vi.fn(),
}));

import {
  TRACES_DB_FILE, TRACES_INSTALL_FILE, applyPrStates, closeEndpointSession, configureTraces, liveTraceOf, noteTypedForTraces, openEndpointSession,
  recordConsent, sessionsToAskForPr, stopTracesRuntime, traceStore, traceUploader,
} from '../../../electron/services/traces-runtime';
import { LOST_DEMAND_BYTES_MAX, LOST_DEMAND_MAX, OUTCOME_BYTES_MAX, boundOutcomeTasks, type TraceTask } from '../../../electron/services/trace-store';
import { clearSessionStart, noteSessionStart, takeSessionStart, START_NOTE_MS } from '../../../electron/core/session-start';
import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { oneTaskQueue } from '../../../electron/core/one-task';
import { createTaskLedger, setLiveTaskLedger, type TaskAgentView, type TaskLedger } from '../../../electron/services/task-ledger';
import { sessionDocument } from '../../../electron/services/trace-export';

const EP = 'ep-a3test';
const LEAD = 'lead-0000-a3';
let home: string;
let project: string;
let other: string;
let fleet: Map<string, AgentStatus>;
let ledger: TaskLedger;
let settings: AppSettings;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

function repo(dir: string, branch: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', 'README');
  git(dir, 'commit', '-q', '-m', 'first');
  return git(dir, 'rev-parse', 'HEAD');
}

function agent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  const a = {
    id, name: id.toUpperCase(), status: 'idle', provider: 'qwen-code', model: 'open-model-1', endpointId: EP, traces: true,
    projectPath: project, skills: [], output: [], lastActivity: '', ...over,
  } as AgentStatus;
  fleet.set(id, a);
  return a;
}

const view = (a: AgentStatus, over: Partial<TaskAgentView> = {}): TaskAgentView => ({ id: a.id, status: 'running', projectPath: a.projectPath, provider: a.provider, ...over });
const startOf = (traceId: string) => traceStore().session(traceId)?.start;
const outcomeOf = (traceId: string) => traceStore().session(traceId)?.outcome;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-a3-'));
  project = path.join(home, 'project');
  other = path.join(home, 'other');
  fleet = new Map();
  settings = {
    inferenceEndpoints: [{ id: EP, name: 'Remote', baseUrl: 'http://127.0.0.1:9/v1', approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, models: ['open-model-1'] }],
    traces: { projects: [project, other], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: '*', models: '*' }], excludeClosedModels: true, uploadUrl: '' },
  } as unknown as AppSettings;
  configureTraces({
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    writeSettings: () => {},
    getAgent: (id) => fleet.get(id),
    emit: () => {},
    // The agents' queue, as main.ts hands it in.
    queue: oneTaskQueue,
  });
  ledger = createTaskLedger({ file: path.join(home, 'task-ledger.jsonl'), textFile: path.join(home, 'private', 'task-texts.jsonl') });
  setLiveTaskLedger(ledger);
});

afterEach(() => {
  stopTracesRuntime();
  setLiveTaskLedger(null);
  for (const t of oneTaskQueue.snapshot().items) oneTaskQueue.cancel(t.ref, 'test over');
  for (const id of fleet.keys()) oneTaskQueue.runEnded(id);
  vi.useRealTimers();
  fs.rmSync(path.dirname(TRACES_DB_FILE), { recursive: true, force: true });
  fs.rmSync(TRACES_INSTALL_FILE, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** A delegated task as run-task hands one over: queued, its turn taken, a session started on it. */
function delegate(agentId: string, at: { queued: number; handed: number }): string {
  const queued = oneTaskQueue.enqueue(agentId, { requesterId: LEAD, title: 'Run the probe' }, at.queued);
  expect(oneTaskQueue.takeTurn(agentId, queued.ref, undefined, at.handed)).toBe(true);
  noteSessionStart(agentId, { trigger: 'task', via: 'api', taskRef: queued.ref, requesterAgentId: LEAD });
  return queued.ref;
}

function open(agentId: string): { traceId: string; token: string } {
  const s = openEndpointSession(agentId);
  expect(s.token, 'no endpoint session').toBeTruthy();
  const traceId = liveTraceOf(agentId);
  expect(traceId, 'not traced').toBeTruthy();
  return { traceId: traceId!, token: s.token! };
}

async function close(token: string, traceId: string): Promise<void> {
  closeEndpointSession(token);
  await expect.poll(() => traceStore().session(traceId)?.session.endedAt, { timeout: 5000 }).toBeTypeOf('number');
}

/** A request of the session as the proxy records it. */
function request(traceId: string, agentId: string, startedAt: number, over: Record<string, unknown> = {}): void {
  const body = Buffer.from(JSON.stringify({ model: 'open-model-1', stream: false, tools: [{ type: 'function', function: { name: 'sh', parameters: {} } }], messages: [{ role: 'user', content: `go ${startedAt}` }] }));
  const reply = Buffer.from(JSON.stringify({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  expect(traceStore().ingest({
    traceId, agentId, surface: 'openai_chat', startedAt, firstByteAt: startedAt + 5, endedAt: startedAt + 10, status: 200,
    contentType: 'application/json', requestBody: body, responseBody: reply, attempts: 1, heldMs: 0, ...over,
  } as never)).toBeTruthy();
}

describe('at a session\'s start', () => {
  it('1 and 3. a delegated task: `task`, its ref and asker, queued when it entered the line, handed when its turn came', async () => {
    repo(project, 'main');
    agent('q');
    const now = Date.now();
    const ref = delegate('q', { queued: now - 9000, handed: now - 2000 });
    const { traceId } = open('q');
    expect(startOf(traceId)).toMatchObject({ trigger: 'task', via: 'api', taskRef: ref, requesterAgentId: LEAD, queuedAt: now - 9000, handedAt: now - 2000 });
  });

  it('1. the window\'s start is `owner`; a channel\'s `channel`, naming it; a restart `restart`; one with no task `start`', () => {
    const cases: Array<[Parameters<typeof noteSessionStart>[1], Record<string, unknown>]> = [
      [{ trigger: 'owner', via: 'window' }, { trigger: 'owner', via: 'window' }],
      [{ trigger: 'channel', via: 'slack' }, { trigger: 'channel', via: 'slack' }],
      [{ trigger: 'restart', via: 'tars' }, { trigger: 'restart', via: 'tars' }],
      [{ trigger: 'start', via: 'api', requesterAgentId: LEAD }, { trigger: 'start', via: 'api', requesterAgentId: LEAD }],
    ];
    for (const [i, [note, want]] of cases.entries()) {
      agent(`a${i}`);
      noteSessionStart(`a${i}`, note);
      const { traceId } = open(`a${i}`);
      expect(startOf(traceId)).toMatchObject(want);
      // Nothing known of a queue: no time is written.
      expect(startOf(traceId)).not.toHaveProperty('queuedAt');
      expect(startOf(traceId)).not.toHaveProperty('handedAt');
    }
  });

  it('1. an agent asleep at its spawn wakes: `wake`, the task it woke for kept', () => {
    agent('s', { status: 'asleep' });
    const now = Date.now();
    const ref = delegate('s', { queued: now - 100, handed: now - 50 });
    const { traceId } = open('s');
    expect(startOf(traceId)).toMatchObject({ trigger: 'wake', taskRef: ref, requesterAgentId: LEAD });
  });

  it('1 and 2. a start nobody named is `unknown`; another agent\'s note, or one past its window, is not read', () => {
    agent('x');
    agent('y');
    noteSessionStart('y', { trigger: 'owner', via: 'window' });
    const first = open('x');
    expect(startOf(first.traceId)).toMatchObject({ trigger: 'unknown' });
    closeEndpointSession(first.token);
    // y's own note is still y's.
    expect(startOf(open('y').traceId)).toMatchObject({ trigger: 'owner', via: 'window' });
    // A note its start never took (no terminal was opened), read by a spawn past its window.
    vi.useFakeTimers({ toFake: ['Date'] });
    noteSessionStart('x', { trigger: 'owner', via: 'window' });
    vi.setSystemTime(Date.now() + START_NOTE_MS + 1);
    const second = open('x');
    expect(startOf(second.traceId)).toMatchObject({ trigger: 'unknown' });
  });

  it('3. the session\'s first request at the endpoint, never one before it', () => {
    agent('f');
    noteSessionStart('f', { trigger: 'owner', via: 'window' });
    const { traceId } = open('f');
    const t0 = Date.now() + 1000;
    expect(startOf(traceId)).not.toHaveProperty('firstRequestAt');
    request(traceId, 'f', t0);
    request(traceId, 'f', t0 + 500);
    expect(startOf(traceId)).toMatchObject({ firstRequestAt: t0 });
  });

  it('4. the commit and branch of the folder it works in, its worktree first; none for a folder that is no checkout', async () => {
    repo(project, 'main');
    const tree = path.join(home, 'tree');
    const treeHead = repo(tree, 'feat/probe');
    agent('w', { worktreePath: tree });
    noteSessionStart('w', { trigger: 'owner', via: 'window' });
    const { traceId } = open('w');
    await expect.poll(() => startOf(traceId)?.commit, { timeout: 5000 }).toBe(treeHead);
    expect(startOf(traceId)).toMatchObject({ branch: 'feat/probe' });

    fs.mkdirSync(project, { recursive: true });
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain);
    agent('p', { projectPath: plain });
    settings.traces!.projects.push(plain);
    const opened = open('p');
    await new Promise(r => setTimeout(r, 300));
    expect(startOf(opened.traceId)).not.toHaveProperty('commit');
    expect(startOf(opened.traceId)).not.toHaveProperty('branch');
  });

  it('5. a ref handed to a session after another had it reads `redelegation`, naming that session', async () => {
    agent('r1');
    agent('r2');
    const now = Date.now();
    const ref = delegate('r1', { queued: now - 100, handed: now - 50 });
    const first = open('r1');
    oneTaskQueue.runEnded('r1');
    noteSessionStart('r2', { trigger: 'task', via: 'api', taskRef: ref, requesterAgentId: LEAD });
    const second = open('r2');
    expect(startOf(second.traceId)).toMatchObject({ trigger: 'redelegation', taskRef: ref, redelegatedFrom: first.traceId });
  });
});

describe('at its end', () => {
  it('6 and 7. the ledger\'s task the session started for, and every task of this agent it ran, with their times', async () => {
    repo(project, 'feat/a');
    const q = agent('q');
    const before = Date.now();
    // A task of q's that ended before the session: not this session's.
    ledger.handedOff('q', { source: 'tars', text: 'old work' });
    const oldTask = ledger.turnStarted(view(q), { sessionId: 'old' })!;
    ledger.stateChanged(view(q, { status: 'idle' }));
    await new Promise(r => setTimeout(r, 20));

    const ref = delegate('q', { queued: before - 4000, handed: Date.now() });
    const { traceId, token } = open('q');
    // Its turn: the ledger opens the task, run-task names the run with it.
    ledger.handedOff('q', { source: 'agent', requesterAgentId: LEAD, text: 'Run the probe' });
    const delegated = ledger.turnStarted(view(q), { sessionId: 'sess-1', text: 'Run the probe' })!;
    oneTaskQueue.runNamed('q', delegated);
    expect(startOf(traceId)).toMatchObject({ taskId: delegated });
    const firstAsk = Date.now() + 5;
    request(traceId, 'q', firstAsk);
    ledger.stateChanged(view(q, { status: 'idle' }));
    oneTaskQueue.runEnded('q');

    // Then the owner types a task of their own into the terminal, and another agent's task runs meanwhile.
    await new Promise(r => setTimeout(r, 20));
    const typed = ledger.turnStarted(view(q), { sessionId: 'sess-1', text: 'And tidy up' })!;
    request(traceId, 'q', Date.now() + 5);
    ledger.stateChanged(view(q, { status: 'error' }));
    const z = agent('z');
    ledger.turnStarted(view(z), { sessionId: 'z-1' });

    await close(token, traceId);
    const outcome = outcomeOf(traceId)!;
    expect(outcome.task).toMatchObject({ id: delegated, source: 'agent', requesterAgentId: LEAD, status: 'completed', ref });
    expect(outcome.task!.startedAt).toBeTypeOf('number');
    expect(outcome.task!.endedAt).toBeTypeOf('number');
    const ids = outcome.tasks!.map(t => t.id);
    expect(ids).toEqual([delegated, typed]);
    expect(ids).not.toContain(oldTask);
    const [d, t] = outcome.tasks!;
    expect(d).toMatchObject({ queuedAt: before - 4000, firstRequestAt: firstAsk });
    expect(d.handedAt!).toBeGreaterThanOrEqual(d.queuedAt!);
    // Typed by the owner: no queue, no hand-off; its turn is when it came.
    expect(t).toMatchObject({ source: 'terminal', status: 'error', queuedAt: t.startedAt, handedAt: t.startedAt });
  });

  it('7. a task handed without the queue takes its hand-off\'s time', async () => {
    const q = agent('h');
    noteSessionStart('h', { trigger: 'channel', via: 'slack' });
    const { traceId, token } = open('h');
    const handed = Date.now();
    ledger.handedOff('h', { source: 'slack', text: 'From the channel' });
    await new Promise(r => setTimeout(r, 30));
    ledger.turnStarted(view(q), { sessionId: 'h-1' });
    ledger.stateChanged(view(q, { status: 'idle' }));
    await close(token, traceId);
    const [task] = outcomeOf(traceId)!.tasks!;
    expect(task.source).toBe('slack');
    expect(task.handedAt!).toBeGreaterThanOrEqual(handed);
    expect(task.handedAt!).toBeLessThan(task.startedAt);
    expect(task.queuedAt).toBe(task.handedAt);
  });

  it('8. the same task in two sessions is linked both ways, and the earlier session\'s change sequence moves', async () => {
    const q = agent('k');
    noteSessionStart('k', { trigger: 'owner', via: 'window' });
    const a = open('k');
    const task = ledger.turnStarted(view(q), { sessionId: 'k-1' })!;
    await close(a.token, a.traceId);
    expect(outcomeOf(a.traceId)!.tasks!.map(t => t.id)).toEqual([task]);
    const seqBefore = traceStore().seqOf(a.traceId)!;
    // The task is still open: it runs on in the next session (an agent restarted mid-task).
    noteSessionStart('k', { trigger: 'restart', via: 'tars' });
    const b = open('k');
    ledger.turnStarted(view(q), { sessionId: 'k-2' });
    ledger.stateChanged(view(q, { status: 'idle' }));
    await close(b.token, b.traceId);
    expect(outcomeOf(b.traceId)!.tasks!.find(t => t.id === task)).toMatchObject({ alsoIn: [a.traceId] });
    expect(outcomeOf(a.traceId)!.tasks!.find(t => t.id === task)).toMatchObject({ alsoIn: [b.traceId] });
    expect(traceStore().seqOf(a.traceId)!).toBeGreaterThan(seqBefore);
  });
});

describe('its pull request', () => {
  it('9. written into the ended sessions of its repository and branch that started before it closed, once', async () => {
    repo(project, 'feat/a');
    repo(other, 'feat/a');
    const mk = (id: string, folder: string) => { agent(id, { projectPath: folder }); noteSessionStart(id, { trigger: 'owner', via: 'window' }); return open(id); };
    const mine = mk('m1', project);
    const elsewhere = mk('m2', other);
    const stillOpen = mk('m3', project);
    await expect.poll(() => startOf(mine.traceId)?.branch, { timeout: 5000 }).toBe('feat/a');
    await close(mine.token, mine.traceId);
    await close(elsewhere.token, elsewhere.traceId);
    // A session on another branch of the same repository.
    git(project, 'checkout', '-q', '-b', 'feat/b');
    const onB = mk('m4', project);
    await close(onB.token, onB.traceId);
    const closedAt = Date.now() + 1000;
    // A session that started after the pull request closed.
    git(project, 'checkout', '-q', 'feat/a');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(closedAt + 60_000);
    const late = mk('m5', project);
    vi.useRealTimers();
    await close(late.token, late.traceId);

    const seq = traceStore().seqOf(mine.traceId)!;
    const written = applyPrStates([{ repo: 'owner/project', projects: [project], number: 42, branch: 'feat/a', state: 'merged', at: closedAt }]);
    expect(written).toBe(1);
    expect(outcomeOf(mine.traceId)!.pr).toEqual({ number: 42, state: 'merged', at: closedAt });
    for (const s of [elsewhere, stillOpen, onB, late]) expect(outcomeOf(s.traceId)?.pr, s.traceId).toBeUndefined();
    expect(traceStore().seqOf(mine.traceId)!).toBeGreaterThan(seq);
    // The same state again moves nothing.
    const after = traceStore().seqOf(mine.traceId)!;
    expect(applyPrStates([{ repo: 'owner/project', projects: [project], number: 42, branch: 'feat/a', state: 'merged', at: closedAt }])).toBe(0);
    expect(traceStore().seqOf(mine.traceId)).toBe(after);
  });
});

describe('the demand that never arrived', () => {
  it('10. a task taken out of the queue, in the agent\'s live session, with its kind; none without a traced session', () => {
    agent('d');
    noteSessionStart('d', { trigger: 'owner', via: 'window' });
    const { traceId } = open('d');
    const reasons = ['cancelled', 'taken_back', 'dropped_with_stop', 'queue_cleared', 'agent_removed', 'not_handed_again'] as const;
    const refs: string[] = [];
    for (const reason of reasons) {
      const item = oneTaskQueue.enqueue('d', { requesterId: LEAD, title: `work ${reason}` }, Date.now() - 1000);
      refs.push(item.ref);
      oneTaskQueue.cancel(item.ref, `free words for ${reason}`, reason);
    }
    const lost = traceStore().session(traceId)!.lostDemand!;
    expect(lost.map(l => l.reason)).toEqual([...reasons]);
    expect(lost.map(l => l.ref)).toEqual(refs);
    for (const l of lost) {
      expect(l.kind).toBe('queue_drop');
      expect(l.at).toBeGreaterThanOrEqual(l.queuedAt);
      expect(JSON.stringify(l)).not.toContain('free words');
    }
    // An agent on no endpoint: nothing anywhere.
    agent('n', { endpointId: undefined });
    const item = oneTaskQueue.enqueue('n', { title: 'nobody traces this' });
    oneTaskQueue.cancel(item.ref, 'gone', 'cancelled');
    for (const s of traceStore().list({}).sessions) {
      expect(JSON.stringify(traceStore().session(s.traceId)!.lostDemand ?? [])).not.toContain(item.ref);
    }
  });

  it('11. a request given up while held ends its turn `abandoned` and counts apart from the endpoint\'s errors', async () => {
    agent('g');
    noteSessionStart('g', { trigger: 'owner', via: 'window' });
    const { traceId, token } = open('g');
    const t0 = Date.now() + 100;
    request(traceId, 'g', t0, { status: 499, responseBody: Buffer.alloc(0), contentType: undefined, attempts: 3, heldMs: 2000, cancel: { by: 'harness', cause: 'abandoned_while_held', at: t0 + 2000, deliveredBytes: 0 } });
    const s = traceStore().session(traceId)!;
    expect(s.turns[0].finalStatus).toBe('abandoned');
    expect(s.turns[0].requests[0].cancel).toEqual({ by: 'harness', cause: 'abandoned_while_held', at: t0 + 2000, deliveredBytes: 0 });
    await close(token, traceId);
    expect(outcomeOf(traceId)).toMatchObject({ requestErrors: 0, abandonedWhileHeld: 1 });
    expect(traceStore().session(traceId)!.session.finalStatus).toBe('abandoned');
  });
});

describe('13. the outcome\'s tasks, bounded', () => {
  const uuid = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
  /** A task as a delegation leaves it in the outcome: id, ref, source, asker, status and its six times. */
  const typical = (i: number): TraceTask => ({
    id: uuid(i), ref: `t-${String(i).padStart(8, '0')}`, source: 'agent', requesterAgentId: uuid(900), status: 'completed',
    queuedAt: 1795786698798 + i, handedAt: 1795786698799 + i, startedAt: 1795786700506 + i, firstRequestAt: 1795786701466 + i, endedAt: 1795786704114 + i,
  });
  const rest = { branch: 'feat/a-long-branch-name', head: 'e5cbe3cd'.repeat(5), heldRequests: 3, requestErrors: 0, abandonedWhileHeld: 1 };

  it('at 0: neither the list nor a count', () => {
    const bounded = boundOutcomeTasks({ ...rest });
    expect(bounded).not.toHaveProperty('tasks');
    expect(bounded).not.toHaveProperty('tasksOmitted');
  });

  it('at 50: all of them, no count; at 51: the last 50, one omitted', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => typical(i));
    const kept = boundOutcomeTasks({ ...rest, task: fifty[0], tasks: fifty });
    expect(kept.tasks).toEqual(fifty);
    expect(kept).not.toHaveProperty('tasksOmitted');
    const fiftyOne = Array.from({ length: 51 }, (_, i) => typical(i));
    const cut = boundOutcomeTasks({ ...rest, task: fiftyOne[0], tasks: fiftyOne });
    expect(cut.tasks).toEqual(fiftyOne.slice(1));
    expect(cut.tasksOmitted).toBe(1);
    // The session's own task stays, listed or not.
    expect(cut.task).toEqual(fiftyOne[0]);
    for (const o of [kept, cut]) expect(Buffer.byteLength(JSON.stringify(o))).toBeLessThanOrEqual(OUTCOME_BYTES_MAX);
  });

  it('every field filled: fewer than 50, the oldest out first, under the cap, counted', () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ ...typical(i), parentTaskId: uuid(500 + i), alsoIn: [`tr_${'x'.repeat(24)}`, `tr_${'y'.repeat(24)}`] }));
    const bounded = boundOutcomeTasks({ ...rest, task: full[49], tasks: full, tasksOmitted: 2 });
    const kept = bounded.tasks!;
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(OUTCOME_BYTES_MAX);
    expect(kept.length).toBeLessThan(50);
    expect(kept).toEqual(full.slice(50 - kept.length));
    // What an earlier bound omitted is counted on.
    expect(bounded.tasksOmitted).toBe(2 + 50 - kept.length);
  });

  it('at a session\'s end: 51 tasks of the ledger, the last 50 kept, one omitted', async () => {
    const q = agent('many');
    noteSessionStart('many', { trigger: 'owner', via: 'window' });
    const { traceId, token } = open('many');
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      ids.push(ledger.turnStarted(view(q), { sessionId: 'many-1' })!);
      ledger.stateChanged(view(q, { status: 'idle' }));
    }
    await close(token, traceId);
    const outcome = outcomeOf(traceId)!;
    expect(outcome.tasks!.map(t => t.id)).toEqual(ids.slice(1));
    expect(outcome.tasksOmitted).toBe(1);
    expect(outcome.task!.id).toBe(ids[0]);
  });
});

describe('14. the task each turn served', () => {
  it('a turn opened by a message that handed a task over carries its ref; one with none carries none', () => {
    agent('t');
    noteSessionStart('t', { trigger: 'owner', via: 'window' });
    const { traceId } = open('t');
    const t0 = Date.now();
    noteTypedForTraces({ agentId: 't', from: 'Lead', sender: { kind: 'agent', id: LEAD }, taskRef: 't-0000aaaa' } as never, `go ${t0 + 10}`);
    request(traceId, 't', t0 + 10);
    noteTypedForTraces({ agentId: 't', from: 'you' } as never, `go ${t0 + 20}`);
    request(traceId, 't', t0 + 20);
    const turns = traceStore().session(traceId)!.turns;
    expect(turns.map(x => x.taskRef ?? null)).toEqual(['t-0000aaaa', null]);
  });

  it('the first turn of a session started on a task carries the start\'s ref, the export and the upload with it', () => {
    agent('s1');
    const now = Date.now();
    const ref = delegate('s1', { queued: now - 100, handed: now - 50 });
    const { traceId } = open('s1');
    request(traceId, 's1', now + 10);
    request(traceId, 's1', now + 20);
    const turns = traceStore().session(traceId)!.turns;
    expect(turns.map(x => x.taskRef ?? null)).toEqual([ref, null]);
    const doc = sessionDocument(traceStore(), traceId)!;
    expect(doc.turns.map(x => x.task_ref)).toEqual([ref, null]);
    recordConsent(new Date().toISOString());
    const body = traceUploader().preview(traceId)!.document.batches[0].body as { turns: Array<Record<string, unknown>> };
    expect(body.turns.map(x => x.taskRef ?? null)).toEqual([ref, null]);
  });
});

/**
 * A back office as the uploader meets it (trace-upload.ts), refusing what the real one refuses on size: an outcome
 * over 16 KiB, and a lost demand over its budget, each with 422 invalid_batch, the whole batch.
 */
async function sizeCheckingBackOffice(): Promise<{ base: string; sessions: Map<string, Record<string, unknown>>; refused: number; close: () => Promise<void> }> {
  const bo = { base: '', sessions: new Map<string, Record<string, unknown>>(), refused: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const raw = Buffer.concat(chunks);
      const enc = req.headers['content-encoding'];
      const body = enc === 'zstd' ? (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(raw) : enc === 'gzip' ? zlib.gunzipSync(raw) : raw;
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/v1/installs') { send(201, { installId: 'inst-1', token: 'tbi_1', limits: {}, retentionDays: 90 }); return; }
      if (req.method === 'POST' && url === '/v1/blobs/missing') { send(200, { missing: [] }); return; }
      if (req.method === 'PUT' && url.startsWith('/v1/blobs/')) { send(201, { stored: true }); return; }
      if (req.method === 'PUT' && url.startsWith('/v1/batches/')) {
        const batch = JSON.parse(body.toString()) as { sessions?: Array<Record<string, unknown>> };
        const tooBig = (batch.sessions ?? []).some(s => Buffer.byteLength(JSON.stringify(s.outcome ?? {})) > 16 * 1024 || Buffer.byteLength(JSON.stringify(s.lostDemand ?? [])) > 8 * 1024);
        if (tooBig) { bo.refused++; send(422, { error: 'invalid_batch' }); return; }
        for (const s of batch.sessions ?? []) bo.sessions.set(String(s.sessionId), s);
        send(200, { batchId: url, replayed: false, applied: {}, missingBlobs: [] });
        return;
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  bo.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  bo.close = () => new Promise<void>(r => server.close(() => r()));
  return bo;
}

describe('15. a long session still uploads', () => {
  it('200 tasks and 300 queue drops: bounded, counted, and taken by a back office that refuses an outcome over 16 KiB', async () => {
    const q = agent('long');
    noteSessionStart('long', { trigger: 'owner', via: 'window' });
    const { traceId, token } = open('long');
    request(traceId, 'long', Date.now() + 5);
    for (let i = 0; i < 200; i++) {
      ledger.handedOff('long', { source: 'agent', requesterAgentId: LEAD, text: `task ${i}` });
      ledger.turnStarted(view(q), { sessionId: 'long-1' });
      ledger.stateChanged(view(q, { status: 'idle' }));
    }
    const drops: string[] = [];
    for (let i = 0; i < 300; i++) {
      const item = oneTaskQueue.enqueue('long', { requesterId: LEAD, title: `drop ${i}` });
      drops.push(item.ref);
      oneTaskQueue.cancel(item.ref, 'gone', i % 2 ? 'taken_back' : 'not_handed_again');
    }
    await close(token, traceId);

    const s = traceStore().session(traceId)!;
    expect(s.outcome!.tasks!.length).toBeLessThanOrEqual(50);
    expect(s.outcome!.tasksOmitted).toBe(200 - s.outcome!.tasks!.length);
    expect(s.lostDemand!.map(l => l.ref)).toEqual(drops.slice(-LOST_DEMAND_MAX));
    expect(s.lostDemandOmitted).toBe(300 - LOST_DEMAND_MAX);
    expect(Buffer.byteLength(JSON.stringify(s.lostDemand))).toBeLessThanOrEqual(LOST_DEMAND_BYTES_MAX);

    const bo = await sizeCheckingBackOffice();
    try {
      settings = { ...settings, traces: { ...settings.traces!, uploadUrl: bo.base, uploadAllowPlainHttp: true } } as AppSettings;
      recordConsent(new Date().toISOString());
      const pass = await traceUploader().runOnce();
      expect(pass, JSON.stringify(pass)).toMatchObject({ failed: 0 });
      expect(bo.refused).toBe(0);
      const sent = bo.sessions.get(traceId)!;
      expect(sent, 'the session reached the back office').toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(sent.outcome))).toBeLessThanOrEqual(16 * 1024);
      expect(sent).toMatchObject({ lostDemandOmitted: 300 - LOST_DEMAND_MAX, outcome: { tasksOmitted: 200 - s.outcome!.tasks!.length } });
      expect((sent.lostDemand as unknown[]).length).toBe(LOST_DEMAND_MAX);
    } finally {
      await bo.close();
    }
  });
});

describe('16. gh is asked only while a pull request can still come', () => {
  it('not for a session ended more than 14 days ago, nor one on its repository\'s default branch', async () => {
    repo(project, 'feat/a');
    const develop = path.join(home, 'develop-repo');
    repo(develop, 'develop');
    // Its origin says its default branch is develop.
    git(develop, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    settings.traces!.projects.push(develop);
    const ended = (id: string, folder: string, branch: string, daysAgo: number) => {
      agent(id, { projectPath: folder });
      noteSessionStart(id, { trigger: 'owner', via: 'window' });
      const { traceId } = open(id);
      traceStore().endTrace(traceId, Date.now() - daysAgo * 86_400_000, { branch });
      return traceId;
    };
    const asked = ended('p1', project, 'feat/a', 1);
    ended('p2', project, 'feat/a', 15);
    ended('p3', project, 'main', 1);
    ended('p4', project, 'master', 1);
    ended('p5', develop, 'develop', 1);
    const askedToo = ended('p6', develop, 'main', 1);
    const sessions = await sessionsToAskForPr(Date.now());
    expect(sessions.map(x => x.traceId).sort()).toEqual([asked, askedToo].sort());
  });
});

describe('17. a request given up while held never reached the endpoint', () => {
  it('it adds nothing to the request counts or the model time, and is no first request', async () => {
    agent('l2');
    const now = Date.now();
    const ref = delegate('l2', { queued: now - 100, handed: now - 50 });
    const { traceId, token } = open('l2');
    const t0 = Date.now() + 100;
    // Given up first, then one that reached the endpoint, in the same turn.
    const given = { status: 499, responseBody: Buffer.alloc(0), contentType: undefined, attempts: 3, heldMs: 2000, cancel: { by: 'harness', cause: 'abandoned_while_held', at: t0 + 2000, deliveredBytes: 0 } };
    request(traceId, 'l2', t0, given);
    const body = Buffer.from(JSON.stringify({ model: 'open-model-1', stream: false, tools: [{ type: 'function', function: { name: 'sh', parameters: {} } }], messages: [{ role: 'user', content: `go ${t0}` }, { role: 'assistant', content: 'x' }, { role: 'tool', content: 'out', tool_call_id: 'c' }] }));
    request(traceId, 'l2', t0 + 3000, { requestBody: body });
    const s = traceStore().session(traceId)!;
    expect(s.session.requestCount).toBe(1);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].modelMs).toBe(10);
    expect(s.start!.firstRequestAt).toBe(t0 + 3000);
    const doc = sessionDocument(traceStore(), traceId)!;
    expect(doc.turns[0].request_count).toBe(1);
    expect(doc.trace.request_count).toBe(1);
    // A task's first request is the one that reached the endpoint.
    ledger.handedOff('l2', { source: 'agent', requesterAgentId: LEAD, text: 'probe' });
    const task = ledger.turnStarted(view(fleet.get('l2')!), { sessionId: 'l2-1' })!;
    oneTaskQueue.runNamed('l2', task);
    ledger.stateChanged(view(fleet.get('l2')!, { status: 'idle' }));
    expect(ref).toBeTruthy();
    await close(token, traceId);
    expect(traceStore().session(traceId)!.outcome!.task!.firstRequestAt).toBe(t0 + 3000);
  });
});

describe('18. a start that opens no terminal', () => {
  it('clears its note, which no later spawn of the agent reads', () => {
    noteSessionStart('nospawn', { trigger: 'owner', via: 'window' });
    clearSessionStart('nospawn');
    expect(takeSessionStart('nospawn')).toBeUndefined();
    // Clearing another agent's note does nothing to this one's.
    noteSessionStart('keeps', { trigger: 'task', via: 'api' });
    clearSessionStart('other');
    expect(takeSessionStart('keeps')).toMatchObject({ trigger: 'task' });
  });
});

describe('what leaves', () => {
  it('12. the preview carries every new field, and no name or task text', async () => {
    repo(project, 'feat/a');
    const q = agent('u');
    const now = Date.now();
    const ref = delegate('u', { queued: now - 3000, handed: now - 1000 });
    const { traceId, token } = open('u');
    await expect.poll(() => startOf(traceId)?.commit, { timeout: 5000 }).toBeTruthy();
    ledger.handedOff('u', { source: 'agent', requesterAgentId: LEAD, text: 'SECRET-TASK-WORDS' });
    const task = ledger.turnStarted(view(q), { sessionId: 'u-1', text: 'SECRET-TASK-WORDS' })!;
    oneTaskQueue.runNamed('u', task);
    request(traceId, 'u', Date.now() + 5);
    request(traceId, 'u', Date.now() + 50, { status: 499, responseBody: Buffer.alloc(0), contentType: undefined, attempts: 2, heldMs: 1000, cancel: { by: 'harness', cause: 'abandoned_while_held', at: Date.now() + 1050, deliveredBytes: 0 } });
    const dropped = oneTaskQueue.enqueue('u', { requesterId: LEAD, title: 'SECRET-DROPPED-WORDS' });
    oneTaskQueue.cancel(dropped.ref, 'taken back in the window', 'taken_back');
    ledger.stateChanged(view(q, { status: 'idle' }));
    oneTaskQueue.runEnded('u');
    await close(token, traceId);
    applyPrStates([{ repo: 'owner/project', projects: [project], number: 7, branch: 'feat/a', state: 'closed', at: Date.now() + 10 }]);

    // The export and the reader's API: the session document.
    const doc = sessionDocument(traceStore(), traceId)!;
    expect(doc.trace.start).toMatchObject({ trigger: 'task', taskRef: ref, taskId: task, queuedAt: now - 3000, handedAt: now - 1000, branch: 'feat/a' });
    expect(doc.trace.lost_demand).toEqual([expect.objectContaining({ kind: 'queue_drop', ref: dropped.ref, reason: 'taken_back' })]);
    expect(doc.requests.map(r => r.cancel ?? null)).toEqual([null, { by: 'harness', cause: 'abandoned_while_held', at: expect.any(Number), deliveredBytes: 0 }]);

    // The upload, as the user's preview shows it.
    recordConsent(new Date().toISOString());
    const preview = traceUploader().preview(traceId)!;
    const body = preview.document.batches[0].body as { sessions: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> };
    const session = body.sessions[0];
    expect(session.start).toMatchObject({ trigger: 'task', taskRef: ref, taskId: task, queuedAt: now - 3000, handedAt: now - 1000, firstRequestAt: expect.any(Number), commit: expect.any(String), branch: 'feat/a' });
    expect(session.lostDemand).toEqual([expect.objectContaining({ kind: 'queue_drop', reason: 'taken_back', queuedAt: expect.any(Number), at: expect.any(Number) })]);
    expect(session.outcome).toMatchObject({ task: { id: task, source: 'agent', requesterAgentId: LEAD, status: 'completed' }, pr: { number: 7, state: 'closed' }, abandonedWhileHeld: 1 });
    expect(body.requests.map(r => r.cancel ?? null)).toEqual([null, expect.objectContaining({ by: 'harness', cause: 'abandoned_while_held' })]);
    const sent = JSON.stringify(preview.document);
    expect(sent).not.toContain('SECRET-TASK-WORDS');
    expect(sent).not.toContain('SECRET-DROPPED-WORDS');
    expect(sent).not.toContain('Run the probe');
  });
});
