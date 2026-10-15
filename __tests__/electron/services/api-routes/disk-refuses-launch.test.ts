import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';

/**
 * A launch on a nearly full disk is refused, saying why (JeanBrasse, 05/10). On
 * 01/10 the Mac stopped with 68 MB free, worktrees and agents writing until
 * there was nothing left (electron/core/disk-space.ts).
 *
 * How it fails, written before the code (2026-10-05):
 * 1. An agent starts with less than LAUNCH_MIN_FREE_BYTES free.
 * 2. The refusal does not say why, or the API answers a bare 500.
 * 3. Over-correction: a disk whose free space cannot be read refuses every
 *    launch; or one with room refuses.
 * 4. A path that spawns an agent's terminal goes around the check.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-disk-launch-${process.pid}-${Date.now()}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ pid: 999_999, process: 'claude', onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), resize: vi.fn() })),
}));
vi.mock('electron-updater', () => ({
  autoUpdater: { autoDownload: false, autoInstallOnAppQuit: true, on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() },
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.2', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../../electron/handlers/ipc-handlers';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

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

let routes: RouteApp;
let ctx: RouteContext;

beforeEach(() => {
  handlers.clear();
  agents.clear();
  ptyProcesses.clear();
  registerIpcHandlers(deps());
  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  const appSettings = {} as AppSettings;
  ctx = {
    mainWindow: null, appSettings, getAppSettings: () => appSettings,
    getTelegramBot: () => null, getSlackApp: () => null, slackResponseChannel: null, slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'), agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
  registerAgentRoutes(routes, ctx);
});

async function call(method: string, path: string, opts: { body?: unknown; caller?: string; internal?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes.routes.find(r => r.method === method && (typeof r.pattern === 'string' ? r.pattern === path : r.pattern.test(path)));
  if (!route) throw new Error(`no route ${method} ${path}`);
  const match = typeof route.pattern === 'string' ? null : route.pattern.exec(path);
  const url = new URL(`http://localhost${path}`);
  let answer = { status: 200, body: {} as Record<string, unknown> };
  const req = {
    method, pathname: path, url, body: opts.body ?? {}, raw: { headers: {} }, res: {},
    params: { id: match?.[1] }, callerAgentId: opts.caller, internal: opts.internal,
  } as unknown as RouteRequest;
  await route.handler(req, (data, status = 200) => { answer = { status, body: data as Record<string, unknown> }; }, ctx);
  return answer;
}

/**
 * The CLI a start may launch. On Windows the start resolves it to a file
 * before it opens the terminal (the CLI is the terminal's process), and a runner has no
 * claude: a stand-in claude.exe, never run (node-pty is mocked). Elsewhere
 * nothing, and `claude` by name, as before.
 */
function startableCli(): Partial<AgentStatus> {
  if (process.platform !== 'win32') return {};
  const cliPath = path.join(tmpHome, 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, '');
  return { cliPath };
}

function agent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  const a = { id, name: `Agent ${id}`, status: 'running', provider: 'claude', projectPath: tmpHome, skills: [], output: [], lastActivity: '', currentSessionId: `sess-${id}`, ...over } as AgentStatus;
  agents.set(id, a);
  return a;
}

import { LAUNCH_MIN_FREE_BYTES, diskRefusal, setFreeSpaceReader } from '../../../../electron/core/disk-space';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';

const GB = 1024 ** 3;
afterEach(() => setFreeSpaceReader(undefined));

describe('the rule', () => {
  it('1, 3. refuses under the floor, says how much is free and what the floor is, and lets the rest through', () => {
    expect(LAUNCH_MIN_FREE_BYTES).toBe(2 * GB);
    expect(diskRefusal(Math.round(1.4 * GB))).toMatch(/1\.4 GB free/);
    expect(diskRefusal(Math.round(1.4 * GB))).toMatch(/2 GB/);
    expect(diskRefusal(68 * 1024 ** 2)).toMatch(/68 MB free/);
    expect(diskRefusal(3 * GB)).toBeNull();
    expect(diskRefusal(null)).toBeNull();
  });
});

describe('a launch', () => {
  it('4. spawnAgentPty refuses, with the reason, and spawns nothing', () => {
    vi.mocked(pty.spawn).mockClear();
    setFreeSpaceReader(() => 500 * 1024 ** 2);
    expect(() => spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24, env: {} })).toThrow(/500 MB free/);
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it('2. /start answers 507 with the reason, and the agent stays as it was', async () => {
    const w1 = agent('w1', { status: 'idle', currentSessionId: undefined });
    agent('orch', { status: 'idle' });
    setFreeSpaceReader(() => GB);

    const r = await call('POST', '/api/agents/w1/start', { body: { prompt: 'go' }, caller: 'orch' });

    expect(r.status).toBe(507);
    expect(r.body).toMatchObject({ diskFull: true, error: expect.stringMatching(/1 GB free/) });
    expect(w1.status).toBe('idle');
  });

  it('3. with room, it starts', async () => {
    agent('orch', { status: 'idle' });
    const w1 = agent('w1', { status: 'idle', currentSessionId: undefined, ...startableCli() });
    setFreeSpaceReader(() => 50 * GB);
    const r = await call('POST', '/api/agents/w1/start', { body: { prompt: 'go' }, caller: 'orch' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w1.status).toBe('running');
  });
});
