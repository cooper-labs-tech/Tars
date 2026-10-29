import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { ProcessTree, parseProcessTable, processTable } from '../../../electron/services/acp/client';

/**
 * The process tree a stopped delegated run is ended by (#197, #199): read from
 * ps before the first signal, and read again before the last, from every
 * process already known.
 *
 * Between the two reads a known process may end and its id be given to another
 * process, anyone's. Read again, that id is still "known", so its group, and
 * any child of it, were taken for the run's and signalled (the Audit's gate of
 * #199). Matching (pid, ppid) pairs does not tell them apart: launchd is the
 * parent of a reparented process and of many a new one. The age ps gives does:
 * a process younger than the time since the first read did not exist then.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A known pid taken by an unrelated process between the reads has that
 *    process's group signalled.
 * 2. A child of such a process is adopted as the run's; or, when the new
 *    process leads a group of its own, that group has the id of one of the
 *    run's, and is signalled under it.
 * 3. Over-correction: a known process that is still the same one is dropped,
 *    and its group or the child it started between the reads is left running.
 * 4. Over-correction: a process started between the reads by a known one is
 *    dropped for being young.
 * 5. ps's age is misread: `mm:ss`, `hh:mm:ss` and `d-hh:mm:ss` are all seconds.
 * 6. A ps that gives no age (busybox) makes every known process a stranger:
 *    with no age, nothing is dropped, as before.
 *
 * ps gives the age in whole seconds, so a process given a known id less than a
 * second after the first read is not told apart. That is the part left open.
 *
 * And the session (2026-10-23, case 8 of quit-ends-terminals.test.ts on Linux,
 * red on Nexarion434's ubuntu CI since 17/10): a process a CLI starts in a group
 * of its own, whose parent then exits before the next read, is reparented to
 * init. Nothing in (pid, ppid, pgid) ties it to the tree any more, and the quit
 * returned with it still running (16 runs out of 20 in a node:22 container).
 * What it keeps is its session: an agent's terminal leads one (node-pty's shell
 * calls setsid), and setpgid does not leave it. Linux's ps gives it (`sid`);
 * macOS's gives 0 for every process (`sess`), so there the tree stays read by
 * parentage alone, and that is the part left open on macOS.
 * 7. ps's session column is misread, or read where ps gives none (macOS).
 * 8. A process of a session a root leads is not the tree's once its parent
 *    ended, though it leads a group of its own.
 * 9. Over-correction: a process of another session, or of Tars's own, is taken;
 *    or one of a root's session when that root does not lead it (a root started
 *    in Tars's session shares Tars's).
 * 10. A session whose id a new leader took since the first read (every process
 *    of the old one gone) is still taken for the root's.
 * 11. On Linux, the real ps gives no session, or not the one a detached child
 *    leads; on macOS, a session is made up from the 0 it gives.
 */

const row = (pid: number, ppid: number, pgid: number, etime?: string) =>
  `${pid} ${ppid} ${pgid} S${etime === undefined ? '' : ` ${etime}`}`;
const table = (...rows: string[]) => parseProcessTable(rows.join('\n'));

const T0 = 1_000_000;

/** A Linux row, with the session: pid ppid pgid sid stat etime. */
const srow = (pid: number, ppid: number, pgid: number, sid: number, etime = '01:00') => `${pid} ${ppid} ${pgid} ${sid} S ${etime}`;
const stable = (...rows: string[]) => parseProcessTable(rows.join('\n'), true);

describe('the second read of a run\'s process tree', () => {
  it('1, 2. takes nothing from a known pid that another process took since the first read', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100, '05:00'), row(200, 100, 200, '04:00')), T0);
    expect(tree.targets.sort()).toEqual([100, 200]);

    // 200 ended; its id went to someone else's shell (group 900), which started 901.
    tree.grow(table(row(100, 1, 100, '05:05'), row(200, 1, 900, '00:01'), row(901, 200, 901, '00:01')), T0 + 5_000);

    expect(tree.targets).not.toContain(900);
    expect(tree.targets).not.toContain(901);
  });

  it('2. leaves a group alone whose id a new process took by leading it', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100, '05:00'), row(200, 100, 200, '04:00')), T0);

    // Group 200 ended with its leader; a new process got pid 200 and leads a group of that id.
    tree.grow(table(row(100, 1, 100, '05:05'), row(200, 1, 200, '00:01')), T0 + 5_000);

    expect(tree.targets).toEqual([100]);
  });

  it('3, 4. keeps a known process that is the same one, and what it started in between', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100, '05:00'), row(200, 100, 200, '04:00')), T0);

    tree.grow(table(row(100, 1, 100, '05:05'), row(200, 100, 200, '04:05'), row(300, 200, 300, '00:02')), T0 + 5_000);

    expect(tree.targets.sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('5. reads every form of ps\'s age', () => {
    expect(table(row(1, 0, 1, '07'), row(2, 0, 2, '01:07'), row(3, 0, 3, '02:01:07'), row(4, 0, 4, '3-02:01:07'))
      .map(r => r.age)).toEqual([7, 67, 7267, 3 * 86_400 + 7267]);
  });

  it('6. drops nothing when ps gives no age', () => {
    const tree = new ProcessTree([100]);
    tree.grow(table(row(100, 1, 100), row(200, 100, 200)), T0);

    tree.grow(table(row(100, 1, 100), row(200, 100, 200), row(300, 200, 300)), T0 + 5_000);

    expect(tree.targets.sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });
});

describe('the session of a terminal\'s tree (Linux)', () => {
  it('7. reads the session column where ps gives one, and none where it does not', () => {
    expect(stable(srow(100, 1, 100, 100, '05:00'))).toEqual([{ pid: 100, ppid: 1, pgid: 100, sid: 100, zombie: false, age: 300 }]);
    expect(table(row(100, 1, 100, '05:00'))[0].sid).toBeUndefined();
  });

  it('8. takes a process of the root\'s session whose parent ended, in a group of its own', () => {
    const tree = new ProcessTree([100]);
    // 100 leads its session (a terminal's shell); 200 is the CLI, in a group of its own.
    tree.grow(stable(srow(100, 1, 100, 100, '05:00'), srow(200, 100, 200, 100, '04:00')), T0);
    // The CLI started 300 in a group of its own and exited; 300 is init's now, and 100 is gone too.
    tree.grow(stable(srow(300, 1, 300, 100, '00:01')), T0 + 2_000);
    expect(tree.targets).toContain(300);
    expect(tree.anyLeft(stable(srow(300, 1, 300, 100, '00:01')))).toBe(true);
  });

  it('9. takes nothing of another session, nor of Tars\'s own, nor by session from a root that does not lead its own', () => {
    const own = process.pid;
    const tree = new ProcessTree([100]);
    tree.grow(stable(srow(own, 1, own, 50), srow(100, own, 100, 100, '05:00')), T0);
    tree.grow(stable(srow(own, 1, own, 50), srow(400, 1, 400, 77, '00:01'), srow(401, 1, 401, 50, '00:01')), T0 + 2_000);
    expect(tree.targets).not.toContain(400);
    expect(tree.targets).not.toContain(401);

    // A root in Tars's own session (no setsid): its session is Tars's, never taken.
    const shared = new ProcessTree([110]);
    shared.grow(stable(srow(own, 1, own, 50), srow(110, own, 110, 50, '05:00')), T0);
    shared.grow(stable(srow(own, 1, own, 50), srow(401, 1, 401, 50, '00:01')), T0 + 2_000);
    expect(shared.targets).not.toContain(401);
  });

  it('10. drops a session whose id a new leader took since the first read', () => {
    const tree = new ProcessTree([100]);
    tree.grow(stable(srow(100, 1, 100, 100, '05:00')), T0);
    // 100 and its whole session ended; a new session leader got pid 100, with a child.
    tree.grow(stable(srow(100, 1, 100, 100, '00:01'), srow(500, 100, 500, 100, '00:01')), T0 + 5_000);
    expect(tree.targets).not.toContain(500);
    expect(tree.targets).not.toContain(100);
  });

  it('11. ps gives a detached child\'s session on Linux, and none on macOS', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const rows = await processTable();
      const mine = rows?.find(r => r.pid === child.pid);
      expect(mine, 'the child is in the table').toBeDefined();
      if (process.platform === 'linux') expect(mine!.sid).toBe(child.pid);
      else expect(mine!.sid).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
    }
  });
});
