import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A delegated run's processes all end, the one born while the stop read ps included (the QA's B1 on #358).
 *
 * The stop reads the run's tree from ps, then signals the groups it found: SIGTERM, then SIGKILL two seconds on,
 * after a second read. A command's command, starting while that first ps ran, was in no read. Its parent died at
 * the SIGTERM; in a group of its own, it was reparented to launchd (ppid 1), and the second read could not tie it to
 * the run. On the QA's bench, main's own compiled ProcessTree on the process shape of acp-delegation.spec.ts left
 * that grandchild 22 runs out of 22, and the spec was red 3 runs out of 5 on a Mac. Linux reads ps the same way.
 *
 * How it fails, written before the code (2026-10-15):
 * 1. The stop (AcpSession.stop) leaves a process born during its first read of ps, whose parent dies at the SIGTERM.
 * 2. The quit (endProcessTreesNow) leaves it the same way.
 * 3. A group stopped to be read is left stopped.
 * 4. Tars's own group, or init's, is signalled.
 * 5. On win32 a POSIX signal is sent, or ps is read: the tree is taskkill's there (platform/kill-tree.ts).
 * 6. A tree that keeps starting processes holds the stop: the reads end after a few rounds, and whatever they saw
 *    is ended.
 * 7. (added with the code, for the mutant that reads again only once) The tree is read again once only: a process
 *    the late one starts during that read is left, as the late one was.
 * The processes are a table in memory, ps's lines and what each signal does to the processes of a group, so the race
 * is the same at every run and on every host: what is born during a read is born right after its snapshot.
 */

interface Proc { pid: number; ppid: number; pgid: number; state: 'running' | 'stopped' | 'dead'; term: boolean }

/** A process table and the signals a group gets, as the kernel keeps them. */
class World {
  readonly procs = new Map<number, Proc>();
  readonly signals: Array<{ target: number; sig: string }> = [];
  reads = 0;
  private readonly afterRead = new Map<number, () => void>();
  private everyRead: (() => void) | undefined;

  add(pid: number, ppid: number, pgid: number): void {
    this.procs.set(pid, { pid, ppid, pgid, state: 'running', term: false });
  }

  /** What happens right after the `read`-th snapshot, while ps is still running. */
  after(read: number, then: () => void): void {
    this.afterRead.set(read, then);
  }

  afterEach(then: () => void): void {
    this.everyRead = then;
  }

  /** ps -A -o pid=,ppid=,pgid=,stat=,etime= */
  print(): string {
    const out = [...this.procs.values()].filter(p => p.state !== 'dead')
      .map(p => `${p.pid} ${p.ppid} ${p.pgid} ${p.state === 'stopped' ? 'T' : 'S'} 00:01`).join('\n');
    this.reads += 1;
    this.afterRead.get(this.reads)?.();
    this.everyRead?.();
    return out;
  }

  kill(target: number, sig: string | number): true {
    this.signals.push({ target, sig: String(sig) });
    const members = [...this.procs.values()].filter(p => p.state !== 'dead' && (target < 0 ? p.pgid === -target : p.pid === target));
    if (!members.length) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    for (const p of members) {
      if (sig === 'SIGKILL') this.end(p);
      else if (sig === 'SIGSTOP') p.state = 'stopped';
      else if (sig === 'SIGCONT') { p.state = 'running'; if (p.term) this.end(p); }
      else if (sig === 'SIGTERM') { if (p.state === 'stopped') p.term = true; else this.end(p); }
    }
    return true;
  }

  private end(p: Proc): void {
    p.state = 'dead';
    for (const child of this.procs.values()) if (child.state !== 'dead' && child.ppid === p.pid) child.ppid = 1;
  }

  alive(pid: number): boolean {
    const p = this.procs.get(pid);
    return !!p && p.state !== 'dead';
  }
}

const state = vi.hoisted(() => ({ world: undefined as unknown as { print(): string }, taskkills: [] as string[][] }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const answer = (file: string, args: unknown): string => {
    if (file === 'ps') return state.world.print();
    if (/[\\/]taskkill\.exe$/i.test(file)) { state.taskkills.push(args as string[]); return ''; }
    throw new Error(`not in this test: ${file}`);
  };
  return {
    ...actual,
    execFile: ((file: string, args: unknown, ...rest: unknown[]) => {
      const done = rest.find(r => typeof r === 'function') as (err: Error | null, out?: string, errOut?: string) => void;
      try { done(null, answer(file, args), ''); } catch (err) { done(err as Error, '', ''); }
      return {} as never;
    }) as typeof actual.execFile,
    execFileSync: ((file: string, args: unknown) => answer(file, args)) as typeof actual.execFileSync,
  };
});

import { AcpSession, endProcessTreesNow } from '../../../electron/services/acp/client';

const ROOT = 70_001;
const COMMAND = 70_002;
const LATE = 70_003;
/** A descendant in Tars's own group: real processes cannot build it (the run leads a session of its own), the guard holds anyway. */
const IN_TARS_GROUP = 70_004;
const TARS_GROUP = 69_000;

const LATER = 70_005;

/** The spec's shape: the agent, the command its turn started, and that command's command, born during the first read. */
function lateChildWorld(): World {
  const world = new World();
  world.add(process.pid, 1, TARS_GROUP);
  world.add(ROOT, process.pid, ROOT);
  world.add(COMMAND, ROOT, COMMAND);
  world.add(IN_TARS_GROUP, ROOT, TARS_GROUP);
  world.after(1, () => world.add(LATE, COMMAND, LATE));
  return world;
}

let world: World;
const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
function use(next: World, platform: NodeJS.Platform): void {
  world = next;
  state.world = next;
  state.taskkills.length = 0;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => world.kill(pid, sig ?? 'SIGTERM')) as typeof process.kill);
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', real);
});

/** A session whose agent is the root, as start() leaves it. */
function sessionOf(root: number): AcpSession {
  const session = new AcpSession({ command: 'npx', args: [] }, { cwd: '/' });
  (session as unknown as { child: unknown }).child = { pid: root, exitCode: null, signalCode: null, kill: vi.fn() };
  return session;
}

/** The stop, through its two seconds of grace and the SIGKILL. */
async function stop(root: number): Promise<void> {
  sessionOf(root).stop();
  await vi.advanceTimersByTimeAsync(2_500);
}

function expectNothingLeftStopped(): void {
  expect([...world.procs.values()].filter(p => p.state === 'stopped').map(p => p.pid), 'left stopped').toEqual([]);
  const stopped = new Set(world.signals.filter(s => s.sig === 'SIGSTOP').map(s => s.target));
  for (const group of stopped) {
    const lastStop = world.signals.map(s => `${s.target} ${s.sig}`).lastIndexOf(`${group} SIGSTOP`);
    expect(world.signals.slice(lastStop).some(s => s.target === group && s.sig === 'SIGCONT'), `group ${-group} continued`).toBe(true);
  }
}

function expectTarsAndInitSpared(): void {
  const spared = [-TARS_GROUP, process.pid, -process.pid, 0, -1, 1];
  expect(world.signals.filter(s => spared.includes(s.target) && s.sig !== '0')).toEqual([]);
}

describe.each(['darwin', 'linux'] as const)('on %s', (platform) => {
  it('1, 3, 4. the stop ends a process born during its first read, leaves no group stopped, and spares Tars and init', async () => {
    use(lateChildWorld(), platform);
    await stop(ROOT);
    expect(world.alive(LATE), 'the late grandchild').toBe(false);
    expect([ROOT, COMMAND].filter(pid => world.alive(pid))).toEqual([]);
    expectNothingLeftStopped();
    expectTarsAndInitSpared();
  });

  it('2, 3, 4. the quit does the same', () => {
    use(lateChildWorld(), platform);
    endProcessTreesNow([ROOT]);
    expect(world.alive(LATE), 'the late grandchild').toBe(false);
    expect([ROOT, COMMAND].filter(pid => world.alive(pid))).toEqual([]);
    expectNothingLeftStopped();
    expectTarsAndInitSpared();
  });

  it('6. a tree that keeps starting processes: a few reads, then what they saw is ended', async () => {
    const endless = new World();
    endless.add(process.pid, 1, TARS_GROUP);
    endless.add(ROOT, process.pid, ROOT);
    endless.add(COMMAND, ROOT, COMMAND);
    let newest = COMMAND;
    let next = 71_000;
    endless.afterEach(() => { const pid = next++; endless.add(pid, newest, pid); newest = pid; });
    use(endless, platform);
    await stop(ROOT);
    expect(world.reads).toBeLessThanOrEqual(8);
    expectNothingLeftStopped();
    const signalled = new Set(world.signals.filter(s => s.sig === 'SIGTERM').map(s => -s.target));
    expect([...world.procs.values()].filter(p => p.state !== 'dead' && signalled.has(p.pgid)).map(p => p.pid)).toEqual([]);
  });
});

describe.each(['darwin', 'linux'] as const)('on %s, two generations late', (platform) => {
  it('7. the stop and the quit read again until a read finds no group more', async () => {
    const twice = () => { const w = lateChildWorld(); w.after(2, () => w.add(LATER, LATE, LATER)); return w; };
    use(twice(), platform);
    await stop(ROOT);
    expect([LATE, LATER].filter(pid => world.alive(pid)), 'after the stop').toEqual([]);
    vi.restoreAllMocks();
    use(twice(), platform);
    endProcessTreesNow([ROOT]);
    expect([LATE, LATER].filter(pid => world.alive(pid)), 'after the quit').toEqual([]);
  });
});

describe('on win32', () => {
  it('5. the stop and the quit end the tree with taskkill, read no ps and send no signal', async () => {
    use(lateChildWorld(), 'win32');
    await stop(ROOT);
    endProcessTreesNow([ROOT]);
    expect(state.taskkills).toEqual([['/PID', String(ROOT), '/T', '/F'], ['/PID', String(ROOT), '/T', '/F']]);
    expect(world.reads).toBe(0);
    expect(world.signals).toEqual([]);
  });
});
