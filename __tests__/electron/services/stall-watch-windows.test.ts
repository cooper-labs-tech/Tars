import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const run = vi.hoisted(() => ({ files: [] as string[], ps: '', table: '' }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  // Windows has no ps; PowerShell's answer is the table handed in.
  const execFile = (file: string, _args: string[], _options: unknown, done: (err: Error | null, stdout: string) => void) => {
    run.files.push(file);
    const missing = () => Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    setImmediate(() => {
      if (file === 'ps') return process.platform === 'win32' ? done(missing(), '') : done(null, run.ps);
      if (/\\powershell\.exe$/i.test(file) && process.platform === 'win32') return done(null, run.table);
      return done(missing(), '');
    });
  };
  return { ...actual, execFile, default: { ...actual, execFile } };
});

import { readProcesses, cliProcess, stallOf, STALL_AFTER_MS, type Proc } from '../../../electron/services/stall-watch';
import { sleepRefusal, type SleepFacts } from '../../../electron/services/agent-sleep';

/**
 * The sleep and the stall passes on Windows (the parity program's P7, R3).
 *
 * Both read the process table: which process is an agent's CLI, and what
 * lives under it. macOS and Linux read it with ps. Windows has none, so both
 * passes read nothing there, and no agent was put to sleep or seen stalled.
 * The reader itself is platform/windows-processes.test.ts; the splitting of a
 * Windows command line, platform/windows-command-line.test.ts.
 *
 * On Windows an agent's CLI is its terminal's own process (core/agent-manager.ts,
 * startCliInTerminal), or the child of the PowerShell its terminal waits in
 * when the user typed it there; npm's shim is read through to
 * `node.exe <...>\@anthropic-ai\claude-code\cli.js` (platform/cli-binary.ts).
 *
 * How it fails, written before the code (2026-10-17):
 * 1. On win32, ps is run, there is none, and nothing is read; or darwin and
 *    linux stop reading ps.
 * 2. On win32, claude is not found in a Windows command line: its path quoted
 *    for a space, `claude.exe` in any case, Node running Claude Code's npm
 *    script, or a script named claude as a stand-in is.
 * 3. On win32, something else is taken for claude: claude-helper.exe, another
 *    package's cli.js, node running nothing, a folder named claude.
 * 4. A frozen claude.exe with only its MCP servers under it is not seen
 *    stalled, or one with a Git Bash tool at work is.
 * 5. An idle claude.exe is kept awake by its MCP servers, or put to sleep with
 *    a dev server running under it.
 */

const NOW = Date.UTC(2026, 9, 17, 4, 0, 0);
const TARS = 3100;
const TERMINAL = 4012;
const TARS_EXE = 'C:\\Users\\Sam Lee\\AppData\\Local\\Programs\\tars\\Tars.exe';
const NATIVE = '"C:\\Users\\Sam Lee\\.local\\bin\\claude.exe" --dangerously-skip-permissions --resume 1f2e';
const NPM = '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume 1f2e';

const w = (pid: number, ppid: number, command: string, age = 3600): Proc => ({ pid, ppid, age, command });

/** An agent's terminal on Windows: the CLI is its process, its MCP servers under it. */
function windowsTerminal(cli: string, extra: Proc[] = []): Proc[] {
  return [
    w(TARS, 1, `"${TARS_EXE}"`, 7200),
    w(TERMINAL, TARS, cli),
    w(4100, TERMINAL, `"${TARS_EXE}" "C:\\Users\\Sam Lee\\AppData\\Local\\Programs\\tars\\resources\\mcp-orchestrator\\dist\\bundle.js"`),
    w(4104, TERMINAL, 'C:\\Windows\\system32\\cmd.exe /d /s /c "npx -y @sentry/mcp-server"'),
    ...extra,
  ];
}

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const readAs = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...hostPlatform, value: platform });

beforeEach(() => {
  run.files.length = 0;
  run.ps = '';
  run.table = '';
});
afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform); });

describe('reading the table', () => {
  it('1. reads Windows itself on win32', async () => {
    readAs('win32');
    run.table = JSON.stringify([{ p: TERMINAL, pp: TARS, a: 60_000, c: NATIVE }]);
    expect(await readProcesses()).toEqual([{ pid: TERMINAL, ppid: TARS, age: 60, command: NATIVE }]);
  });

  it.each(['darwin', 'linux'] as const)('1. reads ps on %s, and nothing else', async (platform) => {
    readAs(platform);
    run.ps = '  101   100 S+    01:00 /Users/x/.local/bin/claude --resume 1f2e\n';
    expect(await readProcesses()).toEqual([{ pid: 101, ppid: 100, stat: 'S+', age: 60, command: '/Users/x/.local/bin/claude --resume 1f2e' }]);
    expect(run.files).toEqual(['ps']);
  });
});

describe('the CLI in a Windows command line', () => {
  it.each([
    NATIVE,
    NPM,
    'C:\\Users\\sam\\.local\\bin\\CLAUDE.EXE --resume 1f2e',
    'claude --resume 1f2e',
    'node.exe "C:\\stand in\\claude.js" --resume 1f2e',
  ])('2. finds claude in %s', (cli) => {
    readAs('win32');
    expect(cliProcess(TERMINAL, windowsTerminal(cli))?.pid).toBe(TERMINAL);
  });

  it('2. finds it under the PowerShell the user typed it into', () => {
    readAs('win32');
    const shell = w(4000, TARS, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo');
    const tree = windowsTerminal(NATIVE).map((p) => (p.pid === TERMINAL ? { ...p, ppid: shell.pid } : p));
    expect(cliProcess(shell.pid, [shell, ...tree])?.pid).toBe(TERMINAL);
  });

  it.each([
    'C:\\tools\\claude-helper.exe --resume 1f2e',
    '"C:\\Program Files\\nodejs\\node.exe" C:\\tools\\node_modules\\some-cli\\cli.js',
    'node.exe',
    '"C:\\claude\\bin\\other.exe" claude',
    'C:\\Users\\sam\\claude\\run.exe',
  ])('3. takes nothing else for claude: %s', (cli) => {
    readAs('win32');
    expect(cliProcess(TERMINAL, windowsTerminal(cli))).toBeUndefined();
  });
});

describe('judged on a Windows table', () => {
  it('4. sees a frozen claude.exe stalled, and not one with a Git Bash tool at work', () => {
    readAs('win32');
    const silentSince = NOW - STALL_AFTER_MS - 60_000;
    const input = { status: 'running', provider: 'claude', transcriptWrittenAt: silentSince, terminalPid: TERMINAL, now: NOW };
    expect(stallOf({ ...input, procs: windowsTerminal(NATIVE) })).toBe(silentSince);
    const bash = w(4200, TERMINAL, '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm run build"', 60);
    expect(stallOf({ ...input, procs: windowsTerminal(NATIVE, [bash]) })).toBeUndefined();
  });

  it('5. puts an idle claude.exe to sleep past its MCP servers, and keeps one with a dev server awake', () => {
    readAs('win32');
    const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
    const facts = (procs: Proc[]): SleepFacts => ({
      agent: { status: 'idle', statusSince: ago(40), lastTurnStartedAt: ago(42), workHandedAt: ago(43) },
      orchestrator: false, now: NOW, cliRunning: true, starting: false, resumable: true,
      owed: false, owes: false, pending: false, fieldInUse: false, procs, terminalPid: TERMINAL,
    });
    expect(sleepRefusal(facts(windowsTerminal(NATIVE)))).toBeNull();
    expect(sleepRefusal(facts(windowsTerminal(NPM)))).toBeNull();
    const devServer = w(4300, TERMINAL, 'C:\\Windows\\system32\\cmd.exe /d /s /c "npm run dev"', 600);
    expect(sleepRefusal(facts(windowsTerminal(NATIVE, [devServer])))).toBe('busy');
  });
});
