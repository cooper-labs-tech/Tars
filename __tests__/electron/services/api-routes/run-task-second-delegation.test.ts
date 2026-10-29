import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * The second task delegated into a claude agent's terminal, from another
 * agent, after the first one ended (the QA's CLI matrix, H1, 2026-10-18): it
 * was typed without its ", task t-..." line, and delegate_task told its asker
 * it "never started, and Tars no longer has it" while it ran.
 *
 * Unlike run-task-into-terminal.test.ts, the terminal's real writer types the
 * task here (core/pty-manager.ts, writeProgrammaticInput): only the terminal
 * is a stand-in, which records what it is given. The route, the one-task
 * queue, the dispatch, the real task ledger and the real task watch run as in
 * the app; the CLI's hooks are the calls they make.
 *
 * Every way it can fail, written before the code:
 *  S1. An asker the target once handed work to, whose link to the target is
 *      still up (a CLI with no hook, whose turn's end Tars never sees: amp,
 *      grok), is taken for a worker reporting back: its delegated task is
 *      typed without its task id, and its turn cannot be told apart.
 *  S2. One task typed into a live session leaves two hand-offs in the ledger
 *      (the writer's, and the route's own): the spare one, with no id, is
 *      taken by the agent's next turn that has none.
 *  S3. The second task, from another asker, is then filed under the first
 *      asker: its own asker reads 404 "never started" while it runs, and asks
 *      again.
 *  S4. The second task's answer is the first's, or it never ends.
 *  S5. An asker with no link to the target (the case that worked) changes:
 *      its line, its turn or its answer.
 *  S6. A task Tars itself hands over (the super chat), whose line carries no
 *      id, leaves its spare hand-off behind: the next turn the user types
 *      into that terminal is filed as Tars's task, with Tars's old words.
 *  P1. The target's CLI is not running (stopped, asleep, exited), so Tars
 *      starts a session with the task as its prompt: a task from an asker it
 *      once handed work to is filed as Tars's, or under the target's own
 *      requester, a third agent (the Audit's M1 on #470).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-run-task-second-'));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/agent-pty', async (original) => ({
  ...(await original<typeof import('../../../../electron/core/agent-pty')>()),
  cliRunningIn: (p: unknown) => !!p,
  spawnAgentPty: vi.fn(() => { throw new Error('no second terminal'); }),
}));
vi.mock('../../../../electron/services/acp/delegate', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/acp/delegate')>()),
  canDelegateOverAcp: () => true,
  delegateOverAcp: async () => { throw new Error('no run over ACP'); },
}));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses, rememberTerminalOwner } from '../../../../electron/core/pty-manager';
import { noteTurn, liveTaskLedger } from '../../../../electron/services/task-ledger';
import { startTaskWatch, stopTaskWatch } from '../../../../electron/services/task-watch';
import { emitAgentStatus } from '../../../../electron/services/agent-events';
import { oneTaskQueue } from '../../../../electron/core/one-task';
import { transcriptPath } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

let routes: RouteApp;

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  const ledgerDir = fs.mkdtempSync(path.join(tmp, 'ledger-'));
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
  agents.clear();
  await until(() => !oneTaskQueue.busyRun('dev') && !oneTaskQueue.queued('dev').length);
  stopTaskWatch();
});

type Answer = { data: Record<string, unknown>; status: number };
function call(method: 'GET' | 'POST', url: string, callerAgentId: string | undefined, body?: Record<string, unknown>): Promise<Answer> {
  const u = new URL(`http://localhost${url}`);
  const route = routes.routes.find(r => r.method === method && typeof r.pattern !== 'string' && r.pattern.test(u.pathname))!;
  const match = (route.pattern as RegExp).exec(u.pathname)!;
  let got = false;
  return new Promise<Answer>((resolve) => {
    const req = {
      method, pathname: u.pathname, url: u, body: body ?? {},
      raw: { headers: {}, on: () => {} }, res: {}, params: { id: match[1] }, callerAgentId, ...(callerAgentId ? {} : { internal: true }),
    } as unknown as RouteRequest;
    void route.handler(req, (data, status = 200) => {
      if (got) return;
      got = true;
      resolve({ data: data as Record<string, unknown>, status });
    }, {} as RouteContext);
  });
}

const until = async (what: () => unknown, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const project = () => {
  const p = path.join(tmp, 'project');
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** The claude agent the tasks go into: a terminal that records what the writer types, its CLI at its prompt. */
function target(): { agent: AgentStatus; written: string[] } {
  const written: string[] = [];
  const ptyId = 'pty-dev';
  const terminal = { id: ptyId, pid: 4242, write: (d: string) => { written.push(d); }, onExit: vi.fn(), onData: vi.fn() };
  ptyProcesses.set(ptyId, terminal as never);
  rememberTerminalOwner(terminal as never, 'dev');
  const agent = {
    id: 'dev', name: 'Claude Agent', status: 'waiting', waitingReason: 'idle', provider: 'claude', projectPath: project(), ptyCwd: project(),
    skills: [], output: [], lastActivity: new Date().toISOString(), ptyId, currentSessionId: 'sid-dev',
  } as AgentStatus;
  agents.set('dev', agent);
  return { agent, written };
}

/** An asker. `linkedTo`: the agent once handed it work, and its link to that agent is still up. */
function asker(id: string, name: string, linkedTo?: string): AgentStatus {
  const agent = {
    id, name, status: 'running', provider: id === 'x-amp' ? 'amp' : 'grok', projectPath: project(), skills: [], output: [],
    lastActivity: new Date().toISOString(),
    ...(linkedTo ? { requestedBy: { agentId: linkedTo, ptyId: 'pty-dev', taskRef: 't-0000aaaa' } } : {}),
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

/** What the CLI receives as its prompt once the Enter goes in: the typed text, paste markers off. */
function promptTyped(written: string[], from: number): string | undefined {
  const text = written.slice(from).join('');
  const enter = text.indexOf('\r');
  if (enter < 0) return undefined;
  return text.slice(0, enter).replace(/\x1b\[20[01]~/g, '');
}

function reply(agent: AgentStatus, text: string, at = Date.now()) {
  const file = transcriptPath(agent.projectPath, agent.currentSessionId!, os.homedir());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: `m-${at}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } }) + '\n');
}

/** A delegated task from `from`, typed in, its turn run and answered: what its asker reads at its end. */
async function delegate(dev: { agent: AgentStatus; written: string[] }, from: string | undefined, task: string, answer: string) {
  // The project's orchestrator for this task, as the matrix makes each asker in turn: a worker hands no work.
  for (const a of agents.values()) if (a.id !== 'dev') a.role = a.id === from ? 'orchestrator' : 'worker';
  const start = dev.written.length;
  const started = await call('POST', '/api/agents/dev/run-task', from, { task, answer: 'started' });
  expect(started.status, JSON.stringify(started.data)).toBe(200);
  const ref = String(started.data.taskId);
  let prompt: string | undefined;
  await until(() => (prompt = promptTyped(dev.written, start)));
  // UserPromptSubmit, the reply, then the Stop.
  dev.agent.status = 'running';
  noteTurn(dev.agent, { sessionId: dev.agent.currentSessionId, text: prompt });
  emitAgentStatus('dev');
  await new Promise((r) => setTimeout(r, 30));
  reply(dev.agent, answer);
  dev.agent.status = 'waiting';
  dev.agent.waitingReason = 'idle';
  emitAgentStatus('dev');
  const ended = await call('GET', `/api/tasks/${ref}?wait=10`, from);
  await until(() => !oneTaskQueue.busyRun('dev'));
  return { ref, prompt: prompt!, ended };
}

describe('two tasks delegated in a row into one claude agent, from two other agents', () => {
  it('(S1 to S4) both askers once given work by it: each task is typed under its asker\'s line with its id, and each asker reads its own answer', async () => {
    const dev = target();
    asker('x-amp', 'Amp Agent', 'dev');
    asker('x-grok', 'Grok Agent', 'dev');

    const first = await delegate(dev, 'x-amp', 'ECHO ANSWERAMPCLAUDE', 'echo ANSWERAMPCLAUDE');
    expect.soft(first.prompt).toContain(`Message from agent "Amp Agent" ("x-amp"), task ${first.ref}: `);
    expect(first.ended.status).toBe(200);
    expect(first.ended.data.task).toMatchObject({ outcome: 'completed', requesterAgentId: 'x-amp', result: 'echo ANSWERAMPCLAUDE' });

    const second = await delegate(dev, 'x-grok', 'ECHO ANSWERGROKCLAUDE', 'echo ANSWERGROKCLAUDE');
    expect.soft(second.prompt).toContain(`Message from agent "Grok Agent" ("x-grok"), task ${second.ref}: `);
    expect(second.ended.status, JSON.stringify(second.ended.data)).toBe(200);
    expect(second.ended.data.task).toMatchObject({ outcome: 'completed', requesterAgentId: 'x-grok', result: 'echo ANSWERGROKCLAUDE' });
  });

  it('(S2, S3) the first asker once given work by it, the second not: the second asker reads its own task, never 404', async () => {
    const dev = target();
    asker('x-amp', 'Amp Agent', 'dev');
    asker('x-grok', 'Grok Agent');

    const first = await delegate(dev, 'x-amp', 'first job', 'first answer');
    expect(first.ended.data.task).toMatchObject({ outcome: 'completed', requesterAgentId: 'x-amp', result: 'first answer' });
    const second = await delegate(dev, 'x-grok', 'second job', 'second answer');
    expect(second.ended.status, JSON.stringify(second.ended.data)).toBe(200);
    expect(second.ended.data.task).toMatchObject({ outcome: 'completed', requesterAgentId: 'x-grok', result: 'second answer' });
  });

  it('(S5) askers with no link to it, as before: each line has its id, each asker its own answer', async () => {
    const dev = target();
    asker('x-amp', 'Amp Agent');
    asker('x-grok', 'Grok Agent');

    const first = await delegate(dev, 'x-amp', 'first job', 'first answer');
    expect(first.prompt).toContain(`Message from agent "Amp Agent" ("x-amp"), task ${first.ref}: \nfirst job`);
    expect(first.ended.data.task).toMatchObject({ outcome: 'completed', requesterAgentId: 'x-amp', result: 'first answer' });
    const second = await delegate(dev, 'x-grok', 'second job', 'second answer');
    expect(second.prompt).toContain(`Message from agent "Grok Agent" ("x-grok"), task ${second.ref}: \nsecond job`);
    expect(second.ended.data.task).toMatchObject({ outcome: 'completed', requesterAgentId: 'x-grok', result: 'second answer' });
  });

  it('(S2, S6) a task from Tars, then a turn the user types: that turn is the terminal\'s own, not a second hand-off of Tars\'s', async () => {
    const dev = target();
    const first = await delegate(dev, undefined, 'first job from Tars', 'first answer');
    expect(first.ended.data.task).toMatchObject({ outcome: 'completed', source: 'tars', result: 'first answer' });

    // The user types into the terminal: UserPromptSubmit, then the Stop.
    dev.agent.status = 'running';
    const typedByUser = noteTurn(dev.agent, { sessionId: dev.agent.currentSessionId, text: 'what does this file do?' });
    emitAgentStatus('dev');
    await new Promise((r) => setTimeout(r, 30));
    const own = liveTaskLedger()!.task(String(typedByUser));
    expect(own).toMatchObject({ source: 'terminal', requesterAgentId: null });
    expect(own?.text).toBe('what does this file do?');
  });
});

describe('a task delegated into a claude agent whose CLI is not running', () => {
  // The launch each test starts is under way for CLI_BOOT_MS (core/agent-launch.ts): not the next test's.
  afterEach(() => resetLaunches());

  /** The task from `from`, which starts the agent's session: its first turn run and answered, then what its asker reads. */
  async function startedBy(from: string, linked: boolean) {
    const dev = target();
    // Stopped: no terminal, no session. The task starts one, its prompt the task.
    ptyProcesses.clear();
    Object.assign(dev.agent, { status: 'stopped', ptyId: undefined, currentSessionId: undefined, waitingReason: undefined });
    const launched: string[] = [];
    vi.mocked(spawnAgentPty).mockImplementationOnce((o) => {
      launched.push((o.args ?? []).join(' '));
      return { pid: 4343, write: vi.fn(), onExit: vi.fn(), onData: vi.fn(), kill: vi.fn(), resize: vi.fn() } as never;
    });
    asker(from, 'Amp Agent', linked ? 'dev' : undefined);
    // The dev agent's own requester, a third agent: never this task's asker.
    dev.agent.requestedBy = { agentId: 'x-lead', ptyId: 'pty-old', taskRef: 't-0000bbbb' };
    for (const a of agents.values()) if (a.id !== 'dev') a.role = a.id === from ? 'orchestrator' : 'worker';
    const started = await call('POST', '/api/agents/dev/run-task', from, { task: 'PROBE-TASK in a new session', answer: 'started' });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(launched).toHaveLength(1);
    const ref = String(started.data.taskId);
    // SessionStart, UserPromptSubmit on the launch's prompt (no sender line), the reply, then the Stop.
    dev.agent.currentSessionId = 'sid-new';
    dev.agent.status = 'running';
    noteTurn(dev.agent, { sessionId: 'sid-new', text: 'PROBE-TASK in a new session' });
    emitAgentStatus('dev');
    await new Promise((r) => setTimeout(r, 30));
    reply(dev.agent, 'probe answer');
    dev.agent.status = 'waiting';
    dev.agent.waitingReason = 'idle';
    emitAgentStatus('dev');
    const ended = await call('GET', `/api/tasks/${ref}?wait=3`, from);
    await until(() => !oneTaskQueue.busyRun('dev'));
    return ended;
  }

  it('(P1) from an asker it once handed work to: the task is that asker\'s, not Tars\'s nor its own requester\'s', async () => {
    const ended = await startedBy('x-amp', true);
    expect(ended.status, JSON.stringify(ended.data)).toBe(200);
    expect(ended.data.task).toMatchObject({ outcome: 'completed', source: 'agent', requesterAgentId: 'x-amp', result: 'probe answer' });
  });

  it('(P1, control) from an asker with no link to it, as before: the task is that asker\'s', async () => {
    const ended = await startedBy('x-amp', false);
    expect(ended.status, JSON.stringify(ended.data)).toBe(200);
    expect(ended.data.task).toMatchObject({ outcome: 'completed', source: 'agent', requesterAgentId: 'x-amp', result: 'probe answer' });
  });
});
