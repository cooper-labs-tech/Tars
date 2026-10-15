import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The stop as the API, the MCP tool and the window ask for it (PLAN-1.9.2.md
 * item A): with a reason, from somebody, recorded, and an agent that then
 * reads `stopped` until it is started again.
 *
 * How it fails, written before the code (2026-10-01):
 * 1. /stop without a reason stops the agent all the same: stop_agent gave none,
 *    and nobody could tell afterwards why an agent was down.
 * 2. The stop is filed under the wrong caller: the agent that asked, by its
 *    own token, or Tars for its own pass (the super chat).
 * 3. A reason reaches the record with line breaks or control characters, or
 *    longer than a line of a card (200 characters).
 * 4. /wait does not come back for a stopped agent, or says nothing of the stop.
 * 5. The next start keeps the old stop: the agent reads stopped while it runs.
 * 6. The window's stop leaves the agent idle, or files it under nobody.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-stop-reason-${process.pid}-${Date.now()}`,
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

describe('POST /api/agents/:id/stop', () => {
  it('1. refuses a stop with no reason, and leaves the agent as it was', async () => {
    agent('orch', { status: 'idle' });
    const worker = agent('w1');

    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 42 }]) {
      const r = await call('POST', '/api/agents/w1/stop', { body, caller: 'orch' });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(String(r.body.error)).toMatch(/reason/i);
    }
    expect(worker.status).toBe('running');
    expect(worker.stoppedBy).toBeUndefined();
  });

  it('2. files the stop under the agent whose token asked, or under Tars for its own pass', async () => {
    agent('orch', { name: 'Tars-Orchestrator', status: 'idle' });
    const w1 = agent('w1');
    const w2 = agent('w2');

    expect((await call('POST', '/api/agents/w1/stop', { body: { reason: 'frozen' }, caller: 'orch' })).status).toBe(200);
    expect((await call('POST', '/api/agents/w2/stop', { body: { reason: 'JeanBrasse asked' }, internal: true })).status).toBe(200);

    expect(w1).toMatchObject({ status: 'stopped', stoppedBy: 'Tars-Orchestrator', stopReason: 'frozen' });
    expect(w2).toMatchObject({ status: 'stopped', stoppedBy: 'Tars', stopReason: 'JeanBrasse asked' });
  });

  it('3. keeps a reason on one line, without control characters, and at most 200 characters', async () => {
    agent('orch', { status: 'idle' });
    const w1 = agent('w1');

    await call('POST', '/api/agents/w1/stop', { body: { reason: `  stuck\nin a loop\u202E\u0007 ${'x'.repeat(900)}` }, caller: 'orch' });

    expect(w1.stopReason!.startsWith('stuck in a loop')).toBe(true);
    expect(w1.stopReason).not.toMatch(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/);
    expect(w1.stopReason!.length).toBeLessThanOrEqual(200);
  });
});

describe('a second stop', () => {
  it('answers that the agent is already stopped, with the first stop kept', async () => {
    agent('orch', { name: 'Tars-Orchestrator', status: 'idle' });
    agent('other', { name: 'Other', status: 'idle' });
    const w1 = agent('w1');
    await call('POST', '/api/agents/w1/stop', { body: { reason: 'frozen' }, caller: 'orch' });

    const again = await call('POST', '/api/agents/w1/stop', { body: { reason: 'tidying up' }, caller: 'other' });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ success: true, alreadyStopped: true, stoppedBy: 'Tars-Orchestrator', stopReason: 'frozen' });
    expect(w1).toMatchObject({ status: 'stopped', stoppedBy: 'Tars-Orchestrator', stopReason: 'frozen' });
  });
});

describe('after the stop', () => {
  it('4. /wait comes back at once, saying who stopped it and why', async () => {
    agent('orch', { status: 'idle' });
    agent('w1');
    await call('POST', '/api/agents/w1/stop', { body: { reason: 'frozen' }, caller: 'orch' });

    const r = await call('GET', '/api/agents/w1/wait', { caller: 'orch' });

    expect(r.body).toMatchObject({ status: 'stopped', stoppedBy: 'Agent orch', stopReason: 'frozen' });
  });

  it('5. a start clears the stop: the agent runs, and no longer reads as stopped', async () => {
    agent('orch', { status: 'idle' });
    const w1 = agent('w1', startableCli());
    await call('POST', '/api/agents/w1/stop', { body: { reason: 'frozen' }, caller: 'orch' });

    const r = await call('POST', '/api/agents/w1/start', { body: { prompt: 'again' }, caller: 'orch' });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w1.status).toBe('running');
    expect(w1.stoppedBy).toBeUndefined();
    expect(w1.stoppedAt).toBeUndefined();
    expect(w1.stopReason).toBeUndefined();
  });
});

describe("the window's stop", () => {
  it('6. files it under you, with the reason given or none', async () => {
    const w1 = agent('w1');
    const w2 = agent('w2');

    await handlers.get('agent:stop')!({}, 'w1', 'not needed any more');
    await handlers.get('agent:stop')!({}, 'w2');

    expect(w1).toMatchObject({ status: 'stopped', stoppedBy: 'you', stopReason: 'not needed any more' });
    expect(w2).toMatchObject({ status: 'stopped', stoppedBy: 'you' });
    expect(w2.stopReason).toBeUndefined();
  });
});

describe('a start after a stop (JeanBrasse, 05/10)', () => {
  // An orchestrator may start again an agent JeanBrasse stopped, whenever it needs
  // to, a scheduled task too: the one that restarts it is told who stopped it
  // and why, and the restart is noted on the agent. How it fails, written
  // before the code (2026-10-05):
  // 7. The restarter hears nothing of the stop it undid.
  // 8. Nothing on the agent says it was restarted after a stop, by whom.
  // 9. A start of an agent that was not stopped reads as a restart.
  it('7, 8. tells the restarter who stopped it, when and why, and notes the restart', async () => {
    agent('orch', { status: 'idle' });
    const w1 = agent('w1', startableCli());
    await call('POST', '/api/agents/w1/stop', { body: { reason: 'out of budget' }, caller: 'orch' });
    const stoppedAt = w1.stoppedAt;

    const r = await call('POST', '/api/agents/w1/start', { body: { prompt: 'go on' }, caller: 'orch' });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.restartedAfterStop).toEqual({ stoppedBy: 'Agent orch', stoppedAt, stopReason: 'out of budget' });
    expect(w1.lastRestartAfterStop).toMatchObject({ stoppedBy: 'Agent orch', stoppedAt, stopReason: 'out of budget', restartedBy: 'Agent orch' });
    expect(Date.parse(w1.lastRestartAfterStop!.restartedAt)).toBeGreaterThan(0);
  });

  it('7. a /dispatch that starts it again says so too, as a scheduled task\'s does', async () => {
    agent('orch', { status: 'idle' });
    const w1 = agent('w1', startableCli());
    await call('POST', '/api/agents/w1/stop', { body: { reason: 'night' }, caller: 'orch' });

    const r = await call('POST', '/api/agents/w1/dispatch', { body: { message: 'the morning task' }, caller: 'orch' });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.restartedAfterStop).toMatchObject({ stopReason: 'night' });
    expect(w1.lastRestartAfterStop).toMatchObject({ stopReason: 'night' });
  }, 60_000);

  it('9. a start of an agent that was not stopped is no restart', async () => {
    agent('orch', { status: 'idle' });
    const w1 = agent('w1', { status: 'idle', currentSessionId: undefined, ...startableCli() });

    const r = await call('POST', '/api/agents/w1/start', { body: { prompt: 'go' }, caller: 'orch' });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.restartedAfterStop).toBeUndefined();
    expect(w1.lastRestartAfterStop).toBeUndefined();
  });
});

