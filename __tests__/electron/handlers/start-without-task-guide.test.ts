import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * How Tars works (services/agent-guide.ts) reaches a CLI without Claude's
 * SessionStart hook that the window's launcher starts with no task: Start from
 * the Dashboard or the Agents page, autostart, a restart, a wake. The Audit's
 * N1 on #448 (head 8e7c000c): the launcher gave such a start the section as its
 * prompt, so `opencode run '<section>'` and `amp -x '<section>'` ran one turn
 * and exited instead of opening their screen, and codex, gemini, grok and pi
 * started a turn nobody asked for while Tars showed them idle.
 *
 * How this can fail, written before the code:
 * 1. a start without a task hands the CLI a prompt: the section, the project's
 *    memory, or the skills line alone (six providers wrapped an empty prompt in
 *    "[IMPORTANT: Use these skills ...]" before 2.0.4), and the CLI runs a turn,
 *    or runs once and exits;
 * 2. such a session never learns how Tars works, nor its memory: nothing gives
 *    it the section afterwards;
 * 3. it gets the section with every message Tars types in, not with the first
 *    one only;
 * 4. the section is typed in on its own, as a message of its own, and starts the
 *    turn nobody asked for after all, rather than going in with the first task;
 * 5. it goes in under the sender's line, as if the sender had written it, or
 *    the message loses its sender's line;
 * 6. a start with a task gets the section in its command and then again with
 *    the first message typed into that session;
 * 7. a claude agent, whose bootstrap carries the section, is given it by either
 *    path;
 * 8. a message that never went in (withdrawn, or dropped because the CLI is
 *    gone) uses it up, and the next one that does go in goes without it.
 * 9. (the Audit's L-B and QA's L1 on #448, written before the fix) a CLI
 *    launched again into a terminal that still owes the section, as a bot does
 *    with launchIntoTerminal, the section in its own command: the next message
 *    typed in carries the section a second time, with the memory as it was at
 *    the first start.
 * 10. (the Audit's M1 on #465, written before the fix) the session never told
 *    whose it is: no line of what Tars gives it names the agent, so codex's
 *    session log, which Tars binds to an agent only on evidence, has none in
 *    its first message, and on Windows, where the codex holding a file cannot
 *    be read, no session of an agent started from the window is ever its own.
 *    The first message typed in, or the command of a start with a task, says
 *    it once: Tars's identity line, `(id <agent id>)`, as spawnAgentSession's.
 * 11. (19/10, a gemini agent's first delegated task, written before the fix)
 *    Tars's words typed ahead of the sender's line push that line out of the
 *    prompt's start: a CLI whose hooks report the prompt (gemini's BeforeAgent,
 *    its first 200 bytes) never shows whose task the turn is, nor its id, and
 *    the task is filed as nobody's, its asker answered 404.
 *
 * And the guide route (the Audit's L-A on #448): GET /api/guide?topic=project-folder
 * says why a project's folder could not be made, and so does the section
 * agentGuideSection writes, rather than blaming the project's path.
 *
 * The handlers here are the real ones (registered with registerIpcHandlers), as
 * are initAgentPty, spawnAgentPty, the writer and the dispatch route; only
 * node-pty is replaced, by a terminal that records what is typed into it and
 * whose foreground can be set the way node-pty reports it.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-start-no-task-${process.pid}-${Date.now()}`),
}));

type FakePty = {
  pid: number;
  process: string;
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
  spawn: vi.fn((file: string): FakePty => {
    const terminal: FakePty = {
      pid: 5252 + spawned.length,
      process: file,
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
    getVersion: () => '2.0.4', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
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
import { agents, initAgentPty, launchIntoTerminal } from '../../../electron/core/agent-manager';
import { toLaunch } from '../../../electron/platform/launch';
import { ptyProcesses, resetTerminalInput, writeProgrammaticInput, withdrawWaiting, writeHumanInput } from '../../../electron/core/pty-manager';
import { resetResumeTracking, encodeProjectDirName } from '../../../electron/utils/resume-session';
import { resetAgentRestarts } from '../../../electron/core/agent-restart';
import { resetLaunches } from '../../../electron/core/agent-launch';
import { resetAgentWatch } from '../../../electron/services/agent-watch';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import { agentGuideSection } from '../../../electron/services/agent-guide';
import { projectFilesDir } from '../../../electron/utils/project-files';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell. On
// a Windows host they read it as linux; the win32 launch replaces the shell by
// the CLI, through the same launcher and the same writer.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const project = path.join(tmpHome, 'project');
const SECTION = '## How Tars works';
const MEMORY = 'NOTE-7731 the build runs on Node 22';
// Every CLI whose config folder is not Claude's, so with no SessionStart hook.
const NO_HOOK = ['opencode', 'amp', 'codex', 'gemini', 'grok', 'pi'] as const;

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

function agentAtRest(fields: Partial<AgentStatus>): AgentStatus {
  const agent = {
    id: 'agent-a', name: 'Worker', status: 'idle', provider: 'opencode', projectPath: project,
    skills: ['frontend-design'], output: [], lastActivity: new Date().toISOString(),
    permissionMode: 'normal', role: 'worker',
    ...fields,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

const start = (id: string, prompt = '') =>
  handlers.get('agent:start')!({}, { id, prompt, options: {} }) as Promise<{ success: boolean; error?: string }>;

/** A launch, with the clock run past the half second a fresh terminal is given. */
async function settled<T>(launch: Promise<T>, ms = 600): Promise<T> {
  const outcome = launch.then(value => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  const done = await outcome;
  if ('error' in done) throw done.error;
  return done.value;
}

/** Everything typed into a terminal, as one string. */
// What the field shows: every piece goes in bracket paste markers since 22/10.
const typedInto = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('').replace(/\x1b\[20[01]~/g, '');

/** A launch too long for one typed line is written to a script the shell sources (`. '<file>'`). */
const commandOf = (typed: string) => {
  const script = /\. '([^']+\.sh)'/.exec(typed)?.[1];
  return script && fs.existsSync(script) ? fs.readFileSync(script, 'utf8') : typed;
};
const count = (text: string, what = SECTION) => text.split(what).length - 1;

/** The agent started from the window, its CLI then up in its terminal. */
async function startedFromWindow(prompt: string, fields: Partial<AgentStatus> = {}): Promise<{ agent: AgentStatus; terminal: FakePty; command: string }> {
  const agent = agentAtRest(fields);
  expect(await settled(start(agent.id, prompt))).toMatchObject({ success: true });
  const terminal = spawned[0];
  const command = commandOf(typedInto(terminal));
  // node-pty names the CLI once it runs in the terminal's foreground.
  terminal.process = agent.provider ?? 'opencode';
  terminal.write.mockClear();
  return { agent, terminal, command };
}

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

/** POST /api/agents/:id/dispatch from the project's orchestrator, through the real route. */
async function dispatch(agentId: string, message: string): Promise<Record<string, unknown>> {
  if (!agents.has('orch')) {
    agents.set('orch', {
      id: 'orch', name: 'Lead', status: 'running', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), role: 'orchestrator',
    } as AgentStatus);
  }
  const app = routes();
  const pathname = `/api/agents/${agentId}/dispatch`;
  const route = app.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
  let answer: Record<string, unknown> = {};
  await settled(Promise.resolve(route.handler({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { message },
    raw: { headers: {}, on: () => {} }, res: {}, params: { id: agentId }, callerAgentId: 'orch',
  } as unknown as RouteRequest, (json) => { answer = json as Record<string, unknown>; }, {} as RouteContext)), 2_000);
  return answer;
}

/** GET /api/guide?topic=, as tars_guide calls it, with the token of `callerAgentId`. */
async function guide(topic: string, callerAgentId?: string): Promise<Record<string, unknown>> {
  const app = routes();
  const route = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/guide')!;
  let answer: Record<string, unknown> = {};
  await route.handler({
    method: 'GET', pathname: '/api/guide', url: new URL(`http://localhost/api/guide?topic=${topic}`), body: {},
    raw: { headers: {}, on: () => {} }, res: {}, params: {}, callerAgentId,
  } as unknown as RouteRequest, (json) => { answer = json as Record<string, unknown>; }, {} as RouteContext);
  return answer;
}

/** A file where the project's folder goes: mkdir fails as on a full disk, the path absolute and fine. */
function folderBlocked(): string {
  const dir = projectFilesDir(project)!;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'in the way');
  return dir;
}

beforeEach(() => {
  vi.useFakeTimers();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  // The project's memory, which a CLI without the hook gets with the section.
  const memory = path.join(tmpHome, '.claude', 'projects', encodeProjectDirName(project), 'memory');
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), `${MEMORY}\n`);
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

describe('a CLI without Claude\'s hook started from the window with no task', () => {
  it.each(NO_HOOK)('%s starts on no prompt: no section, no memory, no skills line (1)', async (provider) => {
    const { agent, command } = await startedFromWindow('', { provider });
    expect(count(command), command).toBe(0);
    expect(command).not.toContain(MEMORY);
    expect(command).not.toContain('Use these skills');
    if (provider === 'opencode') expect(command).not.toMatch(/ run '/);
    if (provider === 'amp') expect(command).not.toMatch(/ -x '/);
    // And Tars shows it as what it is: at its prompt.
    expect(agent.status).toBe('idle');
  });

  it('gets the section and its memory with the first task typed in, once, under Tars\'s line (2, 3, 4, 5)', async () => {
    const { agent, terminal } = await startedFromWindow('');

    expect(await dispatch(agent.id, 'FIRST>> rebase onto main')).toMatchObject({ success: true, mode: 'message' });
    const first = typedInto(terminal);
    expect(count(first), first).toBe(1);
    expect(first).toContain(MEMORY);
    expect(first).toContain('assign_task');
    // One message, one Enter: the section goes in with the task, not as a turn of its own.
    expect(count(first, '\r')).toBe(1);
    // The task under its sender's line, which opens the prompt (11), then Tars's words under Tars's line.
    const tars = first.indexOf('Message from Tars: ');
    const sender = first.indexOf('Message from agent "Lead" ("orch")');
    expect(sender, first).toBe(0);
    expect(first.indexOf('FIRST>> rebase onto main')).toBeGreaterThan(sender);
    expect(tars).toBeGreaterThan(first.indexOf('FIRST>> rebase onto main'));
    expect(first.indexOf(SECTION)).toBeGreaterThan(tars);
    expect(first.indexOf(MEMORY)).toBeGreaterThan(tars);

    terminal.write.mockClear();
    expect(await dispatch(agent.id, 'SECOND>> and push it')).toMatchObject({ success: true, mode: 'message' });
    const second = typedInto(terminal);
    expect(second).toContain('SECOND>> and push it');
    expect(count(second), second).toBe(0);
    expect(second).not.toContain(MEMORY);
  });

  it('keeps it for the first message that goes in, not one withdrawn before it did (8)', async () => {
    const { agent, terminal } = await startedFromWindow('');
    // Somebody is typing: the message waits, and is withdrawn while it waits.
    writeHumanInput(terminal as never, 'x');
    const held = writeProgrammaticInput(terminal as never, 'WITHDRAWN>> never mind', true, {
      agentId: agent.id, from: 'Lead', sender: { kind: 'agent', id: 'orch', name: 'Lead' }, taskRef: 't-gone',
    });
    expect(held).toBe('held');
    expect(withdrawWaiting(terminal as never, 't-gone')).toBe(1);
    writeHumanInput(terminal as never, '\x7f');
    await vi.advanceTimersByTimeAsync(10_000);
    terminal.write.mockClear();

    expect(await dispatch(agent.id, 'FIRST>> rebase onto main')).toMatchObject({ success: true });
    const first = typedInto(terminal);
    expect(first).toContain('FIRST>> rebase onto main');
    expect(count(first), first).toBe(1);
  });
});

describe('a CLI launched again into a terminal that still owes the section', () => {
  it('owes nothing from the earlier start: the next message carries no section (9)', async () => {
    const { agent, terminal } = await startedFromWindow('');
    // Its CLI quits, the shell is back in front, and a bot launches it again
    // there with the task, the section in its command (bot-core.ts, withGuide).
    terminal.process = 'bash';
    const relaunch = toLaunch(`'opencode' --prompt '${SECTION} BOT>> the task from Telegram'`, project, process.env);
    // On win32 a launch replaces the terminal (startCliInTerminal), and what the
    // old one owed goes with it: the case is the typed launch of darwin and linux.
    if (relaunch.platform !== 'win32') {
      await launchIntoTerminal(agent, terminal as never, relaunch, { ptyProcesses, initAgentPty });
      terminal.process = 'opencode';
      terminal.write.mockClear();

      expect(await dispatch(agent.id, 'NEXT>> and push it')).toMatchObject({ success: true, mode: 'message' });
      const next = typedInto(terminal);
      expect(next).toContain('NEXT>> and push it');
      expect(count(next), next).toBe(0);
      expect(next).not.toContain(MEMORY);
    }
  });
});

describe("whose session it is (10)", () => {
  it.each(NO_HOOK)("%s: the first task typed in says whose session it is, once, and the next message does not", async (provider) => {
    const { agent, terminal } = await startedFromWindow('', { provider });
    const identity = `[Tars: you are agent "${agent.name}" (id ${agent.id}),`;
    await dispatch(agent.id, 'FIRST>> rebase onto main');
    const first = typedInto(terminal);
    expect(count(first, identity), first).toBe(1);
    expect(first.indexOf(identity)).toBeLessThan(first.indexOf(SECTION));

    terminal.write.mockClear();
    await dispatch(agent.id, 'NEXT>> and push it');
    expect(count(typedInto(terminal), identity)).toBe(0);
  });

  it('a start with a task says it in its command, once', async () => {
    const { agent, command } = await startedFromWindow('WINDOW>> read the guide', { provider: 'codex' });
    expect(count(command, `(id ${agent.id})`), command).toBe(1);
  });
});

describe('a start that carries a task, and a claude agent', () => {
  it('a task: the section in the command, and not again with the next message (6)', async () => {
    const { agent, terminal, command } = await startedFromWindow('WINDOW>> read the guide');
    expect(count(command), command).toBe(1);
    expect(command).toContain('WINDOW>> read the guide');
    expect(command).toContain(MEMORY);

    await dispatch(agent.id, 'NEXT>> and push it');
    const next = typedInto(terminal);
    expect(next).toContain('NEXT>> and push it');
    expect(count(next), next).toBe(0);
  });

  it('claude: neither in its command nor with its first message (7)', async () => {
    const { agent, terminal, command } = await startedFromWindow('', { provider: 'claude' });
    expect(count(command)).toBe(0);
    // claude registers its session before it counts as up (agent-launch.ts).
    agent.sessionRegisteredAt = new Date().toISOString();
    expect(await dispatch(agent.id, 'FIRST>> rebase onto main')).toMatchObject({ success: true, mode: 'message' });
    const first = typedInto(terminal);
    expect(first).toContain('FIRST>> rebase onto main');
    expect(count(first)).toBe(0);
  });
});

describe('a project folder Tars could not make (the Audit\'s L-A on #448)', () => {
  it('the section an agent gets says why, not that the path is not absolute', () => {
    const dir = folderBlocked();
    const section = agentGuideSection(agentAtRest({}));
    expect(section).toContain(dir);
    expect(section).toMatch(/could not be made/);
    expect(section).not.toMatch(/absolute/);
  });

  it('tars_guide\'s project-folder topic says why, for the agent its token names', async () => {
    const dir = folderBlocked();
    agentAtRest({});
    const answer = await guide('project-folder', 'agent-a');
    expect(String(answer.text)).toContain(dir);
    expect(String(answer.text)).toMatch(/could not be made/);
    expect(String(answer.text)).not.toMatch(/absolute/);
  });

  it('tars_guide without an agent behind the token says so, and names no folder', async () => {
    const answer = await guide('project-folder');
    expect(String(answer.text)).toContain('no agent is named by the token that asked');
    expect(String(answer.text)).not.toContain('project-files');
  });
});
