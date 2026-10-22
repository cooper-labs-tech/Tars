import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IPty } from 'node-pty';
import { World } from '../process-world';

/**
 * An agent's terminal, ended by a stop or by the quit, leaves nothing its CLI was starting at that moment (the
 * follow-up of the QA's B1 on #358, found with #422).
 *
 * endTerminals (core/pty-manager.ts: endAllTerminals at the quit, endTerminalTree at a stop) read the terminal's tree
 * from ps once, before the hangup, then watched only the groups that read found, and gave SIGKILL to what was left of
 * them. A command the CLI started during that read, in a group of its own, was in no read; the CLI died at the hangup
 * its shell relays; the command went to launchd, and nothing tied it to the terminal any more.
 *
 * How it fails, written before the code (2026-10-15):
 * 1. A stop leaves a command the CLI started during the read, whose parent died at the hangup.
 * 2. The quit leaves it the same way.
 * 3. That command, deaf to the hangup, is not ended at all: not in the tree, so not in the SIGKILL either.
 * 4. A group stopped to be read is left stopped.
 * 5. Tars's own group, or init's, is signalled.
 * 6. The user's own shell panel is held or hung up as an agent's tree: a job its user left there with nohup
 *    survives the quit, as in any terminal app.
 * 7. On win32 a group is stopped, continued or hung up: there are no process groups, and the tree is not read
 *    from ps (its end is #358's taskkill).
 * 8. (added with the code, for the mutant that hangs up the shells alone) Continued, the CLI starts one command more
 *    before its shell's hangup reaches it, which the shell relays only once it runs again: that command is left.
 * The processes are a table in memory (process-world.ts): what is born during a read is born right after its
 * snapshot, so the race is the same at every run and on every host.
 */

const state = vi.hoisted(() => ({ world: undefined as unknown as { print(): string } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { once: vi.fn(), exit: vi.fn() }, BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }) }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const answer = (file: string): string => {
    if (file === 'ps') return state.world.print(args);
    throw new Error(`not in this test: ${file}`);
  };
  return {
    ...actual,
    execFile: ((file: string, _args: unknown, ...rest: unknown[]) => {
      const done = rest.find(r => typeof r === 'function') as (err: Error | null, out?: string, errOut?: string) => void;
      try { done(null, answer(file), ''); } catch (err) { done(err as Error, '', ''); }
      return {} as never;
    }) as typeof actual.execFile,
    execFileSync: ((file: string) => answer(file)) as typeof actual.execFileSync,
  };
});

import { endAllTerminals, endTerminalTree, ptyProcesses, quickPtyProcesses } from '../../../electron/core/pty-manager';

const TARS_GROUP = 69_000;
const SHELL = 80_001;
const CLI = 80_002;
const LATE = 80_003;
const QUICK = 80_101;
const QUICK_JOB = 80_102;
const NOHUP = 80_103;
const ONE_MORE = 80_004;

/** An agent's terminal: its shell, the CLI the shell runs as a job, and a command the CLI starts during the first read. */
function agentTerminal(world: World, late: { ignores?: string[] } = {}): void {
  world.add(process.pid, 1, TARS_GROUP);
  world.add(SHELL, process.pid, SHELL, { jobs: [CLI] });
  world.add(CLI, SHELL, CLI);
  world.after(1, () => world.add(LATE, CLI, LATE, late));
}

let world: World;
const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
function use(next: World, platform: NodeJS.Platform): void {
  world = next;
  state.world = next;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => world.kill(pid, sig ?? 'SIGTERM')) as typeof process.kill);
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', real);
  ptyProcesses.clear();
  quickPtyProcesses.clear();
});

/** node-pty's terminal, as endTerminals uses it: its shell's pid, the hangup, and the exit node-pty reports. */
function terminalOf(shell: number): IPty {
  const exits: Array<(e: { exitCode: number }) => void> = [];
  world.onDeath(shell, () => { for (const cb of exits.splice(0)) cb({ exitCode: 0 }); });
  return {
    pid: shell,
    kill: (signal = 'SIGHUP') => { process.kill(shell, signal as NodeJS.Signals); },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => undefined }; },
  } as unknown as IPty;
}

function expectNothingLeftStopped(): void {
  expect([...world.procs.values()].filter(p => p.state === 'stopped').map(p => p.pid), 'left stopped').toEqual([]);
  for (const group of new Set(world.signals.filter(s => s.sig === 'SIGSTOP').map(s => s.target))) {
    const lastStop = world.signals.map(s => `${s.target} ${s.sig}`).lastIndexOf(`${group} SIGSTOP`);
    expect(world.signals.slice(lastStop).some(s => s.target === group && s.sig === 'SIGCONT'), `group ${-group} continued`).toBe(true);
  }
}

function expectTarsAndInitSpared(): void {
  const spared = [-TARS_GROUP, process.pid, -process.pid, 0, -1, 1];
  expect(world.signals.filter(s => spared.includes(s.target) && s.sig !== '0')).toEqual([]);
}

describe.each(['darwin', 'linux'] as const)('on %s', (platform) => {
  it('1, 4, 5. a stop ends a command the CLI started during the read, leaves no group stopped, and spares Tars and init', async () => {
    const w = new World();
    agentTerminal(w);
    use(w, platform);
    await endTerminalTree(terminalOf(SHELL), 1_000);
    expect(world.alive(LATE), 'the command started during the read').toBe(false);
    expect([SHELL, CLI].filter(pid => world.alive(pid))).toEqual([]);
    expectNothingLeftStopped();
    expectTarsAndInitSpared();
  });

  it('2, 4, 5, 6. the quit does the same, and leaves the user\'s own shell panel as it did', async () => {
    const w = new World();
    agentTerminal(w);
    w.add(QUICK, process.pid, QUICK, { jobs: [QUICK_JOB] });
    w.add(QUICK_JOB, QUICK, QUICK_JOB);
    w.add(NOHUP, QUICK, NOHUP, { ignores: ['SIGHUP'] });
    use(w, platform);
    ptyProcesses.set('agent', terminalOf(SHELL));
    quickPtyProcesses.set('panel', terminalOf(QUICK));
    await endAllTerminals(1_000);
    expect(world.alive(LATE), 'the command started during the read').toBe(false);
    expect([SHELL, CLI, QUICK, QUICK_JOB].filter(pid => world.alive(pid))).toEqual([]);
    expect(world.alive(NOHUP), 'a job left with nohup in the user\'s panel').toBe(true);
    expect(world.signals.filter(s => [-QUICK, -QUICK_JOB, -NOHUP, NOHUP].includes(s.target) && s.sig !== 'SIGHUP')).toEqual([]);
    expect(world.signals.filter(s => s.target === -NOHUP || s.target === NOHUP)).toEqual([]);
    expectNothingLeftStopped();
    expectTarsAndInitSpared();
  });

  it('3. a command started during the read and deaf to the hangup is ended with the tree, after its grace', async () => {
    const w = new World();
    agentTerminal(w, { ignores: ['SIGHUP', 'SIGTERM'] });
    use(w, platform);
    await endTerminalTree(terminalOf(SHELL), 300);
    expect(world.alive(LATE), 'the deaf command started during the read').toBe(false);
    expectNothingLeftStopped();
  });
});

describe.each(['darwin', 'linux'] as const)('on %s, a CLI that goes on', (platform) => {
  it('8. continued, the CLI is hung up already: it starts nothing more', async () => {
    const w = new World();
    w.add(process.pid, 1, TARS_GROUP);
    w.add(SHELL, process.pid, SHELL, { jobs: [CLI] });
    w.add(CLI, SHELL, CLI, { onContinue: () => w.add(ONE_MORE, CLI, ONE_MORE) });
    use(w, platform);
    await endTerminalTree(terminalOf(SHELL), 1_000);
    expect(world.alive(ONE_MORE), 'a command started as the CLI went on').toBe(false);
    expect(world.alive(CLI)).toBe(false);
  });
});

describe('on win32', () => {
  it('7. the hangup alone: no group is stopped, continued or hung up', async () => {
    const w = new World();
    agentTerminal(w);
    use(w, 'win32');
    await endTerminalTree(terminalOf(SHELL), 300);
    expect(world.signals.filter(s => s.target < 0 && s.sig !== 'SIGKILL')).toEqual([]);
    expect(world.signals.filter(s => s.sig === 'SIGSTOP' || s.sig === 'SIGCONT')).toEqual([]);
  });
});
