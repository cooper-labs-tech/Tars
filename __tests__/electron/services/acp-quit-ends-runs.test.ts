import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/**
 * Quitting Tars ends its delegated runs, before the app exits.
 *
 * Measured on #197 (2026-09-24, claude-agent-acp 0.81.1, app.quit() in a
 * sandbox Tars): before-quit did nothing for a delegated run. A run that still
 * answered ended by itself about 2.4 s after the quit, once its stdin closed.
 * A run whose adapter was wedged (SIGSTOP) was whole 14 s later, npm, adapter,
 * claude, zsh and sleep, reparented to launchd. The stop path cannot serve at
 * quit: it reads ps asynchronously and sends its SIGKILL two seconds on, and
 * neither outlives the process.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A run is left running when the quit returns: its processes outlive Tars.
 * 2. A stuck run (the process Tars spawned SIGSTOPped, commands ignoring
 *    SIGTERM) outlives it: only a SIGKILL, sent before the quit returns, ends it.
 * 3. The commands the CLI ran in process groups of their own outlive it.
 * 4. A run that ends on SIGTERM is held for the whole grace anyway, and the
 *    quit takes longer than it has to.
 * 5. The quit is held without bound by a run that will not die.
 * 6. Over-reach: a process group that is not a run's, or Tars's own, is signalled.
 * 7. Without ps, nothing is ended, where the process Tars spawned still has to go.
 * 8. The quit never calls it.
 * 9. (the Audit's gate of #199) A ps that hangs holds the quit for every read:
 *    three reads at 2 s each stretched it to 6.5 s. One deadline bounds them all.
 * 10. (same gate) With no run under way, ps is run anyway: the shortcut that
 *    skips it had no test, and a mutant that removed it survived.
 *
 * And of the tests themselves (2026-10-07): a case that fails before it has
 * read its run's pids, as one did on 2026-10-06, never handed them to the
 * cleanup, and the stand-ins that ignore SIGTERM ran on for 23 minutes until
 * they were ended by hand.
 * 11. A test leaves a stand-in, or what it started, running after it ends.
 *
 * On win32 (audit A21, and the phase 0 run where ps was ENOENT at every quit):
 * 12. The quit ends each run's root alone, `child.kill()`, and what runs under
 *    it outlives Tars. There the tree is ended by taskkill /T /F run while the
 *    quit waits (platform/kill-tree.ts), and taskkill takes the place of ps in
 *    cases 7, 9 and 10: missing, hung, and not run at all for no run.
 * Every case runs on every platform with the same assertions. What differs on
 * win32: the witness that the commands are out of the naive kill's reach is
 * their parentage rather than their group; a run cannot be made stuck with
 * SIGSTOP, which Windows does not have, and does not need to be, since
 * taskkill /F asks nothing of the process it ends; and a process is alive
 * until Windows says it has exited, there being no zombie to tell apart.
 * And 11's sweep reads the command lines from Win32_Process, ps having none
 * there, after a case that failed only: one query takes up to 25 s on CI's
 * runner, and a case that passed has handed its pids to the cleanup.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-quit-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

/**
 * An ACP agent that, asked for a turn, starts a command in a group of its own
 * which starts another in a third group. `stubborn`: the agent and both
 * commands ignore SIGTERM, as a wedged CLI and a command that traps it would.
 */
function agentWithDetachedWork(tag: string, stubborn: boolean): { command: string; args: string[]; pidFile: string } {
  const pidFile = path.join(tmp, `${tag}.pid`);
  const file = path.join(tmp, `${tag}.mjs`);
  const ignore = stubborn ? "process.on('SIGTERM', () => {});" : '';
  // The grandchild writes its pid, then the child writes both, then the agent all three.
  const grandchild = `${ignore} require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
  const child = `${ignore}
    const { spawn } = require('child_process');
    const fs = require('fs');
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1] + '.g'], { detached: true, stdio: 'ignore' });
    const wait = setInterval(() => {
      if (!fs.existsSync(process.argv[1] + '.g')) return;
      clearInterval(wait);
      fs.writeFileSync(process.argv[1], process.pid + ' ' + g.pid);
    }, 20);
    setInterval(() => {}, 1000);`;
  fs.writeFileSync(file, `
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
${ignore}
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    const out = ${JSON.stringify(pidFile)} + '.c';
    spawn(process.execPath, ['-e', ${JSON.stringify(child)}, out], { detached: true, stdio: 'ignore' });
    const wait = setInterval(() => {
      if (!existsSync(out)) return;
      clearInterval(wait);
      writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + readFileSync(out, 'utf-8'));
    }, 20);
  }
}
`);
  return { command: process.execPath, args: [file], pidFile };
}

let launch: { command: string; args: string[] };
vi.mock('../../../electron/services/acp/registry', () => ({ acpLaunchFor: () => launch, loadAcpRegistry: async () => undefined }));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({ getMcpOrchestratorPath: () => serverBundle, getMcpMemoryPath: () => serverBundle }));
vi.mock('../../../electron/providers', () => ({ getProvider: () => ({ getPtyEnvVars: () => ({}), configDir: '/not-claude' }) }));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

const onWindows = process.platform === 'win32';
/** The tool the quit finds the tree with: ps on macOS and Linux, taskkill on Windows. */
const treeTool = (file: string) => file === 'ps' || /[\\/]taskkill\.exe$/i.test(file);

/** ps (taskkill on Windows), as the product runs it, unless a case takes it away. */
const psBroken = { value: false };
/** ps (taskkill) answers nothing until the caller's own timeout ends it. */
const psHung = { value: false };
/** How many times the product ran ps (taskkill), while counted. */
const psRuns = { counting: false, count: 0 };
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      if (psBroken.value && treeTool(file)) {
        const done = rest.find(r => typeof r === 'function') as ((err: Error, out: string, errOut: string) => void) | undefined;
        setImmediate(() => done?.(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''));
        return {} as never;
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
    execFileSync: ((file: string, ...rest: unknown[]) => {
      if (psRuns.counting && treeTool(file)) psRuns.count++;
      if (psBroken.value && treeTool(file)) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
      if (psHung.value && treeTool(file)) {
        const options = rest.find(r => r && typeof r === 'object' && !Array.isArray(r)) as { timeout?: number } | undefined;
        // A process that answers nothing for 30 s, on any platform (Windows has no sleep).
        return (actual.execFileSync as (...a: unknown[]) => unknown)(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: options?.timeout ?? 30_000 });
      }
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFileSync,
  };
});

import { delegateOverAcp, endAcpRunsOnQuit } from '../../../electron/services/acp/delegate';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { Leftovers } from '../../setup/leftover-processes';

const agent = (id: string) => ({
  id, name: id, status: 'running', projectPath: tmp, provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus);
/** Alive, and not a zombie: the test process is the fake agent's parent and
 *  cannot reap it while the quit holds the thread, as Tars cannot either. */
const alive = (pid: number) => {
  if (onWindows) { try { process.kill(pid, 0); return true; } catch { return false; } }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};

/** win32: each process's parent, from Win32_Process. The filter holds numbers only. */
function parentsOf(pids: number[]): Map<number, number> {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const filter = pids.map(pid => `ProcessId=${Math.trunc(pid)}`).join(' OR ');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`]).toString();
  return new Map(out.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(' ').map(Number) as [number, number]));
}
const until = async (what: string, test: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); }
};

/** The processes whose argv names this file's folder: a run's adapter, and the commands it started. */
function startedIn(dir: string): number[] {
  if (onWindows) return commandLinesNaming(dir);
  const ps = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && m[2].includes(dir + path.sep) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}

/** win32: the processes whose command line names `dir`, from Win32_Process. */
function commandLinesNaming(dir: string): number[] {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'],
  { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }).toString();
  return out.split(/\r?\n/).flatMap(line => {
    const m = /^(\d+) (.*)$/.exec(line);
    return m && m[2].includes(dir + path.sep) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}

// Ended by id only while the id is still the process the test saw: see leftover-processes.ts.
const leftovers = new Leftovers();
afterEach((context) => {
  psBroken.value = false;
  psHung.value = false;
  psRuns.counting = false;
  leftovers.end();
  // 11. Whatever the case did, and even when it failed before it read its run's
  // pids: every process whose argv names this file's folder, by PID. On win32
  // after a case that failed only (see the header).
  if (onWindows && context.task.result?.state !== 'fail') return;
  for (const pid of startedIn(tmp)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}, 60_000);

/** Starts a delegated run of `tag`, and never awaits it: the app quits under it. */
async function runStarted(tag: string, stubborn: boolean) {
  const a = agentWithDetachedWork(tag, stubborn);
  launch = a;
  void delegateOverAcp({ agent: agent(`agent-${tag}`), task: 'work', appSettings: {} as AppSettings, timeoutMs: 60_000 });
  await until('the run started its commands', () => fs.existsSync(a.pidFile) && fs.readFileSync(a.pidFile, 'utf-8').split(' ').length === 3);
  const [adapter, command, nested] = fs.readFileSync(a.pidFile, 'utf-8').split(' ').map(Number);
  leftovers.push(adapter, command, nested);
  if (onWindows) {
    const parents = parentsOf([adapter, command, nested]);
    expect(parents.get(command)).toBe(adapter);
    expect(parents.get(nested)).toBe(command);
    return { adapter, command, nested };
  }
  const groupOf = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim());
  expect(groupOf(command)).toBe(command);
  expect(groupOf(nested)).toBe(nested);
  return { adapter, command, nested };
}

describe('quitting Tars with delegated runs under way', { timeout: 30_000 }, () => {
  it('1, 2, 3, 5. ends a stuck run, and what its CLI started, before the quit returns', async () => {
    const { adapter, command, nested } = await runStarted('stuck', true);
    if (!onWindows) process.kill(adapter, 'SIGSTOP');

    const began = Date.now();
    expect(endAcpRunsOnQuit()).toBe(1);
    const took = Date.now() - began;

    expect([adapter, command, nested].filter(alive), 'alive when the quit returned').toEqual([]);
    expect(took, 'the quit was held too long').toBeLessThan(2_500);
  });

  it('4. lets a run that ends on SIGTERM go without waiting out the grace', async () => {
    const { adapter, command, nested } = await runStarted('polite', false);

    const began = Date.now();
    endAcpRunsOnQuit();
    const took = Date.now() - began;

    expect([adapter, command, nested].filter(alive)).toEqual([]);
    expect(took).toBeLessThan(800);
  });

  it('6. leaves a process group that is not a run\'s alone', async () => {
    const outsider = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
    leftovers.push(outsider.pid!);
    await runStarted('neighbour', true);

    endAcpRunsOnQuit();

    expect(alive(outsider.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  });

  it('7. still ends the process Tars spawned when ps cannot be run', async () => {
    const { adapter } = await runStarted('nops', true);
    psBroken.value = true;

    endAcpRunsOnQuit();

    expect(alive(adapter)).toBe(false);
  });

  it('10. returns at once when no run is under way, without running ps', () => {
    psRuns.counting = true;
    psRuns.count = 0;
    const began = Date.now();
    expect(endAcpRunsOnQuit()).toBe(0);
    expect(Date.now() - began).toBeLessThan(100);
    expect(psRuns.count, 'ps was run for no run').toBe(0);
  });

  it('9. holds the quit a bounded time when ps hangs, and still ends the process Tars spawned', async () => {
    const { adapter } = await runStarted('hungps', true);
    psHung.value = true;

    const began = Date.now();
    endAcpRunsOnQuit();
    const took = Date.now() - began;
    psHung.value = false;

    expect(took, 'every read waited out its own timeout').toBeLessThan(2_500);
    expect(alive(adapter)).toBe(false);
  });
});

describe('the app', () => {
  it('8. ends the delegated runs when it quits', () => {
    const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');
    const quit = main.slice(main.indexOf("app.on('before-quit'"));
    const body = quit.slice(0, quit.indexOf('\n});') + 4);

    expect(body, 'not in the before-quit steps').toMatch(/endAcpRunsOnQuit/);
  });
});
