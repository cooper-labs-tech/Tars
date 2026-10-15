import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A message that lands while an agent's CLI is being launched waits for it.
 *
 * Measured by the Audit on 2026-09-23 (re-gate of #120 and #126): a restart
 * kills the CLI, opens a terminal, gives its shell half a second, types the
 * launch, and the CLI execs a moment later. A /dispatch in that time found no
 * CLI and started a session over the launch, without --resume: the
 * conversation was lost (WORD=NONE at +0.3 s and at +0.49 s), and at +0.49 s
 * the killed CLI's late SessionStart then took the agent from the live one.
 * Scripted senders land there: the bots, the Hermes webhook, the overseer.
 *
 * What follows is the harness of start-launch-settings.test.ts: every launch from a window, and the two the main process makes on its own,
 * run on the agent's model and effort, and a change to either applies by
 * itself, at a moment that cuts nothing.
 *
 * What happened on 2026-09-22 with 1.7.9: JeanBrasse moved every agent to Opus 5.5
 * in the Agents page. The CLIs went on running the old model, and the ones he
 * relaunched from the Dashboard came back on the model their previous session
 * had answered on: Opus 5 for four Tars agents and five Parallel ones, Opus
 * 4.8 for the Audit Engineer, read from a transcript a month old. Their argv
 * said so, process by process. Then every one of them sat in `running` with no
 * task in front of an idle prompt.
 *
 * The handlers here are the real ones (registered with registerIpcHandlers),
 * as are initAgentPty, spawnAgentPty, the draft guard and the restart; only
 * node-pty is replaced, by a terminal that records what is typed into it and
 * whose foreground can be set the way node-pty reports it (`bash` at a shell,
 * the version number while claude runs).
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-launch-settings-${process.pid}-${Date.now()}`),
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
      pid: 4242 + spawned.length,
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
    getVersion: () => '1.7.9', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => {
    broadcasts.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? null)) });
  },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const broadcasts: Array<{ channel: string; payload: unknown }> = [];

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses, resetTerminalInput } from '../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { resetResumeTracking, encodeProjectDirName } from '../../../electron/utils/resume-session';
import { resetAgentRestarts } from '../../../electron/core/agent-restart';
import { resetLaunches, CLI_BOOT_MS } from '../../../electron/core/agent-launch';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import { EventEmitter } from 'node:events';
import { resetAgentWatch, startAgentWatch, stopAgentWatch, queueBusMessage } from '../../../electron/services/agent-watch';
import { registerHooksRoutes } from '../../../electron/services/api-routes/hooks-routes';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


const project = path.join(tmpHome, 'project');
const OLD_SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    // The real one: a restart opens a new terminal, through the one function
    // that spawns an agent's pty.
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

/** The transcript of the agent's last session, which answered on `model`. */
function lastSessionAnsweredOn(model: string): void {
  const dir = path.join(tmpHome, '.claude', 'projects', encodeProjectDirName(project));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${OLD_SESSION}.jsonl`), [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n') + '\n');
}

/** An agent whose terminal is open, spawned the way every agent terminal is. */
function agentWithTerminal(opts: Partial<AgentStatus> & { foreground: string }): { agent: AgentStatus; terminal: FakePty } {
  const { foreground, ...fields } = opts;
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: 'agent-a' },
  }) as unknown as FakePty;
  terminal.process = foreground;
  ptyProcesses.set('pty-a', terminal as never);
  const agent = {
    id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
    ptyId: 'pty-a', ptyCwd: project, permissionMode: 'bypass',
    model: 'claude-opus-5-5', effort: 'max',
    ...fields,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return { agent, terminal };
}

const update = (params: Record<string, unknown>) =>
  handlers.get('agent:update')!({}, params) as Promise<{ success: boolean }>;

/** POST /api/hooks/status, as a hook script sends it, through the real route. */
function hookStatus(body: Record<string, unknown>): Record<string, unknown> {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerHooksRoutes(app, {
    getAppSettings: () => ({} as AppSettings),
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
  } as unknown as RouteContext);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern) === '/api/hooks/status')!;
  let answer: Record<string, unknown> = {};
  void route.handler({ body, params: {} } as unknown as RouteRequest, (json) => { answer = json as Record<string, unknown>; });
  return answer;
}

/** Everything typed into a terminal, as one string. */
const typedInto = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');

/** The terminal opened for the agent after `before` terminals existed. */
const newTerminal = (before: number) => spawned[before];

beforeEach(() => {
  vi.useFakeTimers();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  broadcasts.length = 0;
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


/** POST /api/agents/:id/dispatch through the real route, from another agent of the project. */
function dispatch(id: string, message: string, endpoint: 'dispatch' | 'message' = 'dispatch'): Promise<{ status: number; body: Record<string, unknown> }> {
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
  const pathname = `/api/agents/${id}/${endpoint}`;
  const route = app.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
  let answer = { status: 200, body: {} as Record<string, unknown> };
  return Promise.resolve(route.handler({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { message },
    raw: { headers: {}, on: () => {} }, res: {}, params: { id }, callerAgentId: 'orch',
  } as unknown as RouteRequest, (json, status = 200) => { answer = { status, body: json as Record<string, unknown> }; }, {} as RouteContext))
    .then(() => answer);
}

/** The session the restarted CLI registers, a fork of the one it resumes. */
const FORK = '61200c3f-6bbe-44d5-b76e-016196479491';

/** The agent at rest, its CLI up, a conversation behind it, and an orchestrator in the project. */
function agentMidConversation() {
  lastSessionAnsweredOn('claude-opus-5-5');
  agents.set('orch', {
    id: 'orch', name: 'Orchestrator', status: 'running', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
  return agentWithTerminal({
    foreground: '2.1.280', effort: 'high',
    currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
  });
}

/**
 * The cases that resume a conversation read its transcript under Claude's
 * folder for the project, named as darwin and linux name it (resume-session.ts:
 * `/` and `.` to `-`). This file runs as linux on any host; on a Windows
 * host the project is a Windows path, whose `:` and `\` no folder name can
 * hold, so the transcript those cases resume from has nowhere to go. They run
 * on macOS and Linux; the Windows name is held by resume-session.test.ts.
 */
const NO_POSIX_TRANSCRIPT_FOLDER = process.platform === 'win32';

describe('a dispatch that lands while a restart launches the CLI', () => {
  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER).each([
    ['after the kill, while the new shell starts', 300],
    ['just after the launch was typed, before the CLI runs', 550],
  ])('waits for the CLI and goes into the resumed session (%s)', async (_when, at) => {
    const { agent, terminal } = agentMidConversation();
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(at);
    expect(terminal.kill, 'the restart did not begin').toHaveBeenCalled();
    const answered = dispatch(agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(800 - at);
    // The restarted CLI takes its terminal, and its session registers.
    newTerminal(before).process = '2.1.280';
    await vi.advanceTimersByTimeAsync(500);
    expect(typedInto(newTerminal(before)), 'typed before the CLI took keys').not.toContain('WORD?');
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'idle', source: 'resume' });
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await answered;

    expect(answer.body.mode, JSON.stringify(answer.body)).toBe('message');
    expect(spawned.length, 'a session was started over the launch').toBe(before + 1);
    const restarted = newTerminal(before);
    expect(typedInto(restarted)).toContain(`--resume '${OLD_SESSION}' --fork-session`);
    expect(typedInto(restarted)).toContain('WORD?');
    expect(agent.ptyId).not.toBe('pty-a');
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('holds a /message the same way, which the MCP send_message uses', async () => {
    const { agent } = agentMidConversation();
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(300);
    const answered = dispatch(agent.id, 'WORD?', 'message');
    await vi.advanceTimersByTimeAsync(500);
    newTerminal(before).process = '2.1.280';
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'idle', source: 'resume' });
    await vi.advanceTimersByTimeAsync(1_000);
    await answered;

    expect(spawned.length, 'a session was started over the launch').toBe(before + 1);
    expect(typedInto(newTerminal(before))).toContain('WORD?');
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('gives up on a launch whose CLI never comes up, and starts a session', async () => {
    const { agent } = agentMidConversation();
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(300);
    const answered = dispatch(agent.id, 'WORD?');
    // The launch was typed and nothing ever took the terminal.
    await vi.advanceTimersByTimeAsync(CLI_BOOT_MS + 1_000);
    const answer = await answered;

    expect(answer.body.mode).toBe('start');
    expect(spawned.length).toBe(before + 2);
  });
});

describe('a session started through the API, then a second message', () => {
  // The Audit's gate of #134: spawnAgentSession, which serves /start and the
  // start branch of /dispatch and /message, did not mark its launch. Its CLI
  // execs at once and counts as running, so a second message 0.1 to 0.3 s
  // later was typed into a claude not yet reading keys: lost 4 times in 5,
  // with a 200 `mode: message` to the caller.
  function orchestratorAndIdleAgent(): AgentStatus {
    agents.set('orch', {
      id: 'orch', name: 'Orchestrator', status: 'running', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus);
    const agent = {
      id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    } as AgentStatus;
    agents.set(agent.id, agent);
    return agent;
  }

  it('holds the second message until the session has begun its task, then types it once', async () => {
    const agent = orchestratorAndIdleAgent();
    const before = spawned.length;

    const first = await dispatch(agent.id, 'Rebase onto main');
    expect(first.body.mode).toBe('start');
    const terminal = newTerminal(before);
    // The shell execs claude at once: node-pty names it by its version.
    terminal.process = '2.1.280';
    await vi.advanceTimersByTimeAsync(300);
    const second = dispatch(agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typedInto(terminal), 'typed into a claude not yet reading keys').not.toContain('WORD?');

    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', source: 'startup' });
    await vi.advanceTimersByTimeAsync(1_000);
    // Registered, and about to submit the task it was started with from its
    // own field: a message typed now was lost once in five in the app.
    expect(typedInto(terminal), 'typed between the SessionStart and the task').not.toContain('WORD?');

    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', event: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await second;

    expect(answer.body.mode, JSON.stringify(answer.body)).toBe('message');
    expect(spawned.length, 'a second session was started').toBe(before + 1);
    expect(typedInto(terminal).split('WORD?').length - 1).toBe(1);
  });

  it('does not hold anyone for a CLI that exited before its session came up', async () => {
    const agent = orchestratorAndIdleAgent();
    const before = spawned.length;
    await dispatch(agent.id, 'Rebase onto main');
    const terminal = newTerminal(before);
    const onExit = terminal.onExit.mock.calls.at(-1)![0] as (e: { exitCode: number }) => void;
    onExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(2_000);

    const t0 = Date.now();
    const answered = dispatch(agent.id, 'again');
    await vi.advanceTimersByTimeAsync(600);
    const answer = await answered;

    expect(answer.body.mode).toBe('start');
    expect(Date.now() - t0, 'waited on a launch that had ended').toBeLessThan(CLI_BOOT_MS);
  });
});

describe('a launch that fails', () => {
  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('lets the next sender through when a start is refused over a CLI already up', async () => {
    // The Dashboard's start on an agent whose CLI runs: refused, nothing typed.
    // Left marked, that launch made the next /dispatch wait CLI_BOOT_MS for a
    // SessionStart no launch was going to send.
    const { agent } = agentMidConversation();
    const refused = await (handlers.get('agent:start')!({}, { id: agent.id, prompt: '' }) as Promise<{ success: boolean; cliRunning?: boolean }>);
    expect(refused).toMatchObject({ success: false, cliRunning: true });

    const t0 = Date.now();
    const answered = dispatch(agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await answered;

    expect(answer.body.mode).toBe('message');
    expect(Date.now() - t0, 'the refused start still held the agent').toBeLessThan(CLI_BOOT_MS);
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('lets the next sender through at once instead of after CLI_BOOT_MS', async () => {
    const agent = agentMidConversation().agent;
    agent.ptyId = undefined;
    const pty = await import('node-pty');
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('posix_spawnp failed.'); });

    // The window's start: its launch is marked, and the terminal cannot open.
    const started = (handlers.get('agent:start')!({}, { id: agent.id, prompt: '' }) as Promise<{ success: boolean }>)
      .catch(() => ({ success: false }));
    await vi.advanceTimersByTimeAsync(600);
    expect((await started).success).toBe(false);

    const t0 = Date.now();
    const answered = dispatch(agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(600);
    const answer = await answered;

    expect(answer.body.mode).toBe('start');
    expect(Date.now() - t0, 'the failed launch still held the agent').toBeLessThan(CLI_BOOT_MS);
  });
});

describe('a room message held while its recipient launches', () => {
  // agent-watch holds what it owes an agent whose launch is on its way (its
  // terminal is a shell about to hand over). It then waited for a status
  // change SessionStart never makes, and at that change dropped the message,
  // bound to "no session" while the one that registered had an id.
  it('goes in when the new session registers, not before and not never', async () => {
    startAgentWatch();
    try {
      const agent = {
        id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
        skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
      } as AgentStatus;
      agents.set(agent.id, agent);
      const before = spawned.length;
      const started = handlers.get('agent:start')!({}, { id: agent.id, prompt: '' }) as Promise<{ success: boolean }>;
      await vi.advanceTimersByTimeAsync(600);
      expect((await started).success).toBe(true);
      const terminal = newTerminal(before);

      expect(queueBusMessage(agent.id, {
        messageId: 'm1', roomId: 'project:/p', threadId: 't1',
        authorKind: 'agent', authorName: 'QA', text: 'the gate is green',
      })).toBe(true);
      // The CLI execs; it takes no keys until its session is up. Past the
      // writer's own pause after the launch (3 s), well inside CLI_BOOT_MS.
      terminal.process = '2.1.280';
      await vi.advanceTimersByTimeAsync(6_000);
      expect(typedInto(terminal), 'pasted at a shell prompt or into a claude not yet reading').not.toContain('the gate is green');

      hookStatus({ agent_id: agent.id, session_id: FORK, status: 'idle', source: 'startup' });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(typedInto(terminal)).toContain('the gate is green');
    } finally {
      stopAgentWatch();
    }
  });
});

describe('a launch slower than CLI_BOOT_MS, as under load (Database Engineer, re-gate of #134)', () => {
  // At a load average of 120 to 300, 5 of 18 launches took longer than 15 s.
  // The sender was released at 15 s, typed into a claude not yet taking keys,
  // answered 200 "message", and the text was lost.
  //
  // How this fails, written before the code:
  // 1. At CLI_BOOT_MS a launch whose CLI runs but whose session or task has
  //    not started is given up, and the next sender types blind.
  // 2. A sender is held past what its own caller waits for (30 s for the MCP
  //    tools), so the caller gives up on an answer that later says "message".
  // 3. A sender that cannot wait any longer types anyway, instead of saying
  //    nothing was typed.
  // 4. A CLI that never comes up holds every sender forever.
  function agentBeingStarted(): { agent: AgentStatus; terminal: () => FakePty; before: number } {
    agents.set('orch', {
      id: 'orch', name: 'Orchestrator', status: 'running', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus);
    const agent = {
      id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    } as AgentStatus;
    agents.set(agent.id, agent);
    const before = spawned.length;
    return { agent, terminal: () => newTerminal(before), before };
  }

  it('keeps holding a sender while the CLI runs and its task has not started, then types once it has', async () => {
    const { agent, terminal } = agentBeingStarted();
    expect((await dispatch(agent.id, 'Rebase onto main')).body.mode).toBe('start');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(14_000);
    const second = dispatch(agent.id, 'WORD?');
    // Past CLI_BOOT_MS: the claude runs, slowly, and has not started its task.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(typedInto(terminal()), 'typed into a claude not yet taking keys').not.toContain('WORD?');

    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', source: 'startup' });
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', event: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await second;

    expect(answer.body.mode, JSON.stringify(answer.body)).toBe('message');
    expect(typedInto(terminal()).split('WORD?').length - 1).toBe(1);
  });

  it('answers that nothing was typed when the launch is still starting at the end of its wait', async () => {
    const { agent, terminal } = agentBeingStarted();
    await dispatch(agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(10_000);
    const t0 = Date.now();
    let answeredAt = 0;
    const second = dispatch(agent.id, 'WORD?').then(r => { answeredAt = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(40_000);
    const answer = await second;

    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(answer.body).toMatchObject({ starting: true });
    // Before the MCP tools' own 30 s: an answer after it reaches nobody.
    expect(answeredAt - t0, 'answered after the caller had given up').toBeLessThan(30_000);
    expect(typedInto(terminal())).not.toContain('WORD?');
  });

  it('answers the same for a /message, which the MCP send_message uses', async () => {
    const { agent, terminal } = agentBeingStarted();
    await dispatch(agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(10_000);
    const second = dispatch(agent.id, 'WORD?', 'message');
    await vi.advanceTimersByTimeAsync(40_000);
    const answer = await second;

    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(answer.body).toMatchObject({ starting: true });
    expect(typedInto(terminal())).not.toContain('WORD?');
  });

  it('stops holding senders for a CLI that never comes up', async () => {
    const { agent, terminal } = agentBeingStarted();
    await dispatch(agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    const late = dispatch(agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await late;

    expect(answer.status, 'a dead launch held the agent').not.toBe(409);
  });
});

describe('QA #158: CLI_UP_MS itself', () => {
  // Written by the QA at the gate of #158. The test above holds a launch ten
  // minutes and lets any bound under that pass: measured, CLI_UP_MS at 160 s
  // or at ten minutes left the whole file green. A launch whose CLI runs is
  // still held at 170 s, and let go by 186 s, at once.
  it('holds a sender while the CLI runs up to CLI_UP_MS, and not a moment past it', async () => {
    agents.set('orch', {
      id: 'orch', name: 'Orchestrator', status: 'running', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus);
    const agent = {
      id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    } as AgentStatus;
    agents.set(agent.id, agent);
    const terminal = () => newTerminal(0);

    await dispatch(agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(150_000);
    const held = dispatch(agent.id, 'EARLY?');
    await vi.advanceTimersByTimeAsync(21_000);
    expect((await held).status, 'a CLI still booting at 170 s was let go').toBe(409);
    expect(typedInto(terminal())).not.toContain('EARLY?');

    await vi.advanceTimersByTimeAsync(15_000);
    const t1 = Date.now();
    let lateAt = -1;
    const late = dispatch(agent.id, 'LATE?').then(r => { lateAt = Date.now() - t1; return r; });
    await vi.advanceTimersByTimeAsync(25_000);
    const answer = await late;

    expect(lateAt, 'a launch 186 s old still held its sender').toBeLessThan(1_000);
    expect(answer.body.mode, JSON.stringify(answer.body)).toBe('message');
  });
});

describe('QA #158: every sender answered in time, and the link a refusal leaves', () => {
  // Written by the QA at the gate of #158. What each one guards:
  // 1. The 20 s a sender waits is counted from the moment it takes the agent's
  //    lock, not from its request: a second sender queued behind the first
  //    waits out the first's 20 s, then its own, and is answered after the MCP
  //    tools have given up at 30 s, which is the answer that reaches nobody.
  // 2. A sender refused with 409 typed nothing, and takes nothing either: the
  //    delegation link stays with the agent the launch's work is for, which
  //    is the one agent-watch tells when that work is done.
  function plannerBeingStarted(): { agent: AgentStatus; terminal: () => FakePty } {
    for (const id of ['orch', 'qa']) {
      agents.set(id, {
        id, name: id === 'orch' ? 'Orchestrator' : 'QA', status: 'running', provider: 'claude', projectPath: project,
        skills: [], output: [], lastActivity: new Date().toISOString(),
      } as AgentStatus);
    }
    const agent = {
      id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    } as AgentStatus;
    agents.set(agent.id, agent);
    const before = spawned.length;
    return { agent, terminal: () => newTerminal(before) };
  }

  /** As dispatch() above, from the agent `caller`. */
  function send(caller: string, id: string, message: string, endpoint: 'dispatch' | 'message' = 'dispatch'): Promise<{ status: number; body: Record<string, unknown> }> {
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
    const pathname = `/api/agents/${id}/${endpoint}`;
    const route = app.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
    let answer = { status: 200, body: {} as Record<string, unknown> };
    return Promise.resolve(route.handler({
      method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { message },
      raw: { headers: {}, on: () => {} }, res: {}, params: { id }, callerAgentId: caller,
    } as unknown as RouteRequest, (json, status = 200) => { answer = { status, body: json as Record<string, unknown> }; }, {} as RouteContext))
      .then(() => answer);
  }

  it('answers a second sender, queued behind the first, before its caller gives up at 30 s', async () => {
    const { agent, terminal } = plannerBeingStarted();
    await send('orch', agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(10_000);

    const t0 = Date.now();
    const at: number[] = [];
    const first = send('orch', agent.id, 'ONE?').then(r => { at[0] = Date.now() - t0; return r; });
    const second = send('qa', agent.id, 'TWO?', 'message').then(r => { at[1] = Date.now() - t0; return r; });
    // The launch comes up 35 s after both were sent: past the MCP tools' 30 s.
    await vi.advanceTimersByTimeAsync(35_000);
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', source: 'startup' });
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', event: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(10_000);
    const answers = [await first, await second];

    expect(answers[0].status).toBe(409);
    expect(at[0]).toBeLessThan(30_000);
    expect(at[1], `the second sender was answered ${JSON.stringify(answers[1])} after ${at[1]} ms`).toBeLessThan(30_000);
  });

  it('leaves the delegation link with the agent the launch works for when a sender is refused', async () => {
    const { agent, terminal } = plannerBeingStarted();
    await send('orch', agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    expect(agent.requestedBy?.agentId).toBe('orch');
    await vi.advanceTimersByTimeAsync(10_000);

    const refused = send('qa', agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(21_000);
    expect((await refused).status).toBe(409);

    expect(agent.requestedBy?.agentId, 'a sender typed nothing, and took the note owed to the orchestrator').toBe('orch');
  });

  // The same two, the other way round: which route comes second, and which is
  // refused. Measured at the re-check: with only the tests above, /dispatch
  // counting its 20 s from the lock again, and /message recording the link
  // before its wait or never, all left the suite green.
  it('answers a second sender that is a /dispatch, queued behind a /message, before its caller gives up', async () => {
    const { agent, terminal } = plannerBeingStarted();
    await send('orch', agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(10_000);

    const t0 = Date.now();
    const at: number[] = [];
    const first = send('orch', agent.id, 'ONE?', 'message').then(r => { at[0] = Date.now() - t0; return r; });
    const second = send('qa', agent.id, 'TWO?').then(r => { at[1] = Date.now() - t0; return r; });
    await vi.advanceTimersByTimeAsync(35_000);
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', source: 'startup' });
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', event: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(10_000);
    const answers = [await first, await second];

    expect(answers[0].status).toBe(409);
    expect(at[0]).toBeLessThan(30_000);
    expect(at[1], `the second sender was answered ${JSON.stringify(answers[1])} after ${at[1]} ms`).toBeLessThan(30_000);
  });

  it('leaves the link alone when a /message is refused, and queues a /message once typed behind the work in hand', async () => {
    const { agent, terminal } = plannerBeingStarted();
    await send('orch', agent.id, 'Rebase onto main');
    terminal().process = '2.1.280';
    await vi.advanceTimersByTimeAsync(10_000);

    const refused = send('qa', agent.id, 'WORD?', 'message');
    await vi.advanceTimersByTimeAsync(21_000);
    expect((await refused).status).toBe(409);
    expect(agent.requestedBy?.agentId, 'a refused /message took the note owed to the orchestrator').toBe('orch');

    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', source: 'startup' });
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'running', event: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(1_000);
    const typed = send('qa', agent.id, 'WORD?', 'message');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await typed).status).toBe(200);
    // The orchestrator's task is still the agent's work: the link stays its
    // own, and QA's request waits, delivered, to take it when that work ends
    // (PR A, core/task-requests.ts). It used to be overwritten here, and the
    // orchestrator's result went to QA.
    expect(agent.requestedBy?.agentId, 'a second request took the link of the work in hand').toBe('orch');
    expect(agent.taskQueue?.map(r => [r.requesterAgentId, r.state])).toContainEqual(['qa', 'delivered']);
  });
});
