import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * An agent changed over the API shows on a page that is already open.
 *
 * Found by the Frontend verifying #93: no route in agent-routes.ts told the
 * windows anything. An agent created, started, given a task or stopped over the
 * API stayed as it was on every open page until a reload, and the super chat
 * drives its agents over exactly these routes.
 *
 * Two channels, and each view reads one of them, which is why every case
 * checks both:
 * - the Chat page's rail reloads the fleet on `agent:status`
 *   (src/hooks/useRoomAgents.ts);
 * - the Agents page and the Dashboard redraw from `agents:tick`
 *   (src/hooks/useElectron.ts), whose payload says what each card shows.
 *
 * The renderer hooks themselves cannot run here, the repo has no DOM renderer
 * for tests, so these stop at the boundary they cross: what the main process
 * sends, read as it was sent.
 */

type Pushed = { channel: string; payload: unknown };
const pushes: Pushed[] = [];

type FakePty = {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
};
const spawned: FakePty[] = [];

function fakePty(): FakePty {
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  return {
    onData: cb => { dataCb = cb; },
    onExit: cb => { exitCb = cb; },
    kill: vi.fn(),
    write: vi.fn(),
    emitData: data => dataCb?.(data),
    emitExit: exitCode => exitCb?.({ exitCode }),
  };
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty = fakePty();
    spawned.push(pty);
    return pty;
  }),
}));
let ptyCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-${++ptyCounter}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({
  // Copied at the moment of sending: the payloads are live objects, and reading
  // them later would show their state now instead of what the window was told.
  broadcastToAllWindows: (channel: string, payload: unknown) => {
    pushes.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? null)) });
  },
}));
vi.mock('../../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  PROGRAMMATIC_SUBMIT_DELAY_MS: 300,
  // A stop ends the terminal's tree (core/agent-stop.ts); here, its hangup.
  endTerminalTree: vi.fn(async (t: { kill?: () => void }) => { t.kill?.(); }),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));
vi.mock('../../../../electron/services/acp/delegate', () => ({
  // Stop and delete end the agent's delegated runs too (#6): none run here.
  stopAcpRuns: async () => 0,
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../../../electron/core/pty-manager';
import { startAgentWatch, stopAgentWatch } from '../../../../electron/services/agent-watch';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';
import type { AgentTickItem } from '../../../../electron/utils/agents-tick';
import { moveTestHome } from '../../../setup/test-home';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-routes-window-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-routes-window-project-'));

let restoreHome: () => void;
let routes: RouteApp;
let ctx: RouteContext;

beforeEach(() => {
  vi.useFakeTimers();
  pushes.length = 0;
  spawned.length = 0;
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(writeProgrammaticInput).mockClear();
  // Starting a session pre-accepts workspace trust in ~/.claude.json.
  restoreHome = moveTestHome(home);
  expect(os.homedir(), 'HOME is not redirected, and a spawn would write the real ~/.claude.json').toBe(home);

  routes = {
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
  registerAgentRoutes(routes, ctx);
  startAgentWatch();
});

afterEach(async () => {
  // Every timer fired, including the ones firing schedules, rather than
  // dropped: the tick keeps its timer in a module variable, and one abandoned
  // here would silence every tick of the next test.
  await vi.runAllTimersAsync();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  stopAgentWatch();
  restoreHome();
});

/** Calls a route the way the server does, and returns what it answered. */
async function call(method: string, url: string, body: Record<string, unknown> = {}, caller?: string) {
  const pathname = url.split('?')[0];
  for (const route of routes.routes) {
    if (route.method !== method) continue;
    const m = typeof route.pattern === 'string' ? (route.pattern === pathname ? [pathname] : null) : pathname.match(route.pattern);
    if (!m) continue;
    const answers: Array<{ data: unknown; status: number }> = [];
    const req = {
      method, pathname, url: new URL(`http://localhost${url}`), body,
      raw: { headers: {}, on: () => {} }, res: {}, params: m[1] ? { id: m[1] } : {},
      // The caller the server resolves from the bearer token. The routes that
      // drive an agent refuse one that is nobody; here the agent in the path
      // stands in for an agent of its own project, which is the ordinary case.
      callerAgentId: caller ?? m[1],
    } as unknown as RouteRequest;
    await route.handler(req, (data, status = 200) => { answers.push({ data, status }); }, ctx);
    return answers.at(-1);
  }
  throw new Error(`no route for ${method} ${url}`);
}

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = {
    name: over.id, status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/** A live terminal in the map, as a running session leaves one. The agent it
 *  belongs to must record the same working directory, or killStalePty takes
 *  the terminal for a stale one and replaces it. */
function liveTerminal(ptyId: string): FakePty {
  const pty = fakePty();
  ptyProcesses.set(ptyId, pty as never);
  return pty;
}

/** A session between turns: a CLI in front of the terminal's shell, and the
 *  status `idle`, which is what every turn ends on. A message is typed into
 *  it only because a CLI runs there: without one it would run as a command. */
function liveCliTerminal(ptyId: string): FakePty {
  const pty = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30, env: {},
  }) as unknown as FakePty & { process: string };
  pty.process = '2.1.280';
  ptyProcesses.set(ptyId, pty as never);
  return pty;
}

/** The Chat page's rail: every agent:status this agent was announced with. */
const railHeard = (id: string) => pushes
  .filter(p => p.channel === 'agent:status' && (p.payload as { agentId: string }).agentId === id)
  .map(p => (p.payload as { status: string }).status);

/** The Agents page and the Dashboard: this agent's card in the last tick, once the tick has gone out. */
async function cardOf(id: string): Promise<AgentTickItem | undefined> {
  await vi.advanceTimersByTimeAsync(600);
  const ticks = pushes.filter(p => p.channel === 'agents:tick');
  expect(ticks.length, 'no agents:tick was sent, so the Agents page and the Dashboard never redraw').toBeGreaterThan(0);
  return (ticks.at(-1)!.payload as AgentTickItem[]).find(a => a.id === id);
}

describe('an agent changed over the API', () => {
  it('shows when it is created', async () => {
    // Creation has no agent in its path, so the caller is named: the route
    // refuses one that is nobody, the way every route that drives an agent does.
    const creator = putAgent({ id: 'creator' });
    const answer = await call('POST', '/api/agents', { projectPath: project, name: 'Fresh' }, creator.id);
    const id = (answer!.data as { agent: AgentStatus }).agent.id;

    expect(railHeard(id)).toEqual(['idle']);
    expect((await cardOf(id))?.name).toBe('Fresh');
  });

  it('shows as working when it is started', async () => {
    putAgent({ id: 'a1' });

    await call('POST', '/api/agents/a1/start', { prompt: 'build it' });

    expect(spawned).toHaveLength(1);
    expect(railHeard('a1')).toEqual(['running']);
    expect((await cardOf('a1'))?.displayStatus).toBe('working');
  });

  it('keeps the cards moving while its terminal writes', async () => {
    putAgent({ id: 'a1' });
    await call('POST', '/api/agents/a1/start', { prompt: 'build it' });
    await vi.advanceTimersByTimeAsync(600);
    pushes.length = 0;

    spawned[0].emitData('compiling...\r\n');

    expect(await cardOf('a1')).toBeDefined();
  });

  it('shows as done when its process exits, names no terminal, and still tells whoever delegated it', async () => {
    const orchestratorPty = liveTerminal('pty-orch');
    putAgent({ id: 'orch', status: 'idle', ptyId: 'pty-orch', currentSessionId: 'sess-orch' });
    const agent = putAgent({ id: 'a1' });
    await call('POST', '/api/agents/a1/start', { prompt: 'build it' });
    agent.requestedBy = { agentId: 'orch', ptyId: agent.ptyId! };
    pushes.length = 0;

    spawned[0].emitExit(0);
    await vi.advanceTimersByTimeAsync(1600);

    expect(agent.status).toBe('completed');
    expect(agent.ptyId, 'the record still names a terminal that is gone').toBeUndefined();
    expect(railHeard('a1')).toEqual(['completed']);
    expect((await cardOf('a1'))?.displayStatus).toBe('done');
    // Clearing the terminal before the in-process emit made agent-watch drop
    // this note: it matches the link against the child's ptyId.
    // The fourth argument names the terminal and who the note is from, so a
    // note that has to wait for a human draft can be shown as waiting.
    expect(writeProgrammaticInput).toHaveBeenCalledWith(
      orchestratorPty, expect.stringContaining('a1'), true, expect.objectContaining({ agentId: 'orch' }),
    );
  });

  it('shows as stopped when it is stopped, and its dying terminal writes no error onto it', async () => {
    const agent = putAgent({ id: 'a1' });
    await call('POST', '/api/agents/a1/start', { prompt: 'build it' });
    pushes.length = 0;

    await call('POST', '/api/agents/a1/stop', { reason: 'not needed' });

    expect(agent.ptyId, 'a stopped agent still names its terminal').toBeUndefined();
    // stopped, not idle, since PLAN-1.9.2 item A (core/agent-stop.ts).
    expect(railHeard('a1')).toEqual(['stopped']);
    expect((await cardOf('a1'))?.displayStatus).toBe('stopped');

    spawned[0].emitExit(1);
    await vi.advanceTimersByTimeAsync(1600);

    expect(agent.status).toBe('stopped');
    expect(agent.error).toBeUndefined();
  });

  it('shows as working when /dispatch types into its live session', async () => {
    const terminal = liveCliTerminal('pty-live');
    putAgent({ id: 'a1', status: 'waiting', ptyId: 'pty-live', ptyCwd: project });

    const answer = await call('POST', '/api/agents/a1/dispatch', { message: 'carry on' });

    expect((answer!.data as { mode: string }).mode).toBe('message');
    expect(writeProgrammaticInput).toHaveBeenCalledWith(terminal, 'carry on', true, expect.objectContaining({ agentId: expect.any(String) }));
    expect(railHeard('a1')).toEqual(['running']);
    expect((await cardOf('a1'))?.displayStatus).toBe('working');
  });

  it('shows as working when /message types into its live session', async () => {
    const terminal = liveCliTerminal('pty-live');
    putAgent({ id: 'a1', status: 'idle', ptyId: 'pty-live', ptyCwd: project });

    await call('POST', '/api/agents/a1/message', { message: 'one more thing' });

    expect(writeProgrammaticInput).toHaveBeenCalledWith(terminal, 'one more thing', true, expect.objectContaining({ agentId: expect.any(String) }));
    expect(railHeard('a1')).toEqual(['running']);
    expect((await cardOf('a1'))?.displayStatus).toBe('working');
  });

  it('is gone from the pages when it is deleted', async () => {
    putAgent({ id: 'a1' });
    putAgent({ id: 'a2' });

    await call('DELETE', '/api/agents/a1');

    expect(railHeard('a1')).toHaveLength(1);
    expect(await cardOf('a1')).toBeUndefined();
    expect(await cardOf('a2')).toBeDefined();
  });
});

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux, once the home above
// has moved as the host names it; the win32 launch (the CLI as the terminal's
// process) is held by launch-call-sites.test.ts and agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform); });
