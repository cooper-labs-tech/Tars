import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * A start the machine has no terminal for, through each path that opens an agent's terminal (2.0.6, item 1; the
 * Audit's re-check of #553 at 848a307ee, 29/10). core/no-terminal.ts is tested alone in no-terminal.test.ts; here the
 * real start paths run, the real initAgentPty, spawnAgentPty, the IPC handlers and the API's routes, with spawnPty
 * refusing as a full pool makes it (NoTerminalLeft) and node-pty replaced by a terminal that records nothing.
 *
 * How it fails, written before the code (29/10):
 * C1. initAgentPty (the window's start, a wake, the bots) lets NoTerminalLeft through and leaves the agent as it was
 *     (L3: a mutant without the mark passed every test).
 * C2. Nobody waiting on the agent hears of it (L2): no `status:<id>` (what wait_for_agent listens to) and no
 *     `fleet-change` (what agent-watch reads), so a waiter runs to its timeout and the requester is not told; or
 *     hears it before the mark, and reads the agent idle with no reason (the Audit's L1 on #557).
 * C3. The next start through initAgentPty opens a terminal and the reason stays beside a working agent (L1).
 * C4. spawnAgentSession (the API's start, dispatch, message and delegate) leaves the agent as it was (L3).
 * C5. The window's agent:start rejects instead of answering { success: false, error, code: 'no_terminal' } (L3).
 */

const { tmpHome, refuse } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-no-terminal-sites-${process.pid}-${Date.now()}`),
  refuse: { on: false },
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string) => ({
    pid: 4242, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
  })),
}));
// The full pool, as spawnPty says it once node-pty is refused.
vi.mock('../../../electron/core/pty-spawn', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../electron/core/pty-spawn')>();
  const { NoTerminalLeft } = await import('../../../electron/core/pty-pool');
  return {
    ...real,
    spawnPty: (...args: Parameters<typeof real.spawnPty>) => {
      if (refuse.on) throw new NoTerminalLeft({ inUse: 510, max: 511, tars: 30, open: 30 }, 'darwin');
      return real.spawnPty(...args);
    },
  };
});
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '2.0.6', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
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
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { resetLaunches } from '../../../electron/core/agent-launch';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import { agentStatusEmitter } from '../../../electron/services/agent-events';
import { NoTerminalLeft } from '../../../electron/core/pty-pool';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// The launch these run is darwin and linux's; on a Windows host they read it as linux.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const project = path.join(tmpHome, 'project');

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    // The real one, as main.ts hands it.
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

/** An agent at rest with no terminal, and its project's orchestrator. */
function restingAgent(): AgentStatus {
  agents.set('orch', {
    id: 'orch', role: 'orchestrator', name: 'Orchestrator', status: 'running', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
  const agent = {
    id: 'agent-a', name: 'Harbor Worker', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/** POST /api/agents/:id/dispatch through the real route, from the project's orchestrator. */
async function dispatch(id: string, message: string): Promise<unknown> {
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
  const pathname = `/api/agents/${id}/dispatch`;
  const route = app.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
  return route.handler({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { message },
    raw: { headers: {}, on: () => {} }, res: {}, params: { id }, callerAgentId: 'orch',
  } as unknown as RouteRequest, () => undefined, {} as RouteContext);
}

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  agents.clear();
  ptyProcesses.clear();
  resetLaunches();
  refuse.on = true;
  registerIpcHandlers(deps());
});
afterEach(() => { refuse.on = false; });

describe('a start the machine has no terminal for, through each path', () => {
  it('C1, C2. initAgentPty marks the agent and tells whoever waits on it', async () => {
    const agent = restingAgent();
    // What a listener reads when it hears: a wait_for_agent answers from the record at that moment (the Audit's L1
    // on #557: an emit before the mark passed, and the wait answered idle with no reason).
    const heard: string[] = [];
    const onStatus = () => heard.push(`status:${agent.status}:${agent.error ?? ''}`);
    const onFleet = (id: string) => heard.push(`fleet:${id}:${agent.status}:${agent.error ?? ''}`);
    agentStatusEmitter.on(`status:${agent.id}`, onStatus);
    agentStatusEmitter.on('fleet-change', onFleet);
    try {
      await expect(initAgentPty(agent, null, vi.fn(), vi.fn())).rejects.toBeInstanceOf(NoTerminalLeft);
    } finally {
      agentStatusEmitter.off(`status:${agent.id}`, onStatus);
      agentStatusEmitter.off('fleet-change', onFleet);
    }
    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/^No terminal can be opened on this machine: 510 of 511 are in use/);
    expect(heard).toEqual(expect.arrayContaining([`status:error:${agent.error}`, `fleet:${agent.id}:error:${agent.error}`]));
  });

  it('C3. the next start through initAgentPty that opens a terminal takes the reason away', async () => {
    const agent = restingAgent();
    await expect(initAgentPty(agent, null, vi.fn(), vi.fn())).rejects.toBeInstanceOf(NoTerminalLeft);
    refuse.on = false;
    expect(ptyProcesses.has(await initAgentPty(agent, null, vi.fn(), vi.fn()))).toBe(true);
    expect(agent.error).toBeUndefined();
  });

  it('C4. spawnAgentSession (a dispatch) marks the agent', async () => {
    const agent = restingAgent();
    await expect(dispatch(agent.id, 'the task')).rejects.toBeInstanceOf(NoTerminalLeft);
    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/^No terminal can be opened on this machine/);
  });

  it('C5. the window\'s start answers with the reason and its code, and the agent reads it', async () => {
    const agent = restingAgent();
    const answer = await handlers.get('agent:start')!({}, { id: agent.id, prompt: 'the task' }) as { success: boolean; error?: string; code?: string };
    expect(answer).toEqual({ success: false, error: agent.error, code: 'no_terminal' });
    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/^No terminal can be opened on this machine/);
  });
});
