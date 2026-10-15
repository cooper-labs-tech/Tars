import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';

const mockPtyProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  // The routes tell every open window when an agent changes; here there are none.
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  // Exported by agent-manager and imported by agent-routes: a mock that omits
  // it makes the spawn path throw on an undefined call.
  armTaskStartWatch: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  // A stop ends the terminal's tree (core/agent-stop.ts); here, its hangup.
  endTerminalTree: vi.fn(async (t: { kill?: () => void }) => { t.kill?.(); }),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

// The CLIs of POST /api/agents' case 4, on a POSIX disk in memory: this file runs
// as darwin or linux on every host (below), and a Windows host's own disk has
// C:\ paths and no execute bit.
const cliDisk = vi.hoisted(() => new Map<string, PosixEntry>());
vi.mock('fs', async (importOriginal) => (await import('../../platform/posix-fake-disk')).onPosixDisk(await importOriginal<typeof import('fs')>(), cliDisk));

import * as pty from 'node-pty';
import { POSIX_ROOT, type PosixEntry } from '../../platform/posix-fake-disk';
import { getAllProviders } from '../../../../electron/providers';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents, saveAgents, killStalePty } from '../../../../electron/core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { RouteApp, RouteContext, RouteRequest, SendJson } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


/**
 * A terminal with a CLI up in it, opened the way every agent terminal is. The
 * routes type into a session only where cliRunningIn finds a CLI, and it reads
 * what spawnAgentPty recorded: a PTY that did not come from there runs nothing.
 */
function liveCliTerminal(ptyId: string) {
  const terminal = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), process: '2.1.280' };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: '/test/project', cols: 80, rows: 24, env: {} });
  ptyProcesses.set(ptyId, terminal as never);
  return terminal;
}

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'idle',
    projectPath: '/test/project',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A request the way the server hands one to a route, with the caller the
 * server resolved from the bearer token.
 *
 * `callerAgentId` defaults to the agent in the path: the routes that drive an
 * agent refuse a caller that is nobody, and an agent driving one of its own
 * project is the ordinary case. A test that wants the refusal passes
 * `callerAgentId: undefined` explicitly - `makeReq({ callerAgentId: undefined })`
 * does not restore the default, because the key is present.
 */
function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  const base = {
    method: 'GET',
    pathname: '',
    url: new URL('http://localhost/'),
    body: {},
    raw: {} as any,
    res: {} as any,
    params: {},
  };
  const req = { ...base, ...overrides } as RouteRequest;
  if (!('callerAgentId' in overrides)) req.callerAgentId = req.params.id;
  return req;
}

let ctx: RouteContext;

beforeEach(() => {
  // A launch marked by one test holds the agent in the next (core/agent-launch.ts).
  resetLaunches();
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(saveAgents).mockClear();
  vi.mocked(killStalePty).mockClear();
  vi.mocked(writeProgrammaticInput).mockClear();
  mockPtyProcess.onData.mockClear();
  mockPtyProcess.onExit.mockClear();
  mockPtyProcess.kill.mockClear();

  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  };
});

describe('agent-routes', () => {
  function findHandler(app: RouteApp, method: string, patternStr: string) {
    return app.routes.find(r => r.method === method && String(r.pattern).includes(patternStr))!.handler;
  }

  describe('GET /api/agents', () => {
    it('returns list of agents', async () => {
      agents.set('a1', makeAgent({ id: 'a1', name: 'Agent A' }));
      agents.set('a2', makeAgent({ id: 'a2', name: 'Agent B' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(makeReq(), sendJson, ctx);

      expect(sendJson).toHaveBeenCalledTimes(1);
      const result = sendJson.mock.calls[0][0];
      expect(result.agents).toHaveLength(2);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns projected agent without the raw output buffer', async () => {
      const agent = makeAgent({ id: 'a1', output: ['ansi-chunk-1', 'ansi-chunk-2'] });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'agents\\/([^/]+)$');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, url: new URL('http://localhost/api/agents/a1') }), sendJson, ctx);

      const result = sendJson.mock.calls[0][0] as { agent: Record<string, unknown> };
      // The ANSI output buffer (up to 10 000 chunks) must never be serialized
      // into MCP responses — it destroys the orchestrator's context window.
      expect(result.agent.output).toBeUndefined();
      expect(result.agent.outputChunks).toBe(2);
      expect(result.agent.id).toBe('a1');
    });

    it('returns the full agent with ?full=true', async () => {
      const agent = makeAgent({ id: 'a1', output: ['chunk'] });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'agents\\/([^/]+)$');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, url: new URL('http://localhost/api/agents/a1?full=true') }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ agent });
    });

    it('returns 404 for missing agent', async () => {
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'agents\\/([^/]+)$');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'nope' } }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'Agent not found' }, 404);
    });
  });

  describe('GET /api/agents/:id/output', () => {
    it('returns agent output', async () => {
      const agent = makeAgent({ id: 'a1', output: ['line1', 'line2', 'line3'], status: 'running' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'output');

      const sendJson = vi.fn();
      const url = new URL('http://localhost/api/agents/a1/output?lines=2');
      await handler(makeReq({ params: { id: 'a1' }, url }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ output: 'line2line3', status: 'running' });
    });
  });

  describe('POST /api/agents', () => {
    /** The caller of a create: an agent of the fleet, since this route has no
     *  agent in its path to stand in for one. */
    function creator(): string {
      agents.set('creator', makeAgent({ id: 'creator' }));
      return 'creator';
    }

    it('creates a new agent', async () => {
      const callerAgentId = creator();
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'POST' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      // In the creator's own project: another one takes allowCrossProject,
      // as on every route that drives an agent.
      await handler(makeReq({ callerAgentId, body: { projectPath: '/test/project', name: 'Test Agent' } }), sendJson, ctx);

      expect(sendJson).toHaveBeenCalledTimes(1);
      const result = sendJson.mock.calls[0][0];
      expect(result.agent.name).toBe('Test Agent');
      expect(result.agent.status).toBe('idle');
      expect(agents.size).toBe(2);
      expect(saveAgents).toHaveBeenCalled();
    });

    it('returns 400 without projectPath', async () => {
      const callerAgentId = creator();
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'POST' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(makeReq({ callerAgentId, body: {} }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'projectPath is required' }, 400);
    });
  });

  /**
   * An agent makes another on any provider and CLI (2.0.2, JeanBrasse: "ça doit supporter n'importe quel
   * provider/cli"). How it fails, written before the code (2026-10-14):
   * 1. An unknown provider is refused without the providers that exist: the caller cannot correct it.
   * 2. A provider run through an API key, without its key, is created, and its first launch is refused
   *    (or, worse, would run on the user's Anthropic account): refused at creation, as the launch would.
   * 3. A CLI provider loses its model, effort or permission mode on the way.
   * 4. A cliPath that is not absolute, does not exist, is a folder or is not executable is kept, and the
   *    launch fails later with no reason; or an absolute executable file is refused.
   * 5. A permission mode outside plan, normal, auto and bypass is kept.
   */
  describe('POST /api/agents: any provider and any CLI (2.0.2)', () => {
    const create = async (body: Record<string, unknown>) => {
      agents.set('creator', makeAgent({ id: 'creator' }));
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'POST' && r.pattern === '/api/agents')!.handler;
      const sendJson = vi.fn();
      await handler(makeReq({ callerAgentId: 'creator', body: { projectPath: '/test/project', name: 'Made', ...body } }), sendJson, ctx);
      return sendJson.mock.calls[0] as [Record<string, any>, number | undefined];
    };

    it('1. refuses an unknown provider, and names every provider of the registry', async () => {
      const [answer, status] = await create({ provider: 'nope' });
      expect(status).toBe(400);
      for (const p of getAllProviders()) expect(answer.error).toContain(p.id);
    });

    it("2. refuses a provider run through an API key when its key is not set, as its launch would", async () => {
      const [answer, status] = await create({ provider: 'openrouter' });
      expect(status).toBe(400);
      expect(answer.error).toBe('No API key configured for provider "openrouter". Add it (or an OpenRouter key) in Settings > AI Providers.');
      expect(agents.size).toBe(1);
    });

    it('3. keeps a CLI provider with its model, effort and permission mode', async () => {
      const [answer, status] = await create({ provider: 'codex', model: 'gpt-5-codex', effort: 'high', permissionMode: 'normal' });
      expect(status).toBeUndefined();
      expect(answer.agent).toMatchObject({ provider: 'codex', model: 'gpt-5-codex', effort: 'high', permissionMode: 'normal' });
    });

    it('4. takes a cliPath only when it is an absolute path to an executable file, and says why otherwise', async () => {
      const exe = `${POSIX_ROOT}/my-cli`;
      const plain = `${POSIX_ROOT}/plain`;
      cliDisk
        .set(POSIX_ROOT, { kind: 'dir', mode: 0o755 })
        .set(exe, { kind: 'file', mode: 0o755 })
        .set(plain, { kind: 'file', mode: 0o644 });
      for (const [cliPath, why] of [
        ['my-cli', /absolute/], [`${POSIX_ROOT}/missing`, /no file/], [POSIX_ROOT, /not a file/], [plain, /not executable/],
      ] as const) {
        const [answer, status] = await create({ cliPath });
        expect(status, cliPath).toBe(400);
        expect(answer.error, cliPath).toMatch(why);
      }
      const [made, status] = await create({ provider: 'codex', cliPath: exe });
      expect(status).toBeUndefined();
      expect(made.agent.cliPath).toBe(exe);
    });

    it('5. refuses a permission mode outside plan, normal, auto and bypass', async () => {
      const [answer, status] = await create({ permissionMode: 'yolo' });
      expect(status).toBe(400);
      expect(answer.error).toMatch(/plan, normal, auto or bypass/);
    });

    // The Audit's Low 2 on #407: a Codex agent made in plan ran as normal and edited once it had asked.
    it("6. refuses plan for a provider that has none, with the window's reason, and keeps it for Claude Code", async () => {
      const [answer, status] = await create({ provider: 'codex', permissionMode: 'plan' });
      expect(status).toBe(400);
      expect(answer.error).toMatch(/has no plan mode here: plan would run as manual/);
      expect(agents.size).toBe(1);
      const [made, ok] = await create({ provider: 'claude', permissionMode: 'plan' });
      expect(ok).toBeUndefined();
      expect(made.agent.permissionMode).toBe('plan');
    });
  });

  describe('POST /api/agents/:id/stop', () => {
    it('stops a running agent', async () => {
      const mockPty = { kill: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', status: 'running', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'stop');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { reason: 'done for today' } }), sendJson, ctx);

      expect(mockPty.kill).toHaveBeenCalled();
      // stopped, with who and why, since PLAN-1.9.2 item A (core/agent-stop.ts).
      expect(agent.status).toBe('stopped');
      expect(agent.stopReason).toBe('done for today');
      expect(sendJson).toHaveBeenCalledWith(expect.objectContaining({ success: true, stopReason: 'done for today' }));
    });
  });

  describe('POST /api/agents/:id/start', () => {
    it('kills existing PTY before spawning a new one', async () => {
      const existingPty = { kill: vi.fn() };
      ptyProcesses.set('existing-pty', existingPty as any);
      const agent = makeAgent({ id: 'a1', status: 'idle', ptyId: 'existing-pty' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'Do something' } }), sendJson, ctx);

      expect(existingPty.kill).toHaveBeenCalled();
      expect(ptyProcesses.has('existing-pty')).toBe(false);
      expect(sendJson).toHaveBeenCalledWith({ success: true, agent: { id: 'a1', status: 'running' } });
    });

    it('transitions waiting→error when PTY exits while agent is waiting', async () => {
      const agent = makeAgent({ id: 'a1', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'Do something' } }), sendJson, ctx);

      // Simulate status being set to 'waiting' by a hook while the PTY is running
      agent.status = 'waiting';

      // Simulate PTY exit
      // The route's own listener, registered last: spawnAgentPty's terminal
      // mirror subscribes before any caller does.
      const exitHandler = mockPtyProcess.onExit.mock.calls.at(-1)![0] as (args: { exitCode: number }) => void;
      exitHandler({ exitCode: 1 });

      // After the 1500ms delay, status should become 'error' not stay 'waiting'
      await new Promise(r => setTimeout(r, 1600));
      expect(agent.status).toBe('error');
    });

    it('clears session ownership so stale hooks cannot flip the new task', async () => {
      const agent = makeAgent({
        id: 'a1',
        status: 'waiting',
        currentSessionId: 'old-sess',
        waitingReason: 'permission',
        lastCleanOutput: 'old output',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'new task' } }), vi.fn(), ctx);

      expect(agent.status).toBe('running');
      expect(agent.currentSessionId).toBeUndefined();
      expect(agent.waitingReason).toBeUndefined();
      expect(agent.lastCleanOutput).toBeUndefined();
      // The killed session is tombstoned so its in-flight hooks are rejected
      // even while currentSessionId is still undefined.
      expect(agent.lastKilledSessionId).toBe('old-sess');
    });

    it('removes a dead PTY from the live map immediately on exit', async () => {
      const agent = makeAgent({ id: 'a1', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'work' } }), vi.fn(), ctx);
      expect(ptyProcesses.has('test-uuid')).toBe(true);

      // PTY dies: it must leave the map RIGHT AWAY (node-pty write on a dead
      // PTY is a silent no-op), not after the 1500ms status-delay — otherwise
      // /dispatch happily "types" the next task into a corpse.
      const exitHandler = mockPtyProcess.onExit.mock.calls.at(-1)![0] as (args: { exitCode: number }) => void;
      exitHandler({ exitCode: 0 });
      expect(ptyProcesses.has('test-uuid')).toBe(false);
      // Status change is still deferred for hook output capture.
      expect(agent.status).toBe('running');
    });
  });

  describe('POST /api/agents/:id/dispatch', () => {
    it('types into the live PTY when the agent is running and clears stale output', async () => {
      const mockPty = liveCliTerminal('pty-1');
      const agent = makeAgent({ id: 'a1', name: 'Worker', status: 'running', ptyId: 'pty-1', lastCleanOutput: 'previous task result' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'next step' } }), sendJson, ctx);

      expect(writeProgrammaticInput).toHaveBeenCalledWith(mockPty, 'next step', true, expect.objectContaining({ agentId: expect.any(String) }));
      // The previous task's output must not be mistaken for this task's result.
      expect(agent.lastCleanOutput).toBeUndefined();
      expect(sendJson).toHaveBeenCalledWith({
        success: true,
        mode: 'message',
        previousStatus: 'running',
        agent: { id: 'a1', name: 'Worker', status: 'running' },
      });
    });

    it('refuses to type into a blocking permission dialog (409)', async () => {
      const mockPty = { write: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', status: 'waiting', waitingReason: 'permission', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'yes go on' } }), sendJson, ctx);

      // Typing would be useless and the delayed \r could ACCEPT the pending
      // permission — the dispatch must be refused with the reason.
      expect(writeProgrammaticInput).not.toHaveBeenCalled();
      expect(sendJson.mock.calls[0][1]).toBe(409);
      expect((sendJson.mock.calls[0][0] as { waitingReason: string }).waitingReason).toBe('permission');
      expect(agent.status).toBe('waiting');
    });

    it('spawns a fresh session when the agent is idle', async () => {
      const agent = makeAgent({ id: 'a1', name: 'Worker', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'do the task' } }), sendJson, ctx);

      const pty = await import('node-pty');
      expect(pty.spawn).toHaveBeenCalled();
      expect(agent.status).toBe('running');
      expect(sendJson).toHaveBeenCalledWith({
        success: true,
        mode: 'start',
        previousStatus: 'idle',
        agent: { id: 'a1', name: 'Worker', status: 'running' },
      });
    });

    it('spawns fresh when status says waiting but the PTY is dead', async () => {
      // The "agent ne répond plus" scenario: status stuck at waiting with no
      // live PTY. Dispatch must NOT try to message a ghost — it respawns.
      const agent = makeAgent({ id: 'a1', status: 'waiting', ptyId: 'gone-pty' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'retry task' } }), sendJson, ctx);

      expect(writeProgrammaticInput).not.toHaveBeenCalled();
      const result = sendJson.mock.calls[0][0] as { mode: string };
      expect(result.mode).toBe('start');
      expect(agent.status).toBe('running');
    });

    it('returns 400 without message', async () => {
      agents.set('a1', makeAgent({ id: 'a1' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: {} }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'message is required' }, 400);
    });
  });

  describe('identity bootstrap', () => {
    it('spawn command carries an identity header so agents know who they are', async () => {
      const agent = makeAgent({
        id: 'a1',
        name: 'Backend-Alpha',
        status: 'idle',
        role: 'worker',
        projectPath: '/proj/alpha',
        worktreePath: '/proj/alpha/.worktrees/feat/backend',
        branchName: 'feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'fix the API' } }), vi.fn(), ctx);

      const pty = await import('node-pty');
      const command = (pty.spawn as any).mock.calls.at(-1)[1][2] as string;
      expect(command).toContain('you are agent "Backend-Alpha" (id a1), worker of project /proj/alpha');
      expect(command).toContain('worktree /proj/alpha/.worktrees/feat/backend');
      expect(command).toContain('fix the API');

      const spawnEnv = (pty.spawn as any).mock.calls.at(-1)[2].env;
      expect(spawnEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    });

    it('GET /:id/bootstrap returns identity and same-project roster only', async () => {
      agents.set('orch', makeAgent({ id: 'orch', name: 'Orchestrator-Alpha', role: 'orchestrator', projectPath: '/proj/alpha' }));
      agents.set('w1', makeAgent({ id: 'w1', name: 'Frontend-Alpha', role: 'worker', projectPath: '/proj/alpha', branchName: 'feat/frontend' }));
      agents.set('w2', makeAgent({ id: 'w2', name: 'Tars-Worker', role: 'worker', projectPath: '/proj/beta' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'bootstrap');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'orch' }, url: new URL('http://localhost/api/agents/orch/bootstrap') }), sendJson, ctx);

      const context = (sendJson.mock.calls[0][0] as { context: string }).context;
      expect(context).toContain('You are "Orchestrator-Alpha"');
      expect(context).toContain('Frontend-Alpha');
      expect(context).not.toContain('Tars-Worker');
      expect(context).toContain('Delegate ONLY to the agents listed above');
    });

    it('GET /:id/health reports PTY liveness and session presence', async () => {
      const mockPty = { kill: vi.fn() };
      ptyProcesses.set('pty-live', mockPty as any);
      agents.set('alive', makeAgent({ id: 'alive', status: 'running', ptyId: 'pty-live', currentSessionId: 'sess' }));
      agents.set('ghost', makeAgent({ id: 'ghost', status: 'waiting', ptyId: 'pty-gone' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'health');

      const sendAlive = vi.fn();
      await handler(makeReq({ params: { id: 'alive' }, url: new URL('http://localhost/api/agents/alive/health') }), sendAlive, ctx);
      expect(sendAlive.mock.calls[0][0]).toMatchObject({ ptyAlive: true, hasLiveSession: true, status: 'running' });

      const sendGhost = vi.fn();
      await handler(makeReq({ params: { id: 'ghost' }, url: new URL('http://localhost/api/agents/ghost/health') }), sendGhost, ctx);
      expect(sendGhost.mock.calls[0][0]).toMatchObject({ ptyAlive: false, hasLiveSession: false, status: 'waiting' });
    });
  });

  describe('project scoping', () => {
    /**
     * A call from an agent of this project, as the server hands it to a route:
     * callerAgentId is the agent its token was minted for. The agent is put in
     * the fleet, since the project is read from there and from nothing the
     * call says.
     */
    function reqFromProject(project: string, overrides: Partial<RouteRequest> = {}): RouteRequest {
      const callerId = `caller-of-${project}`;
      agents.set(callerId, makeAgent({ id: callerId, projectPath: project }));
      return makeReq({
        raw: { headers: {}, on: () => {} } as any,
        callerAgentId: callerId,
        ...overrides,
      });
    }

    it('GET /api/agents returns only the caller project agents', async () => {
      agents.set('a1', makeAgent({ id: 'a1', projectPath: '/proj/alpha' }));
      agents.set('a2', makeAgent({ id: 'a2', projectPath: '/proj/beta' }));
      agents.set('a3', makeAgent({ id: 'a3', projectPath: '/proj/alpha' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(reqFromProject('/proj/alpha', { url: new URL('http://localhost/api/agents') }), sendJson, ctx);

      const result = sendJson.mock.calls[0][0] as { agents: { id: string }[]; scopedToProject?: string };
      expect(result.agents.map(a => a.id).sort()).toEqual(['a1', 'a3', 'caller-of-/proj/alpha']);
      expect(result.scopedToProject).toBe('/proj/alpha');
    });

    it('GET /api/agents?all=true returns every project', async () => {
      agents.set('a1', makeAgent({ id: 'a1', projectPath: '/proj/alpha' }));
      agents.set('a2', makeAgent({ id: 'a2', projectPath: '/proj/beta' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(reqFromProject('/proj/alpha', { url: new URL('http://localhost/api/agents?all=true') }), sendJson, ctx);

      const result = sendJson.mock.calls[0][0] as { agents: { id: string }[] };
      expect(result.agents.map(a => a.id).sort()).toEqual(['a1', 'a2', 'caller-of-/proj/alpha']);
    });

    it('rejects dispatch to an agent of another project with 403', async () => {
      agents.set('a1', makeAgent({ id: 'a1', name: 'Tars-Worker', projectPath: '/proj/beta' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const pty = await import('node-pty');
      const spawnCallsBefore = (pty.spawn as any).mock.calls.length;

      const sendJson = vi.fn();
      await handler(reqFromProject('/proj/alpha', { params: { id: 'a1' }, body: { message: 'go' } }), sendJson, ctx);

      expect(sendJson.mock.calls[0][1]).toBe(403);
      expect(String((sendJson.mock.calls[0][0] as { error: string }).error)).toContain('Cross-project access denied');
      expect((pty.spawn as any).mock.calls.length).toBe(spawnCallsBefore);
    });

    it('allows cross-project dispatch with allowCrossProject: true', async () => {
      const agent = makeAgent({ id: 'a1', projectPath: '/proj/beta', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(
        reqFromProject('/proj/alpha', { params: { id: 'a1' }, body: { message: 'go', allowCrossProject: true } }),
        sendJson,
        ctx
      );

      expect(agent.status).toBe('running');
      expect((sendJson.mock.calls[0][0] as { mode: string }).mode).toBe('start');
    });

    it('a caller that is nobody starts nothing, with no header to give it away', async () => {
      // The hole, measured on b17db0f: the shared token with no x-tars-client
      // header started, stopped and deleted an agent of any project and got a
      // 200. The guard only refused a caller that volunteered that header,
      // which is a claim the caller writes about itself.
      const agent = makeAgent({ id: 'a1', projectPath: '/proj/beta', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ callerAgentId: undefined, params: { id: 'a1' }, body: { prompt: 'go' } }), sendJson, ctx);

      expect(sendJson.mock.calls[0][1]).toBe(403);
      expect(String((sendJson.mock.calls[0][0] as { error: string }).error))
        .toContain('Driving an agent takes an identity of your own');
      expect(agent.status).toBe('idle');
    });

    it('takes no project from a header: a caller that is nobody is refused whatever project it names', async () => {
      // The project it names is the target's own, so believing the header
      // would let this through. Every agent can read the shared token and
      // write this header, which is why it scopes nothing.
      const agent = makeAgent({ id: 'a1', projectPath: '/proj/beta', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({
        callerAgentId: undefined,
        params: { id: 'a1' },
        body: { prompt: 'go' },
        raw: { headers: { 'x-tars-client': 'mcp', 'x-tars-caller-project': '/proj/beta', 'x-dorothy-caller-project': '/proj/beta' }, on: () => {} } as any,
      }), sendJson, ctx);

      expect(sendJson.mock.calls[0][1]).toBe(403);
      expect(String((sendJson.mock.calls[0][0] as { error: string }).error))
        .toContain('Driving an agent takes an identity of your own');
      expect(agent.status).toBe('idle');
    });

    it('refuses a caller whose id no longer belongs to any agent of the fleet', async () => {
      // A removed agent whose process is still alive keeps its token until the
      // app restarts. Resolving its project would give undefined, which is how
      // the old guard read "unrestricted".
      const agent = makeAgent({ id: 'a1', projectPath: '/proj/beta', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ callerAgentId: 'removed-agent', params: { id: 'a1' }, body: { prompt: 'go' } }), sendJson, ctx);

      expect(sendJson.mock.calls[0][1]).toBe(404);
      expect(sendJson.mock.calls[0][0]).toEqual({ error: 'The calling agent is not one Tars knows about.' });
      expect(agent.status).toBe('idle');
    });
  });

  describe('POST /api/agents/:id/message', () => {
    it('sends message to agent PTY', async () => {
      const mockPty = liveCliTerminal('pty-1');
      const agent = makeAgent({ id: 'a1', status: 'running', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'hello' } }), sendJson, ctx);

      expect(writeProgrammaticInput).toHaveBeenCalledWith(mockPty, 'hello', true, expect.objectContaining({ agentId: expect.any(String) }));
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });

    it('auto-respawns PTY with message as prompt when PTY is missing', async () => {
      const agent = makeAgent({ id: 'a1', status: 'waiting', projectPath: '/test/project' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'continue the task' } }), sendJson, ctx);

      // Should NOT call the legacy initAgentPtyCallback (bare bash shell)
      expect(ctx.initAgentPtyCallback).not.toHaveBeenCalled();
      // Should have spawned a new one-shot PTY
      const pty = await import('node-pty');
      expect(pty.spawn).toHaveBeenCalled();
      // Agent should be running and PTY registered
      expect(agent.status).toBe('running');
      expect(agent.ptyId).toBe('test-uuid');
      expect(ptyProcesses.has('test-uuid')).toBe(true);
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });

    it('BUG 4: calls killStalePty before reusing existing PTY', async () => {
      liveCliTerminal('pty-1');
      const agent = makeAgent({
        id: 'a1',
        status: 'running',
        ptyId: 'pty-1',
        projectPath: '/test/project',
        worktreePath: '/test/project/.worktrees/feat/backend',
        ptyCwd: '/test/project/.worktrees/feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'hi' } }), vi.fn(), ctx);

      // killStalePty must be called on every /message so stale cwd is caught
      expect(killStalePty).toHaveBeenCalledWith(agent);
    });

    it('BUG 4: reconnect path records worktreePath as ptyCwd', async () => {
      const agent = makeAgent({
        id: 'a1',
        status: 'waiting',
        projectPath: '/test/project',
        worktreePath: '/test/project/.worktrees/feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'go' } }), vi.fn(), ctx);

      // ptyCwd must match the worktree path — this is the cwd bash/claude
      // actually inherits from pty.spawn. Without it, killStalePty can't
      // detect a later worktree change.
      expect(agent.ptyCwd).toBe('/test/project/.worktrees/feat/backend');

      // pty.spawn must receive the raw path (not the shell-escaped version)
      // so it works for paths that legitimately contain a single quote.
      const pty = await import('node-pty');
      expect(pty.spawn).toHaveBeenCalled();
      const spawnOpts = (pty.spawn as any).mock.calls.at(-1)[2];
      expect(spawnOpts.cwd).toBe('/test/project/.worktrees/feat/backend');
    });

    it('reconnect path applies the skills prefix like /start does', async () => {
      // The old reconnect path rebuilt the claude command from scratch and
      // silently dropped the skills prefix — reconnected agents "forgot" their
      // skills. Both paths now share spawnAgentSession.
      const agent = makeAgent({ id: 'a1', status: 'waiting', skills: ['frontend-design'] });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'continue' } }), vi.fn(), ctx);

      const pty = await import('node-pty');
      const command = (pty.spawn as any).mock.calls.at(-1)[1][2] as string;
      expect(command).toContain('Use these skills for this session: frontend-design');
    });
  });

  describe('BUG 4 cwd invariants', () => {
    it('POST /start uses worktreePath as raw spawn cwd and records ptyCwd', async () => {
      const agent = makeAgent({
        id: 'a1',
        status: 'idle',
        projectPath: '/test/project',
        worktreePath: '/test/project/.worktrees/feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'work' } }), vi.fn(), ctx);

      // ptyCwd must match the logical worktree path so killStalePty has
      // ground truth to compare against when worktreePath later changes.
      expect(agent.ptyCwd).toBe('/test/project/.worktrees/feat/backend');

      // pty.spawn must receive the raw (non-shell-escaped) worktree path.
      // Passing the escaped form would break paths containing single quotes.
      const pty = await import('node-pty');
      const spawnOpts = (pty.spawn as any).mock.calls.at(-1)[2];
      expect(spawnOpts.cwd).toBe('/test/project/.worktrees/feat/backend');
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes agent and kills PTY', async () => {
      const mockPty = { kill: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'DELETE', 'agents');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' } }), sendJson, ctx);

      expect(mockPty.kill).toHaveBeenCalled();
      expect(agents.has('a1')).toBe(false);
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('GET /api/agents/:id/wait', () => {
    it('returns immediately for terminal state', async () => {
      const agent = makeAgent({ id: 'a1', status: 'completed', lastCleanOutput: 'done' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'wait');

      const sendJson = vi.fn();
      const url = new URL('http://localhost/api/agents/a1/wait');
      await handler(makeReq({ params: { id: 'a1' }, url }), sendJson, ctx);

      expect(sendJson).toHaveBeenCalledWith({
        status: 'completed',
        lastCleanOutput: 'done',
        error: undefined,
      });
    });
  });
});
