import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { processStartOf, windowsProcessCreatedAt } from '../../../electron/platform/process-start';

/**
 * When the process under a pid started, as the OS says it (2.0.3, the Audit's Low on #418's M1): a live pid in the
 * run record is another Tars only if the process under it is the one that wrote the record. Once a crashed Tars's pid
 * is taken by a long-lived process of the same user, reading "alive" as "another Tars" stops the crash resume, the
 * report and the record of every launch until that process ends. So the record keeps when its process started, and
 * a live pid is compared on that.
 * - linux: field 22 of /proc/<pid>/stat (start time in clock ticks since boot).
 * - darwin: `ps -o lstart= -p <pid>` (to the second), from /bin/ps, in the C locale.
 * - win32: none, by this function: there is no ps, and asking PowerShell for this run's own start would hold the first
 *   window back at every launch. win32 asks instead, only when a live pid must be judged, when its process was
 *   created (windowsProcessCreatedAt below; services/run-state.ts says how that judges it).
 *
 * How it fails, written before the code:
 * 1. darwin: ps is looked up on PATH (the packaged main process has a bare one), or answers in the user's locale, or
 *    anything but a start date is taken as one.
 * 2. linux: a command name with spaces or parentheses shifts the fields, and another field is read as the start.
 * 3. win32 and others: a program runs, or an answer is made up.
 * 4. A process that is gone, a program that fails, an answer that is empty or malformed throws, or gives an answer.
 * 5. Real: the same process reads differently twice, or two processes started a second apart read the same.
 * And when a process was created, on Windows (2.0.4, parity: the single-instance lock is per profile, so a second Tars
 * started with another profile on the same home reads the first's open record, and win32 took any live pid there for
 * a reused one: a false abrupt end, and the first's working agents resumed by the second while the first runs them):
 * 6. Nothing is asked of Windows, so the record's Tars cannot be told from a process that took its pid.
 * 7. PowerShell is the one found on the PATH or under a relative SystemRoot, or a PowerShell 7 parent's PSModulePath
 *    is passed on (child-env.ts), or the pid is written into the script.
 * 8. A process that is gone, a PowerShell that fails, an answer that is empty or not a time throws, or gives a time;
 *    a pid that is not a positive whole number reaches PowerShell; another platform asks Windows.
 */

const LSTART = 'Thu Oct 15 20:57:01 2026';
const stat = (comm: string, start: string) =>
  `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

describe('when the process under a pid started', () => {
  it('1. darwin: /bin/ps in the C locale, its start date as is', () => {
    const calls: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const execFileSync = (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => { calls.push({ file, args, env: opts.env }); return `${LSTART}\n`; };
    expect(processStartOf(4242, 'darwin', { execFileSync })).toBe(`darwin:${LSTART}`);
    expect(calls).toEqual([{ file: '/bin/ps', args: ['-o', 'lstart=', '-p', '4242'], env: expect.objectContaining({ LC_ALL: 'C' }) }]);
    expect(processStartOf(4242, 'darwin', { execFileSync: () => 'Thu Oct  5 09:07:01 2026\n' })).toBe('darwin:Thu Oct  5 09:07:01 2026');
    for (const odd of ['jeu 15 oct 20:57:01 2026', '20:57', 'PID TT', '']) {
      expect(processStartOf(4242, 'darwin', { execFileSync: () => odd }), odd).toBeNull();
    }
  });

  it('2. linux: field 22 of /proc/<pid>/stat, whatever the command is called', () => {
    const readFile = (p: string) => { expect(p).toBe('/proc/4242/stat'); return stat('tars', '987654'); };
    expect(processStartOf(4242, 'linux', { readFile })).toBe('linux:987654');
    expect(processStartOf(4242, 'linux', { readFile: () => stat('a b) S 1 2 (c', '555') })).toBe('linux:555');
  });

  it('3. win32: none, and nothing runs', () => {
    const boom = () => { throw new Error('ran'); };
    expect(processStartOf(4242, 'win32', { execFileSync: boom, readFile: boom })).toBeNull();
    expect(processStartOf(4242, 'freebsd' as NodeJS.Platform, { execFileSync: boom, readFile: boom })).toBeNull();
  });

  it('4. gone, failing or malformed: none, and nothing thrown', () => {
    const fail = () => { throw Object.assign(new Error('no such process'), { status: 1 }); };
    expect(processStartOf(4242, 'darwin', { execFileSync: fail })).toBeNull();
    expect(processStartOf(4242, 'linux', { readFile: fail })).toBeNull();
    expect(processStartOf(4242, 'linux', { readFile: () => '4242 (tars) S 1 2' })).toBeNull();
    expect(processStartOf(4242, 'linux', { readFile: () => stat('tars', 'x12') })).toBeNull();
    for (const pid of [0, -1, Number.NaN, 1.5]) expect(processStartOf(pid, 'darwin', { execFileSync: fail })).toBeNull();
  });

  describe('when a process was created, on Windows', () => {
    type Call = { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv };
    const asking = (answer: string | (() => string)) => {
      const calls: Call[] = [];
      const execFileSync = (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ file, args, env: opts.env });
        return typeof answer === 'string' ? answer : answer();
      };
      return { calls, execFileSync };
    };
    const script = (call: Call) => Buffer.from(String(call.args[call.args.indexOf('-EncodedCommand') + 1]), 'base64').toString('utf16le');

    it('6-7. asks Win32_Process, through the PowerShell under SystemRoot, the pid in the environment', () => {
      const ask = asking('1792185661123\r\n');
      const env = { SystemRoot: 'D:\\Win', PSModulePath: 'C:\\pwsh7\\Modules', Path: 'C:\\evil' };
      expect(windowsProcessCreatedAt(4242, { execFileSync: ask.execFileSync, env })).toBe(1792185661123);
      expect(ask.calls).toHaveLength(1);
      const [call] = ask.calls;
      expect(call.file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(call.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive']);
      expect(script(call)).toMatch(/Get-CimInstance Win32_Process/);
      expect(script(call)).toMatch(/CreationDate/);
      expect(script(call)).not.toMatch(/4242/);
      expect(call.env?.TARS_PID).toBe('4242');
      expect(call.env && 'PSModulePath' in call.env).toBe(false);
      for (const root of ['Windows', '.\\Windows', '\\\\server\\share', '']) {
        const again = asking('1');
        windowsProcessCreatedAt(4242, { execFileSync: again.execFileSync, env: { SystemRoot: root } });
        expect(again.calls[0].file, root).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      }
    });

    it('8. gone, failing or not a time: none, and nothing thrown; nothing asked for a bad pid', () => {
      const fail = () => { throw Object.assign(new Error('Get-CimInstance failed'), { status: 1 }); };
      expect(windowsProcessCreatedAt(4242, { execFileSync: asking(fail).execFileSync, env: {} })).toBeNull();
      for (const odd of ['', '\r\n', '17 oct. 2026 02:12', '-5', '1792185661123.5', '12345678901234567890']) {
        expect(windowsProcessCreatedAt(4242, { execFileSync: asking(odd).execFileSync, env: {} }), odd).toBeNull();
      }
      for (const pid of [0, -1, Number.NaN, 1.5]) {
        const ask = asking('1');
        expect(windowsProcessCreatedAt(pid, { execFileSync: ask.execFileSync, env: {} })).toBeNull();
        expect(ask.calls).toEqual([]);
      }
    });
  });

  it.runIf(process.platform === 'win32')('9. real, on Windows: this process was created before now, and a child after it', async () => {
    const own = windowsProcessCreatedAt(process.pid);
    expect(own).not.toBeNull();
    expect(own!).toBeLessThanOrEqual(Date.now());
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(windowsProcessCreatedAt(kid.pid!)!).toBeGreaterThan(own!);
    } finally {
      kid.kill();
    }
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('5. real: one process reads the same twice; two started a second apart differ', async () => {
    const own = processStartOf(process.pid);
    expect(own).not.toBeNull();
    expect(processStartOf(process.pid)).toBe(own);
    const kids: ChildProcess[] = [];
    try {
      kids.push(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }));
      await new Promise((r) => setTimeout(r, 1_100));
      kids.push(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }));
      await new Promise((r) => setTimeout(r, 200));
      const [a, b] = kids.map((k) => processStartOf(k.pid!));
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    } finally {
      for (const k of kids) k.kill();
    }
  });
});
