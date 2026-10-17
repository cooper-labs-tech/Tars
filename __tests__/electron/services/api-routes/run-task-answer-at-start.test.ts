import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * The server side of delegate_task after a cut connection (2.0.4), on its own:
 * POST /api/agents/:id/run-task with `answer: 'started'` and a per-run
 * `model`, and GET /api/tasks/:id?wait=. The Audit's L2 on f09ad4c9: only the
 * one happy-path E2E drove them, and a mutant TASK_WAIT_MAX_S = 600 survived
 * every test of the PR. The route is the real one; the run behind it is a
 * stand-in that starts when told and ends when told, and the ledger a small
 * in-memory one.
 *
 * Every way it can fail:
 *  S1. A wait is held past one segment (120 s), whatever `wait` asks: a
 *      request outlives undici's 300 s again.
 *  S2. A `wait` that is not a number, or negative, holds the request.
 *  S3. A task that ends during the wait is answered only at the segment's
 *      end, or answered `timeout: true`.
 *  S4. A model that is not a model name (spaces, not a string, too long,
 *      empty) reaches the run instead of a 400 invalid_model.
 *  S5. A valid model does not reach the run.
 *  S6. `answer: 'started'` with no task to follow (the ledger named none) is
 *      answered at the start anyway: the caller has nothing to wait on and the
 *      run's end is lost. It must then be answered at the end, with the run.
 *  S7. `answer: 'started'` with a task is not answered until the run ends.
 *  S8. The cross-project guard is looser or stricter on run-task than it was:
 *      another project's agent is driven without allowCrossProject: true, or
 *      refused with it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-run-task-at-start-'));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  PROGRAMMATIC_SUBMIT_DELAY_MS: 300,
}));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

type RunOpts = { model?: string; onStarted?: (run: { model?: unknown }) => void };
/** The run behind the route: starts at once, ends when the test says. */
const runs: { opts: RunOpts; end: () => void }[] = [];
vi.mock('../../../../electron/services/acp/delegate', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/acp/delegate')>()),
  canDelegateOverAcp: () => true,
  delegateOverAcp: async (opts: RunOpts) => {
    opts.onStarted?.({});
    await new Promise<void>((resolve) => runs.push({ opts, end: resolve }));
    return { ok: true, transport: 'acp', started: true, stopReason: 'end_turn', text: 'the run\'s answer', toolCalls: [] };
  },
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { setLiveTaskLedger, type TaskLedger } from '../../../../electron/services/task-ledger';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

let routes: RouteApp;
type Task = { id: string; agentId: string; requesterAgentId?: string; source: string; outcome: string; startedAt: number; endedAt?: number; result?: string };
let tasks: Map<string, Task>;
/** Whether the ledger names a task when a run starts. */
let ledgerNames: boolean;

beforeEach(() => {
  runs.length = 0;
  tasks = new Map();
  ledgerNames = true;
  agents.clear();
  setLiveTaskLedger({
    acpStarted: ({ agent, requesterAgentId }: { agent: AgentStatus; requesterAgentId?: string }) => {
      if (!ledgerNames) throw new Error('ledger unwritable');
      const id = `t-${tasks.size + 1}`;
      tasks.set(id, { id, agentId: agent.id, requesterAgentId, source: 'acp', outcome: 'running', startedAt: Date.now() });
      return id;
    },
    acpEnded: (id: string, end: { outcome: string; result?: string }) => {
      const t = tasks.get(id)!;
      tasks.set(id, { ...t, outcome: end.outcome, result: end.result, endedAt: Date.now() });
    },
    task: (id: string) => tasks.get(id),
  } as unknown as TaskLedger);
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

afterEach(() => {
  vi.useRealTimers();
  for (const run of runs) run.end();
  setLiveTaskLedger(null);
});

type Answer = { data: Record<string, unknown>; status: number };
/** Calls a route as the server does; `answer` settles when it sends, `answered()` says whether it has. */
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

function putAgent(id: string, projectPath = tmp): AgentStatus {
  const agent = {
    id, name: id, status: 'idle', provider: 'claude', projectPath,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('GET /api/tasks/:id?wait=', () => {
  function runningTask(): string {
    putAgent('a1');
    tasks.set('t-9', { id: 't-9', agentId: 'a1', source: 'acp', outcome: 'running', startedAt: Date.now() });
    return 't-9';
  }

  it('(S1) holds a wait of 600 s for 120 s at most, then answers timeout: true', async () => {
    vi.useFakeTimers();
    const id = runningTask();
    const wait = call('GET', `/api/tasks/${id}?wait=600`, 'a1');
    await vi.advanceTimersByTimeAsync(119_000);
    expect(wait.answered(), 'answered before its segment ended').toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    const { data, status } = wait.answered() ?? { data: {}, status: 0 };
    expect(status, 'still held past 120 s').toBe(200);
    expect(data.timeout).toBe(true);
    expect(data.task).toMatchObject({ id, outcome: 'running' });
  });

  it.each(['abc', '-5', '0', ''])('(S2) wait=%s: answered at once, not held', async (wait) => {
    vi.useFakeTimers();
    const id = runningTask();
    const call_ = call('GET', `/api/tasks/${id}?wait=${wait}`, 'a1');
    await vi.advanceTimersByTimeAsync(0);
    expect(call_.answered()?.status).toBe(200);
    expect(call_.answered()?.data.timeout).toBeUndefined();
  });

  it('(S3) a task that ends during the wait is answered then, with its end and no timeout', async () => {
    vi.useFakeTimers();
    const id = runningTask();
    const wait = call('GET', `/api/tasks/${id}?wait=120`, 'a1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wait.answered()).toBeUndefined();
    tasks.set(id, { ...tasks.get(id)!, outcome: 'completed', result: 'done' });
    await vi.advanceTimersByTimeAsync(600);
    expect(wait.answered()?.data.timeout).toBeUndefined();
    expect(wait.answered()?.data.task).toMatchObject({ id, outcome: 'completed', result: 'done' });
  });
});

describe('POST /api/agents/:id/run-task, model', () => {
  it.each([
    ['a space', 'claude opus'],
    ['a number', 4],
    ['101 characters', 'a'.repeat(101)],
    ['empty', ''],
    ['a shell character', 'opus;rm'],
  ])('(S4) %s: 400 invalid_model, and no run', async (_label, model) => {
    putAgent('a1');
    const { data, status } = await call('POST', '/api/agents/a1/run-task', 'a1', { task: 'do it', model }).answer;
    expect(status).toBe(400);
    expect(data.code).toBe('invalid_model');
    expect(runs).toHaveLength(0);
    expect(agents.get('a1')!.status).toBe('idle');
  });

  it.each(['claude-opus-4-6', 'sonnet[1m]', 'openai/gpt-5.1', 'gemini:2.5-pro'])('(S5) %s reaches the run', async (model) => {
    putAgent('a1');
    call('POST', '/api/agents/a1/run-task', 'a1', { task: 'do it', model, answer: 'started' });
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.model).toBe(model);
  });
});

describe('POST /api/agents/:id/run-task, answer: started', () => {
  it('(S7) with a task: answered at the start, the run still going', async () => {
    putAgent('a1');
    const run = call('POST', '/api/agents/a1/run-task', 'a1', { task: 'do it', answer: 'started' });
    const { data, status } = await run.answer;
    expect(status).toBe(200);
    expect(data).toMatchObject({ started: true, outcome: 'running', taskId: 't-1' });
    expect(tasks.get('t-1')!.outcome).toBe('running');
  });

  it('(S6) with no task named: not answered at the start, answered at the end with the run', async () => {
    ledgerNames = false;
    putAgent('a1');
    const run = call('POST', '/api/agents/a1/run-task', 'a1', { task: 'do it', answer: 'started' });
    await flush();
    expect(runs).toHaveLength(1);
    expect(run.answered(), 'answered at the start with no task to follow').toBeUndefined();
    runs[0].end();
    const { data, status } = await run.answer;
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, started: true, text: 'the run\'s answer' });
    expect(data.taskId).toBeUndefined();
  });

  it('(S7) without answer: started, held to the run\'s end as before', async () => {
    putAgent('a1');
    const run = call('POST', '/api/agents/a1/run-task', 'a1', { task: 'do it' });
    await flush();
    expect(run.answered()).toBeUndefined();
    runs[0].end();
    expect((await run.answer).data).toMatchObject({ ok: true, text: 'the run\'s answer', taskId: 't-1' });
  });
});

describe('POST /api/agents/:id/run-task from another project', () => {
  it('(S8) refused 403 without allowCrossProject: true, run with it', async () => {
    putAgent('target');
    putAgent('orch', path.join(tmp, 'another-project')).role = 'orchestrator';
    const refused = await call('POST', '/api/agents/target/run-task', 'orch', { task: 'do it', answer: 'started' }).answer;
    expect(refused.status).toBe(403);
    expect(String(refused.data.error)).toMatch(/Cross-project access denied/);
    expect(runs).toHaveLength(0);

    const allowed = await call('POST', '/api/agents/target/run-task', 'orch', { task: 'do it', answer: 'started', allowCrossProject: true }).answer;
    expect(allowed.status).toBe(200);
    expect(allowed.data).toMatchObject({ started: true, taskId: 't-1' });
  });
});
