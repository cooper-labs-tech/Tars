import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * An agent's first task (core/first-task.ts) at every way an agent starts: the window's launcher (Start, a team
 * deployed, a wake, a recovery after a crash) and spawnAgentSession (a delegation, /start, a bot's or Hermes's
 * message to a stopped agent). The Audit's L3 on #584, at 42c3e0a75.
 *
 * How it fails, written before the code (10/11, the orchestrator's task t-970bd603):
 * 1. A start through spawnAgentSession leaves the first task in place: the agent does that start's work, and its
 *    first task waits for a later start. Whichever start comes first takes it or clears it.
 * 2. Taken by such a start, it goes in after the sender's message, under the sender's line as if the sender had
 *    written it, or replaces the message: it goes before the message, the message under its own sender's line.
 * 3. A wake, or a recovery after a crash, continues the agent's conversation with no resume option, so it counts as
 *    a fresh start and types the old first task into that conversation as a new turn. Whether a start is fresh is
 *    read from the conversation the launch resolves: one that continues a conversation types nothing of it, and
 *    clears it.
 * 4. The first start of an agent that has no conversation yet (a team deployed without starting) no longer types
 *    its first task, from the window or through spawnAgentSession: it still does, once, and clears it.
 * 5. The first task is written as the agent's role (savedPrompt) by either path: never.
 *
 * The handlers and the routes are the real ones (registerIpcHandlers, registerAgentRoutes), as are initAgentPty,
 * spawnAgentPty, the launcher and the sleep; only node-pty is replaced, by a terminal that records how it was
 * started and what is typed into it.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-first-task-${process.pid}-${Date.now()}`),
}));

type FakePty = {
  pid: number;
  process: string;
  args: string[];
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
};

const spawned = vi.hoisted(() => [] as FakePty[]);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[] | string): FakePty => {
    const terminal: FakePty = {
      pid: 6161 + spawned.length,
      process: file,
      args: Array.isArray(args) ? args : [String(args)],
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    spawned.push(terminal);
    return terminal;
  }),
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '2.0.7', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses, resetTerminalInput } from '../../../electron/core/pty-manager';
import { resetResumeTracking, encodeProjectDirName } from '../../../electron/utils/resume-session';
import { resetAgentRestarts } from '../../../electron/core/agent-restart';
import { resetLaunches } from '../../../electron/core/agent-launch';
import { resetAgentWatch } from '../../../electron/services/agent-watch';
import { fallAsleep, wakeAgent } from '../../../electron/core/agent-asleep';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// The launch these hold is darwin and linux's. On a Windows host they read it as linux.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const project = path.join(tmpHome, 'project');
const FIRST = 'FIRST-TASK-5150 build the login page';
const ROLE = 'You lead the team of my-app.';
const SESSION = '5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, null, vi.fn(), vi.fn()),
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

/** An agent of the project with a first task, never started in this run. */
function agentWithFirstTask(fields: Partial<AgentStatus> = {}): AgentStatus {
  const agent = {
    id: 'lead', name: 'Lead', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'normal', role: 'worker',
    savedPrompt: ROLE, firstTask: { text: FIRST, setAt: '2026-11-10T00:00:00.000Z' },
    ...fields,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/** The transcript of a conversation the agent had, as Claude Code files it. */
function conversationOnDisk(sessionId: string): void {
  const dir = path.join(tmpHome, '.claude', 'projects', encodeProjectDirName(project));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

/** A launch, with the clock run past the half second a fresh terminal is given. */
async function settled<T>(launch: Promise<T>, ms = 600): Promise<T> {
  const outcome = launch.then(value => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  const done = await outcome;
  if ('error' in done) throw done.error;
  return done.value;
}

/** A launch too long for one line is written to a script the shell sources (`. '<file>'`). */
const withScript = (text: string) => {
  const script = /\. '([^']+\.sh)'/.exec(text)?.[1];
  return script && fs.existsSync(script) ? `${text}\n${fs.readFileSync(script, 'utf8')}` : text;
};
/** How a terminal's CLI was started: its spawn arguments (spawnAgentSession) and what was typed into it (the launcher). */
const commandOf = (terminal: FakePty) =>
  withScript([...terminal.args, ...terminal.write.mock.calls.map(call => String(call[0]))].join('\n').replace(/\x1b\[20[01]~/g, ''));

function routes(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(app, {
    mainWindow: null, appSettings: {} as AppSettings, getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null, getSlackApp: () => null, slackResponseChannel: null, slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'), agentStatusEmitter: new EventEmitter(),
  } as unknown as RouteContext);
  return app;
}

/** POST /api/agents/:id/start from the project's orchestrator, through the real route: spawnAgentSession. */
async function startThroughApi(agentId: string, prompt: string): Promise<Record<string, unknown>> {
  if (!agents.has('orch')) {
    agents.set('orch', {
      id: 'orch', name: 'Orch', status: 'running', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), role: 'orchestrator',
    } as AgentStatus);
  }
  const app = routes();
  const pathname = `/api/agents/${agentId}/start`;
  const route = app.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
  let answer: Record<string, unknown> = {};
  await settled(Promise.resolve(route.handler({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { prompt },
    raw: { headers: {}, on: () => {} }, res: {}, params: { id: agentId }, callerAgentId: 'orch',
  } as unknown as RouteRequest, (json) => { answer = json as Record<string, unknown>; }, {} as RouteContext)), 2_000);
  return answer;
}

const startFromWindow = (id: string) =>
  settled(handlers.get('agent:start')!({}, { id, prompt: '', options: {} }) as Promise<{ success: boolean; error?: string }>);

/** Asleep, as agent-sleep.ts puts it (fallAsleep), its terminal ended; then woken by a key, as the window does. */
async function sleepThenWake(agent: AgentStatus): Promise<FakePty> {
  fallAsleep(agent, undefined, Date.now());
  ptyProcesses.clear();
  // Its session came up long before it fell asleep: no launch of it is still under way.
  resetLaunches();
  const before = spawned.length;
  expect(await settled(wakeAgent(agent, 'you', 'key'))).toMatchObject({ success: true });
  expect(spawned.length, 'the wake opened a terminal').toBe(before + 1);
  return spawned[spawned.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  spawned.length = 0;
  agents.clear();
  ptyProcesses.clear();
  resetResumeTracking();
  resetAgentRestarts();
  resetAgentWatch();
  resetLaunches();
  registerIpcHandlers(deps());
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  for (const terminal of spawned) resetTerminalInput(terminal as never);
  resetAgentRestarts();
  vi.useRealTimers();
});

describe("an agent's first task, at every way it starts", () => {
  it('4, 5. the window\'s first start of an agent with no conversation types it once, and clears it', async () => {
    const agent = agentWithFirstTask();
    expect(await startFromWindow(agent.id)).toMatchObject({ success: true });
    expect(commandOf(spawned[0])).toContain(FIRST);
    expect(agent.firstTask).toBeUndefined();
    expect(agent.savedPrompt).toBe(ROLE);
  });

  it('1, 2, 4, 5. a first start through spawnAgentSession takes it, before the sender\'s message, and clears it', async () => {
    const agent = agentWithFirstTask();
    expect(await startThroughApi(agent.id, 'MESSAGE-7 fix the build')).toMatchObject({ success: true });
    const command = commandOf(spawned[0]);
    expect(command).toContain(FIRST);
    expect(command).toContain('MESSAGE-7 fix the build');
    const sender = command.indexOf('Message from agent "Orch" ("orch")');
    expect(sender, command).toBeGreaterThan(-1);
    expect(command.indexOf(FIRST)).toBeLessThan(sender);
    expect(command.indexOf('MESSAGE-7 fix the build')).toBeGreaterThan(sender);
    expect(agent.firstTask).toBeUndefined();
    expect(agent.savedPrompt).toBe(ROLE);
  });

  it('1, 3. started by a message, then put to sleep and woken: the wake types nothing of it', async () => {
    const agent = agentWithFirstTask();
    expect(await startThroughApi(agent.id, 'MESSAGE-8 fix the build')).toMatchObject({ success: true });
    // The session its first start opened, on disk as Claude Code files it.
    agent.currentSessionId = SESSION;
    agent.resumableSessionId = SESSION;
    conversationOnDisk(SESSION);
    const woken = await sleepThenWake(agent);
    const command = commandOf(woken);
    expect(command, 'the wake continues its conversation').toContain(SESSION);
    expect(command).not.toContain(FIRST);
    expect(agent.firstTask).toBeUndefined();
  });

  it('3. a wake that continues a conversation types nothing of a first task still there, and clears it', async () => {
    const agent = agentWithFirstTask({ status: 'asleep', resumableSessionId: SESSION });
    conversationOnDisk(SESSION);
    const woken = await sleepThenWake(agent);
    const command = commandOf(woken);
    expect(command).toContain(SESSION);
    expect(command).not.toContain(FIRST);
    expect(agent.firstTask).toBeUndefined();
    expect(agent.savedPrompt).toBe(ROLE);
  });

  it('3. the window\'s first start of the run continues the last conversation: nothing of it is typed, and it is cleared', async () => {
    const agent = agentWithFirstTask({ resumableSessionId: SESSION });
    conversationOnDisk(SESSION);
    expect(await startFromWindow(agent.id)).toMatchObject({ success: true });
    const command = commandOf(spawned[0]);
    expect(command).toContain(SESSION);
    expect(command).not.toContain(FIRST);
    expect(agent.firstTask).toBeUndefined();
  });

  it('1, 3. a first start through spawnAgentSession that continues a conversation types nothing of it, and clears it', async () => {
    const agent = agentWithFirstTask({ resumableSessionId: SESSION });
    conversationOnDisk(SESSION);
    expect(await startThroughApi(agent.id, 'MESSAGE-9 fix the build')).toMatchObject({ success: true });
    const command = commandOf(spawned[0]);
    expect(command).toContain(SESSION);
    expect(command).toContain('MESSAGE-9 fix the build');
    expect(command).not.toContain(FIRST);
    expect(agent.firstTask).toBeUndefined();
  });
});
