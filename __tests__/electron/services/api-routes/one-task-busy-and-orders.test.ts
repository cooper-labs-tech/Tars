import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * One task at a time and a worker's orders, at the routes, after the Audit's
 * gate of #449 at f9966e6e: what a run, a turn and a note really hold, for
 * every CLI, and the routes the first pass missed. The routes, the queue, the
 * terminals' writer, the task ledger and the kanban's claim are the real ones;
 * the terminals are fake ptys. Since 2.0.4 a delegated task goes into the
 * agent's own terminal (no run over ACP): a claude terminal here does what
 * Claude Code's hooks do when a task is typed in, its turn begins, and that
 * turn lasts until the test ends it. A "run" below is that delegated task in
 * hand: typed in, its turn, until its answer is read.
 *
 * How it fails, written before the code (2026-10-18):
 * 1. (H1) An agent whose CLI tells Tars nothing of its turns (amp, grok,
 *    opencode, pi: no end-of-turn hook; codex's turns are read from its
 *    session log since 2.0.4, case 1b) reads busy for ever once its
 *    terminal was handed a task: it stays `running` while its TUI is open,
 *    and every task delegated to it waits in its queue for ever.
 * 2. (H1) A claude agent whose Stop hook was lost, which the stall watch
 *    found doing nothing (stalledSince), holds its line for ever the same way.
 * 3. (H1) The other way round: a claude agent in a turn Tars can see end no
 *    longer holds its line, and a delegated run starts beside the turn.
 * 4. (H1) A worker's note to an agent with no end-of-turn hook waits for a
 *    turn's end that never comes: it is never typed in.
 * 5. (M1) A task typed into a live terminal never asks the queue: start_agent
 *    (/dispatch with a task) types into an agent at its prompt while a
 *    delegated run of it works, and two copies of it work at once; or, once
 *    it waited its turn, it never goes in.
 * 6. (M1) The same through /message.
 * 7. (M1) At the end of a terminal turn, a note held for it and a run queued
 *    behind the same turn both go: one into the terminal, one over ACP; or,
 *    the run under way, the note goes in as soon as the agent's status reads
 *    idle (its terminal's Stop came late, or the run does not own the status).
 * 8. (M1) Tars's own note (the kanban's, the error triage's) is typed into a
 *    terminal while a run of its agent works, or is queued as a task.
 * 9. (M2) A worker hands another agent a kanban task (assign_task with
 *    agent_id), which types it into that agent or starts it: an order; or the
 *    orchestrator is refused the same.
 * 10. (L1) A worker's steer, /run-task or /start reaches another agent.
 * 11. (L1) A worker's note to an agent with no session starts one, through
 *     /dispatch or /message.
 * 12. (L1) A stranger reads a task queued for another agent, or the shared
 *     token cancels one.
 * 13. (L2) A queued task is cancelled by a chat's runner that did not ask for
 *     it, or by the project's orchestrator with no reason, and the chat that
 *     asked is not told; or its asker, or Tars, is refused.
 * 14. (L3) A task given with start_agent that waited its turn is said
 *     `starting` for ever once it was handed over: its follower cannot tell it
 *     went in. (Since 2.0.4 the task before it started the agent's permanent
 *     session, and this one goes into that session: `typed`, never a second.)
 * 15. (L1, the Audit's K12, which only the role-site table caught) A worker's
 *     report to whoever leads it is labelled a note; or, a run of that agent
 *     under way, it is queued as a task in its line instead of waiting for
 *     the run's end.
 *
 * Added after the Audit's gate of 9d9a7ad9, before the code (2026-10-18):
 * 16. (H-A) The orchestrator's answer to an agent waiting on a question is
 *     queued behind a task that waits for that very turn: in auto mode as a
 *     task of its own, in queue mode behind the line. Nothing moves until a
 *     person acts.
 * 17. (M-A) A message held at the head of the terminal's writer lets the
 *     queued tasks behind it go in back to back: the second is typed into the
 *     first one's turn, and both read delivered before anything was typed.
 * 18. (L-A, the Audit's N9) The kanban's note to an agent whose run works is
 *     typed beside the run, or queued as a task.
 * 19. (L-D) A note held behind steady work is never retold: its sender heard
 *     only that it was queued.
 *
 * Added after the QA's gate of 05e31fa4, for the code that fixed them (mutant
 * killers, as cases 10 to 12):
 * 20. (D5) The kanban's hand-off to an agent whose run works is typed beside
 *     the run: no task.
 * 21. (D2) A task whose turn came while a note is still held sits behind the
 *     note in the writer, and the note waits for that task's turn: neither
 *     ever goes in.
 * 22. (D4) A task held in the writer (a person typing) gives its turn back
 *     before it is written, and the next task is typed behind it, into the
 *     same turn.
 *
 * Added after the Audit's gate of 8f4f1fd7 (M-B), failures first:
 * 23. A task whose turn came, held in the writer by a draft and taken back by
 *     its asker's cancel, keeps the turn for good: every later task to that
 *     agent queues behind a task that no longer exists, until Tars restarts.
 *
 * Added after the Audit's gate of 6fb17592 on #453, before the code:
 * 24. (L1) The banner's stop on a task in hand whose turn has not begun (held
 *     in the writer by a draft) sends Esc and says the turn stopped: the task
 *     is not withdrawn and goes in later, or another turn is interrupted.
 * 25. (L2) A task queued behind a delegated task whose CLI exited meanwhile is
 *     never said started: no session is started for it, or it reads typed.
 */

type FakePty = { pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn> };
const spawned = vi.hoisted(() => [] as FakePty[]);
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const t: FakePty = { pid: 7000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    spawned.push(t);
    return t;
  }),
}));
let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-spawned-${++uuidCounter}`) }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({ needsPromptInjection: () => false, assembleDigest: async () => '', wrapDigestForPrompt: (d: string) => d }));
/** The delegated tasks whose turn began in a claude terminal, each ended by the test (its Stop). */
const runs = vi.hoisted(() => [] as { task: string; end: () => void }[]);
// Who was told a task they asked for was cancelled: the chat that asked.
const told = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../../electron/services/agent-watch', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/agent-watch')>()),
  tellCancelled: (...args: unknown[]) => { told.push(args); },
}));

import { registerAgentRoutes, performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { registerTaskRoutes } from '../../../../electron/services/api-routes/task-routes';
import { registerKanbanRoutes, carryKanban } from '../../../../electron/services/api-routes/kanban-routes';
import { agentStatusEmitter } from '../../../../electron/services/agent-events';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents, wireDialogProbe } from '../../../../electron/core/agent-manager';
import { ptyProcesses, resetTerminalInput, writeHumanInput } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { oneTaskQueue } from '../../../../electron/core/one-task';
import { stopTask } from '../../../../electron/services/task-banner';
import { noteTurn } from '../../../../electron/services/task-ledger';
import { startTaskWatch, stopTaskWatch } from '../../../../electron/services/task-watch';
import { emitAgentStatus } from '../../../../electron/services/agent-events';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'one-task-busy-'));
let routes: RouteApp & { routes: Array<{ method: string; pattern: string | RegExp; handler: (req: RouteRequest, send: (data: unknown, status?: number) => void, ctx: RouteContext) => unknown }> };
let ctx: RouteContext;
const used = new Set<string>();

type Answer = { data: Record<string, unknown>; status: number };

/** A route called as the agent `caller` presents its own token (or Tars's pass, or the shared token: no caller). */
function call(method: string, url: string, body: Record<string, unknown>, caller: string | undefined, opts: { internal?: boolean } = {}) {
  const pathname = url.split('?')[0];
  const route = routes.routes.find(r => r.method === method && (typeof r.pattern === 'string' ? r.pattern === pathname : r.pattern.test(pathname)))!;
  const m = typeof route.pattern === 'string' ? [pathname] : pathname.match(route.pattern)!;
  let got: Answer | undefined;
  const req = {
    method, pathname, url: new URL(`http://localhost${url}`), body, raw: { headers: {}, on: () => {} }, res: {},
    params: m[1] ? { id: m[1] } : {}, callerAgentId: caller, ...(opts.internal ? { internal: true } : {}),
  } as unknown as RouteRequest;
  const done = route.handler(req, (data, status = 200) => { if (!got) got = { data: data as Record<string, unknown>, status }; }, ctx);
  return { done: Promise.resolve(done), answer: () => got };
}

function member(id: string, extra: Partial<AgentStatus> = {}): AgentStatus {
  used.add(id);
  const agent = {
    id, name: id.toUpperCase(), role: 'worker', status: 'idle', projectPath: project, provider: 'claude', skills: [], output: [],
    lastActivity: new Date().toISOString(), permissionMode: 'bypass', ...extra,
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

/**
 * What Claude Code's hooks do when a delegated task is submitted in its
 * terminal: its turn begins (UserPromptSubmit), and lasts until the test ends
 * it, its Stop: the agent rests.
 */
function begin(agent: AgentStatus, prompt: string) {
  agent.status = 'running';
  agent.lastTurnStartedAt = new Date().toISOString();
  noteTurn(agent, { sessionId: agent.currentSessionId, text: prompt });
  emitAgentStatus(agent.id);
  runs.push({ task: prompt, end: () => { agent.status = 'idle'; emitAgentStatus(agent.id); } });
}

/** An agent whose terminal runs its CLI (the foreground process is what cliRunningIn reads). */
function withCli(id: string, provider: string, status: AgentStatus['status'], extra: Partial<AgentStatus> = {}) {
  const terminal = spawnAgentPty({ binaryName: provider === 'claude' ? 'claude' : provider, shell: '/bin/bash', args: ['-l'], runsCommand: false, cwd: project, cols: 120, rows: 30, env: { CLAUDE_AGENT_ID: id } }) as unknown as FakePty;
  terminal.process = provider === 'claude' ? '2.1.300' : provider;
  ptyProcesses.set(`pty-${id}`, terminal as never);
  const agent = member(id, { status, provider: provider as AgentStatus['provider'], ptyId: `pty-${id}`, ptyCwd: project, currentSessionId: `sess-${id}`, ...extra });
  // A claude terminal: a task submitted in it (its Enter) begins a turn. Notes, reports and answers are no tasks here.
  if (provider === 'claude') {
    let line = '';
    terminal.write.mockImplementation((data: string) => {
      for (const ch of String(data)) {
        if (ch !== '\r') { line += ch; continue; }
        if (/TASK-[A-Z]/.test(line)) begin(agent, line.replace(/\x1b\[20[01]~/g, ''));
        line = '';
      }
    });
  }
  return { agent, terminal };
}
const typedInto = (t: FakePty) => t.write.mock.calls.map(c => String(c[0])).join('');
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  resetLaunches(); vi.useFakeTimers(); agents.clear(); ptyProcesses.clear(); spawned.length = 0; runs.length = 0; told.length = 0; used.clear();
  const ledgerDir = fs.mkdtempSync(path.join(project, 'ledger-'));
  startTaskWatch(path.join(ledgerDir, 'l.jsonl'), path.join(ledgerDir, 't.jsonl'), path.join(ledgerDir, 'r.jsonl'));
  routes = { routes: [], add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); }, get(p, h) { this.add('GET', p, h); }, post(p, h) { this.add('POST', p, h); }, put(p, h) { this.add('PUT', p, h); }, delete(p, h) { this.add('DELETE', p, h); } } as typeof routes;
  const settings = {} as AppSettings;
  ctx = { mainWindow: null, appSettings: settings, getAppSettings: () => settings, getTelegramBot: () => null, getSlackApp: () => null, slackResponseChannel: null, slackResponseThreadTs: null, handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(), initAgentPtyCallback: vi.fn(async () => 'unused'), agentStatusEmitter: new EventEmitter() } as RouteContext;
  registerAgentRoutes(routes, ctx);
  registerTaskRoutes(routes);
  registerKanbanRoutes(routes, ctx);
  // What main.ts wires at launch: a message sent to wait for a turn's end reads the agents.
  wireDialogProbe();
  member('orch', { role: 'orchestrator', status: 'running' });
  // Two chats' runners: stored as workers, with an orchestrator's powers, each for its own chat.
  member('chat2', { role: 'worker', kind: 'chat', status: 'running' } as Partial<AgentStatus>);
  member('chat3', { role: 'worker', kind: 'chat', status: 'running' } as Partial<AgentStatus>);
});

afterEach(() => {
  for (const r of runs) r.end();
  for (const id of used) {
    for (const t of oneTaskQueue.queued(id)) oneTaskQueue.cancel(t.ref);
    oneTaskQueue.runEnded(id);
  }
  for (const t of spawned) resetTerminalInput(t as never);
  vi.useRealTimers();
  stopTaskWatch();
});

describe('what holds an agent, for every CLI (H1)', () => {
  it('1. a grok worker whose terminal took a task, its TUI open and running, still gets a delegated task: it goes in', async () => {
    const { terminal } = withCli('gk', 'grok', 'running');
    const a = call('POST', '/api/agents/gk/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(a.answer()?.data, JSON.stringify(a.answer())).toMatchObject({ queued: false, outcome: 'delivered' });
    expect(typedInto(terminal)).toContain('TASK-A');
    // And the next one too: a task its CLI says nothing of does not hold it.
    const b = call('POST', '/api/agents/gk/run-task', { task: 'TASK-B fix it', answer: 'started' }, 'orch');
    await later(1500);
    expect(b.answer()?.data, JSON.stringify(b.answer())).toMatchObject({ queued: false, outcome: 'delivered' });
    expect(typedInto(terminal)).toContain('TASK-B');
  });

  it('1b. a codex worker in a turn, which Tars sees end in codex\'s session log since 2.0.4, holds its line as claude does', async () => {
    const { agent, terminal } = withCli('cx', 'codex', 'running');
    const a = call('POST', '/api/agents/cx/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(a.answer()?.data).toMatchObject({ queued: true, outcome: 'queued' });
    expect(typedInto(terminal), 'typed into the turn in hand').not.toContain('TASK-A');
    agent.status = 'idle';
    await later(1500);
    expect(typedInto(terminal), 'typed in once the turn ended').toContain('TASK-A');
  });

  it('2. a claude worker the stall watch found doing nothing (its Stop lost) does not hold its line', async () => {
    withCli('st', 'claude', 'running', { stalledSince: new Date(Date.now() - 31 * 60_000).toISOString() } as Partial<AgentStatus>);
    const a = call('POST', '/api/agents/st/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(a.answer()?.data, JSON.stringify(a.answer())).toMatchObject({ queued: false, outcome: 'starting' });
    expect(runs).toHaveLength(1);
  });

  it('3. a claude worker in a turn Tars can see end still holds its line: the task waits for the turn', async () => {
    const { agent } = withCli('cl', 'claude', 'running');
    const a = call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(a.answer()?.data).toMatchObject({ queued: true, outcome: 'queued' });
    expect(String(a.answer()?.data.queuedBehind)).toContain('a turn in its terminal');
    expect(runs).toHaveLength(0);
    agent.status = 'idle';
    await later(1500);
    expect(runs, 'started once the turn ended').toHaveLength(1);
  });

  it('4. a worker\'s note to a grok worker, its TUI open, is typed in: no turn end is waited for that never comes', async () => {
    const { terminal } = withCli('gk', 'grok', 'running');
    member('w1');
    const n = call('POST', '/api/agents/gk/dispatch', { message: 'NOTE-ONE the notes are in' }, 'w1');
    await later(3000);
    await n.done;
    expect(n.answer()?.data, JSON.stringify(n.answer())).toMatchObject({ success: true, note: true });
    expect(typedInto(terminal)).toContain('NOTE-ONE');
  });
});

describe('nothing goes into a terminal beside a run (M1)', () => {
  it('5. start_agent to an agent at its prompt while its delegated run works is queued, then typed in once the run ends, and said so', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(runs).toHaveLength(1);
    const b = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-B fix it', intent: 'task' }, 'orch');
    await later(2000);
    await b.done;
    expect(b.answer()?.data, JSON.stringify(b.answer())).toMatchObject({ success: true, mode: 'queued', queued: true });
    const ref = String(b.answer()?.data.queuedTask);
    expect(ref).toMatch(/^t-[0-9a-f]{8}$/);
    expect(typedInto(terminal), 'typed beside the run').not.toContain('TASK-B');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('TASK-B');
    const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await seen.done;
    expect(seen.answer()?.data.task, JSON.stringify(seen.answer())).toMatchObject({ id: ref, outcome: 'delivered', how: 'typed' });
  });

  it('6. /message to an agent at its prompt while its delegated run works types nothing, and says to send it with /dispatch', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const c = call('POST', '/api/agents/cl/message', { message: 'TASK-C fix it' }, 'orch');
    await later(2000);
    await c.done;
    expect(c.answer(), JSON.stringify(c.answer())).toMatchObject({ status: 409, data: { code: 'agent_busy' } });
    expect(typedInto(terminal)).not.toContain('TASK-C');
  });

  it('7. a note held for a turn\'s end and a run queued behind that turn go one after the other, never together', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'running');
    member('w1');
    const a = call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(a.answer()?.data).toMatchObject({ outcome: 'queued' });
    const n = call('POST', '/api/agents/cl/dispatch', { message: 'NOTE-TWO read me later' }, 'w1');
    await later(1500);
    await n.done;
    expect(n.answer()?.data).toMatchObject({ success: true, note: true, queued: true });
    expect(typedInto(terminal)).not.toContain('NOTE-TWO');
    // Its Stop: the turn ends, and one of the two takes the agent.
    agent.status = 'idle';
    await later(3000);
    const noteFirst = typedInto(terminal).includes('NOTE-TWO');
    expect(noteFirst && runs.length === 1, 'the note went in beside the run').toBe(false);
    expect(noteFirst || runs.length === 1, 'neither went').toBe(true);
    // The turn of whichever went ends: the other goes.
    if (noteFirst) agent.status = 'idle'; else runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('NOTE-TWO');
    expect(runs).toHaveLength(1);
  });

  it('7b. a note waits for a run whatever the agent\'s status reads (a late Stop, a run that does not own the status)', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'idle');
    member('w1');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(runs).toHaveLength(1);
    agent.status = 'idle';
    const n = call('POST', '/api/agents/cl/dispatch', { message: 'NOTE-SEVEN read me later' }, 'w1');
    await later(3000);
    await n.done;
    expect(n.answer()?.data).toMatchObject({ success: true, note: true, queued: true });
    expect(typedInto(terminal), 'the note went in beside the run').not.toContain('NOTE-SEVEN');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('NOTE-SEVEN');
  });

  it('8. Tars\'s own note to an agent whose run works waits for the run, and is no task in its queue', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    let got: Answer | undefined;
    const written = vi.fn();
    await performDispatch(agent, {
      message: 'INFO-ONE a task landed on your board', from: 'Tars', sender: { kind: 'tars' }, information: true, onWritten: written,
    } as Parameters<typeof performDispatch>[1], ctx, (data, status = 200) => { got ??= { data: data as Record<string, unknown>, status }; });
    await later(1500);
    expect(got?.data, JSON.stringify(got)).toMatchObject({ success: true, mode: 'message' });
    expect(got?.data.queuedTask).toBeUndefined();
    expect(oneTaskQueue.queued('cl')).toEqual([]);
    expect(typedInto(terminal)).not.toContain('INFO-ONE');
    expect(written).not.toHaveBeenCalled();
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('INFO-ONE');
    expect(written).toHaveBeenCalled();
  });
});

describe('a worker hands no work through the kanban (M2)', () => {
  it('9. a worker\'s assign_task for another agent is refused, and says to ask its orchestrator; the orchestrator\'s is not', async () => {
    member('w1');
    member('w2');
    const byWorker = call('POST', '/api/kanban/tasks/t_0123abcd/claim', { agent_id: 'w2' }, 'w1');
    await byWorker.done;
    expect(byWorker.answer(), JSON.stringify(byWorker.answer())).toMatchObject({ status: 403, data: { code: 'worker_may_not_order' } });
    expect(String(byWorker.answer()?.data.error)).toContain('Ask your orchestrator');
    // Past the role: the board answers (here, no Hermes is configured).
    const byLead = call('POST', '/api/kanban/tasks/t_0123abcd/claim', { agent_id: 'w2' }, 'orch');
    await byLead.done;
    expect(byLead.answer()?.status, JSON.stringify(byLead.answer())).not.toBe(403);
    const forItself = call('POST', '/api/kanban/tasks/t_0123abcd/claim', { agent_id: 'w1' }, 'w1');
    await forItself.done;
    expect(forItself.answer()?.status).not.toBe(403);
    expect(spawned).toHaveLength(0);
  });
});

describe('the routes the mutants walked through (L1)', () => {
  it('10. a worker\'s steer, run-task and start of another agent are refused, and nothing starts', async () => {
    member('w1');
    withCli('cl', 'claude', 'running');
    member('w3');
    const steer = call('POST', '/api/agents/cl/dispatch', { message: 'stop that', mode: 'steer' }, 'w1');
    const run = call('POST', '/api/agents/cl/run-task', { task: 'TASK-W run the gate', answer: 'started' }, 'w1');
    const start = call('POST', '/api/agents/w3/start', { prompt: 'TASK-W run the gate' }, 'w1');
    await later(500);
    await Promise.all([steer.done, run.done, start.done]);
    for (const [what, a] of [['steer', steer], ['run-task', run], ['start', start]] as const) {
      expect(a.answer(), `${what}: ${JSON.stringify(a.answer())}`).toMatchObject({ status: 403, data: { code: 'worker_may_not_order' } });
    }
    expect(runs).toHaveLength(0);
    expect(ctx.initAgentPtyCallback).not.toHaveBeenCalled();
  });

  it('11. a worker\'s note to an agent with no session starts none, through /dispatch or /message', async () => {
    member('w1');
    member('w2');
    const d = call('POST', '/api/agents/w2/dispatch', { message: 'NOTE-THREE' }, 'w1');
    const m = call('POST', '/api/agents/w2/message', { message: 'NOTE-FOUR' }, 'w1');
    await later(500);
    await Promise.all([d.done, m.done]);
    expect(d.answer(), JSON.stringify(d.answer())).toMatchObject({ status: 409, data: { code: 'note_needs_session' } });
    expect(m.answer(), JSON.stringify(m.answer())).toMatchObject({ status: 409, data: { code: 'note_needs_session' } });
    expect(ctx.initAgentPtyCallback).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });

  it('12. a stranger cannot read a queued task, and the shared token cannot cancel one', async () => {
    withCli('cl', 'claude', 'idle');
    member('w2');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const b = call('POST', '/api/agents/cl/run-task', { task: 'TASK-B fix it', answer: 'started' }, 'orch');
    await later(50);
    const ref = String(b.answer()?.data.taskId);
    expect(b.answer()?.data).toMatchObject({ outcome: 'queued' });
    const stranger = call('GET', `/api/tasks/${ref}`, {}, 'w2');
    const asker = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await Promise.all([stranger.done, asker.done]);
    expect(stranger.answer()?.status, JSON.stringify(stranger.answer())).toBe(404);
    expect(asker.answer()?.data.task).toMatchObject({ id: ref, outcome: 'queued' });
    const shared = call('POST', `/api/tasks/${ref}/cancel`, {}, undefined);
    await shared.done;
    expect(shared.answer()?.status).toBe(404);
    expect(oneTaskQueue.find(ref), 'still queued').toBeDefined();
  });
});

describe('who takes a queued task back (L2)', () => {
  it('13. its asker, Tars, or the project\'s orchestrator with a reason, which the chat that asked is told; not another chat', async () => {
    withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const queue = async (by: string, task: string) => {
      const q = call('POST', '/api/agents/cl/run-task', { task, answer: 'started' }, by);
      await later(50);
      expect(q.answer()?.data, JSON.stringify(q.answer())).toMatchObject({ outcome: 'queued' });
      return String(q.answer()?.data.taskId);
    };
    const cancel = async (ref: string, by: string | undefined, body: Record<string, unknown> = {}, internal = false) => {
      const c = call('POST', `/api/tasks/${ref}/cancel`, body, by, { internal });
      await c.done;
      return c.answer()!;
    };
    const b = await queue('chat2', 'TASK-B of chat 2');
    const otherChat = await cancel(b, 'chat3', { reason: 'mine now' });
    expect(otherChat, JSON.stringify(otherChat)).toMatchObject({ status: 403, data: { error: 'not_your_task' } });
    expect(oneTaskQueue.find(b), 'still queued').toBeDefined();
    const noReason = await cancel(b, 'orch');
    expect(noReason, JSON.stringify(noReason)).toMatchObject({ status: 400, data: { error: 'reason_required' } });
    expect(oneTaskQueue.find(b), 'still queued').toBeDefined();
    const withReason = await cancel(b, 'orch', { reason: 'the gate moved' });
    expect(withReason, JSON.stringify(withReason)).toMatchObject({ status: 200, data: { success: true, cancelled: b } });
    expect(oneTaskQueue.find(b)).toBeUndefined();
    expect(told, 'the chat that asked is told').toEqual([['chat2', 'cl', expect.any(String), 'the gate moved']]);
    const c = await queue('chat2', 'TASK-C of chat 2');
    expect(await cancel(c, 'chat2'), 'its asker, with no reason').toMatchObject({ status: 200, data: { cancelled: c } });
    const d = await queue('orch', 'TASK-D of the lead');
    expect(await cancel(d, undefined, {}, true), "Tars's own pass").toMatchObject({ status: 200, data: { cancelled: d } });
    expect(told).toHaveLength(1);
  });
});

describe('a worker reporting to whoever leads it (L1)', () => {
  it('15. its report is no note, and, a run of that agent under way, waits for it without taking a place in its line', async () => {
    const { agent: lead, terminal } = withCli('ld', 'claude', 'idle', { role: 'orchestrator' });
    member('w1');
    const atRest = call('POST', '/api/agents/ld/dispatch', { message: 'REPORT-ONE the PR is up' }, 'w1');
    await later(1500);
    await atRest.done;
    expect(atRest.answer()?.data, JSON.stringify(atRest.answer())).toMatchObject({ success: true, mode: 'message' });
    expect(atRest.answer()?.data.note).toBeUndefined();
    expect(typedInto(terminal)).toContain('REPORT-ONE');
    expect(typedInto(terminal)).not.toContain('Note for information');
    // The turn the report opened ends (its Stop); then a run of the orchestrator's own, asked by Tars.
    lead.status = 'idle';
    call('POST', '/api/agents/ld/run-task', { task: 'TASK-A plan', answer: 'started' }, undefined, { internal: true });
    await later(1500);
    expect(runs).toHaveLength(1);
    const duringRun = call('POST', '/api/agents/ld/dispatch', { message: 'REPORT-TWO tests green' }, 'w1');
    await later(1500);
    await duringRun.done;
    expect(duringRun.answer()?.data, JSON.stringify(duringRun.answer())).toMatchObject({ success: true, queued: true });
    expect(duringRun.answer()?.data.queuedTask, 'queued as a task').toBeUndefined();
    expect(oneTaskQueue.queued('ld')).toEqual([]);
    expect(typedInto(terminal)).not.toContain('REPORT-TWO');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('REPORT-TWO');
  });
});

describe('an answer, a held message and queued tasks (the Audit\'s gate of 9d9a7ad9)', () => {
  it('16. the answer to an agent waiting on a question goes in while a task waits for that turn, in auto mode', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'waiting', { waitingReason: 'question' } as Partial<AgentStatus>);
    const q = call('POST', '/api/agents/cl/run-task', { task: 'TASK-Q review', answer: 'started' }, 'orch');
    await later(50);
    expect(q.answer()?.data).toMatchObject({ outcome: 'queued' });
    const a = call('POST', '/api/agents/cl/dispatch', { message: 'ANSWER-42 yes, go on' }, 'orch');
    await later(2000);
    await a.done;
    expect(a.answer()?.data, JSON.stringify(a.answer())).toMatchObject({ success: true, mode: 'message' });
    expect(a.answer()?.data.queuedTask).toBeUndefined();
    expect(typedInto(terminal)).toContain('ANSWER-42');
    void agent;
  });

  it('16b. and in queue mode, which waits for a turn and a run, never for the tasks in line', async () => {
    const { terminal } = withCli('cl', 'claude', 'waiting', { waitingReason: 'question' } as Partial<AgentStatus>);
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-Q review', answer: 'started' }, 'orch');
    await later(50);
    const a = call('POST', '/api/agents/cl/dispatch', { message: 'ANSWER-43 yes', mode: 'queue' }, 'orch');
    await later(3000);
    await a.done;
    expect(typedInto(terminal), 'the answer waits behind the task that waits for it').toContain('ANSWER-43');
  });

  it('17. a held note and two queued tasks go in one at a time, each in a turn of its own, and delivered is said when it went in', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'idle');
    member('x');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const n = call('POST', '/api/agents/cl/dispatch', { message: 'NOTE-N for you' }, 'x');
    await later(500);
    await n.done;
    expect(n.answer()?.data).toMatchObject({ note: true, queued: true });
    const t = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-T fix it', intent: 'task' }, 'orch');
    await later(500);
    await t.done;
    const u = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-U fix that', intent: 'task' }, 'orch');
    await later(500);
    await u.done;
    const tRef = String(t.answer()?.data.queuedTask);
    const uRef = String(u.answer()?.data.queuedTask);
    runs[0].end();
    // At each rest one of them goes in, its own turn, never two; U after T; each said delivered only once in.
    const order: string[] = [];
    for (let rest = 0; rest < 3; rest++) {
      await later(3000);
      const now = ['NOTE-N', 'TASK-T', 'TASK-U'].filter(k => typedInto(terminal).includes(k));
      const fresh = now.filter(k => !order.includes(k));
      expect(fresh, `rest ${rest}: one at a time, typed so far ${now.join(', ')}`).toHaveLength(1);
      order.push(...fresh);
      for (const [key, ref] of [['TASK-T', tRef], ['TASK-U', uRef]] as const) {
        const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
        await seen.done;
        expect(seen.answer()?.data.task, `${key} at rest ${rest}`).toMatchObject(order.includes(key) ? { outcome: 'delivered', how: 'typed' } : { outcome: 'queued' });
      }
      // The turn of what went in ends.
      agent.status = 'idle';
    }
    expect(order.indexOf('TASK-T'), order.join(', ')).toBeLessThan(order.indexOf('TASK-U'));
  });

  it('18. the kanban\'s note to an agent whose run works waits for the run, and takes no place in its line', async () => {
    const { agent, terminal } = withCli('ld', 'claude', 'idle', { role: 'orchestrator' });
    call('POST', '/api/agents/ld/run-task', { task: 'TASK-A plan', answer: 'started' }, undefined, { internal: true });
    await later(1500);
    expect(runs).toHaveLength(1);
    // The task's turn works in the terminal: the kanban's held note is carried, and the fleet changes meanwhile.
    expect(agent.status).toBe('running');
    carryKanban([{ agentId: 'ld', item: { message: 'KANBAN-NOTE a task landed', sender: { kind: 'tars' }, purpose: 'note', what: 'the note of kanban task t_1' }, at: new Date().toISOString() }]);
    agentStatusEmitter.emit('fleet-change', 'ld');
    await later(3000);
    expect(oneTaskQueue.queued('ld'), 'queued as a task').toEqual([]);
    expect(typedInto(terminal), 'typed beside the run').not.toContain('KANBAN-NOTE');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('KANBAN-NOTE');
  });

  it('19. a note held behind work is said still held to its sender, once, ten minutes on', async () => {
    const { terminal: target } = withCli('cl', 'claude', 'idle');
    const { terminal: sender } = withCli('x', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const n = call('POST', '/api/agents/cl/dispatch', { message: 'NOTE-L for you' }, 'x');
    await later(500);
    await n.done;
    expect(n.answer()?.data).toMatchObject({ note: true, queued: true });
    await later(10 * 60_000);
    const told = () => typedInto(sender).split('still waits').length - 1;
    expect(told(), 'never told it is still held').toBe(1);
    await later(20 * 60_000);
    expect(told(), 'told more than once').toBe(1);
    runs[0].end();
    await later(3000);
    expect(typedInto(target)).toContain('NOTE-L');
  });
});

describe('the halves of the fix the QA pinned (gate of 05e31fa4)', () => {
  it('20. the kanban\'s hand-off to an agent whose run works is a task: it waits its turn, never typed beside the run', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(runs).toHaveLength(1);
    // The task's turn works in the terminal: the kanban's held hand-off is carried, and the fleet changes meanwhile.
    expect(agent.status).toBe('running');
    carryKanban([{ agentId: 'cl', item: { message: 'KANBAN-WORK task t_2 is yours', sender: { kind: 'tars' }, purpose: 'work', what: 'kanban task t_2' }, at: new Date().toISOString() }]);
    agentStatusEmitter.emit('fleet-change', 'cl');
    await later(3000);
    expect(typedInto(terminal), 'typed beside the run').not.toContain('KANBAN-WORK');
    // Since 2.0.4 the delegated task is a turn in the terminal: its status is that turn's, and the hand-off waits for
    // it, with the kanban or in the line. (A run over ACP left the status idle, and the hand-off waited in the line.)
    expect(oneTaskQueue.queued('cl').length, 'queued twice').toBeLessThanOrEqual(1);
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('KANBAN-WORK');
  });

  it('21. a task whose turn came while a note is held goes past it in the writer, and the note waits for that task\'s turn', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'idle');
    member('x');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const n = call('POST', '/api/agents/cl/dispatch', { message: 'NOTE-P for you' }, 'x');
    const t = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-P fix it', intent: 'task' }, 'orch');
    await Promise.all([n.done, t.done]);
    expect(n.answer()?.data).toMatchObject({ note: true, queued: true });
    expect(t.answer()?.data).toMatchObject({ mode: 'queued' });
    // Just after the note's first look at the turn probe: the task's turn comes before its next one.
    await later(1010);
    runs[0].end();
    await later(2000);
    expect(typedInto(terminal), 'the task never went in').toContain('TASK-P');
    expect(typedInto(terminal), 'the note went in with the task').not.toContain('NOTE-P');
    agent.status = 'idle';
    await later(3000);
    expect(typedInto(terminal)).toContain('NOTE-P');
  });

  it('22. a task held in the writer by a person typing keeps its turn: the next task waits for it, never typed behind it', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const t = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-T fix it', intent: 'task' }, 'orch');
    const u = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-U fix that', intent: 'task' }, 'orch');
    await Promise.all([t.done, u.done]);
    // Somebody types in the field as the run ends, and erases it: T's turn comes, and T waits for the pause.
    // (A key left in the field would hold T until it is sent: a draft is never set aside since 22/10.)
    writeHumanInput(terminal as never, 'h');
    writeHumanInput(terminal as never, '\x7f');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).not.toContain('TASK-T');
    expect(typedInto(terminal)).not.toContain('TASK-U');
    await later(5000);
    expect(typedInto(terminal), 'T never went in').toContain('TASK-T');
    expect(typedInto(terminal), "U typed behind T, into T's turn").not.toContain('TASK-U');
  });

  it('23. a task whose turn came, held by a draft and cancelled by its asker, gives the turn back: the next task runs', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const t = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-T fix it', intent: 'task' }, 'orch');
    await t.done;
    expect(t.answer()?.data).toMatchObject({ mode: 'queued' });
    // An arrow key in the field, a draft Tars cannot restore: T's turn comes and T is held there.
    writeHumanInput(terminal as never, '\x1b[A');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).not.toContain('TASK-T');
    const c = call('POST', `/api/tasks/${String(t.answer()?.data.taskRef)}/cancel`, {}, 'orch');
    await c.done;
    expect(c.answer()?.data).toMatchObject({ success: true });
    await later(2000);
    expect(oneTaskQueue.busyRun('cl'), 'the cancelled task still holds the turn').toBeUndefined();
    const z = call('POST', '/api/agents/cl/run-task', { task: 'TASK-Z next', answer: 'started' }, 'orch');
    await later(3000);
    expect(z.answer()?.data, 'queued behind a task that no longer exists').not.toMatchObject({ queued: true });
    // Z has the turn now (since 2.0.4 it goes into the same terminal, where the draft holds it in turn).
    expect(oneTaskQueue.busyRun('cl')?.taskRef, 'the next task never took the turn').toBe(String(z.answer()?.data.taskId));
    const q = call('GET', `/api/tasks/${String(t.answer()?.data.queuedTask)}`, {}, 'orch');
    await q.done;
    expect(q.answer()?.data, 'said starting for ever').toMatchObject({ task: { outcome: 'error', error: 'It never started: it was cancelled.' } });
  });

  it('23b. the same for a delegated task (run-task): held by a draft and cancelled by its asker, it gives the turn back at once', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const b = call('POST', '/api/agents/cl/run-task', { task: 'TASK-B fix it', answer: 'started' }, 'orch');
    await later(50);
    expect(b.answer()?.data).toMatchObject({ queued: true, outcome: 'queued' });
    const ref = String(b.answer()?.data.taskId);
    // An arrow key in the field, a draft Tars cannot restore: B's turn comes and B is held there.
    writeHumanInput(terminal as never, '\x1b[A');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).not.toContain('TASK-B');
    const c = call('POST', `/api/tasks/${ref}/cancel`, {}, 'orch');
    await c.done;
    expect(c.answer()?.data, JSON.stringify(c.answer())).toMatchObject({ success: true });
    await later(2000);
    expect(oneTaskQueue.busyRun('cl'), 'the cancelled task still holds the turn').toBeUndefined();
    const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await seen.done;
    expect(seen.answer()?.data.task, JSON.stringify(seen.answer())).toMatchObject({ outcome: 'error' });
    expect(String((seen.answer()?.data.task as { error?: string } | undefined)?.error)).toContain('cancelled');
  });
});

describe('a task that waited its turn and went in (L3)', () => {
  it('14. start_agent queued behind a task whose session was started for it is said delivered once typed into that session, never starting for ever', { timeout: 30_000 }, async () => {
    member('w3');
    call('POST', '/api/agents/w3/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    // Its session, started with the task: claude runs in its terminal, and its turn begins (Claude Code's hooks).
    spawned.at(-1)!.process = '2.1.300';
    begin(agents.get('w3')!, 'TASK-A review');
    const b = call('POST', '/api/agents/w3/dispatch', { message: 'TASK-B fix it', intent: 'task' }, 'orch');
    await later(50);
    await b.done;
    expect(b.answer()?.data, JSON.stringify(b.answer())).toMatchObject({ mode: 'queued' });
    const ref = String(b.answer()?.data.queuedTask);
    runs[0].end();
    await later(5000);
    const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await seen.done;
    expect(seen.answer()?.data.task, JSON.stringify(seen.answer())).toMatchObject({ id: ref, outcome: 'delivered', how: 'typed' });
    // Into the one session started for the task before it: no second one.
    expect(spawned).toHaveLength(1);
    expect(typedInto(spawned[0])).toContain('TASK-B');
  });
});

describe('after the Audit\'s gate of 6fb17592 on #453', () => {
  it('24. the banner\'s stop on a task held by a draft before its turn withdraws it, and interrupts nothing', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    // A draft in the field: the delegated task is held in the writer, its turn not begun.
    writeHumanInput(terminal as never, '\x1b[A');
    const a = call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    const ref = String(a.answer()?.data.taskId);
    expect(oneTaskQueue.busyRun('cl')?.taskRef).toBe(ref);
    const before = typedInto(terminal);
    expect(before).not.toContain('TASK-A');
    const stopped = await stopTask('cl', ref);
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ success: true, stopped: 'queued' });
    expect(typedInto(terminal).slice(before.length), 'Esc sent to a turn that is not this task\'s').not.toContain('\x1b');
    await later(2000);
    expect(oneTaskQueue.busyRun('cl'), 'the stopped task still holds the turn').toBeUndefined();
    await later(10_000);
    expect(typedInto(terminal), 'the stopped task went in later').not.toContain('TASK-A');
  });

  it('25. a task queued behind a delegated task whose CLI exited meanwhile starts a session: said started', { timeout: 30_000 }, async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(1500);
    expect(runs).toHaveLength(1);
    const b = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-B fix it', intent: 'task' }, 'orch');
    await later(50);
    await b.done;
    expect(b.answer()?.data, JSON.stringify(b.answer())).toMatchObject({ mode: 'queued' });
    const ref = String(b.answer()?.data.queuedTask);
    // The task's turn ends, and the CLI exits: its terminal is a shell again.
    terminal.process = 'bash';
    runs[0].end();
    await later(5000);
    const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await seen.done;
    expect(seen.answer()?.data.task, JSON.stringify(seen.answer())).toMatchObject({ id: ref, outcome: 'delivered', how: 'started' });
  });
});
