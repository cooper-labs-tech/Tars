import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { processStartOf } from '../../../electron/platform/process-start';

/**
 * When the process under a pid started, as the OS says it (2.0.3, the Audit's Low on #418's M1): a live pid in the
 * run record is another Tars only if the process under it is the one that wrote the record. Once a crashed Tars's pid
 * is taken by a long-lived process of the same user, reading "alive" as "another Tars" stops the crash resume, the
 * report and the record of every launch until that process ends. So the record keeps when its process started, and
 * a live pid is compared on that.
 * - linux: field 22 of /proc/<pid>/stat (start time in clock ticks since boot).
 * - darwin: `ps -o lstart= -p <pid>` (to the second), from /bin/ps, in the C locale.
 * - win32: none. The single-instance lock ends a second Tars before it reads the record (core/desktop-lifecycle.ts),
 *   so a live pid there is never another Tars.
 *
 * How it fails, written before the code:
 * 1. darwin: ps is looked up on PATH (the packaged main process has a bare one), or answers in the user's locale, or
 *    anything but a start date is taken as one.
 * 2. linux: a command name with spaces or parentheses shifts the fields, and another field is read as the start.
 * 3. win32 and others: a program runs, or an answer is made up.
 * 4. A process that is gone, a program that fails, an answer that is empty or malformed throws, or gives an answer.
 * 5. Real: the same process reads differently twice, or two processes started a second apart read the same.
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
