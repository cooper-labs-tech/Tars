import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The four ways an agent is stopped or deleted reach its delegated run
 * (the Audit's table on a3d7c125, #6): the window's Stop and Delete, and the
 * API's /stop and DELETE, which an orchestrator calls. The window's Stop did
 * nothing at all to an agent with no terminal, which is what an agent that is
 * only running an ACP run is.
 *
 * The routes, the handlers and the delegation are the real ones; the ACP agent
 * is a script that starts a long command and never answers.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-acp-stop-routes-${process.pid}-${Date.now()}`),
}));
const serverBundle = path.join(tmpHome, 'bundle.js');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.0', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
let launch: { command: string; args: string[] };
vi.mock('../../../electron/services/acp/registry', () => ({ acpLaunchFor: () => launch, loadAcpRegistry: async () => undefined }));
vi.mock('../../../electron/services/mcp-orchestrator', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMcpOrchestratorPath: () => serverBundle, getMcpMemoryPath: () => serverBundle,
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import { EventEmitter } from 'node:events';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { Leftovers } from '../../setup/leftover-processes';

fs.mkdirSync(tmpHome, { recursive: true });
fs.writeFileSync(serverBundle, '');

function busyAgent(tag: string) {
  const pidFile = path.join(tmpHome, `${tag}.pid`);
  const file = path.join(tmpHome, `${tag}.mjs`);
  fs.writeFileSync(file, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) handle(JSON.parse(line)); }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    const work = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidFile)}, String(work.pid));
  }
}
`);
  return { command: process.execPath, args: [file], pidFile };
}

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings),
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
registerIpcHandlers(deps());

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

async function route(method: 'POST' | 'DELETE', pathname: string, caller: string): Promise<number> {
  const r = app.routes.find(x => x.method === method && typeof x.pattern !== 'string' && x.pattern.test(pathname))!;
  const match = (r.pattern as RegExp).exec(pathname)!;
  let status = 200;
  await r.handler({
    // A stop takes a reason since PLAN-1.9.2 item A (core/agent-stop.ts).
    method, pathname, url: new URL(`http://localhost${pathname}`), body: pathname.endsWith('/stop') ? { reason: 'the test stops it' } : {}, raw: { headers: {}, on: () => {} }, res: {},
    params: { id: match[1] }, callerAgentId: caller,
  } as unknown as RouteRequest, (_json, code = 200) => { status = code; }, {} as RouteContext);
  return status;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(what: string, test: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); }
}
/** The run's answer, or a failure after 8 s: on main it never answers. */
const ended = (result: Promise<unknown>) => Promise.race([
  result, new Promise((_, reject) => setTimeout(() => reject(new Error('the run was still working 8 s after the stop')), 8_000)),
]);
// Ended by id only while the id is still the process the test saw: see leftover-processes.ts.
const leftovers = new Leftovers();
afterEach(() => leftovers.end(), 60_000);

/** An agent of the project running a delegated run, and the process its run started. */
async function delegated(id: string): Promise<{ result: Promise<unknown>; work: number }> {
  // The project's orchestrator: since 2.0.4 a worker stops and removes no other agent (core/one-task.ts).
  agents.set('orch', { id: 'orch', name: 'Orch', status: 'running', role: 'orchestrator', projectPath: tmpHome, provider: 'claude', skills: [], output: [], lastActivity: '' } as AgentStatus);
  const agent = { id, name: id, status: 'running', projectPath: tmpHome, provider: 'claude', skills: [], output: [], lastActivity: '' } as AgentStatus;
  agents.set(id, agent);
  const a = busyAgent(id);
  launch = a;
  const result = delegateOverAcp({ agent, task: 'work', appSettings: {} as AppSettings, timeoutMs: 60_000 });
  await until('the run began its work', () => fs.existsSync(a.pidFile));
  const work = Number(fs.readFileSync(a.pidFile, 'utf-8'));
  leftovers.push(work);
  return { result, work };
}

describe('stopping or deleting an agent reaches its delegated run', { timeout: 30_000 }, () => {
  it('through the window\'s Stop, on an agent with no terminal', async () => {
    const { result, work } = await delegated('win-stop');
    await handlers.get('agent:stop')!({}, 'win-stop');
    await ended(result);
    await until('the run\'s command is gone', () => !alive(work), 5_000);
  });

  it('through the window\'s Delete', async () => {
    const { result, work } = await delegated('win-delete');
    await handlers.get('agent:remove')!({}, 'win-delete');
    await ended(result);
    await until('the run\'s command is gone', () => !alive(work), 5_000);
  });

  it('through the API\'s /stop', async () => {
    const { result, work } = await delegated('api-stop');
    expect(await route('POST', '/api/agents/api-stop/stop', 'orch')).toBe(200);
    await ended(result);
    await until('the run\'s command is gone', () => !alive(work), 5_000);
  });

  it('through the API\'s DELETE', async () => {
    const { result, work } = await delegated('api-delete');
    expect(await route('DELETE', '/api/agents/api-delete', 'orch')).toBe(200);
    await ended(result);
    await until('the run\'s command is gone', () => !alive(work), 5_000);
  });
});
