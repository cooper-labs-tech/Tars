import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The machine's PTY pool, as Tars reads it and says it (2.0.6, item 1; the incident of 28-29/10: with 510 of macOS's
 * 511 masters held, every agent start answered a bare 500 "Internal server error", and nothing said why).
 *
 * How it fails, written before the code (29/10):
 * Q1. macOS: the pool is not read, or read wrong: in use is the /dev/ttysNNN nodes (one per allocated pty, a leaked
 *     master with no slave included, measured in reports/pty-leak-runs/probe4.js), the limit kern.tty.ptmx_max, and
 *     Tars's share the masters this process holds.
 * Q2. Linux: /proc/sys/kernel/pty/nr and max are not read; a file that cannot be read gives a made-up figure.
 * Q3. Windows (ConPTY, no such pool): a figure is made up instead of null.
 * Q4. A terminal that cannot be opened because the pool is full reads as node-pty's "posix_spawnp failed.", which the
 *     API turns into a bare 500: it must say there is no terminal left on this machine, how many of how many are in
 *     use and how many Tars holds. A failure with room left is the error it was.
 * Q4b. It offers the wrong remedy. With the leak fixed, a terminal is freed by stopping its agent (or by another
 *     app closing its own); a restart of Tars stops every agent and no orchestrator can do it, so it is offered only
 *     when Tars holds more masters than it has terminals open (the audit's M1 of #552, 29/10). The terminals Tars has
 *     open are counted where every one is opened (spawnPty) and given back at each one's exit.
 * Q5. The API answers it with 500 "Internal server error"; it must answer 503 with that message and a code a caller
 *     can read. Any other error keeps its 500.
 * Q6. Nobody is warned before the pool fills, or warned at every sample: past 80 % of the limit the window and the
 *     orchestrators are told once, and again only after it fell under 70 %.
 * Q6b. The warning does not say how many of how many, or offers a restart when stopping agents would do (Q4b).
 * Q7. The health monitor does not put the pool in its samples, or does not run the warning on them.
 */

describe('the machine\'s PTY pool', () => {
  it('Q1. macOS: the ttys nodes in use, kern.tty.ptmx_max, and the masters Tars holds', async () => {
    const { readPtyPool } = await import('../../../electron/core/pty-pool');
    const pool = readPtyPool({
      platform: 'darwin',
      listDev: () => ['ttys000', 'ttys001', 'ttys019', 'tty', 'ttyp0', 'ptmx', 'ttys1x'],
      sysctlMax: () => 511,
      readFile: () => { throw new Error('not on macOS'); },
      ownMasters: () => 2,
    });
    expect(pool).toEqual({ inUse: 3, max: 511, tars: 2 });
  });

  it('Q2. Linux: /proc/sys/kernel/pty/nr and max; a file that cannot be read gives nothing', async () => {
    const { readPtyPool } = await import('../../../electron/core/pty-pool');
    const files: Record<string, string> = { '/proc/sys/kernel/pty/nr': '7\n', '/proc/sys/kernel/pty/max': '4096\n' };
    const io = { platform: 'linux' as const, listDev: () => [], sysctlMax: () => null, readFile: (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }, ownMasters: () => 1 };
    expect(readPtyPool(io)).toEqual({ inUse: 7, max: 4096, tars: 1 });
    delete files['/proc/sys/kernel/pty/max'];
    expect(readPtyPool(io)).toBeNull();
  });

  it('Q3. Windows: null', async () => {
    const { readPtyPool } = await import('../../../electron/core/pty-pool');
    expect(readPtyPool({ platform: 'win32', listDev: () => [], sysctlMax: () => null, readFile: () => '', ownMasters: () => null })).toBeNull();
  });

  it('Q4. a terminal the full pool refuses says so; one refused with room left is the error it was', async () => {
    vi.resetModules();
    vi.doMock('node-pty', () => ({ spawn: () => { throw new Error('posix_spawnp failed.'); } }));
    const pool = { inUse: 511, max: 511, tars: 505 };
    vi.doMock('../../../electron/core/pty-pool', async (orig) => ({ ...(await orig<object>()), readPtyPool: () => pool }));
    const { spawnPty } = await import('../../../electron/core/pty-spawn');
    const { NoTerminalLeft } = await import('../../../electron/core/pty-pool');
    let err: unknown;
    try { spawnPty('/bin/sh', [], {}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NoTerminalLeft);
    expect((err as Error).message).toBe('No terminal can be opened on this machine: 511 of 511 are in use, 505 of them held by Tars, which has 0 open. The other 505 were never given back, and only a restart of Tars frees them: it stops every agent.');
    pool.inUse = 40;
    let other: unknown;
    try { spawnPty('/bin/sh', [], {}); } catch (e) { other = e; }
    expect(other).not.toBeInstanceOf(NoTerminalLeft);
    expect((other as Error).message).toBe('posix_spawnp failed.');
    vi.doUnmock('node-pty');
    vi.doUnmock('../../../electron/core/pty-pool');
    vi.resetModules();
  });

  it('Q4b. a full pool Tars holds no more of than it has open says to stop an agent, never to restart Tars', async () => {
    const { explainSpawnFailure } = await import('../../../electron/core/pty-pool');
    const own = explainSpawnFailure(new Error('posix_spawnp failed.'), { inUse: 511, max: 511, tars: 18, open: 18 }) as Error;
    expect(own.message).toBe('No terminal can be opened on this machine: 511 of 511 are in use, 18 of them held by Tars for its 18 open terminals. Stop an agent that does not need its terminal, or close terminals in other apps, to free one.');
    const unknown = explainSpawnFailure(new Error('posix_spawnp failed.'), { inUse: 4096, max: 4096, tars: null }) as Error;
    expect(unknown.message).toBe('No terminal can be opened on this machine: 4096 of 4096 are in use. Stop an agent that does not need its terminal, or close terminals in other apps, to free one.');
    expect(own.message + unknown.message).not.toMatch(/restart/i);
  });

  it('Q4b. the terminals Tars has open are counted at spawn and given back at exit', async () => {
    const { spawnPty, openTerminals } = await import('../../../electron/core/pty-spawn');
    const before = openTerminals();
    const term = spawnPty(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [], {});
    expect(openTerminals()).toBe(before + 1);
    await new Promise<void>(resolve => { term.onExit(() => resolve()); term.kill(); });
    expect(openTerminals()).toBe(before);
  });

  it('Q5. the API answers 503 with the message and a code; any other error keeps its 500', async () => {
    const { NoTerminalLeft, apiAnswerForError } = await import('../../../electron/core/pty-pool');
    const full = new NoTerminalLeft({ inUse: 511, max: 511, tars: 505 });
    expect(apiAnswerForError(full)).toEqual({ status: 503, body: { error: full.message, code: 'no_terminal' } });
    expect(apiAnswerForError(new Error('boom'))).toEqual({ status: 500, body: { error: 'Internal server error' } });
  });

  it('Q6. past 80 % it warns once, and again only after falling under 70 %', async () => {
    const { ptyWarning } = await import('../../../electron/core/pty-pool');
    const at = (inUse: number) => ({ inUse, max: 500, tars: 1 });
    let warned = false;
    const told: number[] = [];
    for (const inUse of [100, 399, 400, 450, 420, 360, 349, 400, 410]) {
      const step = ptyWarning(warned, at(inUse));
      warned = step.warned;
      if (step.tell) told.push(inUse);
    }
    expect(told).toEqual([400, 400]);
    expect(ptyWarning(false, null)).toEqual({ warned: false, tell: false });
  });

  it('Q6b. the warning says how many of how many, and a restart only for masters Tars has no terminal for', async () => {
    const { terminalsNearFullNote } = await import('../../../electron/core/pty-pool');
    expect(terminalsNearFullNote({ inUse: 410, max: 511, tars: 400, open: 400 })).toBe('The machine\'s terminals are filling: 410 of 511 are in use, 400 of them held by Tars for its 400 open terminals. At 511 no agent can start: stop the agents that do not need their terminal.');
    expect(terminalsNearFullNote({ inUse: 410, max: 511, tars: 400, open: 380 })).toBe('The machine\'s terminals are filling: 410 of 511 are in use, 400 of them held by Tars, which has 380 open. The other 20 were never given back, and only a restart of Tars frees them: it stops every agent.');
    expect(terminalsNearFullNote({ inUse: 3300, max: 4096, tars: null })).not.toMatch(/restart/i);
  });

  it('Q7. each health sample carries the pool, and the monitor warns once past 80 %', async () => {
    const { startHealthMonitor } = await import('../../../electron/services/health/monitor');
    const { readSamples } = await import('../../../electron/services/health/samples');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-pty-pool-'));
    const file = path.join(dir, 'health-samples.jsonl');
    const seen = [100, 450, 460, 300, 420];
    let i = 0;
    const told: number[] = [];
    const monitor = startHealthMonitor({
      file, everyMs: 20, agents: () => ({ total: 1, running: 0 }), page: () => null,
      terminals: () => ({ inUse: seen[Math.min(i++, seen.length - 1)], max: 500, tars: 3, open: 3 }),
      onTerminalsNearFull: (pool) => told.push(pool.inUse),
    });
    try {
      await vi.waitFor(() => expect(readSamples(file).length).toBeGreaterThanOrEqual(seen.length), { timeout: 30_000, interval: 50 });
    } finally { monitor.stop(); }
    expect(told).toEqual([450, 420]);
    expect(readSamples(file)[0].terminals).toEqual({ inUse: 100, max: 500, tars: 3, open: 3 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
