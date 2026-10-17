import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.hoisted(() => ({ calls: [] as { file: string; args: string[]; options: Record<string, unknown> }[], answer: { err: null as Error | null, stdout: '' } }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = (file: string, args: string[], options: Record<string, unknown>, done: (err: Error | null, stdout: string) => void) => {
    run.calls.push({ file, args, options });
    setImmediate(() => done(run.answer.err, run.answer.stdout));
  };
  return { ...actual, execFile, default: { ...actual, execFile } };
});

import { windowsProcessListCommand, parseWindowsProcessList, readWindowsProcesses } from '../../../electron/platform/windows-processes';

/**
 * The process list on Windows, read from Windows itself: what `ps -A -o
 * pid=,ppid=,stat=,etime=,command=` gives the sleep and stall passes on macOS
 * and Linux (services/stall-watch.ts). Windows has no ps, so both passes read
 * nothing there: no idle agent was put to sleep and no frozen one marked
 * stalled (the parity program's P7, R3 of the audit).
 *
 * How it fails, written before the code (2026-10-17):
 * 1. A powershell.exe the PATH finds is started, or one found against the
 *    working directory (a relative SystemRoot): only the one under a plain
 *    absolute %SystemRoot%, else C:\Windows.
 * 2. It loads a profile or waits on input, or inherits a PSModulePath of
 *    PowerShell 7's, under which Windows PowerShell cannot load its own
 *    modules (child-env.ts).
 * 3. A console window opens at every read (powershell.exe is a console
 *    program, Tars a window one), or a read that hangs holds the pass for
 *    good.
 * 4. A command line with a character outside the console's code page (an
 *    accent in a user's folder) comes back mangled: the output is not UTF-8;
 *    or the byte-order mark UTF-8 output may open with makes the whole list
 *    unreadable.
 * 5. A row is misread: the command loses its spaces or its quotes, a process
 *    with no command line (a system one) is dropped where its name would do,
 *    one with no creation date is dropped where only its age is unknown.
 * 6. One process only: ConvertTo-Json gives an object, not a list, and it is
 *    taken for nothing.
 * 7. What is not the list (an error on stdout, a row without a numeric id) is
 *    read as processes, or a read that failed is taken for an empty table,
 *    where every agent would look idle, rather than for no table.
 * 8. Windows never reparents: a process keeps the id of the one that started
 *    it after that one ends, and the id goes to whatever starts next. A
 *    process older than the one now holding that id is taken for its child:
 *    a stranger left by a dead process whose id an agent's CLI now has would
 *    read as a tool at work under it, and the agent would never sleep nor be
 *    seen stalled.
 */

beforeEach(() => {
  run.calls.length = 0;
  run.answer = { err: null, stdout: '' };
});

describe('the command that lists the processes', () => {
  it('1, 2. is the PowerShell under %SystemRoot%, without a profile, input or PowerShell 7\'s module path', () => {
    const { file, args, options } = windowsProcessListCommand({ SystemRoot: 'D:\\Win', PSModulePath: 'C:\\pwsh7\\Modules', Path: 'C:\\tools' });
    expect(file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive']);
    expect(Object.keys(options.env).map((k) => k.toLowerCase())).not.toContain('psmodulepath');
    expect(options.env.Path).toBe('C:\\tools');
  });

  it('1. falls back to C:\\Windows when SystemRoot is missing or not a plain absolute path', () => {
    for (const SystemRoot of [undefined, 'Windows', '.\\Win', 'C:Win']) {
      expect(windowsProcessListCommand({ SystemRoot }).file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    }
  });

  it('3. opens no console window, and gives up after a bound', () => {
    const { options } = windowsProcessListCommand({});
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(30_000);
  });

  it('4. asks for UTF-8 and reads Win32_Process: id, parent, age and command line, or the name', () => {
    const script = windowsProcessListCommand({}).args.join(' ');
    expect(script).toMatch(/\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/);
    expect(script).toMatch(/Get-CimInstance Win32_Process/);
    for (const field of ['ProcessId', 'ParentProcessId', 'CreationDate', 'CommandLine', 'Name']) expect(script).toContain(field);
    expect(script).toMatch(/ConvertTo-Json/);
  });
});

describe('reading what it prints', () => {
  it('5. keeps each command whole, its name when it has no command line, and its age when it has one', () => {
    const out = JSON.stringify([
      { p: 4012, pp: 3100, a: 75_400, c: '"C:\\Users\\Sam Lee\\.local\\bin\\claude.exe" --resume abc' },
      { p: 4, pp: 0, a: null, c: 'System' },
      { p: 5120, pp: 4012, a: 3_000, c: 'C:\\Windows\\System32\\cmd.exe /c "npm test"' },
      { p: 5200, pp: 4012, a: 2_999, c: 'node.exe C:\\Users\\Andrés\\proj\\run.js' },
    ]);
    expect(parseWindowsProcessList(out)).toEqual([
      { pid: 4012, ppid: 3100, age: 75, command: '"C:\\Users\\Sam Lee\\.local\\bin\\claude.exe" --resume abc' },
      { pid: 4, ppid: 0, age: undefined, command: 'System' },
      { pid: 5120, ppid: 4012, age: 3, command: 'C:\\Windows\\System32\\cmd.exe /c "npm test"' },
      { pid: 5200, ppid: 4012, age: 2, command: 'node.exe C:\\Users\\Andrés\\proj\\run.js' },
    ]);
  });

  it('4. reads a list that opens with a byte-order mark', () => {
    expect(parseWindowsProcessList(`\uFEFF${JSON.stringify([{ p: 9, pp: 1, a: 4_000, c: 'x.exe' }])}`)).toEqual([{ pid: 9, ppid: 1, age: 4, command: 'x.exe' }]);
  });

  it('6. reads one process given as an object', () => {
    expect(parseWindowsProcessList(JSON.stringify({ p: 9, pp: 1, a: 4_000, c: 'x.exe' }))).toEqual([{ pid: 9, ppid: 1, age: 4, command: 'x.exe' }]);
  });

  it('7. takes what is not the list for nothing, and drops a row without a numeric id', () => {
    expect(parseWindowsProcessList('Get-CimInstance : Access denied')).toBeUndefined();
    expect(parseWindowsProcessList('')).toBeUndefined();
    expect(parseWindowsProcessList(JSON.stringify([{ p: 'x', pp: 1, a: 1, c: 'a' }, { p: 7, pp: 1, a: 1_000, c: 'b' }, null])))
      .toEqual([{ pid: 7, ppid: 1, age: 1, command: 'b' }]);
  });

  it('8. does not make a process the child of a younger one that took its dead parent\'s id', () => {
    const out = JSON.stringify([
      { p: 600, pp: 1, a: 10_000, c: 'claude.exe' },
      // Started by an earlier holder of 600, an hour ago: not claude's.
      { p: 700, pp: 600, a: 3_600_000, c: 'C:\\tools\\daemon.exe' },
      // Started by this claude: younger than it.
      { p: 800, pp: 600, a: 9_000, c: 'node.exe C:\\mcp\\bundle.js' },
      // Started in the same millisecond as claude: still its child.
      { p: 810, pp: 600, a: 10_000, c: 'C:\\Windows\\System32\\conhost.exe' },
      // Its parent is unknown to the list: kept as it is.
      { p: 900, pp: 555, a: 50_000, c: 'y.exe' },
    ]);
    expect(parseWindowsProcessList(out)!.map((p) => [p.pid, p.ppid])).toEqual([[600, 1], [700, 0], [800, 600], [810, 600], [900, 555]]);
  });
});

describe('a read', () => {
  it('3, 7. runs that command, and gives no table when it fails', async () => {
    run.answer = { err: null, stdout: JSON.stringify([{ p: 9, pp: 1, a: 4_000, c: 'x.exe' }]) };
    expect(await readWindowsProcesses({ SystemRoot: 'C:\\Windows' })).toEqual([{ pid: 9, ppid: 1, age: 4, command: 'x.exe' }]);
    expect(run.calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(run.calls[0].options.windowsHide).toBe(true);

    run.answer = { err: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '[]' };
    expect(await readWindowsProcesses({ SystemRoot: 'C:\\Windows' })).toBeUndefined();
  });
});
