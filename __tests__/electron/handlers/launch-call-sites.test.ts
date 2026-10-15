import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

/**
 * Every place Tars starts a terminal or an agent CLI, as the process it
 * starts: the file, the arguments and what is typed into it (decisions D2 and
 * D3). darwin and linux are held to the values the code produced before the
 * Windows port, written out here as literals; win32 to a CLI started as the
 * terminal's own process, a human shell the platform resolves, and CLIs
 * started by an argv, never a shell string.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. darwin/linux: a call site spawns another shell, other arguments, another
 *    PATH, or types another line than it did: `/bin/bash -l` for an agent's
 *    terminal (agent:create, initAgentPty, the local switch), `/bin/bash -l -c
 *    "cd '<dir>' && exec <cmd>"` for the API (spawnAgentSession), `cd '<dir>'
 *    && <cmd>` typed by agent:start and the bots, defaultShell() with `-l`
 *    for pty:create, shell:startPty and createQuickPty, `npx` with its argv
 *    for a skill, `<shell> [--no-rcs] -c "<command>"` for a plugin, and the
 *    same answers from settings:getInfo, tasmania:getMcpStatus and
 *    shell:version.
 * 2. win32: an agent's terminal, a start or a bot launch still spawns
 *    /bin/bash, types a launch line (audit A1, A2, A4) or goes through a
 *    shell; the CLI is not the terminal's process, in the agent's folder.
 * 3. win32: a human terminal gets /bin/bash or `-l` (A2, B/A-05), or not the
 *    user's terminalShell setting.
 * 4. win32: an installer spawns the bare `npx` (ENOENT through ConPTY, A5,
 *    B/A-06) or hands a shell `-c` and `&&` (B/A-07); a two-step plugin
 *    install runs its second step though the first failed.
 * 5. win32: the version probes run a shell string or a bare name libuv cannot
 *    find (A-10: a .cmd refused with EINVAL), or refuse a path under
 *    `Program Files (x86)` for its parentheses.
 * 6. win32: the child's env carries PATH twice, Path and PATH (A17).
 * 7. win32: the CLI started from a window runs without the agent's identity
 *    (CLAUDE_AGENT_ID, CLAUDE_PROJECT_PATH, a token of its own that names it,
 *    the app's own address).
 * 8. The local switch's terminal, once replaced (a restart, or on win32 the
 *    CLI started in its place), announces `agent:complete` or sets a status:
 *    the Kanban board reads that as the task done.
 * 9. win32: a CLI the API cannot start (LaunchError) is found after the
 *    agent's previous terminal was killed and its session tombstoned: the
 *    caller hears 400 and the agent has lost a working session.
 * 10. win32: a start from a window or a bot kills the shell an agent waits in
 *    although a CLI typed there by hand registered its session from it; or,
 *    refused, still marks the agent running.
 * 11. win32: the CLI's terminal cannot be opened (ConPTY refuses the spawn,
 *    or another terminal was being opened for the agent) and the agent, from
 *    a window or a bot, is left `running` with the task saved, no terminal
 *    and no watch; or the error is swallowed instead of reaching the caller.
 * 12. win32: a terminal in Windows PowerShell 5.1 (an agent's, pty:create,
 *    shell:startPty, the quick terminal) inherits the PSModulePath of a Tars
 *    started from PowerShell 7, finds pwsh 7's modules first and loses core
 *    cmdlets (platform/child-env.ts; real spawns in
 *    platform/psmodulepath-spawn.test.ts); or a pwsh, Git Bash or CLI
 *    terminal loses the parent's value.
 * 13. darwin/linux: a terminal gets another environment than the parent's
 *    (a PSModulePath removed on the way).
 */

/** PSModulePath as a process started from PowerShell 7 has it: pwsh 7's modules first. */
const PWSH7_MODULES = 'C:\\Users\\n\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules';

const { tmpHome } = await vi.hoisted(async () => {
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tars-launch-sites-')) };
});

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;
type FakePty = {
  file: string;
  args: string[] | string;
  opts: { cwd: string; env: Record<string, string>; name: string };
  pid: number;
  process: string;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  exit(code: number): void;
};
const spawned = vi.hoisted(() => [] as FakePty[]);
const children = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; file: string; args?: string[]; options?: Record<string, unknown> }>,
  out: new Map<string, string>(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[] | string, opts: FakePty['opts']) => {
    const data: DataListener[] = [];
    const exits: ExitListener[] = [];
    const terminal: FakePty = {
      file, args, opts, pid: 9000 + spawned.length,
      // What node-pty answers first on Unix, the file it spawned, and always
      // on Windows, the terminal's name (audit A6).
      process: process.platform === 'win32' ? opts.name : file,
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn((listener: DataListener) => { data.push(listener); return { dispose() {} }; }),
      onExit: vi.fn((listener: ExitListener) => { exits.push(listener); return { dispose() {} }; }),
      exit: (exitCode) => { for (const listener of exits) listener({ exitCode, signal: 0 }); },
    };
    spawned.push(terminal);
    // A shell prints its prompt: what shellReady waits for before typing.
    setTimeout(() => { for (const listener of data) listener('$ '); }, 10);
    return terminal;
  }),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const answer = (key: string) => {
    const out = children.out.get(key);
    if (out === undefined) throw Object.assign(new Error(`not found: ${key}`), { code: 'ENOENT' });
    return out;
  };
  const execFile = Object.assign(
    (file: string, args: string[], options: Record<string, unknown>, cb?: (e: Error | null, out?: string, err?: string) => void) => {
      children.calls.push({ fn: 'execFile', file, args, options });
      const callback = typeof options === 'function' ? options as unknown as typeof cb : cb;
      try { callback?.(null, answer([file, ...args].join(' ')), ''); } catch (e) { callback?.(e as Error, '', ''); }
      return new EventEmitter();
    },
    {
      [promisify.custom]: (file: string, args: string[], options: Record<string, unknown>) => {
        children.calls.push({ fn: 'execFile', file, args, options });
        return new Promise((resolve, reject) => {
          try { resolve({ stdout: answer([file, ...args].join(' ')), stderr: '' }); } catch (e) { reject(e); }
        });
      },
    },
  );
  // The version probes (core/version-probe.ts, upstream's since 1.9.3): a
  // child that answers on stdout and closes, or fails to start. No pid, so
  // the probe's end signals nothing real.
  const spawn = (file: string, args: string[], options: Record<string, unknown>) => {
    children.calls.push({ fn: 'spawn', file, args, options });
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
    process.nextTick(() => {
      let out: string;
      try { out = answer([file, ...args].join(' ')); } catch (e) { child.emit('error', e); return; }
      child.stdout.emit('data', out);
      child.emit('close', 0, null);
    });
    return child;
  };
  const mocked = {
    ...actual,
    execFile,
    spawn,
    execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
      children.calls.push({ fn: 'execFileSync', file, args, options });
      return answer([file, ...args].join(' '));
    },
    execSync: (command: string, options: Record<string, unknown>) => {
      children.calls.push({ fn: 'execSync', file: command, options });
      return answer(command);
    },
    exec: (command: string, options: Record<string, unknown>, cb: (e: Error | null, out?: string, err?: string) => void) => {
      children.calls.push({ fn: 'exec', file: command, options });
      try { cb(null, answer(command), ''); } catch (e) { cb(e as Error, '', ''); }
      return new EventEmitter();
    },
  };
  return { ...mocked, default: mocked };
});
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.9.0', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'running', endpoint: 'http://127.0.0.1:8123/v1', modelName: 'qwen' })),
  tasmaniaFetch: vi.fn(),
}));
vi.mock('../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => (process.platform === 'win32' ? WIN_PATH : POSIX_PATH)),
}));
// The Windows disk the resolvers read: a native claude.exe, Node's npx.cmd,
// Windows PowerShell. Read on win32 only; darwin/linux touch no disk here.
vi.mock('../../../electron/platform/fs-probe', () => ({
  realFs: {
    isFile: (p: string) => WIN_DISK.has(p.toLowerCase()),
    readFile: (p: string) => {
      const text = WIN_DISK.get(p.toLowerCase());
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return text;
    },
  },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

const { WIN_PATH, POSIX_PATH, WIN_DISK, CLAUDE_EXE, NODE_EXE, NPX_CLI, WIN_POWERSHELL, X86_CLAUDE } = vi.hoisted(() => {
  const CLI_DIR = 'C:\\Users\\Sam Lee\\.local\\bin';
  const NODE_DIR = 'C:\\Program Files\\nodejs';
  const X86 = 'C:\\Program Files (x86)\\Anthropic';
  const NPX_SHIM = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*',
  ].join('\r\n');
  const files: Record<string, string> = {
    [`${CLI_DIR}\\claude.exe`]: 'MZ',
    [`${X86}\\claude.exe`]: 'MZ',
    [`${NODE_DIR}\\node.exe`]: 'MZ',
    [`${NODE_DIR}\\npx.cmd`]: NPX_SHIM,
    [`${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`]: '',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': 'MZ',
  };
  return {
    WIN_PATH: `${CLI_DIR};${NODE_DIR};C:\\Windows\\System32`,
    POSIX_PATH: '/Users/me/.local/bin:/usr/local/bin:/usr/bin:/bin',
    WIN_DISK: new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v])),
    CLAUDE_EXE: `${CLI_DIR}\\claude.exe`,
    NODE_EXE: `${NODE_DIR}\\node.exe`,
    NPX_CLI: `${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`,
    WIN_POWERSHELL: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    X86_CLAUDE: `${X86}\\claude.exe`,
  };
});

import * as pty from 'node-pty';
import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { broadcastToAllWindows } from '../../../electron/utils/broadcast';
import { agentForToken } from '../../../electron/core/agent-tokens';
import { API_PORT } from '../../../electron/constants';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses, createQuickPty } from '../../../electron/core/pty-manager';
import { resetLaunches } from '../../../electron/core/agent-launch';
import { startWithTask, type BotFleet } from '../../../electron/services/bot-core';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import { DATA_DIR } from '../../../electron/constants';
import { quoteWindowsArg } from '../../../electron/platform/windows-command-line';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const project = path.join(tmpHome, "o'neil project");
const platformBefore = Object.getOwnPropertyDescriptor(process, 'platform')!;
const shellBefore = process.env.SHELL;
let settings: AppSettings = {} as AppSettings;

function pin(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformBefore, value: platform });
}

function deps(overrides: Record<string, unknown> = {}): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => settings,
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, null, vi.fn(), vi.fn()),
    ...overrides,
    isSuperAgent: () => false,
    getSuperAgentTelegramTask: () => false,
    getSuperAgentOutputBuffer: () => [],
    getMainWindow: () => null,
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.toLowerCase().endsWith('ptyprocesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The `agent:complete` events broadcast for a terminal. */
const completesOf = (ptyId: string) => vi.mocked(broadcastToAllWindows).mock.calls
  .filter(([channel, payload]) => channel === 'agent:complete' && (payload as { ptyId?: string }).ptyId === ptyId);
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const typed = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');
/** The value of PATH the child gets, under any spelling, and how many spellings it has. */
function pathOf(env: Record<string, string | undefined>): { value: string | undefined; keys: number } {
  const keys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
  return { value: keys.length ? env[keys[keys.length - 1]] : undefined, keys: keys.length };
}

/** PSModulePath in a terminal's env, under every spelling it has (a spread of process.env may upper-case it). */
const modulePathOf = (t: FakePty) => Object.entries(t.opts.env).filter(([k]) => k.toLowerCase() === 'psmodulepath').map(([, v]) => v);

async function createAgent(): Promise<AgentStatus> {
  const created = await handlers.get('agent:create')!({}, { projectPath: project, skills: [], name: 'Sites' }) as AgentStatus;
  return agents.get(created.id)!;
}

const TASK = 'the task';
/** The claude command a worker in `project` is started with from a window, default permission mode. */
const claudeCommand = (prompt: string) => `'claude' --permission-mode default --add-dir ${q(DATA_DIR)} -- ${q(prompt)}`;

beforeEach(() => {
  resetLaunches();
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  vi.mocked(broadcastToAllWindows).mockClear();
  children.calls.length = 0;
  children.out.clear();
  settings = {} as AppSettings;
  delete process.env.SHELL;
  registerIpcHandlers(deps());
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformBefore);
  if (shellBefore === undefined) delete process.env.SHELL; else process.env.SHELL = shellBefore;
});

afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

describe.each(['darwin', 'linux'] as const)('1. on %s, what each call site started before the port', (platform) => {
  const loginShell = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  beforeEach(() => pin(platform));

  it('agent:create opens /bin/bash -l in the agent\'s folder, on the full PATH', async () => {
    await createAgent();
    expect(spawned).toHaveLength(1);
    expect([spawned[0].file, spawned[0].args, spawned[0].opts.cwd]).toEqual(['/bin/bash', ['-l'], project]);
    expect(spawned[0].opts.env.PATH).toBe(POSIX_PATH);
  });

  it('agent:start types `cd \'<dir>\' && <cmd>` into that shell', async () => {
    const agent = await createAgent();
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(50);
    expect(spawned).toHaveLength(1);
    expect(typed(spawned[0])).toBe(`cd ${q(project)} && ${claudeCommand(TASK)}\r`);
  });

  it('the local switch reopens /bin/bash -l, then types the same line', async () => {
    const agent = await createAgent();
    agent.provider = 'local';
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(650);
    expect(spawned).toHaveLength(2);
    expect([spawned[1].file, spawned[1].args]).toEqual(['/bin/bash', ['-l']]);
    expect(spawned[1].opts.env.PATH).toBe(POSIX_PATH);
    expect(typed(spawned[1])).toBe(`cd ${q(project)} && 'claude' --permission-mode default --add-dir ${q(DATA_DIR)} -- ${q(TASK)}\r`);
  });

  it('8. the local switch\'s terminal, once replaced, exits without a completion; while named, with one', async () => {
    const agent = await createAgent();
    agent.provider = 'local';
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(650);
    const localId = agent.ptyId!;
    agent.status = 'running';
    agent.ptyId = 'the-terminal-a-restart-opened';
    spawned[1].exit(1);
    expect(completesOf(localId), 'a replaced terminal announced a completion').toEqual([]);
    expect(agent.status).toBe('running');

    agent.ptyId = localId;
    spawned[1].exit(0);
    expect(completesOf(localId)).toHaveLength(1);
    expect(agent.status).toBe('completed');
  });

  it('initAgentPty opens /bin/bash -l', async () => {
    const agent = { id: 'restored', name: 'R', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
    await initAgentPty(agent, null, vi.fn(), vi.fn());
    expect([spawned[0].file, spawned[0].args, spawned[0].opts.cwd]).toEqual(['/bin/bash', ['-l'], project]);
    expect(spawned[0].opts.env.PATH).toBe(POSIX_PATH);
  });

  it('a bot start types the same line into a fresh terminal', async () => {
    const agent = { id: 'bot-agent', name: 'Bot', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [], lastActivity: '', permissionMode: 'normal' } as unknown as AgentStatus;
    agents.set(agent.id, agent);
    const fleet: BotFleet = { agents, ptyProcesses, settings: () => settings, saveAgents: vi.fn(), initAgentPty: (a) => initAgentPty(a, null, vi.fn(), vi.fn()) };
    await startWithTask(fleet, agent, TASK, 'Telegram', { resume: false, reply: vi.fn() });
    expect(spawned).toHaveLength(1);
    expect(typed(spawned[0])).toBe(`cd ${q(project)} && ${claudeCommand(TASK)}\r`);
  });

  it('the API start runs `/bin/bash -l -c "cd \'<dir>\' && exec <cmd>"`', async () => {
    const { args, file, env } = await apiStart();
    expect(file).toBe('/bin/bash');
    expect(args).toEqual(['-l', '-c', `cd ${q(project)} && exec ${apiCommand()}`]);
    expect(env.PATH).toBe(POSIX_PATH);
  });

  it('pty:create, shell:startPty and createQuickPty open the login shell with -l', async () => {
    await handlers.get('pty:create')!({}, { cwd: project });
    await handlers.get('shell:startPty')!({}, { cwd: project });
    createQuickPty(project, 80, 24, null);
    expect(spawned.map(t => [t.file, t.args])).toEqual([[loginShell, ['-l']], [loginShell, ['-l']], [loginShell, ['-l']]]);
  });

  it('13. every terminal gets the parent\'s PSModulePath as it was', async () => {
    const before = process.env.PSModulePath;
    process.env.PSModulePath = PWSH7_MODULES;
    try {
      await createAgent();
      await handlers.get('pty:create')!({}, { cwd: project });
      await handlers.get('shell:startPty')!({}, { cwd: project });
      createQuickPty(project, 80, 24, null);
      expect(spawned.map(modulePathOf)).toEqual([[PWSH7_MODULES], [PWSH7_MODULES], [PWSH7_MODULES], [PWSH7_MODULES]]);
    } finally {
      if (before === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = before;
    }
  });

  it('a skill install spawns npx with its argv, on the full PATH', async () => {
    await handlers.get('skill:install-start')!({}, { repo: 'owner/repo/the-skill' });
    expect([spawned[0].file, spawned[0].args]).toEqual(['npx', ['skills', 'add', 'https://github.com/owner/repo', '--skill', 'the-skill']]);
    expect(spawned[0].opts.env.PATH).toBe(POSIX_PATH);
  });

  it('a plugin install runs the command through the shell', async () => {
    const command = 'claude plugin marketplace add owner/market && claude plugin install thing@market -y';
    await handlers.get('plugin:install-start')!({}, { command });
    await handlers.get('plugin:install-start')!({}, { command: '/plugin install thing@market' });
    const rcs = platform === 'darwin' ? ['--no-rcs'] : [];
    expect(spawned.map(t => [t.file, t.args])).toEqual([
      [loginShell, [...rcs, '-c', command]],
      [loginShell, [...rcs, '-c', 'claude "/plugin install thing@market"']],
    ]);
  });

  it('settings:getInfo, tasmania:getMcpStatus and shell:version give the same answers', async () => {
    children.out.set('claude --version 2>/dev/null', '2.1.300 (Claude Code)\n');
    children.out.set('claude --version', '2.1.300 (Claude Code)\n');
    children.out.set('claude mcp list', 'tasmania: node /x/index.js - connected\n');
    const info = await handlers.get('settings:getInfo')!({}) as { claudeVersion: string };
    const mcp = await handlers.get('tasmania:getMcpStatus')!({}) as { configured: boolean };
    const version = await handlers.get('shell:version')!({}, { binary: 'claude' }) as { success: boolean; output: string };
    expect(info.claudeVersion).toBe('2.1.300 (Claude Code)');
    expect(mcp.configured).toBe(true);
    expect(version).toEqual({ success: true, output: '2.1.300 (Claude Code)' });
    const probe = children.calls.find(c => c.file === 'claude' && c.args?.[0] === '--version' && c.fn === 'spawn');
    expect((probe!.options!.env as Record<string, string>).PATH).toBe(POSIX_PATH);
    expect((await handlers.get('shell:version')!({}, { binary: X86_CLAUDE }) as { success: boolean }).success).toBe(false);
  });
});

describe('2-6. on win32', () => {
  // The parent's PATH as Electron started from Explorer spells it, the same on every host.
  const envBefore = { ...process.env };
  beforeEach(() => {
    pin('win32');
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'SYSTEMROOT') delete process.env[key];
    process.env.Path = WIN_PATH;
    process.env.SystemRoot = 'C:\\Windows';
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  });
  const cliLine = (...args: string[]) => args.map(quoteWindowsArg).join(' ');

  it('2, 6. agent:create waits in the resolved shell with its own arguments, PATH under one key', async () => {
    await createAgent();
    expect([spawned[0].file, spawned[0].args, spawned[0].opts.cwd]).toEqual([WIN_POWERSHELL, ['-NoLogo'], project]);
    expect(pathOf(spawned[0].opts.env)).toEqual({ value: WIN_PATH, keys: 1 });
  });

  it('2. agent:start starts the CLI as the terminal\'s process, in the folder, and types nothing', async () => {
    const agent = await createAgent();
    const shell = spawned[0];
    const result = await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(50);
    expect(result).toMatchObject({ success: true });
    expect(typed(shell)).toBe('');
    expect(shell.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
    expect([spawned[1].file, spawned[1].args, spawned[1].opts.cwd])
      .toEqual([CLAUDE_EXE, cliLine('--permission-mode', 'default', '--add-dir', DATA_DIR, '--', TASK), project]);
    expect(ptyProcesses.get(agent.ptyId!)).toBe(spawned[1]);
    expect(pathOf(spawned[1].opts.env)).toEqual({ value: WIN_PATH, keys: 1 });
  });

  it('7. the CLI started from a window carries the agent\'s identity', async () => {
    const agent = await createAgent();
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    const env = spawned[1].opts.env;
    expect(env.CLAUDE_AGENT_ID).toBe(agent.id);
    expect(env.CLAUDE_PROJECT_PATH).toBe(project);
    expect(env.CLAUDE_PROVIDER).toBe('claude');
    expect(env.CLAUDE_MGR_API_URL).toBe(`http://127.0.0.1:${API_PORT}`);
    expect(agentForToken(env.CLAUDE_MGR_API_TOKEN), 'the token does not name the agent').toBe(agent.id);
  });

  it('8. the local switch\'s terminal, killed for the CLI, exits without a completion', async () => {
    const agent = await createAgent();
    agent.provider = 'local';
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(650);
    const localShell = spawned[1];
    expect(localShell.kill).toHaveBeenCalled();
    expect(agent.status).toBe('running');
    localShell.exit(1);
    const others = vi.mocked(broadcastToAllWindows).mock.calls
      .filter(([channel, payload]) => channel === 'agent:complete' && (payload as { ptyId?: string }).ptyId !== agent.ptyId);
    expect(others, 'the killed local shell announced a completion').toEqual([]);
    expect(agent.status).toBe('running');
  });

  it('10. a start from a window or a bot refuses a shell a hand-typed session registered from', async () => {
    const agent = await createAgent();
    const shell = spawned[0];
    agent.currentSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    agent.sessionPtyId = agent.ptyId;

    const result = await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK }) as { success: boolean; cliRunning?: boolean; error?: string };
    expect(result).toMatchObject({ success: false, cliRunning: true });
    expect(result.error).toMatch(/typed into its terminal by hand/);

    const fleet: BotFleet = { agents, ptyProcesses, settings: () => settings, saveAgents: vi.fn(), initAgentPty: (a) => initAgentPty(a, null, vi.fn(), vi.fn()) };
    await expect(startWithTask(fleet, agent, TASK, 'Telegram', { resume: false, reply: vi.fn() })).rejects.toThrow(/typed into its terminal by hand/);

    expect(shell.kill).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(agent.status).toBe('idle');
    expect(typed(shell)).toBe('');
  });

  it.each([
    ['a local model, whose start opens a terminal of its own', (agent: AgentStatus) => { agent.provider = 'local'; }],
    ['an agent moved to another folder, whose old terminal is replaced', (agent: AgentStatus) => {
      agent.worktreePath = path.join(project, 'moved');
      fs.mkdirSync(agent.worktreePath, { recursive: true });
    }],
  ])('10. the refusal comes before the shell is killed, for %s', async (_which, change) => {
    const agent = await createAgent();
    const shell = spawned[0];
    agent.currentSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    agent.sessionPtyId = agent.ptyId;
    change(agent);

    const result = await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK }) as { success: boolean; cliRunning?: boolean; error?: string };

    expect(result).toMatchObject({ success: false, cliRunning: true });
    expect(result.error).toMatch(/typed into its terminal by hand/);
    expect(shell.kill, 'the hand-typed session was ended').not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });

  it('11. a CLI whose terminal cannot be opened leaves the agent as it was, from a window', async () => {
    const agent = await createAgent();
    agent.status = 'completed';
    agent.currentTask = 'the task it finished';
    agent.savedPrompt = 'the prompt it had';
    handlers.clear();
    registerIpcHandlers(deps({ initAgentPty: async () => { throw new Error('ConPTY refused the spawn'); } }));

    await expect(handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK })).rejects.toThrow(/ConPTY refused the spawn/);

    expect(agent.status).toBe('completed');
    expect(agent.currentTask).toBe('the task it finished');
    expect(agent.savedPrompt).toBe('the prompt it had');
    expect(agent.pendingDelivery, 'a watch was armed for a CLI that never started').toBeUndefined();
    const last = vi.mocked(broadcastToAllWindows).mock.calls.filter(([channel]) => channel === 'agent:status').at(-1);
    expect(last?.[1], 'the windows were left showing it running').toMatchObject({ agentId: agent.id, status: 'completed' });
  });

  it('11. a CLI whose terminal cannot be opened leaves the agent as it was, from a bot', async () => {
    const agent = { id: 'bot-agent', name: 'Bot', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [], lastActivity: '', permissionMode: 'normal', currentTask: 'what it did last' } as unknown as AgentStatus;
    agents.set(agent.id, agent);
    let opened = 0;
    const fleet: BotFleet = {
      agents, ptyProcesses, settings: () => settings, saveAgents: vi.fn(),
      // The shell opens; the CLI's terminal then does not.
      initAgentPty: async (a) => {
        if (opened++ === 0) return initAgentPty(a, null, vi.fn(), vi.fn());
        throw new Error('another terminal was being opened for this agent');
      },
    };
    const reply = vi.fn();

    await expect(startWithTask(fleet, agent, TASK, 'Telegram', { resume: false, reply })).rejects.toThrow(/another terminal/);

    expect(reply).not.toHaveBeenCalledWith('started');
    expect(agent.status).toBe('idle');
    expect(agent.currentTask).toBe('what it did last');
    expect(agent.pendingDelivery).toBeUndefined();
  });

  it('9. a CLI the API cannot start leaves the previous terminal and its session as they were', async () => {
    const run = await apiCall({ ptyId: 'pty-previous', currentSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cliPath: 'C:\\nowhere\\claude.exe' }, () => {
      const terminal = { kill: vi.fn(), write: vi.fn() };
      ptyProcesses.set('pty-previous', terminal as never);
      return terminal;
    });
    expect(run.answers[0].status).toBe(400);
    expect(JSON.stringify(run.answers[0].body)).toMatch(/Cannot start/);
    expect(run.extra.kill).not.toHaveBeenCalled();
    expect(ptyProcesses.has('pty-previous')).toBe(true);
    expect(run.agent.ptyId).toBe('pty-previous');
    expect(run.agent.currentSessionId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(run.agent.lastKilledSessionId).toBeUndefined();
    expect(run.agent.status).toBe('idle');
  });

  it('2. the local switch ends on the CLI too, with its Tasmania env', async () => {
    const agent = await createAgent();
    agent.provider = 'local';
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(650);
    const cli = spawned.at(-1)!;
    expect(cli.file).toBe(CLAUDE_EXE);
    expect(cli.opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8123');
    expect(spawned.every(t => typed(t) === '')).toBe(true);
  });

  it('2. a bot start launches the CLI instead of typing', async () => {
    const agent = { id: 'bot-agent', name: 'Bot', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [], lastActivity: '', permissionMode: 'normal' } as unknown as AgentStatus;
    agents.set(agent.id, agent);
    const fleet: BotFleet = { agents, ptyProcesses, settings: () => settings, saveAgents: vi.fn(), initAgentPty: (a) => initAgentPty(a, null, vi.fn(), vi.fn()) };
    const reply = vi.fn();
    await startWithTask(fleet, agent, TASK, 'Telegram', { resume: false, reply });
    expect(reply).toHaveBeenCalledWith('started');
    expect(spawned.every(t => typed(t) === '')).toBe(true);
    const cli = spawned.at(-1)!;
    expect([cli.file, cli.args, cli.opts.cwd]).toEqual([CLAUDE_EXE, cliLine('--permission-mode', 'default', '--add-dir', DATA_DIR, '--', TASK), project]);
    expect(ptyProcesses.get(agent.ptyId!)).toBe(cli);
  });

  it('2, 6. the API start spawns the CLI itself', async () => {
    const { args, file, env, cwd } = await apiStart();
    expect(file).toBe(CLAUDE_EXE);
    expect(typeof args).toBe('string');
    expect(args).not.toMatch(/\bcd\b|\bexec\b/);
    expect(cwd).toBe(project);
    expect(pathOf(env)).toEqual({ value: WIN_PATH, keys: 1 });
  });

  it('3. pty:create and shell:startPty open the resolved shell, the setting first, and createQuickPty the default', async () => {
    await handlers.get('pty:create')!({}, { cwd: project });
    settings = { terminalShell: 'C:\\Program Files\\Git\\bin\\bash.exe' } as AppSettings;
    await handlers.get('shell:startPty')!({}, { cwd: project });
    createQuickPty(project, 80, 24, null);
    expect(spawned.map(t => [t.file, t.args])).toEqual([
      [WIN_POWERSHELL, ['-NoLogo']],
      ['C:\\Program Files\\Git\\bin\\bash.exe', ['-l']],
      [WIN_POWERSHELL, ['-NoLogo']],
    ]);
  });

  it('12. a terminal in Windows PowerShell gets no PSModulePath; pwsh, Git Bash and a CLI keep the parent\'s', async () => {
    for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'psmodulepath') delete process.env[key];
    process.env.PSModulePath = PWSH7_MODULES;
    const agent = await createAgent();
    await handlers.get('pty:create')!({}, { cwd: project });
    createQuickPty(project, 80, 24, null);
    settings = { terminalShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' } as AppSettings;
    await handlers.get('shell:startPty')!({}, { cwd: project });
    settings = { terminalShell: 'C:\\Program Files\\Git\\bin\\bash.exe' } as AppSettings;
    await handlers.get('pty:create')!({}, { cwd: project });
    await handlers.get('agent:start')!({}, { id: agent.id, prompt: TASK });
    await pause(50);
    expect(spawned.map(t => [path.win32.basename(t.file), modulePathOf(t)])).toEqual([
      ['powershell.exe', []],
      ['powershell.exe', []],
      ['powershell.exe', []],
      ['pwsh.exe', [PWSH7_MODULES]],
      ['bash.exe', [PWSH7_MODULES]],
      ['claude.exe', [PWSH7_MODULES]],
    ]);
  });

  it('4, 6. a skill install starts node with npx-cli.js, an argv and no shell', async () => {
    await handlers.get('skill:install-start')!({}, { repo: 'owner/repo/the-skill' });
    expect([spawned[0].file, spawned[0].args])
      .toEqual([NODE_EXE, `"${NPX_CLI}" skills add https://github.com/owner/repo --skill the-skill`]);
    expect(pathOf(spawned[0].opts.env)).toEqual({ value: WIN_PATH, keys: 1 });
  });

  it('4. a two-step plugin install runs each step directly, the second only after the first succeeded', async () => {
    const command = 'claude plugin marketplace add owner/market && claude plugin install thing@market -y';
    await handlers.get('plugin:install-start')!({}, { command });
    expect([spawned[0].file, spawned[0].args]).toEqual([CLAUDE_EXE, 'plugin marketplace add owner/market']);
    spawned[0].exit(0);
    expect([spawned[1].file, spawned[1].args]).toEqual([CLAUDE_EXE, 'plugin install thing@market -y']);

    await handlers.get('plugin:install-start')!({}, { command });
    spawned[2].exit(1);
    expect(spawned).toHaveLength(3);

    await handlers.get('plugin:install-start')!({}, { command: '/plugin install thing@market' });
    expect([spawned[3].file, spawned[3].args]).toEqual([CLAUDE_EXE, '"/plugin install thing@market"']);
  });

  it('4. a next step that cannot be started ends the install there, and throws nothing out of the exit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const command = 'claude plugin marketplace add owner/market && claude plugin install thing@market -y';
    const { id } = await handlers.get('plugin:install-start')!({}, { command }) as { id: string };
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('ConPTY refused the spawn'); });

    expect(() => spawned[0].exit(0)).not.toThrow();

    expect(spawned).toHaveLength(1);
    expect(warn.mock.calls.map(c => c.map(String).join(' ')).join('\n')).toMatch(/not started.*ConPTY refused the spawn/s);
    // The install's terminal is gone: nothing is left for plugin:install-kill to end.
    expect(await handlers.get('plugin:install-kill')!({}, { id })).toMatchObject({ success: false });
  });

  it('5. the version probes start the resolved binary by argv, parentheses in its path accepted', async () => {
    children.out.set(`${CLAUDE_EXE} --version`, '2.1.300 (Claude Code)\n');
    children.out.set(`${X86_CLAUDE} --version`, '2.1.301 (Claude Code)\n');
    children.out.set(`${CLAUDE_EXE} mcp list`, 'tasmania: connected\n');
    const info = await handlers.get('settings:getInfo')!({}) as { claudeVersion: string };
    const mcp = await handlers.get('tasmania:getMcpStatus')!({}) as { configured: boolean };
    const version = await handlers.get('shell:version')!({}, { binary: X86_CLAUDE }) as { success: boolean; output: string };
    expect(info.claudeVersion).toBe('2.1.300 (Claude Code)');
    expect(mcp.configured).toBe(true);
    expect(version).toEqual({ success: true, output: '2.1.301 (Claude Code)' });
    expect(children.calls.filter(c => c.fn === 'exec' || c.fn === 'execSync')).toEqual([]);
    expect(children.calls.filter(c => c.fn === 'spawn').map(c => [c.file, c.args, c.options?.shell])).toEqual([
      [CLAUDE_EXE, ['--version'], undefined],
      [X86_CLAUDE, ['--version'], undefined],
    ]);
    // None opens a console window: Tars is a GUI program, claude a console one.
    const started = children.calls.filter(c => c.fn === 'spawn' || c.args?.join(' ') === 'mcp list');
    expect(started).toHaveLength(3);
    for (const call of started) expect(call.options, `${call.file} ${call.args?.join(' ')}`).toMatchObject({ windowsHide: true });
  });
});

// ── The API path ─────────────────────────────────────────────────────

const ctx: RouteContext = {
  mainWindow: null,
  appSettings: {} as AppSettings,
  getAppSettings: () => settings,
  getTelegramBot: () => null,
  getSlackApp: () => null,
  slackResponseChannel: null,
  slackResponseThreadTs: null,
  handleStatusChangeNotificationCallback: vi.fn(),
  sendNotificationCallback: vi.fn(),
  initAgentPtyCallback: vi.fn(async () => 'unused'),
  agentStatusEmitter: new EventEmitter(),
};

const API_AGENT = { id: 'api-agent', name: 'Api' };
const API_PROMPT = 'from the api';
function apiCommand(): string {
  const header = `[Tars: you are agent "${API_AGENT.name}" (id ${API_AGENT.id}), worker of project ${project}. `
    + 'Work autonomously without asking for confirmation and end with a clear report of your results: an orchestrator reads your final message.]';
  return `'claude' --permission-mode default --add-dir ${q(DATA_DIR)} -- ${q(`${header}\n\n${API_PROMPT}`)}`;
}

async function apiStart(): Promise<{ file: string; args: string[] | string; env: Record<string, string>; cwd: string }> {
  const { answers } = await apiCall({}, () => undefined);
  expect(answers[0]?.status ?? 200, JSON.stringify(answers[0]?.body)).toBe(200);
  const terminal = spawned.at(-1)!;
  return { file: terminal.file, args: terminal.args, env: terminal.opts.env, cwd: terminal.opts.cwd };
}

/** POST /api/agents/api-agent/start from itself, the agent given `fields`; `before` runs once it exists. */
async function apiCall<T>(fields: Partial<AgentStatus>, before: (agent: AgentStatus) => T): Promise<{
  answers: Array<{ body: unknown; status?: number }>; agent: AgentStatus; extra: T;
}> {
  const agent = {
    ...API_AGENT, status: 'idle', projectPath: project, skills: [], output: [], role: 'worker',
    lastActivity: new Date().toISOString(), provider: 'claude', permissionMode: 'normal', ...fields,
  } as AgentStatus;
  agents.set(API_AGENT.id, agent);
  const extra = before(agent);
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(app, ctx);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern).includes('\\/start'))!;
  const req = {
    method: 'POST', pathname: `/api/agents/${API_AGENT.id}/start`, url: new URL('http://localhost/'),
    body: { prompt: API_PROMPT }, raw: {} as never, res: {} as never,
    params: { id: API_AGENT.id }, callerAgentId: API_AGENT.id,
  } as unknown as RouteRequest;
  const answers: Array<{ body: unknown; status?: number }> = [];
  await route.handler(req, (body, status) => { answers.push({ body, status }); });
  return { answers, agent, extra };
}
