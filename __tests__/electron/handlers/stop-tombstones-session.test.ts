import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Stopping an agent from the interface ends its session for good.
 *
 * The hooks of a killed CLI outlive the kill. Its SessionEnd posts `completed`
 * under its own session id, and the interface's stop left that id recorded as
 * the agent's owner, so the post passed the stale check and put a stopped agent
 * back to done. The API's stop had always made the killed session a tombstone;
 * the interface's did not.
 *
 * Driven through the registered agent:stop handler and the real hooks route,
 * with the session id SessionEnd actually sends.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-stop-tombstone-${process.pid}-${Date.now()}`),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.0', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { registerHooksRoutes } from '../../../electron/services/api-routes/hooks-routes';
import { agents } from '../../../electron/core/agent-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { sid } from '../../fixtures/session-id';

const ptyProcesses = new Map<string, { kill: ReturnType<typeof vi.fn> }>();

/** The fleet and the terminals are the real ones the hooks route reads; every other dependency is a stub. */
function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn() };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

let statusRoute: RouteApp['routes'][number]['handler'];
let ctx: RouteContext;

beforeEach(() => {
  handlers.clear();
  agents.clear();
  ptyProcesses.clear();
  registerIpcHandlers(deps());

  const routes: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  ctx = {
    mainWindow: null,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
  registerHooksRoutes(routes, ctx);
  statusRoute = routes.routes.find(r => r.method === 'POST' && r.pattern === '/api/hooks/status')!.handler;
});

async function hookPosts(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let answer: Record<string, unknown> = {};
  const req = { method: 'POST', pathname: '/api/hooks/status', url: new URL('http://localhost/api/hooks/status'), body, raw: { headers: {} }, res: {}, params: {} } as unknown as RouteRequest;
  await statusRoute(req, (data) => { answer = data as Record<string, unknown>; }, ctx);
  return answer;
}

function runningAgent(): AgentStatus {
  ptyProcesses.set('pty-1', { kill: vi.fn() });
  const agent = {
    id: 'a1', name: 'a1', status: 'running', provider: 'claude', projectPath: '/p',
    skills: [], output: [], lastActivity: new Date().toISOString(),
    ptyId: 'pty-1', currentSessionId: sid('sess-killed'),
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

describe('an agent stopped from the interface', () => {
  it('stays stopped when the killed session reports its end', async () => {
    const agent = runningAgent();

    await handlers.get('agent:stop')!({}, 'a1');
    // What hooks/session-end.sh posts once the CLI it belonged to is gone.
    const answer = await hookPosts({ agent_id: 'a1', session_id: sid('sess-killed'), status: 'completed' });

    expect(answer.stale, JSON.stringify(answer)).toBe(true);
    // stopped, not idle, since PLAN-1.9.2 item A: a stop says it was one.
    expect(agent.status).toBe('stopped');
    expect(agent.lastKilledSessionId).toBe(sid('sess-killed'));
  });

  it('still lets the next session take the agent and drive it', async () => {
    // The tombstone must refuse the dead session and nothing else.
    const agent = runningAgent();
    await handlers.get('agent:stop')!({}, 'a1');

    const registered = await hookPosts({ agent_id: 'a1', session_id: sid('sess-next'), status: 'running', source: 'startup' });
    const driven = await hookPosts({ agent_id: 'a1', session_id: sid('sess-next'), status: 'running' });

    expect(registered.registered).toBe(true);
    expect(driven.success, JSON.stringify(driven)).toBe(true);
    expect(agent.currentSessionId).toBe(sid('sess-next'));
    expect(agent.status).toBe('running');
  });
});
