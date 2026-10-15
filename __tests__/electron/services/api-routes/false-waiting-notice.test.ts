import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An orchestrator told "is now waiting" about an agent that had just started.
 *
 * JeanBrasse's report of 2026-09-18 (faux-waiting-2b86): the orchestrator of
 * 1212-Capital delegated a task to 1212-Backend and was told at once, in its
 * own terminal, that 1212-Backend "is now waiting", while it had only begun.
 * What the logs of that evening show, and what each case below replays:
 *
 * - delegate_task tries ACP first, through /run-task, which sets `running`.
 *   The ACP start failed (after 90 s in 1.7.6), /run-task put back the status
 *   the agent had before, `waiting` because idle, and agent-watch took that for
 *   a new wait. The note went to the orchestrator through the link left by a
 *   delegation of 17:30, which a normal end of turn never spends.
 * - The idle prompt is Claude Code saying the agent has sat at its prompt for
 *   sixty seconds. It lands as `waiting` whatever the agent is doing, so one
 *   raised before a task was handed over and posted after it put the working
 *   agent back to `waiting` and told the orchestrator so.
 * - A note held while the orchestrator was busy was handed over after it had
 *   given the same agent new work (09-16 23:30, the QA).
 *
 * And what must still happen: a permission prompt in the middle of a turn is
 * news, and so is the end of the work that was handed over, once.
 *
 * Everything here goes through the real routes, the real agent-watch and the
 * real agent map. The terminals are recorders: the note an orchestrator reads
 * is exactly what writeProgrammaticInput was asked to type into its terminal.
 */

type FakePty = {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  /** What node-pty names in front: first the file it spawned, then a CLI's name. */
  process?: string;
};

function fakePty(): FakePty {
  return { onData: () => {}, onExit: () => {}, kill: vi.fn(), write: vi.fn() };
}

vi.mock('node-pty', () => ({ spawn: vi.fn((file: string) => ({ ...fakePty(), process: file })) }));
let ptyCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-spawned-${++ptyCounter}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: () => {} }));
vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  noteSubmitted: vi.fn(),
  PROGRAMMATIC_SUBMIT_DELAY_MS: 300,
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));
vi.mock('../../../../electron/services/acp/delegate', () => ({
  canDelegateOverAcp: () => true,
  delegateOverAcp: vi.fn(),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { delegateOverAcp } from '../../../../electron/services/acp/delegate';
import { startAgentWatch, stopAgentWatch } from '../../../../electron/services/agent-watch';
import { agentStatusEmitter } from '../../../../electron/services/agent-events';
import { sid } from '../../../fixtures/session-id';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';
import { moveTestHome } from '../../../setup/test-home';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-false-waiting-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-false-waiting-project-'));

/** Claude Code raises its idle prompt this long after the agent stops at its
 *  prompt: 1,390 of 1,393 idle prompts after a Stop in a month of hook logs. */
const IDLE_PROMPT_AFTER_MS = 60_000;

type AcpOutcome = Awaited<ReturnType<typeof delegateOverAcp>>;
const ACP_FAILED: AcpOutcome = {
  ok: false, transport: 'acp', text: '', toolCalls: [],
  error: 'initialize timed out after 90s',
} as AcpOutcome;

let restoreHome: () => void;
let routes: RouteApp;
let ctx: RouteContext;
let orchestratorTerminal: FakePty;

beforeEach(() => {
  vi.useFakeTimers();
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(writeProgrammaticInput).mockClear();
  vi.mocked(delegateOverAcp).mockReset();
  restoreHome = moveTestHome(home);
  expect(os.homedir(), 'HOME is not redirected, and a spawn would write the real ~/.claude.json').toBe(home);

  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  const settings = { notificationsEnabled: true, notifyOnWaiting: true } as AppSettings;
  ctx = {
    mainWindow: null,
    appSettings: settings,
    getAppSettings: () => settings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    // The real one, as api-server.ts hands it over: `emitAgentStatus` fires on
    // that module's emitter, so a fresh EventEmitter here would leave the
    // /wait long poll listening to something nothing ever emits on.
    agentStatusEmitter,
  } as RouteContext;
  registerAgentRoutes(routes, ctx);
  registerHooksRoutes(routes, ctx);
  startAgentWatch();

  // The orchestrator, at rest at its prompt: free, so a note reaches it at
  // once and every assertion below reads what it was actually told.
  orchestratorTerminal = liveTerminal('pty-orch');
  putAgent({ id: 'orch', name: 'Orchestrator', status: 'waiting', waitingReason: 'idle', ptyId: 'pty-orch', currentSessionId: sid('sess-orch') });
  // The agent it delegates to, with a live claude session at its prompt for
  // more than a minute, so `waiting` because idle: /dispatch types into it.
  liveTerminal('pty-be');
  putAgent({ id: 'be', name: '1212-Backend', status: 'waiting', waitingReason: 'idle', ptyId: 'pty-be', currentSessionId: sid('sess-be') });
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  stopAgentWatch();
  restoreHome();
});

/** Calls a route the way the server does, and returns what it answered. */
async function call(method: string, url: string, body: Record<string, unknown> = {}, caller?: string) {
  const pathname = url.split('?')[0];
  for (const route of routes.routes) {
    if (route.method !== method) continue;
    const m = typeof route.pattern === 'string' ? (route.pattern === pathname ? [pathname] : null) : pathname.match(route.pattern);
    if (!m) continue;
    const answers: Array<{ data: unknown; status: number }> = [];
    const req = {
      method, pathname, url: new URL(`http://localhost${url}`), body,
      raw: { headers: {}, on: () => {} }, res: {}, params: m[1] ? { id: m[1] } : {},
      callerAgentId: caller,
    } as unknown as RouteRequest;
    await route.handler(req, (data, status = 200) => { answers.push({ data, status }); }, ctx);
    return answers.at(-1);
  }
  throw new Error(`no route for ${method} ${url}`);
}

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = {
    status: 'idle', provider: 'claude', projectPath: project, ptyCwd: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

function liveTerminal(ptyId: string): FakePty {
  // A CLI up in it, opened the way every agent terminal is: the routes type
  // into a session only where cliRunningIn finds one.
  const pty = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 80, rows: 24, env: {},
  }) as unknown as FakePty;
  pty.process = '2.1.280';
  ptyProcesses.set(ptyId, pty as never);
  return pty;
}

const backend = () => agents.get('be')!;

/** Everything Tars typed into a terminal. */
function typedInto(terminal: FakePty): string[] {
  return vi.mocked(writeProgrammaticInput).mock.calls
    .filter(([pty]) => pty === (terminal as never))
    .map(([, text]) => String(text));
}

/** Everything Tars typed into the orchestrator's terminal. */
const toldOrchestrator = () => typedInto(orchestratorTerminal);

/** The desktop notifications that say an agent is waiting on JeanBrasse. */
function desktopSaysWaiting(): string[] {
  return vi.mocked(ctx.sendNotificationCallback).mock.calls
    .map(([title]) => String(title))
    .filter(title => title.includes('is waiting'));
}

// The hooks, posting what the scripts in hooks/ post.

const status = (id: string, session: string, body: Record<string, unknown>) =>
  call('POST', '/api/hooks/status', { agent_id: id, session_id: session, ...body });

/** user-prompt-submit.sh: a turn begins. */
const turnStarts = (task: string) =>
  status('be', sid('sess-be'), { status: 'running', event: 'UserPromptSubmit', current_task: task });

/** on-stop.sh: the turn ended, with its last message as the output. */
async function turnEnds(output: string) {
  await call('POST', '/api/hooks/output', { agent_id: 'be', session_id: sid('sess-be'), output });
  await status('be', sid('sess-be'), { status: 'idle' });
  await call('POST', '/api/hooks/agent-stopped', { agent_id: 'be', session_id: sid('sess-be') });
}

/** notification.sh on Claude Code's idle_prompt: both of its posts, in order. */
async function idlePrompt(session = sid('sess-be')) {
  await call('POST', '/api/hooks/notification', {
    agent_id: 'be', session_id: session, type: 'idle_prompt', title: '', message: 'Claude is waiting for your input',
  });
  await status('be', session, { status: 'waiting', waiting_reason: 'idle' });
}

/** permission-request.sh: a permission dialog is up in the middle of the turn. */
const permissionAsked = () => status('be', sid('sess-be'), { status: 'waiting', waiting_reason: 'permission' });

/** The orchestrator's own turn, which decides when a held note may go out. */
const orchestratorWorks = () => status('orch', sid('sess-orch'), { status: 'running', event: 'UserPromptSubmit', current_task: 'JeanBrasse asked for BotID' });
const orchestratorStops = () => status('orch', sid('sess-orch'), { status: 'idle' });

/** post-tool-use.sh: a tool ran, so the agent is working, a permission answered. */
const toolRan = () => status('be', sid('sess-be'), { status: 'running' });

/** send_message and start_agent: /dispatch, on behalf of the orchestrator. */
const dispatch = (message: string) => call('POST', '/api/agents/be/dispatch', { message }, 'orch');

/** delegate_task's first attempt, over ACP. Left pending until `settle`. */
function runTaskOverAcp(task: string) {
  let settle!: (outcome: AcpOutcome) => void;
  vi.mocked(delegateOverAcp).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const answered = call('POST', '/api/agents/be/run-task', { task }, 'orch');
  return { answered, settle: (outcome: AcpOutcome) => settle(outcome) };
}

/** The window during which one note holds the next back. */
const pause = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** One delegated task, start to finish, the way the orchestrator's last one went. */
async function oneDelegatedTaskEarlier() {
  await dispatch('task one');
  await pause(500);
  await turnStarts('task one');
  await pause(10_000);
  await turnEnds('task one: done');
  await pause(500);
}

describe('the idle prompt of a rest that is already over', () => {
  it('does not put an agent handed work since back to waiting, nor tell anyone it is', async () => {
    // The agent finished a task thirty seconds ago and sits at its prompt: its
    // idle prompt is due in thirty seconds.
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS / 2);
    const toldBefore = toldOrchestrator().length;

    // delegate_task tries ACP first. /run-task sets `running` and leaves the
    // agent's terminal alone, so the claude in it keeps counting its minute.
    const run = runTaskOverAcp('BotID');
    await pause(IDLE_PROMPT_AFTER_MS / 2);
    expect(backend().status).toBe('running');

    await idlePrompt();

    expect(backend().status, 'an idle prompt raised before the work arrived put the working agent back to waiting').toBe('running');
    expect(toldOrchestrator().slice(toldBefore), 'the orchestrator was told an agent that had just been handed work is waiting').toEqual([]);
    expect(desktopSaysWaiting(), 'JeanBrasse was told the agent is waiting while it had just been handed work').toEqual([]);

    run.settle({ ok: true, transport: 'acp', text: 'BotID is on', toolCalls: [] } as AcpOutcome);
    await run.answered;
  });

  it('does not either through /dispatch, which types into the session of an agent at rest for less than a minute', async () => {
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS / 2);

    // `idle`, not yet `waiting`, its CLI at its prompt: /dispatch types into
    // that session. It used to start a new one over it, which buried this one
    // and its conversation with it.
    const answer = await dispatch('BotID');
    expect((answer!.data as { mode: string }).mode).toBe('message');
    expect(backend().currentSessionId).toBe(sid('sess-be'));

    await pause(IDLE_PROMPT_AFTER_MS / 2);
    await idlePrompt(sid('sess-be'));

    expect(backend().status).toBe('running');
  });

  it('does not either through /message, which types into the session of an agent still idle', async () => {
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS - 1_000);
    const toldBefore = toldOrchestrator().length;

    await call('POST', '/api/agents/be/message', { message: 'BotID' }, 'orch');
    // The prompt raised as the task was typed, posted before the turn starts.
    await idlePrompt();

    expect(backend().status, 'an idle prompt raised before the work arrived put the working agent back to waiting').toBe('running');
    expect(toldOrchestrator().slice(toldBefore)).toEqual([]);
  });

  it('does not either when the turn was typed into the terminal a moment before the prompt landed', async () => {
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS);
    const toldBefore = toldOrchestrator().length;

    // JeanBrasse types into the agent's terminal at the minute. Nothing goes
    // through the API: the turn itself is the only sign of the work.
    await turnStarts('a question of my own');
    await idlePrompt();

    expect(backend().status, 'an idle prompt raised before the turn began put the working agent back to waiting').toBe('running');
    expect(toldOrchestrator().slice(toldBefore)).toEqual([]);
  });

  it('still ends a turn that never sent its Stop, once a minute has gone by with nothing handed over', async () => {
    // A turn interrupted from the terminal, or a prompt that never became a
    // model turn: Claude Code sends no Stop, and this prompt is the only sign
    // that it is over. Measured: 18 in a month, each 61 s or more after the
    // prompt that started it.
    await dispatch('BotID');
    await pause(500);
    await turnStarts('BotID');
    await pause(IDLE_PROMPT_AFTER_MS + 1_000);

    await idlePrompt();

    expect(backend().status).toBe('waiting');
    expect(backend().waitingReason).toBe('idle');
    const notes = toldOrchestrator();
    expect(notes, 'the orchestrator never learned that the turn it handed over had ended').toHaveLength(1);
    expect(notes[0], 'the end of the work was told as a wait').toContain('finished');
    expect(desktopSaysWaiting()).toHaveLength(1);

    // That was the end of the work handed over: a turn JeanBrasse types in its
    // terminal afterwards is nobody's delegation.
    await pause(60_000);
    await turnStarts('a question of my own');
    await pause(20_000);
    await turnEnds('an answer');
    await pause(500);
    expect(toldOrchestrator(), 'a turn the orchestrator never asked for was announced to it').toHaveLength(1);
  });
});

describe('a task typed into an agent in the middle of a turn', () => {
  it('is announced when that task ends, not when the turn it arrived in does', async () => {
    await dispatch('task one');
    await pause(500);
    await turnStarts('task one');
    await pause(10_000);

    // Claude Code holds a message typed during a turn. With no tool call left
    // in that turn, it becomes the next one. Each is its own task (PR A,
    // core/task-requests.ts): the first turn's end is task one's, told then,
    // and task two's own end is told after its own turn. This test expected
    // no word at the first end, the overtaking of the single link: that
    // reported the first turn as task two's and lost task two's own end once
    // requests were per task (the Audit's M2 on #351).
    await dispatch('task two');
    await pause(10_000);
    await turnEnds('task one: done');
    await pause(500);
    expect(toldOrchestrator(), 'the end of task one, the turn it ran in, was not told').toHaveLength(1);

    await turnStarts('task two');
    await pause(20_000);
    await turnEnds('task two: done');
    await pause(500);
    expect(toldOrchestrator(), 'the end of the task typed in during the turn never reached the orchestrator').toHaveLength(2);
  });
});

describe('a failed attempt over ACP', () => {
  it('puts the agent back where it was without telling anyone it is waiting (the BotID note)', async () => {
    // 17:30: a first delegation, finished at 17:33, and the idle prompt a
    // minute later. The agent then rested in `waiting` for 85 minutes.
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(85 * 60_000);
    expect(backend().status).toBe('waiting');
    const toldBefore = toldOrchestrator().length;

    // 18:58:31: delegate_task. The ACP start fails, here at once and in 1.7.6
    // after 90 s, and the route puts back the status the agent had.
    const run = runTaskOverAcp('BotID');
    await pause(1_000);
    run.settle(ACP_FAILED);
    await run.answered;

    expect(backend().status).toBe('waiting');
    expect(toldOrchestrator().slice(toldBefore), 'a failed ACP start was announced to the orchestrator as the agent waiting').toEqual([]);

    // delegate_task falls back on the terminal: the task is typed, the turn
    // runs, and its end is told once.
    await dispatch('BotID');
    await pause(500);
    await turnStarts('BotID');
    await pause(5_000);
    expect(toldOrchestrator().slice(toldBefore), 'the orchestrator was told about the agent while it worked').toEqual([]);
    await turnEnds('BotID: done');
    await pause(500);
    const notes = toldOrchestrator().slice(toldBefore);
    expect(notes, 'the end of the task it handed over never reached the orchestrator').toHaveLength(1);
    expect(notes[0]).toContain('1212-Backend');
  });

  it('does not put an agent back to waiting over a task typed into its terminal while the attempt was still out', async () => {
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(10 * 60_000);
    const toldBefore = toldOrchestrator().length;

    // The MCP client gives up on /run-task before the server does and types
    // the task into the terminal instead. The turn starts.
    const run = runTaskOverAcp('BotID');
    await pause(1_000);
    await dispatch('BotID');
    await pause(500);
    await turnStarts('BotID');

    // Then the ACP attempt fails, and its route restores the status it saw.
    run.settle(ACP_FAILED);
    await run.answered;

    expect(backend().status, 'the failed attempt wrote its old status over a turn in progress').toBe('running');
    expect(toldOrchestrator().slice(toldBefore), 'the orchestrator was told the agent is waiting in the middle of its turn').toEqual([]);
  });
});

describe('a permission prompt in the middle of a turn', () => {
  it('always puts the agent in waiting and tells whoever handed it the work, even right after the dispatch', async () => {
    // Resting in `waiting` because idle, which is how most workers are found.
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(10 * 60_000);
    const toldBefore = toldOrchestrator().length;

    await dispatch('BotID');
    await pause(500);
    await turnStarts('BotID');
    await pause(2_000);
    await permissionAsked();

    expect(backend().status).toBe('waiting');
    expect(backend().waitingReason).toBe('permission');
    const notes = toldOrchestrator().slice(toldBefore);
    expect(notes, 'a permission prompt in the middle of a delegated turn never reached the orchestrator').toHaveLength(1);
    expect(notes[0]).toContain('1212-Backend');
    expect(notes[0]).toContain('permission');
  });
});

describe('an agent that finished and then sat at its prompt for a minute', () => {
  it('is announced once, when it finishes, and not again when the idle prompt comes', async () => {
    await dispatch('BotID');
    await pause(500);
    await turnStarts('BotID');
    await pause(30_000);
    const toldBefore = toldOrchestrator().length;

    await turnEnds('BotID: done');
    await pause(500);
    expect(toldOrchestrator().slice(toldBefore), 'the orchestrator was not told when the work it handed over ended').toHaveLength(1);

    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(500);

    expect(backend().status, 'the rest after a finished turn is still shown as waiting').toBe('waiting');
    expect(toldOrchestrator().slice(toldBefore), 'the idle prompt a minute later was announced as a second piece of news').toHaveLength(1);
  });

  it('does not announce later turns nobody delegated, typed in its terminal', async () => {
    await oneDelegatedTaskEarlier();
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(5 * 60_000);
    const toldBefore = toldOrchestrator().length;

    // JeanBrasse types into the agent's terminal himself. Nothing goes through the API.
    await turnStarts('a question of my own');
    await pause(20_000);
    await turnEnds('an answer');
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(500);

    expect(toldOrchestrator().slice(toldBefore), 'a turn the orchestrator never asked for was announced to it').toEqual([]);
  });
});

describe('a note held while the orchestrator was busy', () => {
  it('is not handed over once the orchestrator has given the same agent new work', async () => {
    await dispatch('task one');
    await pause(500);
    await turnStarts('task one');
    await pause(10_000);

    // The orchestrator is in the middle of a turn of its own when the agent
    // finishes, and still in it a minute later: whatever that said is held.
    await orchestratorWorks();
    await turnEnds('task one: done');
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(20_000);
    expect(toldOrchestrator(), 'a note was typed into an orchestrator in the middle of its turn').toEqual([]);

    // In that same turn it hands the agent its next task, then stops.
    await dispatch('task two');
    await pause(500);
    await turnStarts('task two');
    await pause(2_000);
    await orchestratorStops();
    await pause(500);

    expect(toldOrchestrator(), 'the orchestrator was handed a note about work it had already followed with more').toEqual([]);

    await pause(30_000);
    await turnEnds('task two: done');
    await pause(500);
    expect(toldOrchestrator(), 'the end of the second task never reached the orchestrator').toHaveLength(1);
  });

  it('is not handed over either when the new work came within the minute', async () => {
    await dispatch('task one');
    await pause(500);
    await turnStarts('task one');
    await pause(10_000);
    await orchestratorWorks();
    await turnEnds('task one: done');
    await pause(20_000);

    // Still `idle`, its CLI at its prompt: /dispatch types the task into it.
    const answer = await dispatch('task two');
    expect((answer!.data as { mode: string }).mode).toBe('message');
    await orchestratorStops();
    await pause(500);

    expect(toldOrchestrator(), 'the orchestrator was handed a note about work it had already followed with more').toEqual([]);
  });

  it('is not handed over once the permission it was about has been answered', async () => {
    await dispatch('BotID');
    await pause(500);
    await turnStarts('BotID');
    await orchestratorWorks();
    await permissionAsked();
    await pause(10_000);

    // JeanBrasse answers the dialog in the terminal; the tool runs.
    await toolRan();
    await orchestratorStops();
    await pause(500);

    expect(backend().status).toBe('running');
    expect(toldOrchestrator(), 'the orchestrator was told of a wait that was already over').toEqual([]);
  });
});

describe('an orchestrator that cannot be reached when the work ends', () => {
  it('is not handed news of later turns by its next session', async () => {
    await dispatch('task one');
    await pause(500);
    await turnStarts('task one');
    await pause(10_000);

    // The orchestrator is stopped: no terminal to write into.
    const orchestrator = agents.get('orch')!;
    orchestrator.ptyId = undefined;
    orchestrator.status = 'idle';
    await turnEnds('task one: done');
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();

    // Started again, a new session in a new terminal.
    const next = liveTerminal('pty-orch-2');
    orchestrator.ptyId = 'pty-orch-2';
    orchestrator.currentSessionId = sid('sess-orch-2');

    // JeanBrasse types into the agent's terminal himself.
    await pause(5 * 60_000);
    await turnStarts('a question of my own');
    await pause(20_000);
    await turnEnds('an answer');
    await pause(IDLE_PROMPT_AFTER_MS);
    await idlePrompt();
    await pause(500);

    expect(typedInto(next), 'a new session of the orchestrator was told about a turn nobody delegated').toEqual([]);
  });
});

/**
 * The note, and the long poll, saying the same thing twice.
 *
 * `delegate_task` falls back to `/dispatch` plus `GET /wait` whenever ACP
 * cannot start, which on JeanBrasse's machine is every time. The orchestrator is
 * then sitting in that poll when the turn ends, so it is told twice: the poll
 * answers, and 375 ms later the note is typed into its terminal, which costs
 * it a whole turn to read something it already has. The QA measured 35 s of
 * one on 2026-09-20.
 *
 * Only that case. The note is the only signal on every other path, so it stays
 * for all of them.
 */
describe('an orchestrator already waiting on this agent', () => {
  /** Opens the long poll without waiting for it, and keeps what it answers. */
  function openWait(childId: string, caller: string) {
    const answers: Array<Record<string, unknown>> = [];
    const route = routes.routes.find(r => r.method === 'GET' && String(r.pattern).includes('wait'))!;
    const req = {
      method: 'GET', pathname: `/api/agents/${childId}/wait`,
      url: new URL(`http://localhost/api/agents/${childId}/wait`),
      body: {}, raw: { headers: {}, on: () => {} }, res: {}, params: { id: childId },
      callerAgentId: caller,
    } as unknown as RouteRequest;
    void route.handler(req, (data) => { answers.push(data as Record<string, unknown>); }, ctx);
    return answers;
  }

  beforeEach(() => {
    backend().requestedBy = { agentId: 'orch', ptyId: 'pty-be' };
  });

  it('is told once, by the poll it is sitting in, and not again in its terminal', async () => {
    await turnStarts('run the suite');
    const answers = openWait('be', 'orch');
    expect(answers, 'the poll answered before the turn ended').toEqual([]);

    await turnEnds('the suite is green');
    await pause(500);

    expect(answers.at(-1)?.status, 'the poll did not answer').toBe('idle');
    expect(toldOrchestrator(), 'told again in its terminal, which costs it a turn').toEqual([]);
  });

  it('is told in its terminal when it is not waiting on that agent', async () => {
    await turnStarts('run the suite');
    await turnEnds('the suite is green');
    await pause(500);

    expect(toldOrchestrator().join('')).toContain('1212-Backend');
  });

  it('is told in its terminal when the poll it is sitting in is about someone else', async () => {
    liveTerminal('pty-fe');
    putAgent({ id: 'fe', name: 'Frontend', status: 'running', ptyId: 'pty-fe', currentSessionId: sid('sess-fe') });
    await turnStarts('run the suite');
    openWait('fe', 'orch');

    await turnEnds('the suite is green');
    await pause(500);

    expect(toldOrchestrator().join('')).toContain('1212-Backend');
  });

  it('is told in its terminal again once its poll has gone', async () => {
    await turnStarts('run the suite');
    const answers = openWait('be', 'orch');
    await turnEnds('the suite is green');
    await pause(500);
    expect(answers).toHaveLength(1);
    expect(toldOrchestrator()).toEqual([]);

    // A second turn, dispatched like the first, with nobody polling this
    // time: the note is the only way the orchestrator hears about it. The
    // link is recorded again because the first one was spent when the first
    // turn ended, which is what a second dispatch does.
    backend().requestedBy = { agentId: 'orch', ptyId: 'pty-be' };
    await turnStarts('and again');
    await turnEnds('still green');
    await pause(500);

    expect(toldOrchestrator().join(''), 'the poll that answered went on silencing the next turn').toContain('1212-Backend');
  });
});

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux, once the home above
// has moved as the host names it; the win32 launch (the CLI as the terminal's
// process) is held by launch-call-sites.test.ts and agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform); });
