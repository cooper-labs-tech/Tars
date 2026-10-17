import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { processExists } from '../../../electron/platform/process-exists';

/**
 * Whether a process of this user still runs under a pid (2.0.3, the Audit's M1 on #418): the run record names the
 * Tars that wrote it, and a second Tars on the same home (macOS and Linux hold no single-instance lock) must not read
 * the first, still running, as one that ended abruptly. Node's signal 0 probes without signalling, on the three
 * platforms (on win32 libuv opens the process instead).
 *
 * How it fails, written before the code:
 * 1. A live process reads as gone: the second Tars reports the first's abrupt end and resumes its agents.
 * 2. A process that ended reads as live: a crash is never reported, its agents never resumed.
 * 3. A pid held by a process of another user (EPERM) reads as a Tars of this one.
 * 4. Pid 0 or a negative pid reads as live: kill(0, 0) signals this process's own group and always succeeds, and
 *    kill(-1, 0) every process the user owns. Neither names one process.
 * 5. Something that is not a pid (NaN, a fraction, a string) reaches kill and throws, or reads as live.
 * 6. On win32 the same answers, from the errors Node gives there.
 */

const fakeKill = (code: string | null) => (() => { if (code) throw Object.assign(new Error(code), { code }); return true; }) as typeof process.kill;

describe('whether a pid is a live process of this user', () => {
  it('1. this process, and a child that runs, are live', async () => {
    expect(processExists(process.pid)).toBe(true);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      expect(processExists(child.pid!)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('2. a process that ended is gone', () => {
    const done = spawnSync(process.execPath, ['-e', '0']);
    expect(done.pid).toBeGreaterThan(0);
    expect(processExists(done.pid!)).toBe(false);
  });

  it("3. another user's process is not one of this user's", () => {
    expect(processExists(1234, fakeKill('EPERM'))).toBe(false);
  });

  it('4-5. no pid that names no one process reaches kill', () => {
    let called = 0;
    const kill = (() => { called += 1; return true; }) as typeof process.kill;
    for (const pid of [0, -1, -4242, Number.NaN, 1.5, Infinity, '4242' as unknown as number]) {
      expect(processExists(pid, kill), String(pid)).toBe(false);
    }
    expect(called).toBe(0);
  });

  it('6. the errors Node gives on win32 and POSIX alike: ESRCH is gone, success is live', () => {
    const real = process.platform;
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        expect(processExists(4242, fakeKill(null))).toBe(true);
        expect(processExists(4242, fakeKill('ESRCH'))).toBe(false);
        expect(processExists(4242, fakeKill('EPERM'))).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: real });
      }
    }
  });
});
