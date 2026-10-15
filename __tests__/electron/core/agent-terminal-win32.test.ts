import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An agent's terminal, and the CLI started in it on Windows (decisions D2 and
 * D3; audit A1, A4, A6; B/A-01).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. The terminal an agent waits in is `/bin/bash -l` on win32, which ConPTY
 *    cannot start: no agent is created or restored there (A1, B/A-01).
 * 2. On win32 that terminal passes `-l` to PowerShell or ignores the user's
 *    terminalShell setting; or darwin/linux stop getting `/bin/bash -l`.
 * 3. node-pty on Windows answers the terminal's name when asked what runs in
 *    it ('xterm-256color', measured by audit A6): an agent's idle shell reads
 *    as a running CLI, so a bot types its task into PowerShell as a message
 *    and agent:get reports cliRunning.
 * 4. A CLI started as the terminal's own process does not read as running,
 *    because runsCommand is inferred from a `-c` a direct launch never has; or
 *    it still reads so once it has exited.
 * 5. spawnAgentPty re-splits or re-quotes the command line toLaunch built, or
 *    starts another file than the launch names.
 * 6. Starting the CLI on win32 types into the shell (A4) instead of replacing
 *    it; the CLI gets another file, command line, cwd or env than the launch
 *    (its identity CLAUDE_AGENT_ID, a token of its own); the shell is left
 *    running beside it; the shell's exit is taken for the agent's own (the
 *    agent still names it when it is killed); or the start reports a CLI when
 *    initAgentPty handed back another terminal than the CLI's.
 */

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

const spawned: FakePty[] = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[] | string, opts: FakePty['opts']) => {
    const exits: ExitListener[] = [];
    const terminal: FakePty = {
      file, args, opts, pid: 7000 + spawned.length,
      // What node-pty on Windows answers whatever runs in the terminal: the
      // name it was given (lib/windowsTerminal.js, `get process`; audit A6).
      process: opts.name,
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose() {} })),
      onExit: vi.fn((listener: ExitListener) => { exits.push(listener); return { dispose() {} }; }),
      exit: (exitCode) => { for (const listener of exits) listener({ exitCode, signal: 0 }); },
    };
    spawned.push(terminal);
    return terminal;
  }),
}));
let uuid = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `uuid-${++uuid}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { initAgentPty, agents, startCliInTerminal } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { spawnAgentPty, cliRunningIn, agentShell } from '../../../electron/core/agent-pty';
import { agentForToken } from '../../../electron/core/agent-tokens';
import { toLaunch, type DirectLaunch } from '../../../electron/platform/launch';
import type { FsProbe } from '../../../electron/platform/fs-probe';
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-terminal-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-terminal-project-'));
let restoreHome: () => void;

/** A read-only Windows disk: case-insensitive, backslash paths. */
function fakeWinFs(files: string[]): FsProbe {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    isFile: (p) => set.has(p.toLowerCase()),
    readFile: (p) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); },
  };
}
const noFs: FsProbe = {
  isFile: () => { throw new Error('darwin/linux must not touch the disk'); },
  readFile: () => { throw new Error('darwin/linux must not touch the disk'); },
};

const PWSH_DIR = 'C:\\Program Files\\PowerShell\\7';
const PWSH = `${PWSH_DIR}\\pwsh.exe`;
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CLI_DIR = 'C:\\Users\\Sam Lee\\.local\\bin';
const CLAUDE_EXE = `${CLI_DIR}\\claude.exe`;

beforeEach(() => {
  spawned.length = 0;
  agents.clear();
  ptyProcesses.clear();
  restoreHome = moveTestHome(home);
});

afterEach(() => {
  restoreHome();
});

describe('the shell an agent terminal waits in', () => {
  it('1, 2. /bin/bash -l on darwin and linux, whatever the setting', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(agentShell({ platform, fs: noFs })).toEqual({ shell: '/bin/bash', args: ['-l'] });
      expect(agentShell({ platform, setting: GIT_BASH, fs: noFs })).toEqual({ shell: '/bin/bash', args: ['-l'] });
    }
  });

  it('1, 2. on win32 the shell the platform resolves, with its own arguments, the setting first', () => {
    const env = { Path: PWSH_DIR };
    const disk = fakeWinFs([PWSH, GIT_BASH]);

    expect(agentShell({ platform: 'win32', env, fs: disk })).toEqual({ shell: PWSH, args: ['-NoLogo'] });
    expect(agentShell({ platform: 'win32', env, fs: disk, setting: GIT_BASH })).toEqual({ shell: GIT_BASH, args: ['-l'] });
  });
});

describe('whether a CLI runs in an agent terminal, on Windows', () => {
  it('3. a shell waiting at its prompt is not a CLI, though node-pty names something', () => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: PWSH, args: ['-NoLogo'], runsCommand: false,
      cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: 'agent-idle' },
    }) as unknown as FakePty;

    expect(terminal.process, 'the fake answers as node-pty on Windows does').toBe('xterm-256color');
    expect(cliRunningIn(terminal as never, 'win32')).toBe(false);
  });

  it('4. the CLI started as the terminal\'s process is, for as long as it lives', () => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: CLAUDE_EXE, args: '--model opus -- "fix it"', runsCommand: true,
      cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: 'agent-direct' },
    }) as unknown as FakePty;

    expect(cliRunningIn(terminal as never, 'win32')).toBe(true);
    terminal.exit(0);
    expect(cliRunningIn(terminal as never, 'win32')).toBe(false);
  });

  it('4. what the caller says it runs decides, not a `-c` among its arguments', () => {
    // As node-pty on Linux names a terminal whose leader is still the shell:
    // before, this read as a bare shell because no `-c` was among the args.
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['--login'], runsCommand: true,
      cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: 'agent-told' },
    }) as unknown as FakePty;
    terminal.process = 'bash';

    expect(cliRunningIn(terminal as never, 'linux')).toBe(true);
  });

  it('5. hands node-pty the file and the command line as the launch built them', () => {
    const commandLine = '--model opus -- "line one\nline \\"two\\""';
    spawnAgentPty({
      binaryName: 'claude', shell: CLAUDE_EXE, args: commandLine, runsCommand: true,
      cwd: project, cols: 80, rows: 24, env: {},
    });

    expect(spawned[0].file).toBe(CLAUDE_EXE);
    expect(spawned[0].args).toBe(commandLine);
  });
});

describe('the CLI started in place of the shell (win32)', () => {
  function idleAgent(): AgentStatus {
    const agent = {
      id: 'agent-on-windows', name: 'On Windows', status: 'idle', provider: 'claude',
      projectPath: project, skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus;
    agents.set(agent.id, agent);
    return agent;
  }

  function launchFor(agent: AgentStatus): DirectLaunch {
    const prompt = "line one\n'; New-Item x\n& calc";
    const env = { Path: CLI_DIR, CLAUDE_AGENT_ID: agent.id, CLAUDE_PROJECT_PATH: agent.projectPath };
    const command = `'claude' --permission-mode default -- '${prompt.replace(/'/g, "'\\''")}'`;
    return toLaunch(command, project, env, 'win32', { fs: fakeWinFs([CLAUDE_EXE]) }) as DirectLaunch;
  }

  it('6. replaces the shell with the CLI: its file, line, cwd and env, and nothing typed', async () => {
    const agent = idleAgent();
    const notify = vi.fn();
    const open = (a: AgentStatus) => initAgentPty(a, null, notify, vi.fn());
    agent.ptyId = await open(agent);
    const shell = spawned[0];
    const shellId = agent.ptyId;
    let namedAtKill: string | undefined = 'not killed';
    shell.kill.mockImplementation(() => { namedAtKill = agent.ptyId; });
    const launch = launchFor(agent);

    const cli = await startCliInTerminal(agent, launch, { ptyProcesses, initAgentPty: open }) as unknown as FakePty;

    expect(spawned).toHaveLength(2);
    expect(cli).toBe(spawned[1]);
    expect(cli.file).toBe(CLAUDE_EXE);
    expect(cli.args).toBe(launch.commandLine);
    expect(cli.opts.cwd).toBe(project);
    expect(cli.opts.env.Path).toBe(CLI_DIR);
    expect(cli.opts.env.CLAUDE_AGENT_ID).toBe(agent.id);
    expect(agentForToken(cli.opts.env.CLAUDE_MGR_API_TOKEN)).toBe(agent.id);
    expect(shell.write, 'nothing is typed into the shell').not.toHaveBeenCalled();
    expect(shell.kill).toHaveBeenCalledTimes(1);
    expect(namedAtKill, 'the agent no longer names the shell when it is killed').toBeUndefined();
    expect(agent.ptyId).not.toBe(shellId);
    expect(ptyProcesses.get(agent.ptyId!)).toBe(cli);
    expect(ptyProcesses.has(shellId!)).toBe(false);
    expect(cliRunningIn(cli as never, 'win32')).toBe(true);

    // The shell's exit arrives after: it is the terminal replaced, not the agent stopping.
    shell.exit(1);
    expect(agent.status).toBe('idle');
    expect(notify).not.toHaveBeenCalled();
    expect(ptyProcesses.get(agent.ptyId!)).toBe(cli);
  });

  it('6. starts one when the agent had no terminal at all', async () => {
    const agent = idleAgent();
    const open = (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn());

    const cli = await startCliInTerminal(agent, launchFor(agent), { ptyProcesses, initAgentPty: open }) as unknown as FakePty;

    expect(spawned).toHaveLength(1);
    expect(cli.file).toBe(CLAUDE_EXE);
    expect(ptyProcesses.get(agent.ptyId!)).toBe(cli);
  });

  it('6. refuses to report a CLI when initAgentPty handed back another terminal', async () => {
    const agent = idleAgent();
    const other = spawnAgentPty({
      binaryName: 'claude', shell: PWSH, args: ['-NoLogo'], runsCommand: false,
      cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: agent.id },
    });
    ptyProcesses.set('in-flight', other);
    // What a second caller gets while a first one is opening the terminal.
    const inFlight = vi.fn(async () => 'in-flight');

    await expect(startCliInTerminal(agent, launchFor(agent), { ptyProcesses, initAgentPty: inFlight }))
      .rejects.toThrow(/CLI was not started/);
  });
});
