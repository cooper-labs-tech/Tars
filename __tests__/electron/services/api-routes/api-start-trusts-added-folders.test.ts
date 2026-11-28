import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The API's start trusts every folder its line hands (#665, QA's gate of 28/11, MT9; failure 12 of
 * __tests__/electron/core/claude-added-folders-trust.test.ts, which lists them all).
 *
 * How it fails, written before its case:
 *  12. The start an orchestrator's start_agent sends (POST /api/agents/:id/start, spawnAgentSession) trusts the
 *      working folder alone, as main did, and the agent's Claude Code stops before its first turn on the trust question
 *      for ~/.tars or its secondary folder. That terminal comes from spawnAgentPty directly, never through spawnShell or
 *      launchIntoTerminal, so the call in spawnAgentSessionInSlot is its only trust.
 *
 * The route runs for real down to spawnAgentPty, whose node-pty records the line; the trust is the real one
 * (core/claude-trust.ts), written into the throwaway home's ~/.claude.json and read back from it.
 */

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ pid: 5151, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() })),
}));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../../electron/core/agent-manager', async () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  // The real trust, as agent-manager re-exports it.
  ensureProjectTrusted: (await vi.importActual<typeof import('../../../../electron/core/claude-trust')>('../../../../electron/core/claude-trust')).ensureProjectTrusted,
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));
vi.mock('../../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

import * as pty from 'node-pty';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { DATA_DIR } from '../../../../electron/constants';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

// The launch read here is darwin and linux's (`bash -l -c '<line>'`); on a Windows host the file runs as linux. The
// win32 start's trust is case 13 of claude-added-folders-trust.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const homeFile = () => path.join(os.homedir(), '.claude.json');
function trustedIn(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const config = JSON.parse(fs.readFileSync(file, 'utf-8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
  return Object.entries(config.projects ?? {}).filter(([, p]) => p?.hasTrustDialogAccepted === true).map(([k]) => k);
}
const spellings = (dir: string) => [...new Set([dir, fs.realpathSync.native(dir)])];

function routes(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
}

const ctx: RouteContext = {
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
};

let project: string;
let secondary: string;

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(pty.spawn).mockClear();
  fs.writeFileSync(homeFile(), JSON.stringify({ numStartups: 3, projects: {} }), { mode: 0o600 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  project = fs.mkdtempSync(path.join(os.homedir(), 'project-'));
  secondary = fs.mkdtempSync(path.join(os.homedir(), 'secondary-'));
});

/** POST /api/agents/:id/start from the project's orchestrator, as start_agent sends it; the line spawned. */
async function startFromOrchestrator(fields: Partial<AgentStatus>): Promise<string> {
  const base = { status: 'idle', projectPath: project, skills: [], output: [], lastActivity: new Date().toISOString(), provider: 'claude', permissionMode: 'bypass' };
  agents.set('lead', { id: 'lead', name: 'Lead', role: 'orchestrator', ...base } as unknown as AgentStatus);
  agents.set('worker', { id: 'worker', name: 'Worker', ...base, ...fields } as unknown as AgentStatus);
  const app = routes();
  registerAgentRoutes(app, ctx);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern).includes('\\/start$'))!;
  const req = {
    method: 'POST', pathname: '/api/agents/worker/start', url: new URL('http://localhost/'),
    body: { prompt: 'Rebase onto main' }, raw: {} as never, res: {} as never,
    params: { id: 'worker' }, callerAgentId: 'lead',
  } as unknown as RouteRequest;
  const answers: Array<{ body: unknown; status?: number }> = [];
  await route.handler(req, (body, status) => { answers.push({ body, status }); });
  expect(answers[0]?.status ?? 200, JSON.stringify(answers[0]?.body)).toBe(200);
  const call = vi.mocked(pty.spawn).mock.calls.at(-1)!;
  return (call[1] as string[])[2];
}

describe('12. the API\'s start', () => {
  it('trusts ~/.tars and the secondary folder its line hands, with the agent\'s folder', async () => {
    const line = await startFromOrchestrator({ secondaryProjectPath: secondary });
    expect(line, 'the line hands both folders').toContain(DATA_DIR);
    expect(line).toContain(secondary);
    const trusted = trustedIn(homeFile());
    for (const dir of [...spellings(project), ...spellings(DATA_DIR), ...spellings(secondary)]) expect(trusted).toContain(dir);
  });
});
