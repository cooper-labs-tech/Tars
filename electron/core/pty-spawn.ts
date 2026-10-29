import * as fs from 'fs';
import * as pty from 'node-pty';
import { explainSpawnFailure, readPtyPool, NoTerminalLeft, PtyPool } from './pty-pool';

/**
 * The one way Tars opens a terminal (2.0.6, item 1; its failures: __tests__/electron/core/pty-spawn.test.ts).
 *
 * node-pty 1.1.0's macOS spawn (src/unix/pty.cc, pty_posix_spawn) opens up to three PTY masters first, so that the
 * real one is not fd 0 to 2, and its cleanup loop (`for (; count > 0; count--) close(low_fds[count])`) never closes
 * the first: in a process whose fds 0 to 2 are open, one master with no terminal stays open for each spawn. It keeps
 * its own copy of the slave as well, until the session ends. Measured (reports/pty-leak-runs/probe3.js): fd 16 a
 * master no terminal owns, fd 17 the terminal's, fd 18 the slave; at the child's exit 17 and 18 close, 16 stays.
 * Tars 2.0.4 held 510 of macOS's 511 after 78 hours (28-29/10), and no agent could start. node-pty 1.2.0 (in beta)
 * closes both itself; Tars ships 1.1.0's prebuilt module, so the leftovers are closed here.
 *
 * pty.spawn is synchronous: between the two readings below nothing else runs on this thread, and only node-pty
 * opens a PTY. What the spawn left is told by its device, never by its number alone (a number freed by a listing is
 * reused at once): a new master other than the terminal's, and this process's copy of the terminal's slave. Once
 * node-pty leaves nothing, nothing is closed. Linux (forkpty) and Windows (ConPTY) leave nothing: not read there.
 */
export function spawnPty(file: string, args: string[] | string, options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions): pty.IPty {
  // An E2E spec's full pool (useTestPtyMax): refused as a full machine refuses, before node-pty is asked. One rule on
  // every system, full once Tars's open terminals reach the limit (the Audit's M1 on #567: macOS's "a start needs two
  // free" made the same limit refuse there and not elsewhere), and 0 a limit: no terminal can open.
  if (testMax !== null && open >= testMax) throw new NoTerminalLeft({ inUse: open, max: testMax, tars: open, open });
  const before = process.platform === 'darwin' ? charDevices() : null;
  let term: pty.IPty;
  try {
    term = pty.spawn(file, args, options);
  } catch (err) {
    // node-pty closes nothing when it fails after opening its PTYs (posix_spawn refused, the pool's last one taken
    // by its spare master): 3 left for good per failed start, measured (the Audit's M1 on #553).
    if (before) closeFailedSpawn(before);
    // A full pool reads as node-pty's bare "posix_spawnp failed." (posix_openpt fails first): say what it is.
    throw explainSpawnFailure(err, readTerminals());
  }
  if (before) closeLeftovers(term as pty.IPty & { _fd?: unknown; _pty?: unknown }, before);
  open++;
  term.onExit(() => { open--; });
  return term;
}

/** The terminals Tars has open: each counted at its spawn, given back at its child's exit. */
let open = 0;
export const openTerminals = (): number => open;

/**
 * The limit of an E2E spec's pool (DOROTHY_E2E_PTY_MAX, read by main through ptyTestMax, never by a packaged build),
 * or null. Set, the pool is Tars's own open terminals out of it: the same on every platform, and moved by nothing
 * else on a shared machine, so a spec makes it full with a few terminals and starts an agent through the real path.
 */
let testMax: number | null = null;
export function useTestPtyMax(max: number | null): void { testMax = max; }

/** The machine's pool with the terminals Tars has open: Tars holding more masters than that is a leak. */
export function readTerminals(): PtyPool | null {
  if (testMax !== null) return { inUse: open, max: testMax, tars: open, open };
  const pool = readPtyPool();
  return pool && { ...pool, open };
}

/** The character devices this process holds: fd to rdev. */
function charDevices(): Map<number, number> {
  const out = new Map<number, number>();
  let names: string[] = [];
  try { names = fs.readdirSync('/dev/fd'); } catch { return out; }
  for (const name of names) {
    const fd = Number(name);
    try { const st = fs.fstatSync(fd); if (st.isCharacterDevice()) out.set(fd, st.rdev); } catch { /* the listing's own, closed */ }
  }
  return out;
}

const major = (rdev: number) => (rdev >>> 24) & 0xff;

/**
 * After a spawn that threw: no terminal was returned, so every PTY this process holds that it did not hold before is
 * node-pty's, its masters (/dev/ptmx's major) and its slave (a /dev/ttysNNN node's device). Told by device, as above.
 */
function closeFailedSpawn(before: Map<number, number>): void {
  let masters: number;
  try { masters = major(fs.statSync('/dev/ptmx').rdev); } catch { return; }
  const after = [...charDevices()].filter(([fd, rdev]) => before.get(fd) !== rdev);
  if (!after.length) return;
  const slaves = new Set<number>();
  try {
    for (const name of fs.readdirSync('/dev')) {
      if (/^ttys\d+$/.test(name)) { try { slaves.add(fs.statSync(`/dev/${name}`).rdev); } catch { /* gone meanwhile */ } }
    }
  } catch { /* no listing: the masters alone */ }
  for (const [fd, rdev] of after) {
    if (major(rdev) === masters || slaves.has(rdev)) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function closeLeftovers(term: { _fd?: unknown; _pty?: unknown }, before: Map<number, number>): void {
  // A terminal whose fds Tars cannot read (a test's stand-in, another node-pty): nothing to tell apart.
  if (typeof term._fd !== 'number') return;
  const master = term._fd;
  let masterMajor: number;
  let slave: number | undefined;
  try {
    masterMajor = major(fs.fstatSync(master).rdev);
    if (typeof term._pty === 'string') slave = fs.statSync(term._pty).rdev;
  } catch { return; }
  for (const [fd, rdev] of charDevices()) {
    if (fd === master || before.get(fd) === rdev) continue;
    if (major(rdev) === masterMajor || rdev === slave) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}
