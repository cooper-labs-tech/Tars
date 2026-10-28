import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * delegate_task gives the task to the agent's own permanent terminal (2.0.4,
 * the maintainer's decision of 2026-10-18): POST /api/agents/:id/run-task
 * types it into the session its card shows, or starts that session with it,
 * and GET /api/tasks/:id follows it to its end, read from that session. No run
 * over ACP is opened to delegate any more.
 *
 * The route, the one-task queue, the dispatch, the real task ledger and the
 * real task watch; only node-pty is replaced, by a terminal that records what
 * is typed into it, and the CLI's hooks by the calls they make (a turn begins,
 * the agent rests) and the transcript Claude Code writes.
 *
 * Every way it can fail, written before the code:
 *  D1. The task is not typed into the terminal the agent's card shows: a run
 *      over ACP is opened, or a second terminal is spawned beside the first.
 *  D2. It is typed without the asker's line and its task id, so the agent
 *      cannot tell who asked, and the turn cannot be told apart.
 *  D3. With `answer: 'started'` the caller is not answered at once with a task
 *      id it can follow, or is answered `running` before any turn began.
 *  D4. Followed by that id, the task is not `starting` before its turn, nor
 *      the ledger's task from its turn on, nor its end once the agent rests.
 *  D5. The answer is the hooks' copy, cut at 4000 bytes, or the session's
 *      earlier conversation, not the transcript's final message for the task
 *      in full; why it ended is missing.
 *  D6. A turn interrupted (Esc, stop task) never ends the task: Claude Code
 *      sends no Stop for it. Or it ends as `completed`.
 *  D7. A turn that fails ends as completed, or without what the CLI said.
 *  D8. A second task given while the first works goes into the turn in hand,
 *      or is typed before the first's answer was read, which is then the
 *      second's.
 *  D9. The asker following its task by its id is also told its end in its own
 *      terminal: the same answer twice, a turn spent reading it.
 *  D10. A task the terminal refuses (a permission dialog is open) is followed
 *      for ever as `starting`, and the queue stays held.
 *  D11. A model asked for one task is said taken while the agent's session was
 *      already open, which a model cannot change.
 *  D12. A CLI whose turns Tars cannot see (no hook: opencode, amp, pi, grok)
 *      is followed for ever, or said to have answered what it did not.
 *
 * Added with codex's session log (fix/codex-works, 2026-10-18), before the code:
 *  D18. codex, whose turns Tars reads from its session log and posts as the
 *      hooks would (services/codex-sessions.ts), is said delivered as a CLI
 *      Tars cannot see, or followed to its end without its answer.
 *  D19. A codex turn interrupted (its log's turn_aborted, then the rest it
 *      comes to) ends the task as completed, or never ends it.
 *  D13. Another project's orchestrator that passed allowCrossProject: true is
 *      refused, or its task goes anywhere but the target's terminal (moved
 *      here from run-task-answer-at-start.test.ts, S8, with the run over ACP).
 *
 * Added after the Audit's gate of 6fb17592, before the code (2026-10-18):
 *  D14. (H1) An earlier turn that left background work running keeps its
 *      task open; the delegated task's turn is counted into that task, whose
 *      requester is someone else: its asker reads 404 "never started" and asks
 *      again, and the task runs twice.
 *  D15. (M1) A delegated task that leaves a server running in the background
 *      never ends: delegate_task never answers, and the agent's next task waits
 *      in the line for as long as the server lives. Or it ends without saying
 *      what it left running.
 *  D16. (W1) A turn whose prompt carries another task's id is taken as this
 *      task's turn.
 *  D18. (#461's E2E, 19/10) The interrupt watch (agent-watch) reads the Esc
 *      first and sets the agent at rest: the task ends `completed`, `end_turn`,
 *      though its turn was cut. Whichever reads the cut first, it ends
 *      `stopped`, `interrupted`.
 *  D17. (W2) A task whose turn writes no text is answered with the previous
 *      task's final message.
 *
 * Added 19/10 (the QA's CLI matrix, gemini as B), before the code:
 *  G1. A gemini agent, whose hooks say when its turn begins (BeforeAgent) and
 *      ends (AfterAgent), is taken for a CLI with no hook: its task is said
 *      delivered at once, its answer never read, its end never told.
 *  G2. A second task to it waits for ever behind the first's turn, or goes in
 *      before that turn ended.
 *  G3. (the Audit's L2 on #478) A gemini whose hooks never post (a version
 *      older than them, or an install that failed) is followed to a turn that
 *      never begins, for ever, and every task behind it waits for ever too.
 *
 * Added with the re-check of #536 at 8dab4d39 (2.0.5, lot 2), before the code:
 *  K1. A run-task kept across a restart of Tars (services/agent-queues.ts) goes
 *      back in under Tars's line, or its requester's as it is named today, not
 *      under the sender line it was queued with.
 *  K2. A kept item whose sender reads "the user" (a line only
 *      services/user-questions.ts may produce) is typed after that line.
 *  K3. (the Audit's Low at d50fd606) The same, for a kept dispatch (a message
 *      queued behind a busy agent): typed after "the user", or under another
 *      line than the one it was queued with.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-run-task-terminal-'));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Typed = { ptyId: string; data: string; taskRef?: string; sender?: { kind: string; id?: string } };
const typed: Typed[] = [];
/** What the terminal does with a message: written at once, or refused. */
let writeOutcome: 'written' | 'refused' = 'written';
vi.mock('../../../../electron/core/pty-manager', async (original) => {
  const real = await original<typeof import('../../../../electron/core/pty-manager')>();
  const ledger = await import('../../../../electron/services/task-ledger');
  return {
    ...real,
    ptyProcesses: new Map(),
    // As the real writer does (takeField): the line's id only under a sender, and the hand-off the turn takes noted once written.
    writeProgrammaticInput: vi.fn((pty: { id: string }, data: string, _bp: boolean, origin?: { agentId: string; taskRef?: string; sender?: Typed['sender']; onWritten?: () => void }) => {
      if (writeOutcome === 'refused') return 'refused';
      const taskRef = origin?.sender ? origin.taskRef : undefined;
      typed.push({ ptyId: pty.id, data, taskRef, sender: origin?.sender });
      origin?.onWritten?.();
      if (origin) ledger.noteHandOff(origin.agentId, { ...ledger.handOffFrom(origin.sender as never), text: data, ref: taskRef });
      return 'written';
    }),
  };
});
vi.mock('../../../../electron/core/agent-pty', async (original) => ({
  ...(await original<typeof import('../../../../electron/core/agent-pty')>()),
  cliRunningIn: (p: unknown) => !!p,
  spawnAgentPty: vi.fn(() => { throw new Error('no second terminal'); }),
}));
const acpRuns: unknown[] = [];
vi.mock('../../../../electron/services/acp/delegate', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/acp/delegate')>()),
  canDelegateOverAcp: () => true,
  delegateOverAcp: async (opts: unknown) => { acpRuns.push(opts); return { ok: true, started: true, text: 'over ACP' }; },
}));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { registerAgentRoutes, replayQueuedItem } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { noteTurn, liveTaskLedger } from '../../../../electron/services/task-ledger';
import { startTaskWatch, stopTaskWatch, turnInterrupted } from '../../../../electron/services/task-watch';
import { emitAgentStatus } from '../../../../electron/services/agent-events';
import { oneTaskQueue } from '../../../../electron/core/one-task';
import { endInterruptedTurnsNow } from '../../../../electron/services/agent-watch';
import { transcriptPath } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

let routes: RouteApp;
let ledgerDir: string;

beforeEach(() => {
  typed.length = 0;
  acpRuns.length = 0;
  writeOutcome = 'written';
  agents.clear();
  (ptyProcesses as Map<string, unknown>).clear();
  ledgerDir = fs.mkdtempSync(path.join(tmp, 'ledger-'));
  startTaskWatch(path.join(ledgerDir, 'l.jsonl'), path.join(ledgerDir, 't.jsonl'), path.join(ledgerDir, 'r.jsonl'));
  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(routes, {
    mainWindow: null,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({}) as AppSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext);
});

afterEach(async () => {
  // A task left open by a test ends with its agent: the next test's queue is free.
  agents.clear();
  await until(() => ['dev', 'oc', 'lead'].every((id) => !oneTaskQueue.busyRun(id) && !oneTaskQueue.queued(id).length));
  stopTaskWatch();
});

type Answer = { data: Record<string, unknown>; status: number };
function call(method: 'GET' | 'POST', url: string, callerAgentId: string, body?: Record<string, unknown>) {
  const u = new URL(`http://localhost${url}`);
  const route = routes.routes.find(r => r.method === method && typeof r.pattern !== 'string' && r.pattern.test(u.pathname))!;
  const match = (route.pattern as RegExp).exec(u.pathname)!;
  let got: Answer | undefined;
  let settle!: (a: Answer) => void;
  const answer = new Promise<Answer>((resolve) => { settle = resolve; });
  const req = {
    method, pathname: u.pathname, url: u, body: body ?? {},
    raw: { headers: {}, on: () => {} }, res: {}, params: { id: match[1] }, callerAgentId,
  } as unknown as RouteRequest;
  void route.handler(req, (data, status = 200) => {
    if (got) return;
    got = { data: data as Record<string, unknown>, status };
    settle(got);
  }, {} as RouteContext);
  return { answer, answered: () => got };
}

const project = () => {
  const p = path.join(tmp, 'project');
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** An agent whose CLI runs in its terminal, at its prompt, in session `sid`. */
function liveAgent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  const ptyId = `pty-${id}`;
  (ptyProcesses as Map<string, unknown>).set(ptyId, { id: ptyId, pid: 4242, write: vi.fn(), onExit: vi.fn(), onData: vi.fn() });
  const agent = {
    id, name: id, status: 'waiting', waitingReason: 'idle', provider: 'claude', projectPath: project(), ptyCwd: project(),
    skills: [], output: [], lastActivity: new Date().toISOString(), ptyId, currentSessionId: `sid-${id}`,
    ...over,
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

function orchestrator(): AgentStatus {
  const lead = { id: 'lead', name: 'Lead', status: 'running', role: 'orchestrator', provider: 'claude', projectPath: project(), skills: [], output: [], lastActivity: new Date().toISOString() } as AgentStatus;
  agents.set('lead', lead);
  return lead;
}

/** The transcript line Claude Code writes for a reply. */
function reply(agent: AgentStatus, text: string, at = Date.now()) {
  const file = transcriptPath(agent.projectPath, agent.currentSessionId!, os.homedir());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: `m-${at}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } }) + '\n');
}

/** What the CLI's hooks do around a turn: UserPromptSubmit, then the rest it comes to. */
function turnBegins(agent: AgentStatus, prompt: string) {
  agent.status = 'running';
  noteTurn(agent, { sessionId: agent.currentSessionId, text: prompt });
  emitAgentStatus(agent.id);
}
function rests(agent: AgentStatus, status: 'idle' | 'error' = 'idle', error?: string) {
  agent.status = status;
  if (error) agent.error = error;
  emitAgentStatus(agent.id);
}

const until = async (what: () => unknown, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** The envelope a sender line carries, as the real writer types it. */
const promptOf = (t: Typed) => (t.taskRef ? `Message from agent "Lead" ("lead"), task ${t.taskRef}: ${t.data}` : t.data);

describe('a task delegated into the agent\'s own terminal', () => {
  it('(D1, D2, D3) is typed into the terminal its card shows, under its asker\'s line, and answered at once with an id to follow', async () => {
    orchestrator();
    liveAgent('dev');
    const run = call('POST', '/api/agents/dev/run-task', 'lead', { task: 'review the notes', answer: 'started' });
    const { data, status } = await run.answer;
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, queued: false, outcome: 'starting' });
    expect(String(data.taskId)).toMatch(/^t-[0-9a-f]{8}$/);
    await until(() => typed.length === 1);
    expect(typed[0]).toMatchObject({ ptyId: 'pty-dev', data: 'review the notes', taskRef: data.taskId, sender: { kind: 'agent', id: 'lead' } });
    expect(acpRuns).toHaveLength(0);
  });

  it('(D4, D5) followed by its id: starting, then the ledger\'s task, then its end with the transcript\'s final message in full', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'review the notes', answer: 'started' }).answer;
    const ref = String(data.taskId);
    await until(() => typed.length === 1);
    expect((await call('GET', `/api/tasks/${ref}`, 'lead').answer).data.task).toMatchObject({ id: ref, outcome: 'starting' });

    reply(dev, 'an answer to an earlier task', Date.now() - 60_000);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    const running = (await call('GET', `/api/tasks/${ref}`, 'lead').answer).data.task as Record<string, unknown>;
    expect(running.outcome).toBe('running');
    expect(running.id).not.toBe(ref);

    const long = `The notes are fine. ${'detail '.repeat(1200)}END`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(4000);
    reply(dev, 'Let me read them.');
    reply(dev, long, Date.now() + 5);
    dev.lastCleanOutput = long.slice(0, 4000);
    rests(dev);
    const wait = call('GET', `/api/tasks/${ref}?wait=10`, 'lead');
    const ended = (await wait.answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'completed', stopReason: 'end_turn', result: long });
    expect(liveTaskLedger()!.task(String(ended.id))).toMatchObject({ stopReason: 'end_turn', result: long });
  });

  it('(D6) an interrupted turn ends the task as stopped, interrupted, though no Stop came', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a long job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    reply(dev, 'Starting the long job.');
    const file = transcriptPath(dev.projectPath, dev.currentSessionId!, os.homedir());
    fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 10).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'stopped', stopReason: 'interrupted', result: 'Starting the long job.' });
  });

  it('(D7) a turn that fails ends as error, with what the CLI said', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    rests(dev, 'error', 'Not logged in · Please run /login');
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'error', stopReason: 'error' });
    expect(String(ended.error)).toContain('Not logged in');
  });

  it('(D8) a second task waits its turn, and goes in only after the first\'s answer was read', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const first = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'first job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    const second = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'second job', answer: 'started' }).answer;
    expect(second.data).toMatchObject({ queued: true, outcome: 'queued' });
    expect(String(second.data.queuedBehind)).toMatch(/from "Lead"/);
    await new Promise((r) => setTimeout(r, 600));
    expect(typed).toHaveLength(1);
    reply(dev, 'first answer');
    rests(dev);
    const one = (await call('GET', `/api/tasks/${first.data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(one).toMatchObject({ outcome: 'completed', result: 'first answer' });
    await until(() => typed.length === 2);
    expect(typed[1]).toMatchObject({ ptyId: 'pty-dev', data: 'second job', taskRef: second.data.taskId });
  });

  it('(D10) a task the terminal refuses never started, says why, and frees the queue', async () => {
    orchestrator();
    liveAgent('dev');
    writeOutcome = 'refused';
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended.outcome).toBe('error');
    expect(String(ended.error)).toMatch(/never started/);
    writeOutcome = 'written';
    const next = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'another', answer: 'started' }).answer;
    expect(next.data).toMatchObject({ queued: false });
  });

  it('(D11) a model asked for one task, the session already open, is said not taken', async () => {
    orchestrator();
    liveAgent('dev', { model: 'sonnet' });
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', model: 'opus', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    const task = (await call('GET', `/api/tasks/${data.taskId}`, 'lead').answer).data.task as Record<string, unknown>;
    expect(task.model).toMatchObject({ asked: 'opus', taken: false, own: 'sonnet' });
  });

  it('(D12) a CLI whose turns Tars cannot see: typed in, then said delivered, with what is not read', async () => {
    orchestrator();
    liveAgent('oc', { provider: 'opencode' });
    const { data } = await call('POST', '/api/agents/oc/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    const task = (await call('GET', `/api/tasks/${data.taskId}?wait=5`, 'lead').answer).data.task as Record<string, unknown>;
    expect(task.outcome).toBe('delivered');
    expect(String(task.error)).toMatch(/opencode/);
    expect(String(task.error)).toMatch(/cannot see when its turn ends/);
  });
});

describe('a task delegated into a gemini agent, whose hooks say when its turns begin and end', () => {
  it('(G1) is followed to its turn\'s end, and answered with what its hooks gave', async () => {
    orchestrator();
    const gem = liveAgent('gem', { provider: 'gemini' });
    const { data } = await call('POST', '/api/agents/gem/run-task', 'lead', { task: 'review the notes', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(gem, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    expect(((await call('GET', `/api/tasks/${data.taskId}`, 'lead').answer).data.task as Record<string, unknown>).outcome).toBe('running');
    // AfterAgent: its answer (prompt_response), then the rest.
    gem.lastCleanOutput = 'The notes are fine.';
    rests(gem);
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'completed', stopReason: 'end_turn', result: 'The notes are fine.' });
  });

  it('(G2) a second task goes in at the first\'s end, and is answered with its own', async () => {
    orchestrator();
    const gem = liveAgent('gem', { provider: 'gemini' });
    const first = await call('POST', '/api/agents/gem/run-task', 'lead', { task: 'first job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(gem, promptOf(typed[0]));
    const second = await call('POST', '/api/agents/gem/run-task', 'lead', { task: 'second job', answer: 'started' }).answer;
    expect(second.data).toMatchObject({ queued: true, outcome: 'queued' });
    await new Promise((r) => setTimeout(r, 300));
    expect(typed).toHaveLength(1);
    gem.lastCleanOutput = 'first answer';
    rests(gem);
    expect(((await call('GET', `/api/tasks/${first.data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>).result).toBe('first answer');
    await until(() => typed.length === 2);
    turnBegins(gem, promptOf(typed[1]));
    await new Promise((r) => setTimeout(r, 30));
    gem.lastCleanOutput = 'second answer';
    rests(gem);
    expect(((await call('GET', `/api/tasks/${second.data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>)).toMatchObject({ outcome: 'completed', result: 'second answer' });
  });
});

describe('a task delegated into a gemini whose hooks never post (the Audit\'s L2 on #478)', () => {
  it('(G3) ends as an error once its turn has not begun within the wait, and the next task goes in', async () => {
    orchestrator();
    liveAgent('gem', { provider: 'gemini' });
    const first = await call('POST', '/api/agents/gem/run-task', 'lead', { task: 'first job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    const second = await call('POST', '/api/agents/gem/run-task', 'lead', { task: 'second job', answer: 'started' }).answer;
    expect(second.data).toMatchObject({ queued: true });
    // The wait for its turn is counted from when it went in: the clock is taken from there on.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      // No BeforeAgent ever comes: nothing but the wait ends it.
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000);
      const ended = (await call('GET', `/api/tasks/${first.data.taskId}?wait=5`, 'lead').answer).data.task as Record<string, unknown>;
      expect(ended.outcome).toBe('error');
      expect(String(ended.error)).toMatch(/did not begin within 15 minutes/);
      await until(() => typed.length === 2);
      expect(typed[1].data).toContain('second job');
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});

describe('a task delegated to a codex agent', () => {
  it("(D18) is followed to its turn's end, as codex's session log tells it, and answered with its final message", async () => {
    orchestrator();
    const dev = liveAgent('dev', { provider: 'codex' });
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    // The answer codex wrote at the turn's end (task_complete's last_agent_message), posted in full.
    const long = `Done. ${'detail '.repeat(1200)}END`;
    dev.lastCleanOutput = long;
    rests(dev);
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'completed', stopReason: 'end_turn', result: long });
  });
});

describe('a task delegated to a codex agent, its turn interrupted', () => {
  it('(D19) ends as stopped, interrupted, when codex logs the turn aborted, then rests', async () => {
    orchestrator();
    const dev = liveAgent('dev', { provider: 'codex' });
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a long job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    // What the session watch does on codex's turn_aborted (main.ts wires it to this), then its post of the rest.
    turnInterrupted(dev.id, dev.currentSessionId!);
    rests(dev);
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'stopped', stopReason: 'interrupted' });
  });

  it("(D19) an interrupt from a session that is not the agent's is not its task's", async () => {
    orchestrator();
    const dev = liveAgent('dev', { provider: 'codex' });
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    turnInterrupted(dev.id, 'an-older-session');
    dev.lastCleanOutput = 'all done';
    rests(dev);
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'completed', stopReason: 'end_turn', result: 'all done' });
  });
});

describe('a task from another project', () => {
  it('(D13) allowed with allowCrossProject: true, goes into the target\'s terminal', async () => {
    const lead = orchestrator();
    lead.projectPath = path.join(tmp, 'another-project');
    liveAgent('dev');
    const { data, status } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'cross', answer: 'started', allowCrossProject: true }).answer;
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, queued: false });
    await until(() => typed.length === 1);
    expect(typed[0]).toMatchObject({ ptyId: 'pty-dev', data: 'cross' });
  });
});

describe('the asker following its task', () => {
  it('(D9) is not told its end in its own terminal as well', async () => {
    const lead = orchestrator();
    // At its prompt: news for it would be typed in at once.
    lead.status = 'waiting';
    lead.waitingReason = 'idle';
    const leadPty = { id: 'pty-lead', pid: 4343, write: vi.fn(), onExit: vi.fn(), onData: vi.fn() };
    (ptyProcesses as Map<string, unknown>).set('pty-lead', leadPty);
    agents.get('lead')!.ptyId = 'pty-lead';
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    const wait = call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead');
    await new Promise((r) => setTimeout(r, 50));
    reply(dev, 'done');
    rests(dev);
    expect(((await wait.answer).data.task as Record<string, unknown>).result).toBe('done');
    await new Promise((r) => setTimeout(r, 300));
    expect(typed.filter((t) => t.ptyId === 'pty-lead')).toEqual([]);
  });
});

/** A background Bash the CLI started in its turn, as Claude Code writes its result. */
function backgroundStarted(agent: AgentStatus, id: string, at = Date.now()) {
  const file = transcriptPath(agent.projectPath, agent.currentSessionId!, os.homedir());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'started' }] }, toolUseResult: { backgroundTaskId: id } }) + '\n');
}

describe('a delegated task and the background work of a turn (the Audit\'s gate of 6fb17592)', () => {
  it('(D14) its turn opens a task of its own after an earlier turn that left background work: its asker follows it', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    turnBegins(dev, 'the user typed: start the dev server');
    await new Promise((r) => setTimeout(r, 20));
    backgroundStarted(dev, 'bgserver1');
    reply(dev, 'Started the server in the background.');
    rests(dev);
    await new Promise((r) => setTimeout(r, 100));
    const before = liveTaskLedger()!.openTaskOf('dev')?.id;
    expect(before, 'the earlier task is open while its server runs').toBeDefined();
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'review the notes', answer: 'started' }).answer;
    const ref = String(data.taskId);
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 50));
    reply(dev, 'ANSWER-TO-REVIEW');
    rests(dev);
    const g = await call('GET', `/api/tasks/${ref}?wait=3`, 'lead').answer;
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    const task = g.data.task as Record<string, unknown>;
    expect(task).toMatchObject({ requesterAgentId: 'lead', outcome: 'completed', result: 'ANSWER-TO-REVIEW' });
    expect(task.id, 'counted into the earlier task').not.toBe(before);
    expect(liveTaskLedger()!.task(before!)?.endedAt, 'the earlier task still open').not.toBeNull();
  });

  it('(D15) it ends at its turn\'s rest with its answer and what it left running, and the next task is not held', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'start the server and report', answer: 'started' }).answer;
    const ref = String(data.taskId);
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 20));
    backgroundStarted(dev, 'bgserver2');
    reply(dev, 'The server runs on :3000.');
    rests(dev);
    const g = await call('GET', `/api/tasks/${ref}?wait=3`, 'lead').answer;
    const task = g.data.task as Record<string, unknown>;
    expect(task, JSON.stringify(g.data)).toMatchObject({ outcome: 'completed', result: 'The server runs on :3000.', backgroundLeft: ['bgserver2'] });
    const next = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'second task', answer: 'started' }).answer;
    expect(next.data, 'held behind the server').toMatchObject({ queued: false, outcome: 'starting' });
  });

  it('(D16) a turn tagged with another task\'s id is not this task\'s', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'review the notes', answer: 'started' }).answer;
    const ref = String(data.taskId);
    await until(() => typed.length === 1);
    turnBegins(dev, 'Message from agent "Lead" ("lead"), task t-0000dead: something else');
    await new Promise((r) => setTimeout(r, 300));
    expect((await call('GET', `/api/tasks/${ref}`, 'lead').answer).data.task).toMatchObject({ id: ref, outcome: 'starting' });
    rests(dev);
    await new Promise((r) => setTimeout(r, 100));
    turnBegins(dev, promptOf(typed[0]));
    reply(dev, 'mine');
    rests(dev);
    const g = await call('GET', `/api/tasks/${ref}?wait=3`, 'lead').answer;
    expect(g.data.task).toMatchObject({ outcome: 'completed', result: 'mine' });
  });

  it('(D17) a task whose turn writes no text is not answered with the task before it', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const first = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'first', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    reply(dev, 'FIRST-ANSWER');
    rests(dev);
    expect(((await call('GET', `/api/tasks/${String(first.data.taskId)}?wait=3`, 'lead').answer).data.task as Record<string, unknown>).result).toBe('FIRST-ANSWER');
    await new Promise((r) => setTimeout(r, 50));
    const second = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'second', answer: 'started' }).answer;
    await until(() => typed.length === 2);
    turnBegins(dev, promptOf(typed[1]));
    await new Promise((r) => setTimeout(r, 50));
    rests(dev);
    const g = await call('GET', `/api/tasks/${String(second.data.taskId)}?wait=3`, 'lead').answer;
    const task = g.data.task as Record<string, unknown>;
    expect(task.outcome).toBe('completed');
    expect(task.result, 'the first task\'s answer').not.toBe('FIRST-ANSWER');
  });

  it('(D18) the interrupt watch reading the Esc first does not make the cut task end_turn', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a long job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    reply(dev, 'Starting the long job.');
    const file = transcriptPath(dev.projectPath, dev.currentSessionId!, os.homedir());
    fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 10).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
    await new Promise((r) => setTimeout(r, 20));
    // The watch's tick, before the run's next look (every 500 ms).
    endInterruptedTurnsNow();
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'stopped', stopReason: 'interrupted' });
  });
});


describe('a run-task kept across a restart of Tars (the re-check of #536 at 8dab4d39)', () => {
  const kept = (ref: string, sender: unknown) => ({
    ref, agentId: 'dev', title: 'kept', queuedAt: Date.now(), how: 'task' as const,
    replay: { kind: 'run-task', task: `kept task ${ref}`, from: 'Slack', sender },
  });
  async function replayed(item: ReturnType<typeof kept>) {
    const [restored] = oneTaskQueue.restore({ items: [item as never], paused: {} });
    replayQueuedItem(restored);
    await until(() => typed.some((t) => t.data === item.replay.task));
    return typed.find((t) => t.data === item.replay.task)!;
  }

  it('(K1) goes back in under the sender line it was queued with', async () => {
    const dev = liveAgent('dev');
    const t = await replayed(kept('t-0000000e', { kind: 'channel', channel: 'Slack' }));
    // A channel's line, as Tars's, carries no task id (only an agent's does).
    expect(t).toMatchObject({ ptyId: 'pty-dev', sender: { kind: 'channel', channel: 'Slack' } });
    turnBegins(dev, `Message from Slack: ${t.data}`);
    rests(dev);
  });

  it('(K2) never after "the user": a kept sender Tars does not write gives the default line', async () => {
    const dev = liveAgent('dev');
    const t = await replayed(kept('t-0000000f', { kind: 'user', via: 'Telegram' }));
    expect(t.sender).toEqual({ kind: 'tars' });
    turnBegins(dev, `Message from Tars: ${t.data}`);
    rests(dev);
  });

  it('(K3) a kept dispatch: its own sender line, and never "the user"', async () => {
    const dev = liveAgent('dev');
    const message = (ref: string, sender: unknown) => ({
      ref, agentId: 'dev', title: 'kept', queuedAt: Date.now(), how: 'message' as const,
      replay: { kind: 'dispatch', opts: { message: `kept message ${ref}`, from: 'Slack', sender } },
    });
    const sent = async (item: ReturnType<typeof message>) => {
      const [restored] = oneTaskQueue.restore({ items: [item as never], paused: {} });
      replayQueuedItem(restored);
      await until(() => typed.some((t) => t.data.includes(item.replay.opts.message)));
      return typed.find((t) => t.data.includes(item.replay.opts.message))!;
    };
    const slack = await sent(message('t-0000001a', { kind: 'channel', channel: 'Slack' }));
    expect(slack.sender).toEqual({ kind: 'channel', channel: 'Slack' });
    turnBegins(dev, `Message from Slack: ${slack.data}`);
    rests(dev);
    await until(() => !oneTaskQueue.busyRun('dev'));
    const user = await sent(message('t-0000001b', { kind: 'user', via: 'Telegram' }));
    expect(user.sender).toEqual({ kind: 'tars' });
    turnBegins(dev, `Message from Tars: ${user.data}`);
    rests(dev);
  });
});
