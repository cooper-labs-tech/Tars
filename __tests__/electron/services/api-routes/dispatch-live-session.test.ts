import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * A message to an agent whose CLI is up is typed into that session; a new
 * session is started only where no CLI runs.
 *
 * /dispatch typed into `running` and `waiting` agents and started a new
 * session for every other status. But every turn ends on `idle` (the Stop
 * hook posts it) and a failed one on `error`, with the CLI still at its
 * prompt: the new session was spawned over it, which kills the terminal, and
 * with no `--resume`, the resume being spent once per run. Measured on
 * 2026-09-23 on the orchestrator itself: last Stop at 02:14:16, no idle_prompt
 * after it, a report dispatched at 02:22:24, its session ended and a blank one
 * registered two seconds later. #120 widens it: a Dashboard start and a
 * restart leave the agent `idle` at its prompt.
 *
 * The routes, the writer and cliRunningIn are the real ones. The terminals
 * come from spawnAgentPty, as every agent terminal does, over a node-pty that
 * records what is typed and names its foreground (`bash` at a shell, the
 * version number while claude runs).
 */

type FakePty = {
  pid: number; process: string; spawnedWith: string[];
  write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>;
};
const spawned = vi.hoisted(() => [] as FakePty[]);

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]): FakePty => {
    const terminal: FakePty = {
      pid: 6000 + spawned.length, process: file, spawnedWith: args ?? [],
      write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
    };
    spawned.push(terminal);
    return terminal;
  }),
}));
let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-spawned-${++uuidCounter}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));
vi.mock('../../../../electron/services/acp/delegate', () => ({
  canDelegateOverAcp: () => false,
  delegateOverAcp: vi.fn(),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses, resetTerminalInput } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dispatch-live-'));

let routes: RouteApp;
let ctx: RouteContext;

async function call(method: string, url: string, body: Record<string, unknown>, caller: string) {
  const pathname = url.split('?')[0];
  for (const route of routes.routes) {
    if (route.method !== method) continue;
    const m = typeof route.pattern === 'string' ? (route.pattern === pathname ? [pathname] : null) : pathname.match(route.pattern);
    if (!m) continue;
    const answers: Array<{ data: Record<string, unknown>; status: number }> = [];
    const req = {
      method, pathname, url: new URL(`http://localhost${url}`), body,
      raw: { headers: {}, on: () => {} }, res: {}, params: m[1] ? { id: m[1] } : {},
      callerAgentId: caller,
    } as unknown as RouteRequest;
    await route.handler(req, (data, status = 200) => { answers.push({ data: data as Record<string, unknown>, status }); }, ctx);
    return answers.at(-1)!;
  }
  throw new Error(`no route for ${method} ${url}`);
}

/**
 * The worker, with its terminal open and `foreground` in front: a CLI's
 * version, or the shell. Interactive, as the Dashboard opens one, unless
 * `args` say otherwise.
 */
function worker(status: AgentStatus['status'], foreground: string, args = ['-l']): { agent: AgentStatus; terminal: FakePty } {
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args, runsCommand: args.includes('-c'), cwd: project, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: 'worker' },
  }) as unknown as FakePty;
  terminal.process = foreground;
  ptyProcesses.set('pty-worker', terminal as never);
  const agent = {
    id: 'worker', name: 'Tars-QA', status, projectPath: project, ptyCwd: project, provider: 'claude',
    skills: [], output: [], ptyId: 'pty-worker', currentSessionId: 'sess-live', resumableSessionId: 'sess-live',
    lastActivity: new Date().toISOString(), permissionMode: 'bypass',
  } as AgentStatus;
  agents.set('worker', agent);
  return { agent, terminal };
}

const typedInto = (terminal: FakePty) => terminal.write.mock.calls.map(c => String(c[0])).join('');

beforeEach(() => {
  // A launch marked by one test holds the agent in the next (core/agent-launch.ts).
  resetLaunches();
  vi.useFakeTimers();
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  const settings = {} as AppSettings;
  ctx = {
    mainWindow: null, appSettings: settings, getAppSettings: () => settings,
    getTelegramBot: () => null, getSlackApp: () => null,
    slackResponseChannel: null, slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
  registerAgentRoutes(routes, ctx);
  agents.set('orch', {
    id: 'orch', role: 'orchestrator', name: 'Tars-Orchestrator', status: 'running', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
});

afterEach(() => {
  for (const terminal of spawned) resetTerminalInput(terminal as never);
  vi.useRealTimers();
});

describe('POST /dispatch to an agent whose CLI is up', () => {
  it.each(['idle', 'error', 'completed'] as const)('types into the session when the status says %s, instead of ending it', async (status) => {
    const { agent, terminal } = worker(status, '2.1.280');

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'Gate PR #123' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(answer.status).toBe(200);
    expect(answer.data.mode).toBe('message');
    expect(terminal.kill, 'the session was ended').not.toHaveBeenCalled();
    expect(spawned, 'a second terminal was opened over the first').toHaveLength(1);
    expect(typedInto(terminal)).toContain('Gate PR #123');
    expect(agent.ptyId).toBe('pty-worker');
    expect(agent.currentSessionId).toBe('sess-live');
    expect(agent.lastKilledSessionId).toBeUndefined();
    expect(agent.status).toBe('running');
  });

  it('types into a session the API has just started, before its CLI has taken the terminal', async () => {
    // spawnAgentSession hands the shell its command. Until the exec, while the
    // shell reads its login files, the shell leads the terminal.
    const { terminal } = worker('running', 'bash', ['-l', '-c', `cd '${project}' && exec '/usr/local/bin/claude'`]);

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'second task' }, 'orch');

    expect(answer.data.mode).toBe('message');
    expect(terminal.kill).not.toHaveBeenCalled();
  });
});

describe('a session the API started', () => {
  /** The worker with no terminal yet, as before a /start. */
  function workerWithoutTerminal(): AgentStatus {
    const agent = {
      id: 'worker', name: 'Tars-QA', status: 'idle', projectPath: project, provider: 'claude',
      skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    } as AgentStatus;
    agents.set('worker', agent);
    return agent;
  }

  it('runs its CLI in place of the shell, so the terminal names the CLI', async () => {
    workerWithoutTerminal();

    const started = await call('POST', '/api/agents/worker/start', { prompt: 'remember KIWI' }, 'orch');

    expect(started.status).toBe(200);
    expect(spawned).toHaveLength(1);
    const [login, dashC, command] = spawned[0].spawnedWith;
    expect([login, dashC]).toEqual(['-l', '-c']);
    // The path escaped for the pattern: a Windows path's `\` would read as escapes.
    expect(command).toMatch(new RegExp(`^cd '${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' && exec '`));
  });

  it('takes a /dispatch at its prompt into the same session, as on 2026-09-23 at 02:22:24 it did not', async () => {
    // The orchestrator's own session had been started by the API: idle at its
    // prompt, node-pty naming `bash`, and the dispatch ended it.
    const agent = workerWithoutTerminal();
    await call('POST', '/api/agents/worker/start', { prompt: 'remember KIWI' }, 'orch');
    const terminal = spawned[0];
    terminal.process = 'bash';
    agent.status = 'idle';
    // Its SessionStart, as the hook route records it, and then its first turn:
    // until then the launch is on its way and a /dispatch waits for it
    // (core/agent-launch.ts, #134).
    agent.currentSessionId = 'sess-started';
    agent.sessionRegisteredAt = new Date().toISOString();
    // And its task's turn began (UserPromptSubmit): up, for a launch with one.
    agent.lastTurnStartedAt = new Date().toISOString();

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'which word?' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(answer.data.mode).toBe('message');
    expect(terminal.kill, 'the session was ended').not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(typedInto(terminal)).toContain('which word?');
    expect(agent.currentSessionId).toBe('sess-started');
  });

  it('is not ended by a second /start', async () => {
    const agent = workerWithoutTerminal();
    await call('POST', '/api/agents/worker/start', { prompt: 'remember KIWI' }, 'orch');
    agent.status = 'idle';

    const again = await call('POST', '/api/agents/worker/start', { prompt: 'fresh task' }, 'orch');

    expect(again.status).toBe(409);
    expect(again.data.cliRunning).toBe(true);
    expect(spawned[0].kill).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });
});

describe('a bare shell whose status still says the agent works', () => {
  // A claude that dies without its SessionEnd leaves `running` or `waiting`
  // behind. The Audit forced `waiting` on such a terminal and sent
  // `echo MARK-SHELL-$((6*7))` through /message: the shell printed
  // MARK-SHELL-42. A message from another agent is not a command to run.
  it.each([
    ['running', 'dispatch'], ['waiting', 'dispatch'], ['running', 'message'], ['waiting', 'message'],
  ] as const)('gets nothing typed into it when the status says %s (/%s): a session is started instead', async (status, route) => {
    const { terminal } = worker(status, 'bash');

    await call('POST', `/api/agents/worker/${route}`, { message: 'echo MARK-SHELL-$((6*7))' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(typedInto(terminal), 'the shell was handed a message to run').not.toContain('MARK-SHELL');
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].spawnedWith.join(' ')).toContain('MARK-SHELL');
  });
});

describe('POST /dispatch where no CLI runs', () => {
  it('starts a session in place of the shell, with the message as its task', async () => {
    const { agent, terminal } = worker('idle', 'bash');

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'Gate PR #123' }, 'orch');

    expect(answer.data.mode).toBe('start');
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].spawnedWith.join(' ')).toContain("-- '");
    expect(spawned[1].spawnedWith.join(' ')).toContain('Gate PR #123');
    expect(typedInto(terminal), 'the task was typed into a bare shell').not.toContain('Gate PR #123');
    expect(agent.ptyId).not.toBe('pty-worker');
  });
});

describe('POST /message', () => {
  it('types into a session at its prompt whatever the status says', async () => {
    const { terminal } = worker('idle', '2.1.280');

    const answer = await call('POST', '/api/agents/worker/message', { message: 'status?' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(answer.data.success).toBe(true);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(typedInto(terminal)).toContain('status?');
  });

  it('never types a message into a bare shell, where it would run as a command: it starts a session', async () => {
    const { terminal } = worker('idle', 'bash');

    await call('POST', '/api/agents/worker/message', { message: 'rm -rf dist and rebuild' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(typedInto(terminal)).not.toContain('rm -rf dist');
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
  });
});

describe('POST /start', () => {
  it('refuses to end a session whose CLI is up, and says so', async () => {
    const { agent, terminal } = worker('idle', '2.1.280');

    const answer = await call('POST', '/api/agents/worker/start', { prompt: 'fresh task' }, 'orch');

    expect(answer.status).toBe(409);
    expect(answer.data.cliRunning).toBe(true);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(agent.currentSessionId).toBe('sess-live');
  });

  it('starts a session where only a shell runs, as before', async () => {
    const { terminal } = worker('idle', 'bash');

    const answer = await call('POST', '/api/agents/worker/start', { prompt: 'fresh task' }, 'orch');

    expect(answer.status).toBe(200);
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
  });
});
