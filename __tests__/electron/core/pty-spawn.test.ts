import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

/**
 * Every terminal Tars opens goes through core/pty-spawn.ts, on the real node-pty Tars ships (2.0.6, item 1; the
 * incident of 28-29/10: the installed Tars held 510 of macOS's 511 PTY masters after 78 hours, and every agent start
 * failed). node-pty 1.1.0's macOS spawn (src/unix/pty.cc, pty_posix_spawn) opens up to three masters first so that
 * the real one is not fd 0 to 2, and its cleanup loop never closes the first of them; nor does it close its own copy
 * of the slave. Measured (reports/pty-leak-runs/probe3.js): one master left behind per spawn, for good.
 *
 * How it fails, written before the code (29/10):
 * P1. Each terminal leaves a master behind once it has ended: after N terminals, N more masters are open.
 * P2. While its session runs, this process keeps its own copy of the terminal's slave as well.
 * P3. The terminal's own master is closed with the leftovers: the terminal no longer reads or writes.
 * P4. Another terminal's master, open before this one, is closed with the leftovers.
 * P5. An fd the spawn did not open is taken for a leftover because its number was reused (a directory listed just
 *     before, its fd closed and reopened as a master): one is closed that is not node-pty's, or a leftover is kept.
 */

const unix = process.platform !== 'win32';

/** The character devices this process holds, by fd: what a terminal's master and slave read as under fstat. */
function charFds(): Map<number, number> {
  const out = new Map<number, number>();
  for (const name of fs.readdirSync('/dev/fd')) {
    const fd = Number(name);
    try { const st = fs.fstatSync(fd); if (st.isCharacterDevice()) out.set(fd, st.rdev); } catch { /* the listing's own */ }
  }
  return out;
}
const majorOf = (rdev: number) => (process.platform === 'darwin' ? (rdev >>> 24) & 0xff : (rdev >>> 8) & 0xfff);

type Term = import('node-pty').IPty & { _fd: number; _pty: string };
const exited = (t: Term) => new Promise<void>(resolve => t.onExit(() => resolve()));

describe.skipIf(!unix)('a terminal opened through pty-spawn', () => {
  it('P1. leaves no master behind once it has ended, over many terminals', async () => {
    const { spawnPty } = await import('../../../electron/core/pty-spawn');
    const probe = spawnPty('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24 }) as Term;
    const ptc = majorOf(fs.fstatSync(probe._fd).rdev);
    await exited(probe);
    await new Promise(r => setTimeout(r, 300));
    const masters = () => [...charFds().values()].filter(rdev => majorOf(rdev) === ptc).length;
    const before = masters();
    for (let i = 0; i < 25; i++) await exited(spawnPty('/usr/bin/true', [], { cols: 80, rows: 24 }) as Term);
    await new Promise(r => setTimeout(r, 300));
    expect(masters(), 'masters left behind by 25 terminals').toBe(before);
  }, 30_000);

  it('P2, P3. keeps only its own master while it runs, and that master reads and writes', async () => {
    const { spawnPty } = await import('../../../electron/core/pty-spawn');
    const before = charFds();
    const t = spawnPty('/bin/cat', [], { cols: 80, rows: 24 }) as Term;
    const opened = [...charFds()].filter(([fd, rdev]) => before.get(fd) !== rdev).map(([fd]) => fd);
    expect(opened, 'what this process holds of the new terminal').toEqual([t._fd]);
    const echoed = new Promise<string>(resolve => { let got = ''; t.onData(d => { got += d; if (got.includes('ping')) resolve(got); }); });
    t.write('ping\r');
    expect(await echoed).toContain('ping');
    const done = exited(t);
    t.kill();
    await done;
  }, 30_000);

  it('P4. never closes another terminal\'s master', async () => {
    const { spawnPty } = await import('../../../electron/core/pty-spawn');
    const first = spawnPty('/bin/cat', [], { cols: 80, rows: 24 }) as Term;
    const second = spawnPty('/bin/cat', [], { cols: 80, rows: 24 }) as Term;
    expect(() => fs.fstatSync(first._fd)).not.toThrow();
    const echoed = new Promise<string>(resolve => { let got = ''; first.onData(d => { got += d; if (got.includes('still')) resolve(got); }); });
    first.write('still\r');
    expect(await echoed).toContain('still');
    for (const t of [first, second]) { const done = exited(t); t.kill(); await done; }
  }, 30_000);

  it('P5. tells a leftover from an fd whose number was reused, by its device', async () => {
    const { spawnPty } = await import('../../../electron/core/pty-spawn');
    // A directory opened and closed right before, as the listing itself does: its number is free for node-pty.
    const dir = fs.openSync('/dev', 'r');
    fs.closeSync(dir);
    const t = spawnPty('/bin/cat', [], { cols: 80, rows: 24 }) as Term;
    const ptc = majorOf(fs.fstatSync(t._fd).rdev);
    const masters = [...charFds()].filter(([, rdev]) => majorOf(rdev) === ptc).map(([fd]) => fd);
    expect(masters, 'a master left behind in a reused number').not.toContain(dir);
    const done = exited(t);
    t.kill();
    await done;
  }, 30_000);
});
