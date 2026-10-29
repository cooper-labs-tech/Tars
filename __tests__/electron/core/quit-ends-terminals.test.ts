import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));
vi.setConfig({ testTimeout: 20_000 });

// ps, counted: the quit polls it, and must pause between reads.
const ps = vi.hoisted(() => ({ reads: 0 }));
vi.mock('../../../electron/services/acp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../electron/services/acp/client')>();
  return { ...real, processTable: () => { ps.reads++; return real.processTable(); } };
});

import { endAllTerminals, isQuitting, ptyProcesses, quickPtyProcesses, skillPtyProcesses, pluginPtyProcesses, QUIT_POLL_MS } from '../../../electron/core/pty-manager';
import type { IPty } from 'node-pty';

/**
 * What a quit does to the agents' terminals (the Orchestrator's brief after
 * #231; the crash report of #231's proof).
 *
 * killAllPty sent SIGHUP to each terminal's shell and returned, inside a
 * synchronous before-quit. The shell relays the hangup to its jobs, so the
 * CLIs died, 0.7 to 1.8 s later, measured in 21 quits; but nothing made sure
 * of it, and node-pty's exit callbacks, which need the event loop, came after
 * the quit had moved on: one of them was delivered during Electron's final
 * cleanup, threw from pty.node's ThreadSafeFunction, and aborted the app.
 *
 * Here each "terminal" is a real process group, standing where node-pty's
 * shell would: a leader and a child in a group of its own, as a CLI started
 * from an interactive shell is.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A CLI that does not die on the hangup outlives the quit.
 * 2. Its own children (an MCP server) outlive it, in its group.
 * 3. The quit waits the whole grace when everything ended at once.
 * 4. It returns before the terminals' exits were delivered, so they come
 *    during Electron's teardown (the abort).
 * 5. A process that is not in a terminal's tree is signalled.
 * 6. Over-correction: a CLI that ends on the hangup is killed before it has
 *    had its time, and loses what it writes when it exits.
 *
 * And from the Audit's gate of #235 (2026-09-28):
 * 7. The stubborn fixture was not stubborn: `trap '' HUP TERM` spliced into a
 *    single-quoted `sh -c` became `trap HUP TERM`, SIGHUP kept its default,
 *    and a quit with no SIGKILL at all passed. The fixture is checked to
 *    survive SIGHUP before anything is trusted to it.
 * 8. Something the CLI starts after the hangup, in a group of its own, is not
 *    in the tree read before it, and outlives the quit.
 * 9. node-pty delivers an exit about 200 ms after the process ended: the quit
 *    goes on before it arrives.
 * 10. The user's own shell panel (the quick terminal) is not an agent: a job
 *    left there with nohup or disown survives the quit, as in any terminal
 *    app. Only the shell itself is ended if the hangup does not end it, or the
 *    quit would wait on it forever (node-pty's waitpid).
 * 11. ps is read back to back once the exits are in, instead of once a pause.
 * 12. The hangup waits for the event loop: a quit that runs something
 *    synchronous next (the delegated runs' own grace) starts the terminals'
 *    grace only after it, and the two add up.
 *
 * And from Nexarion434's ubuntu CI (case 8 red there since 17/10, green on
 * macOS; reproduced in a node:22 container, 2026-10-23):
 * 13. A CLI that starts something in a group of its own on the hangup and
 *    exits at once leaves it to init: (pid, ppid, pgid) no longer tie it to the
 *    terminal, and the quit, with every exit in and no known group left,
 *    returned with it running. Case 8's job does just that under bash 5 (it
 *    takes two hangups, the quit's and its shell's, each ending one of its
 *    `wait`s), and does not under macOS's bash 3.2, which is why case 8 was
 *    red on Linux only. It keeps the terminal's session, which Linux's ps
 *    gives; macOS's ps gives none, so this case runs on Linux only, and on
 *    macOS such a process is caught only when a read sees it before its
 *    parent ends.
 */

const started: ChildProcess[] = [];
const pids: { job: () => number; grandchild: () => number; late: () => number }[] = [];
afterEach(() => {
  // By pid as well as by group: a run that fails leaves the job and its children behind otherwise.
  for (const t of pids.splice(0)) for (const pid of [t.job(), t.grandchild(), t.late()]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const c of started.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } try { c.kill('SIGKILL'); } catch { /* gone */ } }
  ptyProcesses.clear();
  quickPtyProcesses.clear();
  skillPtyProcesses.clear();
  pluginPtyProcesses.clear();
});

/** Running: a zombie waiting to be reaped has ended. */
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};

type Job = 'polite' | 'stubborn' | 'slow' | 'late' | 'orphaning';

/**
 * A terminal: a shell-like leader and its job, the job in a group of its own
 * with a child of its own. The leader relays SIGHUP to the job, as bash does,
 * unless `disowned`. The job:
 * - polite: ends on the hangup;
 * - stubborn: it and its child ignore SIGHUP and SIGTERM;
 * - slow: takes 0.5 s to end on the hangup, then writes `<T>.done`;
 * - late: stubborn, and on the hangup starts another child in a group of its own.
 * - orphaning: on the hangup starts another child in a group of its own, and exits at once.
 * `deafShell`: the leader ignores SIGHUP and SIGTERM, and relays nothing.
 * `exitDelayMs`: how long after the leader's end its exit is delivered, as
 * node-pty's comes about 200 ms after the process.
 */
function terminal(kind: Job, opts: { disowned?: boolean; deafShell?: boolean; exitDelayMs?: number } = {}): {
  pty: IPty; leader: ChildProcess; job: () => number; grandchild: () => number; late: () => number; done: () => boolean;
} {
  const traps: Record<Job, string> = {
    polite: '',
    stubborn: 'trap "" HUP TERM;',
    slow: 'trap "sleep 0.5; echo done > \\"$0.done\\"; exit 0" HUP;',
    late: 'set -m; trap "sleep 300 & echo \\$! > \\"$0.late\\"" HUP; trap "" TERM;',
    orphaning: 'set -m; trap "sleep 300 & echo \\$! > \\"$0.late\\"; exit 0" HUP; trap "" TERM;',
  };
  // deafShell: a shell that ignores the hangup itself, as one running a
  // foreground job that traps it does; node-pty's waitpid would hold the quit.
  const relay = opts.deafShell ? 'trap "" HUP TERM'
    : opts.disowned ? 'trap "exit 0" HUP' : "trap 'kill -HUP -$job 2>/dev/null; exit 0' HUP";
  const script = `
    set -m
    bash -c '${traps[kind]} sleep 300 & echo $! > "$0.child"; wait; wait' "$T" &
    job=$!
    echo $job > "$T.job"
    ${relay}
    wait
  `;
  const T = `${process.env.TMPDIR || '/tmp'}/tars-quit-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // bash, as the terminals run: its `set -m` gives the job a group of its own,
  // which dash, Ubuntu's /bin/sh, does not.
  const leader = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, T } });
  started.push(leader);
  const read = (f: string) => { try { return Number(fs.readFileSync(f, 'utf-8').trim()); } catch { return 0; } };
  const exits: Array<(e: { exitCode: number }) => void> = [];
  leader.on('exit', code => {
    const deliver = () => { for (const cb of [...exits]) cb({ exitCode: code ?? 0 }); };
    if (opts.exitDelayMs) setTimeout(deliver, opts.exitDelayMs); else deliver();
  });
  const pty = {
    pid: leader.pid!,
    kill: (signal = 'SIGHUP') => { process.kill(leader.pid!, signal as NodeJS.Signals); },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => exits.splice(exits.indexOf(cb), 1) }; },
  } as unknown as IPty;
  const t = {
    pty, leader,
    job: () => read(`${T}.job`), grandchild: () => read(`${T}.child`), late: () => read(`${T}.late`),
    done: () => fs.existsSync(`${T}.done`),
  };
  pids.push(t);
  return t;
}

// The fixture is a bash process group read through ps: POSIX only. On Windows a
// terminal is a ConPTY console, which the quit ends through killPty
// (pty-kill.test.ts), its tree by taskkill first (windows-terminal-tree.test.ts).
// Without bash the fixture's pids read 0, and these cases would pass on nothing.
const posixGroups = describe.skipIf(process.platform === 'win32');

const settle = async (t: { job: () => number; grandchild: () => number }) => {
  for (let i = 0; i < 50 && !(t.job() && t.grandchild()); i++) await new Promise(r => setTimeout(r, 20));
};

posixGroups('the quit, for the agents\' terminals', () => {
  it('1, 2. ends a CLI that ignores the hangup, and its children, within the grace', async () => {
    const t = terminal('stubborn');
    ptyProcesses.set('pty-1', t.pty);
    await settle(t);
    const began = Date.now();

    await endAllTerminals(1_000);

    expect(Date.now() - began).toBeLessThan(2_500);
    expect(alive(t.job()), 'the CLI outlived the quit').toBe(false);
    expect(alive(t.grandchild()), 'its child outlived the quit').toBe(false);
    expect(alive(t.leader.pid!)).toBe(false);
    expect(isQuitting()).toBe(true);
  });

  it('3, 6. returns as soon as a CLI that ends on the hangup has ended, without killing it first', async () => {
    const t = terminal('polite');
    quickPtyProcesses.set('pty-2', t.pty);
    await settle(t);
    const began = Date.now();

    await endAllTerminals(5_000);

    expect(Date.now() - began, 'waited the whole grace').toBeLessThan(2_000);
    expect(alive(t.job())).toBe(false);
  });

  it('4. resolves only once every terminal\'s exit was delivered', async () => {
    const t = terminal('polite');
    ptyProcesses.set('pty-3', t.pty);
    await settle(t);
    let delivered = false;
    t.pty.onExit(() => { delivered = true; });

    await endAllTerminals(3_000);

    expect(delivered).toBe(true);
  });

  it('5. signals nothing outside the terminals\' trees', async () => {
    const t = terminal('stubborn');
    ptyProcesses.set('pty-4', t.pty);
    const bystander = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
    started.push(bystander);
    await settle(t);

    await endAllTerminals(500);

    expect(alive(bystander.pid!)).toBe(true);
  });
});

posixGroups('the maps the quit empties (QA E9, gate of #235)', () => {
  it("ends the skill and plugin runners' trees too, a `claude auth login` terminal among them, and leaves every map empty", async () => {
    // main.ts hands pluginPtyProcesses to the accounts handlers as loginPtys.
    const skill = terminal('stubborn');
    const login = terminal('stubborn');
    skillPtyProcesses.set('skill-1', skill.pty);
    pluginPtyProcesses.set('login-1', login.pty);
    const shell = terminal('polite');
    quickPtyProcesses.set('shell-1', shell.pty);
    await settle(skill);
    await settle(login);

    await endAllTerminals(500);

    for (const t of [skill, login]) {
      expect(alive(t.job()), 'a runner deaf to the hangup outlived the quit').toBe(false);
      expect(alive(t.grandchild())).toBe(false);
    }
    for (const map of [ptyProcesses, quickPtyProcesses, skillPtyProcesses, pluginPtyProcesses]) expect(map.size).toBe(0);
  });
});

posixGroups('the fixture', () => {
  it('7. is stubborn when it says so: its job and child outlive a SIGHUP to their group', async () => {
    const t = terminal('stubborn');
    await settle(t);
    process.kill(-t.job(), 'SIGHUP');
    await new Promise(r => setTimeout(r, 300));
    expect(alive(t.job())).toBe(true);
    expect(alive(t.grandchild())).toBe(true);
  });
});

posixGroups('the quit, after the Audit\'s gate', () => {
  it('6. lets a CLI that takes half a second to end on the hangup end by itself', async () => {
    const t = terminal('slow');
    ptyProcesses.set('pty-slow', t.pty);
    await settle(t);

    await endAllTerminals(1_500);

    expect(t.done(), 'SIGKILLed before it had written what it writes on exit').toBe(true);
  });

  it('8. ends what the CLI started after the hangup, in a group of its own', async () => {
    const t = terminal('late');
    ptyProcesses.set('pty-late', t.pty);
    await settle(t);

    await endAllTerminals(800);

    expect(t.late(), 'the late child was never started').toBeGreaterThan(0);
    expect(alive(t.late()), 'what the CLI started after the hangup outlived the quit').toBe(false);
    expect(alive(t.job())).toBe(false);
  });

  // Linux only: macOS's ps gives no session, the one tie such a process keeps (13, in the header).
  it.skipIf(process.platform !== 'linux')('13. ends what the CLI started on the hangup in a group of its own when the CLI exited right after', async () => {
    for (let round = 0; round < 5; round++) {
      const t = terminal('orphaning');
      ptyProcesses.set(`pty-orphaning-${round}`, t.pty);
      await settle(t);

      await endAllTerminals(800);

      expect(t.late(), 'the late child was never started').toBeGreaterThan(0);
      expect(alive(t.job()), 'the CLI did not exit on the hangup').toBe(false);
      expect(alive(t.late()), `round ${round}: what the CLI left to init outlived the quit`).toBe(false);
    }
  });

  it('9. waits for an exit node-pty delivers 200 ms after the process ended', async () => {
    const t = terminal('polite', { exitDelayMs: 200 });
    ptyProcesses.set('pty-delayed', t.pty);
    await settle(t);
    let delivered = false;
    t.pty.onExit(() => { delivered = true; });

    await endAllTerminals(3_000);

    expect(delivered).toBe(true);
  });

  it("10. leaves a job the user disowned in their own shell panel, and ends the shell", async () => {
    const t = terminal('stubborn', { disowned: true });
    quickPtyProcesses.set('shell-1', t.pty);
    await settle(t);

    await endAllTerminals(500);

    expect(alive(t.job()), "the user's nohup job was killed").toBe(true);
    expect(alive(t.leader.pid!), 'the shell outlived the quit').toBe(false);
  });

  it("10. ends the user's shell when it ignores the hangup, and only the shell", async () => {
    const t = terminal('stubborn', { deafShell: true });
    quickPtyProcesses.set('shell-deaf', t.pty);
    await settle(t);
    process.kill(t.leader.pid!, 'SIGHUP');
    await new Promise(r => setTimeout(r, 200));
    expect(alive(t.leader.pid!), 'the fixture shell is not deaf').toBe(true);

    await endAllTerminals(500);

    expect(alive(t.leader.pid!), 'a shell that ignores the hangup outlived the quit').toBe(false);
    expect(alive(t.job()), "the user's job was killed with its shell").toBe(true);
  });

  it('10. still ends an agent terminal\'s disowned job', async () => {
    const t = terminal('stubborn', { disowned: true });
    ptyProcesses.set('pty-disowned', t.pty);
    await settle(t);

    await endAllTerminals(500);

    expect(alive(t.job())).toBe(false);
  });

  it('11. pauses between reads of ps', async () => {
    const t = terminal('stubborn');
    ptyProcesses.set('pty-ps', t.pty);
    await settle(t);
    ps.reads = 0;

    await endAllTerminals(1_000);

    // One read before the hangup, one a pause during the grace, a few for the SIGKILL.
    expect(ps.reads).toBeLessThanOrEqual(Math.ceil(1_000 / QUIT_POLL_MS) + 6);
  });

  it('12. sends the hangup before it first gives the event loop back', async () => {
    const t = terminal('polite');
    ptyProcesses.set('pty-sync', t.pty);
    await settle(t);

    const ending = endAllTerminals(3_000);
    // Something synchronous right after, as the delegated runs' grace is.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    const jobAfterBlock = alive(t.job());
    await ending;

    expect(jobAfterBlock, 'the hangup waited for the event loop').toBe(false);
  });
});

describe('main.ts, at quit', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../../electron/main.ts'), 'utf-8');
  // The whole handler, to its closing line: a fixed 3000 characters stopped short of its app.quit() once 2.0.5's
  // shutdown steps (shared servers, born watch, heavy slot, status watch, permission asks) were added to it.
  const start = main.indexOf("app.on('before-quit'");
  const quit = main.slice(start, main.indexOf('\n});\n', start) + 4);

  it('4. holds the quit until the terminals have ended, then quits again', () => {
    expect(quit).toMatch(/preventDefault\(\)/);
    expect(quit).toMatch(/endAllTerminals\(/);
    expect(quit).toMatch(/app\.quit\(\)/);
    expect(quit).not.toMatch(/\['killAllPty', killAllPty\]/);
  });

  it('12. begins the quit and sends the hangups before the delegated runs\' own grace, so the two graces run together', () => {
    // Called at once, on a line of its own: deferred by a then() or a timer,
    // its hangups would wait for the synchronous steps.
    const ending = quit.search(/\n\s*const \w+ = endAllTerminals\(\);\n/);
    expect(ending, 'endAllTerminals is not called directly').toBeGreaterThan(-1);
    expect(ending, 'endAllTerminals starts after the steps, so its grace adds to endAcpRunsOnQuit\'s').toBeLessThan(quit.indexOf("['endAcpRunsOnQuit'"));
  });
});
