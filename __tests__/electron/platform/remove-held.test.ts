import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmRetryingSync, unlinkRetryingSync, REMOVE_RETRY_BUDGET_MS } from '../../../electron/platform';

/**
 * Deleting a file or a folder another program still holds. On Windows a file
 * stays locked for a moment after it was written (an antivirus, the indexer)
 * or after the process that used it exits (a child, or its own child, that
 * still has it open or has the folder as its working directory). Delete it
 * in that moment and the delete fails, and where it runs in a `finally` its
 * error replaces the real result: cli-updater's npm scratch folder turned an
 * Amp update that worked into a failure.
 *
 * Node's own `fs.rmSync(p, { maxRetries, retryDelay })` does not answer it,
 * measured on this machine: under Node 22 (the tests) a folder held as a
 * child's working directory fails at once, EBUSY on rmdir, never retried;
 * under Electron's Node 24 (the app) the same hold reads EPERM, and a held
 * file is retried per file, so a tree of held files waits many times over.
 * The retry here wraps the whole call, with one budget, the same on both.
 *
 * How it can fail, written before the code:
 * 1. darwin/linux change: anything but the one call it replaces, with the same
 *    arguments, its error untouched, no wait and no clock read;
 * 2. win32 gives up at the first EBUSY, EPERM, EACCES or ENOTEMPTY a holder
 *    causes;
 * 3. win32 retries forever or past its budget (it blocks the main process),
 *    counting only the waits and not the time the failing calls take;
 * 4. win32 retries an error no holder causes (ENOENT, EISDIR, ENOSPC, an
 *    error with no code), hiding it or delaying it;
 * 5. the error thrown at the end is not the one the delete gave: another
 *    object, another code, a rewritten message;
 * 6. on the real disk, a folder a child holds as its working directory is
 *    still refused once the child has exited inside the budget;
 * 7. on the real disk, a hold that outlasts the budget is waited on for much
 *    longer than the budget, or its error is lost;
 * 8. on the real disk, a running program's own file is still refused once the
 *    program has exited inside the budget.
 */

const fail = (code?: string) => Object.assign(new Error(`${code ?? 'no code'}: remove`), code ? { code } : {});

/** A fake remove answering each call from `outcomes` (null = done), and a clock each call and each wait moves. */
function fakes(outcomes: Array<string | null | undefined>, callMs = 0) {
  const calls: unknown[][] = [];
  const slept: number[] = [];
  const thrown: Error[] = [];
  let now = 0;
  let clockReads = 0;
  const remove = (...args: unknown[]) => {
    calls.push(args);
    now += callMs;
    const next = outcomes.length ? outcomes.shift() : null;
    if (next !== null) {
      const e = fail(next);
      thrown.push(e);
      throw e;
    }
  };
  return {
    calls, slept, thrown,
    get clockReads() { return clockReads; },
    deps: {
      rm: remove as (p: string, o?: fs.RmOptions) => void,
      unlink: remove as (p: string) => void,
      sleep: (ms: number) => { slept.push(ms); now += ms; },
      now: () => { clockReads++; return now; },
    },
  };
}

function caught(fn: () => void): Error | undefined {
  try { fn(); } catch (e) { return e as Error; }
  return undefined;
}

describe('rmRetryingSync and unlinkRetryingSync', () => {
  it('1. darwin and linux: the one call, same arguments, its own error, no wait and no clock', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const options: fs.RmOptions = { recursive: true, force: true };
      const f = fakes(['EBUSY', 'EBUSY']);
      const rmError = caught(() => rmRetryingSync('/d/scratch', options, { ...f.deps, platform }));
      const unlinkError = caught(() => unlinkRetryingSync('/d/file', { ...f.deps, platform }));
      expect(f.calls).toEqual([['/d/scratch', options], ['/d/file']]);
      expect(f.calls[0][1]).toBe(options);
      expect(rmError).toBe(f.thrown[0]);
      expect(unlinkError).toBe(f.thrown[1]);
      expect(rmError?.message).toBe('EBUSY: remove');
      expect(f.slept).toEqual([]);
      expect(f.clockReads).toBe(0);
    }
  });

  it('1. darwin and linux: no options stays no options', () => {
    const f = fakes([null]);
    rmRetryingSync('/d/file', undefined, { ...f.deps, platform: 'darwin' });
    expect(f.calls).toEqual([['/d/file', undefined]]);
  });

  it('2. win32: waits out a holder, whatever it answers, backing off', () => {
    const f = fakes(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EBUSY', null]);
    rmRetryingSync('C:\\d\\scratch', { recursive: true, force: true }, { ...f.deps, platform: 'win32' });
    expect(f.calls).toHaveLength(6);
    expect(f.calls.every(c => c[0] === 'C:\\d\\scratch')).toBe(true);
    expect(f.slept).toHaveLength(5);
    expect(f.slept.every((ms, i) => i === 0 || ms >= f.slept[i - 1])).toBe(true);

    const u = fakes(['EPERM', 'EBUSY', null]);
    unlinkRetryingSync('C:\\d\\file', { ...u.deps, platform: 'win32' });
    expect(u.calls).toEqual([['C:\\d\\file'], ['C:\\d\\file'], ['C:\\d\\file']]);
  });

  it('3, 5. win32: stops after about its budget and throws the last error as it was', () => {
    const f = fakes(Array(10_000).fill('EBUSY'));
    const e = caught(() => rmRetryingSync('C:\\d\\scratch', { recursive: true, force: true }, { ...f.deps, platform: 'win32' }));
    const waited = f.slept.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(REMOVE_RETRY_BUDGET_MS * 0.9);
    expect(waited).toBeLessThanOrEqual(REMOVE_RETRY_BUDGET_MS * 1.1);
    expect(e).toBe(f.thrown.at(-1));
    expect((e as NodeJS.ErrnoException).code).toBe('EBUSY');
    expect(e?.message).toBe('EBUSY: remove');
  });

  it('3. win32: the time the failing calls take counts against the budget', () => {
    // Electron's rmSync spends about 110 ms failing on a held folder (measured).
    const f = fakes(Array(10_000).fill('EPERM'), 110);
    caught(() => rmRetryingSync('C:\\d\\scratch', { recursive: true, force: true }, { ...f.deps, platform: 'win32' }));
    const elapsed = f.calls.length * 110 + f.slept.reduce((a, b) => a + b, 0);
    expect(elapsed).toBeLessThanOrEqual(REMOVE_RETRY_BUDGET_MS + 110);
    expect(f.calls.length).toBeLessThan(12);
  });

  it('4. win32: an error no holder causes is thrown at once', () => {
    for (const code of ['ENOENT', 'EISDIR', 'ERR_FS_EISDIR', 'ENOSPC', 'EINVAL', undefined]) {
      const f = fakes([code]);
      const e = caught(() => rmRetryingSync('C:\\d\\x', { force: true }, { ...f.deps, platform: 'win32' }));
      expect(e).toBe(f.thrown[0]);
      expect(f.calls).toHaveLength(1);
      expect(f.slept).toEqual([]);
      const u = fakes([code]);
      expect(caught(() => unlinkRetryingSync('C:\\d\\x', { ...u.deps, platform: 'win32' }))).toBe(u.thrown[0]);
      expect(u.calls).toHaveLength(1);
    }
  });
});

// ── 6 to 8. The real disk, a real handle ─────────────────────────────────────

/** A node process that lives `ms` then exits, holding `cwd` as its working directory (and, when it is a copy, its own exe). */
function holder(ms: number, opts: { cwd?: string; exe?: string } = {}): Promise<ChildProcess> {
  const child = spawn(opts.exe ?? process.execPath, ['-e', `process.stdout.write('ready'); setTimeout(() => {}, ${ms})`], {
    cwd: opts.cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_OPTIONS: '' },
  });
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`the holder exited (${code}) before it was ready`)));
  });
}

const exited = (child: ChildProcess) => new Promise<void>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve());
});

function tree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remove-held-'));
  fs.mkdirSync(path.join(dir, 'npm-cache', '_cacache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'npm-cache', '_cacache', 'index'), 'x');
  return dir;
}

describe.runIf(process.platform === 'win32')('6 to 8. a real handle on the real disk (win32)', () => {
  it('6. a folder a child holds as its working directory goes once the child exits', async () => {
    const witness = tree();
    const first = await holder(400, { cwd: witness });
    // The witness: the plain call is refused while the child runs (EBUSY under Node 22, EPERM under Electron's 24).
    const plain = caught(() => fs.rmSync(witness, { recursive: true, force: true }));
    expect(['EBUSY', 'EPERM']).toContain((plain as NodeJS.ErrnoException)?.code);
    await exited(first);
    fs.rmSync(witness, { recursive: true, force: true });

    const dir = tree();
    const child = await holder(400, { cwd: dir });
    const started = Date.now();
    rmRetryingSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(Date.now() - started).toBeLessThan(REMOVE_RETRY_BUDGET_MS + 500);
    await exited(child);
  }, 20_000);

  it('7. a hold longer than the budget: given up after about the budget, the holder\'s code thrown', async () => {
    const dir = tree();
    const child = await holder(REMOVE_RETRY_BUDGET_MS + 3000, { cwd: dir });
    try {
      const started = Date.now();
      const e = caught(() => rmRetryingSync(dir, { recursive: true, force: true })) as NodeJS.ErrnoException | undefined;
      const spent = Date.now() - started;
      expect(['EBUSY', 'EPERM']).toContain(e?.code);
      expect(e?.message).toContain(dir);
      expect(spent).toBeGreaterThanOrEqual(REMOVE_RETRY_BUDGET_MS * 0.9);
      expect(spent).toBeLessThan(REMOVE_RETRY_BUDGET_MS + 1000);
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      child.kill();
      await exited(child);
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 20_000);

  it('8. a running program\'s own file goes once it exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remove-held-'));
    const exe = path.join(dir, 'held.exe');
    // A copy, not a hard link: a link's name can go while its image runs.
    fs.copyFileSync(process.execPath, exe);
    const child = await holder(400, { exe });
    try {
      expect((caught(() => fs.unlinkSync(exe)) as NodeJS.ErrnoException)?.code).toBe('EPERM');
      unlinkRetryingSync(exe);
      expect(fs.existsSync(exe)).toBe(false);
    } finally {
      await exited(child);
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 20_000);
});
