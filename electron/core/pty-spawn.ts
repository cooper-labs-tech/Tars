import * as fs from 'fs';
import * as pty from 'node-pty';

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
  if (process.platform !== 'darwin') return pty.spawn(file, args, options);
  const before = charDevices();
  const term = pty.spawn(file, args, options);
  closeLeftovers(term as pty.IPty & { _fd?: unknown; _pty?: unknown }, before);
  return term;
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
