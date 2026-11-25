import '../../setup/home-guard';
import { describe, it, expect, onTestFinished } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import ts from 'typescript';

import { holdExitUntilTerminalsExit, killPty, type PtyKillDeps, type QuitHold } from '../../../electron/core/pty-kill';
import type { IPty } from 'node-pty';

/**
 * Killing a terminal on Windows raises no error (audit A22, matrix row 17).
 *
 * node-pty 1.1 ends a ConPTY terminal by forking conpty_console_list_agent.js
 * with the shell's pid to list the processes on its console. That helper
 * throws `AttachConsole failed` when the shell has no console any more: every
 * kill of a terminal whose shell has exited. Reproduced before this was
 * written, Windows 11 26200, node-pty 1.1.0: 3 of 3 exited cmd.exe, under
 * Node 22 and under Electron 44. Five seconds later node-pty kills the dead
 * shell's pid anyway, which Windows may have given to another process.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. darwin/linux: anything but pty.kill(), or node-pty's internals read.
 * 2. win32, the shell has exited: the list helper is forked anyway (and
 *    throws AttachConsole failed), or a pid is killed from a stale list.
 * 3. win32, the shell runs: the processes on its console are not listed and
 *    ended as node-pty ends them, or the helper's output reaches Tars's own.
 * 4. win32, the helper fails without a list (the shell exited meanwhile):
 *    the shell's pid is killed regardless, as node-pty's five second fallback
 *    does, instead of nothing.
 * 5. win32, the helper never answers: nothing is ended, or the shell's pid is
 *    ended after the shell has exited.
 * 6. win32, a terminal that is not ConPTY through the inbox console (winpty,
 *    useConptyDll, a node-pty of another shape): altered, or not killed.
 * 7. win32, the helper cannot be forked at all: the kill throws, or the
 *    terminal is left running.
 * 8. For real, 10 exited and 10 running ConPTY terminals killed: an
 *    AttachConsole failure, an uncaught exception, a running shell left, or a
 *    list helper left running. The same run with a plain pty.kill() must show
 *    the failure, or the case proves nothing.
 *
 * Added at win-reviewer's gate (2026-09-25), written before the fix:
 * 9. A node-pty other than 1.1.x, or one whose version cannot be read, has
 *    its internals touched on the strength of their names alone, where it
 *    must get node-pty's own kill().
 *
 * Added after CI run 36240513885 (2026-09-26), where the vitest worker of
 * another file died mid-file while case 8 ran beside it:
 * 10. Case 8's own negative witness lets node-pty kill the ids of ten exited
 *    shells five seconds on, ids Windows may have handed to any process by
 *    then (on the runner, an administrator: anything). The harness records
 *    those kills and sends none, and asserts them: node-pty's plain kill()
 *    does send one per exited shell, killPty() sends none.
 * 11. (run 36247263165) Three of the ten running shells answered their id at
 *    the one reading, 7 s after the kill: still running, or ids Windows had
 *    already handed to other processes. The harness reads each shell's
 *    creation time before the kill, and waits up to 20 s more for every
 *    shell that is still that process to go; an id held by a process created
 *    since is not the shell, and is reported, not counted.
 *
 * Added for the quit that hangs (win-qa, 2026-09-27), written before the code.
 * Measured with Electron 44 and node-pty 1.1.0, electron.exe started directly
 * with 6 ConPTY terminals, idle: ended at before-quit the way the app ends them,
 * the main process outlived its `exit` event until it was killed 15 s later in
 * 7 quits of 8 (1 clean); not ended at all, 7 of 8 exited in 60 ms and 1
 * crashed (0xC0000005); ended, then quit only once every shell's exit had
 * reached the app, 8 of 8 exited in under 200 ms, nothing left running. In the
 * app itself, 8 of 16 idle quits ended in 0xC0000409 and Windows Error Reporting.
 * The shell exits a moment after its pseudo console is closed, and node-pty's
 * exit thread then calls into a Node that Electron is tearing down.
 * holdExitUntilTerminalsExit is what the quit calls after ending the terminals:
 * 12. darwin/linux: anything is held or registered, or node-pty is read.
 * 13. win32, no terminal left to wait for (none ended, or each already
 *     exited, or not node-pty 1.1's inbox ConPTY): the quit is held.
 * 14. win32: the app exits (will-quit goes through, or app.exit is called)
 *     before every terminal it waits for has reported its exit.
 * 15. win32: once they have, the app does not exit, or exits more than once.
 * 16. win32: a terminal that never reports holds the quit for ever; past
 *     the bound the app exits all the same, and says so.
 */

type Agent = {
  _useConpty?: boolean;
  _useConptyDll?: boolean;
  _innerPid?: number;
  exitCode?: number;
  _getConsoleProcessList?: () => Promise<number[]>;
};

/** A node-pty WindowsTerminal as far as kill() goes: it asks its agent for the console's processes and ends them. */
function fakeTerminal(agent: Agent | undefined) {
  const ended: number[] = [];
  let listed: Promise<unknown> | undefined;
  const pty = {
    _agent: agent,
    killCalls: 0,
    kill() {
      pty.killCalls++;
      if (agent?._getConsoleProcessList) listed = agent._getConsoleProcessList().then(list => { ended.push(...list); });
    },
  };
  return { pty: pty as unknown as IPty & { killCalls: number }, ended, listed: () => listed };
}

const original = () => Promise.reject(new Error('node-pty\'s own list was asked for'));
const conpty = (over: Partial<Agent> = {}): Agent => ({
  _useConpty: true, _useConptyDll: false, _innerPid: 4242, exitCode: undefined, _getConsoleProcessList: original, ...over,
});

/** A forked list helper, driven by the case. */
function fakeFork() {
  const calls: { module: string; args: string[]; options: unknown }[] = [];
  const children: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: boolean; kill: () => void })[] = [];
  const fork: NonNullable<PtyKillDeps['fork']> = (module, args, options) => {
    calls.push({ module, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); },
    });
    children.push(child);
    return child as never;
  };
  return { fork, calls, children };
}

const LIST_AGENT = 'C:\\x\\node_modules\\node-pty\\lib\\conpty_console_list_agent.js';

describe('killPty', () => {
  it('1. is pty.kill() on darwin and linux, and reads nothing of node-pty', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const pty = { killCalls: 0, kill() { pty.killCalls++; } };
      Object.defineProperty(pty, '_agent', { get() { throw new Error('node-pty internals were read'); } });

      killPty(pty as unknown as IPty, { platform });

      expect(pty.killCalls).toBe(1);
    }
  });

  it('2. forks nothing and ends nothing once the shell has exited', async () => {
    const forks = fakeFork();
    const { pty, ended, listed } = fakeTerminal(conpty({ exitCode: 0 }));

    killPty(pty, { platform: 'win32', fork: forks.fork, listAgent: LIST_AGENT });
    await listed();

    expect(pty.killCalls).toBe(1);
    expect(forks.calls).toHaveLength(0);
    expect(ended).toEqual([]);
  });

  it('3. lists a running shell\'s console through the same helper, silently, and ends what it names', async () => {
    const forks = fakeFork();
    const { pty, ended, listed } = fakeTerminal(conpty());

    killPty(pty, { platform: 'win32', fork: forks.fork, listAgent: LIST_AGENT });
    expect(forks.calls).toEqual([{ module: LIST_AGENT, args: ['4242'], options: { silent: true } }]);
    forks.children[0].emit('message', { consoleProcessList: [4242, 5151] });
    forks.children[0].emit('close', 0, null);
    await listed();

    expect(ended).toEqual([4242, 5151]);
  });

  it('4. ends nothing when the helper fails without a list, the shell gone meanwhile', async () => {
    const forks = fakeFork();
    const { pty, ended, listed } = fakeTerminal(conpty());

    killPty(pty, { platform: 'win32', fork: forks.fork, listAgent: LIST_AGENT });
    const child = forks.children[0];
    child.stderr.write('Error: AttachConsole failed\n');
    child.stderr.end();
    child.stdout.end();
    child.emit('close', 1, null);
    await listed();

    expect(ended).toEqual([]);
    // Read, not left to fill: a helper that says more than a pipe holds must not hang.
    expect(child.stderr.readableFlowing).toBe(true);
  });

  it('5. ends the shell alone when the helper never answers, and only while the shell still runs', async () => {
    for (const exitsMeanwhile of [false, true]) {
      const forks = fakeFork();
      const agent = conpty();
      const { pty, ended, listed } = fakeTerminal(agent);

      killPty(pty, { platform: 'win32', fork: forks.fork, listAgent: LIST_AGENT, timeoutMs: 30 });
      if (exitsMeanwhile) agent.exitCode = 0;
      await listed();

      expect(forks.children[0].killed).toBe(true);
      expect(ended).toEqual(exitsMeanwhile ? [] : [4242]);
    }
  });

  it('6. leaves winpty, useConptyDll and any other shape to node-pty, and still kills', () => {
    for (const agent of [conpty({ _useConpty: false }), conpty({ _useConptyDll: true }), { _useConpty: true } as Agent, undefined]) {
      const forks = fakeFork();
      const listBefore = agent?._getConsoleProcessList;
      const pty = { _agent: agent, killCalls: 0, kill() { pty.killCalls++; } };

      killPty(pty as unknown as IPty, { platform: 'win32', fork: forks.fork, listAgent: LIST_AGENT });

      expect(pty.killCalls).toBe(1);
      expect(agent?._getConsoleProcessList).toBe(listBefore);
      expect(forks.calls).toHaveLength(0);
    }
  });

  it('9. leaves a node-pty other than 1.1.x, or of no known version, to its own kill()', () => {
    for (const nodePtyVersion of ['1.2.0', '1.0.9', '2.1.0', '1.10.0', undefined]) {
      const forks = fakeFork();
      const agent = conpty();
      const listBefore = agent._getConsoleProcessList;
      const pty = { _agent: agent, killCalls: 0, kill() { pty.killCalls++; } };

      killPty(pty as unknown as IPty, { platform: 'win32', fork: forks.fork, listAgent: LIST_AGENT, nodePtyVersion: nodePtyVersion ?? null });

      expect(pty.killCalls, String(nodePtyVersion)).toBe(1);
      expect(agent._getConsoleProcessList, String(nodePtyVersion)).toBe(listBefore);
    }
    // And 1.1.x, the one read, is handled: the case above is not vacuous.
    const agent = conpty();
    const listBefore = agent._getConsoleProcessList;
    killPty({ _agent: agent, kill() {} } as unknown as IPty, { platform: 'win32', fork: fakeFork().fork, listAgent: LIST_AGENT, nodePtyVersion: '1.1.7' });
    expect(agent._getConsoleProcessList).not.toBe(listBefore);
  });

  it('7. still kills, and ends nothing, when the helper cannot be forked', async () => {
    const { pty, ended, listed } = fakeTerminal(conpty());

    expect(() => killPty(pty, {
      platform: 'win32', listAgent: LIST_AGENT, fork: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); },
    })).not.toThrow();
    await listed();

    expect(pty.killCalls).toBe(1);
    expect(ended).toEqual([]);
  });
});

/** Electron's app as far as the quit goes: will-quit listeners, and exit(). */
function fakeApp() {
  const listeners: ((event: { preventDefault(): void }) => void)[] = [];
  const app = {
    exits: [] as number[],
    once(event: 'will-quit', listener: (event: { preventDefault(): void }) => void) {
      expect(event).toBe('will-quit');
      listeners.push(listener);
      return app;
    },
    exit(code = 0) { app.exits.push(code); },
    /** Emits will-quit as Electron does, and says whether a listener prevented the quit. */
    willQuit(): boolean {
      let prevented = false;
      for (const listener of listeners.splice(0)) listener({ preventDefault() { prevented = true; } });
      return prevented;
    },
    listenerCount: () => listeners.length,
  };
  return app;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const terminalOf = (agent: Agent | undefined) => ({ _agent: agent, kill() {} }) as unknown as IPty;

describe('holdExitUntilTerminalsExit', () => {
  it('12. holds nothing and reads nothing of node-pty on darwin and linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const app = fakeApp();
      const pty = { kill() {} };
      Object.defineProperty(pty, '_agent', { get() { throw new Error('node-pty internals were read'); } });

      holdExitUntilTerminalsExit([pty as unknown as IPty], app as QuitHold, { platform });

      expect(app.listenerCount()).toBe(0);
      expect(app.willQuit()).toBe(false);
      expect(app.exits).toEqual([]);
    }
  });

  it('13. holds nothing when no terminal is left to wait for', () => {
    const cases: [string, IPty[], string | null][] = [
      ['none ended', [], '1.1.0'],
      ['already exited', [terminalOf(conpty({ exitCode: 0 }))], '1.1.0'],
      ['winpty', [terminalOf(conpty({ _useConpty: false }))], '1.1.0'],
      ['useConptyDll', [terminalOf(conpty({ _useConptyDll: true }))], '1.1.0'],
      ['another shape', [terminalOf(undefined), terminalOf({ _useConpty: true } as Agent)], '1.1.0'],
      ['another node-pty', [terminalOf(conpty())], '1.2.0'],
      ['no known node-pty', [terminalOf(conpty())], null],
    ];
    for (const [name, ended, nodePtyVersion] of cases) {
      const app = fakeApp();
      holdExitUntilTerminalsExit(ended, app as QuitHold, { platform: 'win32', nodePtyVersion });
      expect(app.willQuit(), name).toBe(false);
      expect(app.exits, name).toEqual([]);
    }
  });

  it('14 and 15. holds the quit until every terminal has reported its exit, then exits once', async () => {
    const agents = [conpty(), conpty({ _innerPid: 5151 }), conpty({ _innerPid: 6161 })];
    const app = fakeApp();

    holdExitUntilTerminalsExit(agents.map(terminalOf), app as QuitHold, { platform: 'win32', nodePtyVersion: '1.1.0', pollMs: 5, timeoutMs: 5_000 });

    expect(app.exits, 'exited before will-quit').toEqual([]);
    expect(app.willQuit(), 'will-quit went through with three terminals still running').toBe(true);
    agents[0].exitCode = 0;
    agents[2].exitCode = 1;
    await wait(40);
    expect(app.exits, 'exited with one terminal still running').toEqual([]);
    agents[1].exitCode = 0xC000013A;
    await wait(40);
    expect(app.exits).toEqual([0]);
    await wait(40);
    expect(app.exits, 'exited more than once').toEqual([0]);
  });

  it('16. exits past the bound when a terminal never reports, and says so', async () => {
    const app = fakeApp();
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args); };
    onTestFinished(() => { console.warn = warn; });

    holdExitUntilTerminalsExit([terminalOf(conpty())], app as QuitHold, { platform: 'win32', nodePtyVersion: '1.1.0', pollMs: 5, timeoutMs: 60 });
    expect(app.willQuit()).toBe(true);
    await wait(20);
    expect(app.exits).toEqual([]);
    await wait(120);

    expect(app.exits).toEqual([0]);
    expect(warned.map(args => String(args[0])).join('\n')).toMatch(/not exited/);
  });
});

/**
 * The harness runs in a process of its own, so that what the forked helpers
 * print lands in a pipe this test reads rather than in vitest's own stderr.
 * It loads the helper compiled from this worktree's source, and node-pty from
 * this worktree's node_modules.
 */
const HARNESS = String.raw`
const pty = require(process.env.NODE_PTY);
const { killPty } = require(process.env.PTY_KILL);
const mode = process.argv[2];
const uncaught = [];
process.on('uncaughtException', err => uncaught.push(String(err)));
const cmd = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\cmd.exe';
const spawn = args => pty.spawn(cmd, args, { cwd: process.cwd(), env: process.env, cols: 80, rows: 24 });
const exited = Array.from({ length: 10 }, () => spawn(['/d', '/c', 'exit 0']));
const running = Array.from({ length: 10 }, () => spawn(['/d', '/q', '/k']));
// An exited shell's id is free: Windows may give it to any process started
// since, and a kill sent to it ends that one (TerminateProcess, whatever it
// is). A kill of one is recorded and never sent, in both modes: node-pty's
// plain kill() sends one per exited shell five seconds on, and on CI's
// windows-latest that ended a vitest worker (run 36240513885).
// Not a running shell's: Windows may already have given it one of these ids.
const exitedIds = new Set(exited.map(t => t.pid).filter(pid => !running.some(t => t.pid === pid)));
const staleKills = [];
const sendKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (exitedIds.has(Number(pid)) && signal !== 0) { staleKills.push(Number(pid)); return true; }
  return sendKill(pid, signal);
};
const kill = mode === 'plain' ? t => t.kill() : t => killPty(t, { listAgent: process.env.LIST_AGENT });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// When the process holding each of these ids now was created, from
// Win32_Process: a shell that outlived its kill is still the process it was,
// an id that answers after its shell has gone may be another's.
const powershell = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const created = pids => {
  if (pids.length === 0) return new Map();
  const filter = pids.map(pid => 'ProcessId=' + Math.trunc(pid)).join(' OR ');
  const out = require('child_process').execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter '" + filter + "' | ForEach-Object { \"$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())\" }"],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return new Map(out.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(' ').map(Number)));
};
const holding = pids => pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
Promise.all(exited.map(t => new Promise(resolve => t.onExit(resolve)))).then(() => sleep(1500)).then(async () => {
  const runningIds = running.map(t => t.pid);
  const born = created(runningIds);
  for (const t of [...exited, ...running]) kill(t);
  // Past node-pty's own five seconds, and the helper's.
  await sleep(7000);
  // Then until every running shell has gone, 20 s at most: on CI's
  // windows-latest three were still answering at 7 s (run 36247263165).
  const until = Date.now() + 20000;
  let alive = [];
  let reused = [];
  for (;;) {
    const held = holding(runningIds);
    const now = created(held);
    alive = held.filter(pid => now.has(pid) && now.get(pid) === born.get(pid));
    reused = held.filter(pid => now.has(pid) && now.get(pid) !== born.get(pid));
    if (alive.length === 0 || Date.now() > until) break;
    await sleep(500);
  }
  process.stdout.write(JSON.stringify({ uncaught, alive, reused, born: born.size, running: runningIds, exited: [...exitedIds], staleKills }) + '\n');
  process.exit(0);
}).catch(err => {
  // Said and ended, rather than left running until the test's own timeout.
  process.stdout.write(JSON.stringify({ harnessError: String((err && err.stack) || err) }) + '\n');
  process.exit(2);
});
`;

describe.skipIf(process.platform !== 'win32')('killing 20 real ConPTY terminals', () => {
  it('8. raises no AttachConsole failure and leaves nothing running, where a plain kill() does fail', { timeout: 200_000 }, () => {
    const repo = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-pty-kill-'));
    // The killed shells ran in this folder, and Windows may hold it a moment
    // after they end: EBUSY on CI's windows-latest (run 36232894943). Node
    // retries with a linear backoff, 200 ms longer each time, 11 s at most.
    // Once the test is over, so that a cleanup that fails is reported beside
    // what the test found, never instead of it.
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const source = fs.readFileSync(path.join(repo, 'electron', 'core', 'pty-kill.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    fs.writeFileSync(path.join(dir, 'pty-kill.js'), compiled.outputText);
    fs.writeFileSync(path.join(dir, 'harness.js'), HARNESS);
    const req = createRequire(path.join(repo, 'package.json'));
    const env = {
      ...process.env,
      NODE_PTY: req.resolve('node-pty'),
      // The helper, compiled into a scratch folder, finds node-pty and reads
      // its version the way it does inside the app: by resolving it.
      NODE_PATH: path.join(repo, 'node_modules'),
      PTY_KILL: path.join(dir, 'pty-kill.js'),
      LIST_AGENT: path.join(path.dirname(req.resolve('node-pty')), 'conpty_console_list_agent.js'),
    };
    // Both streams kept: the forked helpers print on stderr, the harness reports on stdout.
    const runCapturing = (mode: 'plain' | 'killPty') => {
      const r = spawnSync(process.execPath, [path.join(dir, 'harness.js'), mode], { env, cwd: dir, encoding: 'utf8', timeout: 90_000 });
      // A harness that printed no report says how it ended (fork CI run 36998579236:
      // an empty report, and nothing else to go on).
      if (!r.stdout.trim()) {
        throw new Error(`the ${mode} harness printed no report: status ${r.status}, signal ${r.signal}, error ${r.error?.message ?? 'none'}, stderr: ${r.stderr.slice(-1500)}`);
      }
      const report = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as { uncaught: string[]; alive: number[]; reused: number[]; born: number; running: number[]; exited: number[]; staleKills: number[] };
      const failed = (report as { harnessError?: string }).harnessError;
      if (failed) throw new Error(`the ${mode} harness failed: ${failed}`);
      return { stderr: r.stderr, report };
    };
    const plain = runCapturing('plain');
    expect(plain.stderr, 'the negative witness: a plain kill() of an exited terminal no longer fails, and this helper may go').toMatch(/AttachConsole failed/);
    expect([...plain.report.staleKills].sort(), 'the negative witness: a plain kill() no longer kills the ids of the exited shells').toEqual([...plain.report.exited].sort());

    const safe = runCapturing('killPty');
    expect(safe.stderr).not.toMatch(/AttachConsole failed/);
    expect(safe.report.uncaught).toEqual([]);
    expect(safe.report.staleKills, 'the id of an exited shell was killed, which may be another process by now').toEqual([]);
    expect(safe.report.running).toHaveLength(10);
    expect(safe.report.born, 'every running shell was there to be killed').toBe(10);
    if (safe.report.reused.length > 0) console.log('pty-kill 8: ids of killed shells already held by other processes:', safe.report.reused);
    expect(safe.report.alive, 'a running terminal outlived its kill').toEqual([]);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helpers = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      // Not this PowerShell, whose own command line holds the name.
      "@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*conpty_console_list_agent*' }).Count"], { encoding: 'utf8' }).trim();
    expect(helpers, 'a list helper was left running').toBe('0');
  });
});
