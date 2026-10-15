import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Start never types a launch command into a CLI that is still running.
 *
 * The status could not tell: a turn that fails leaves claude alive at its
 * prompt with the agent marked error, and an agent done or idle keeps its
 * session open. From any of those, agent:start reused the live terminal and
 * typed `cd '...' && claude ...` into claude's own input box.
 *
 * What runs in the terminal is read from the terminal. node-pty names the
 * leader of its foreground process group, measured with the real node-pty and
 * Claude Code 2.1.273 in `/bin/bash -l`: `bash` at the prompt, `2.1.273` while
 * claude runs, `bash` again after /exit. The PTYs here come from the real
 * spawnAgentPty, which records the shell, with node-pty replaced by a terminal
 * whose foreground can be set the way those measurements found it.
 *
 * The renderer gets the same answer as `cliRunning`, on agents:tick and on the
 * agents agent:list and agent:get return.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-start-live-cli-${process.pid}-${Date.now()}`),
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

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => ({
    pid: 4242,
    // What node-pty reports first: the file it was asked to spawn, until a
    // group holds the terminal. Measured under Electron's node: `/bin/bash`
    // for 3 to 127 ms, then `spawn-helper`, then `bash` at the prompt.
    process: file,
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  })),
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
    getVersion: () => '1.7.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
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
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { scheduleTick } from '../../../electron/utils/agents-tick';
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

function deps(overrides: Record<string, unknown> = {}): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    initAgentPty: vi.fn(async () => { throw new Error('the terminal exists: nothing should be spawned'); }),
    ...overrides,
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

/** An agent whose terminal is open, spawned the way every agent terminal is. */
function agentWithTerminal(status: AgentStatus['status'], args = ['-l']): { agent: AgentStatus; terminal: FakePty } {
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args, runsCommand: args.includes('-c'), cwd: project, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: 'agent-live' },
  }) as unknown as FakePty;
  ptyProcesses.set('pty-live', terminal as never);
  const agent = {
    id: 'agent-live', name: 'Planner', status, provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
    ptyId: 'pty-live', ptyCwd: project, currentTask: 'the task it had',
  } as AgentStatus;
  agents.set(agent.id, agent);
  return { agent, terminal };
}

const start = (id: string) => handlers.get('agent:start')!({}, { id, prompt: 'next task' }) as Promise<{
  success: boolean; cliRunning?: boolean; error?: string;
}>;

/** What the next agents:tick says about this agent. */
async function tickFor(id: string): Promise<Record<string, unknown> | undefined> {
  broadcasts.length = 0;
  scheduleTick();
  await vi.advanceTimersByTimeAsync(600);
  const tick = broadcasts.filter(b => b.channel === 'agents:tick').at(-1)?.payload as Array<Record<string, unknown>> | undefined;
  return tick?.find(item => item.id === id);
}

beforeEach(() => {
  vi.useFakeTimers();
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  broadcasts.length = 0;
  agents.clear();
  ptyProcesses.clear();
  registerIpcHandlers(deps());
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe('start with claude still running in the terminal', () => {
  it.each(['error', 'completed', 'idle'] as const)('types nothing and says so, for an agent marked %s', async (status) => {
    const { agent, terminal } = agentWithTerminal(status);
    terminal.process = '2.1.273';

    const result = await start(agent.id);
    await vi.advanceTimersByTimeAsync(1000);

    expect(result).toMatchObject({ success: false, cliRunning: true });
    expect(result.error).toContain('Nothing was typed');
    expect(terminal.write).not.toHaveBeenCalled();
    expect(agent.status).toBe(status);
    expect(agent.currentTask).toBe('the task it had');
  });

  it('reports cliRunning to the renderer on the tick, agent:list and agent:get', async () => {
    const { agent, terminal } = agentWithTerminal('error');
    terminal.process = '2.1.273';

    expect(await tickFor(agent.id)).toMatchObject({ cliRunning: true });
    const listed = (await handlers.get('agent:list')!({})) as AgentStatus[];
    expect(listed.find(a => a.id === agent.id)).toMatchObject({ cliRunning: true });
    expect(await handlers.get('agent:get')!({}, agent.id)).toMatchObject({ cliRunning: true });
    // A copy for the renderer: the stored agent carries nothing to persist.
    expect(agent.cliRunning).toBeUndefined();
  });
});

describe('start with only the shell left, after /exit', () => {
  it('types the launch command as before', async () => {
    const { agent, terminal } = agentWithTerminal('completed');
    terminal.process = 'bash';

    const result = await start(agent.id);
    await vi.advanceTimersByTimeAsync(1000);

    expect(result).toMatchObject({ success: true });
    const typed = terminal.write.mock.calls.map(call => String(call[0])).join('');
    expect(typed).toContain(`cd '${project}' && `);
    expect(agent.status).toBe('running');
  });

  it('reports cliRunning false to the renderer on the tick, agent:list and agent:get', async () => {
    const { agent, terminal } = agentWithTerminal('completed');
    terminal.process = 'bash';

    expect(await tickFor(agent.id)).toMatchObject({ cliRunning: false });
    const listed = (await handlers.get('agent:list')!({})) as AgentStatus[];
    expect(listed.find(a => a.id === agent.id)).toMatchObject({ cliRunning: false });
    expect(await handlers.get('agent:get')!({}, agent.id)).toMatchObject({ cliRunning: false });
  });

  it('follows the terminal from one to the other', async () => {
    const { agent, terminal } = agentWithTerminal('waiting');
    terminal.process = '2.1.273';
    expect(await tickFor(agent.id)).toMatchObject({ cliRunning: true });

    terminal.process = 'bash';
    expect(await tickFor(agent.id)).toMatchObject({ cliRunning: false });
  });
});

/**
 * Before the shell holds its terminal, node-pty names it twice more: the file
 * it was asked to spawn, as given, then its own `spawn-helper`. Both were read
 * as a CLI, because only `bash` was compared. agent:get creates the terminal of
 * an agent that has none, after a stop, and read it within the same call: the
 * Frontend measured `/bin/bash` at 3 ms and `bash` only at 24 ms.
 */
describe('a session the API started, which hands the shell its CLI to run', () => {
  // spawnAgentSession opens `bash -l -c "cd ... && exec <cli>"`. Before the
  // exec, and for the CLI's whole life when there was none, node-pty named
  // bash: every agent the API had started read no CLI, the Dashboard offered
  // Start, and Start typed its launch line into claude's own field (measured
  // by the Frontend on 2026-09-23, on five of JeanBrasse's six Tars agents).
  it.each(['bash', '2.1.280'])('types nothing and says so, with %s in front', async (name) => {
    const { agent, terminal } = agentWithTerminal('idle', ['-l', '-c', `cd '${project}' && exec '/usr/local/bin/claude'`]);
    terminal.process = name;

    expect(await tickFor(agent.id)).toMatchObject({ cliRunning: true });
    const result = await start(agent.id);
    await vi.advanceTimersByTimeAsync(1000);

    expect(result).toMatchObject({ success: false, cliRunning: true });
    expect(result.error).toContain('Nothing was typed');
    expect(terminal.write).not.toHaveBeenCalled();
    expect(agent.status).toBe('idle');
  });
});

describe('a terminal whose shell is still starting', () => {
  it.each(['/bin/bash', 'spawn-helper'])('reads %s as the shell: start types, and nothing says a CLI runs', async (name) => {
    const { agent, terminal } = agentWithTerminal('completed');
    terminal.process = name;

    expect(await tickFor(agent.id)).toMatchObject({ cliRunning: false });
    const listed = (await handlers.get('agent:list')!({})) as AgentStatus[];
    expect(listed.find(a => a.id === agent.id)).toMatchObject({ cliRunning: false });
    expect(await handlers.get('agent:get')!({}, agent.id)).toMatchObject({ cliRunning: false });

    const result = await start(agent.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toMatchObject({ success: true });
    expect(terminal.write.mock.calls.map(call => String(call[0])).join('')).toContain(`cd '${project}' && `);
  });

  it('agent:get says no CLI runs in the terminal just opened for a stopped agent', async () => {
    const agent = {
      id: 'agent-stopped', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(), ptyId: 'pty-killed-by-stop',
    } as AgentStatus;
    agents.set(agent.id, agent);
    // Opened the way a start opens one: agent:get opens none.
    agent.ptyId = await initAgentPty(agent, null, vi.fn(), vi.fn());

    const got = await handlers.get('agent:get')!({}, agent.id) as AgentStatus;

    const terminal = ptyProcesses.get(got.ptyId!) as unknown as FakePty;
    expect(got.ptyId).not.toBe('pty-killed-by-stop');
    // The terminal as node-pty hands it over, before the shell has started.
    expect(terminal.process).toBe('/bin/bash');
    expect(got).toMatchObject({ cliRunning: false });
  });
});
