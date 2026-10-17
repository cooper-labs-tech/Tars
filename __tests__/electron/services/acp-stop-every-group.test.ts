import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/**
 * A stopped run ends every command its CLI started, the ones in process
 * groups of their own included (the Audit's gate of #191).
 *
 * #191 put the process Tars spawns in a group of its own and signals that
 * group. Claude Code's Bash tool runs each command in a group of its own,
 * though. Measured by the Audit with claude-agent-acp 0.81.1: a run whose
 * claude was wedged (SIGSTOP) was stopped, npm, the adapter and claude died
 * with their group, and the `zsh -c` and its `sleep 301` lived on, reparented
 * to launchd, until killed by hand. Only a CLI that cooperates ended them.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A command started in a group of its own outlives the stop, when it
 *    ignores SIGTERM and when the process that started it cannot pass the
 *    stop on (here the fake agent ignores SIGTERM and never asks it to go).
 * 2. A command in a group of its own that would end on SIGTERM is only
 *    reached by the SIGKILL two seconds later, or never: SIGTERM does not
 *    reach its group.
 * 3. A command started by that command, in a third group, outlives it.
 * 4. The groups are looked for after the first signal: by then the processes
 *    that linked them to the run are dead, the rest are reparented, and
 *    nothing ties them to the run any more.
 * 5. Over-reach: a process group that is not the run's, in the same account,
 *    is signalled too.
 * 6. Without ps (or with ps failing), nothing is signalled at all, where the
 *    run's own group still has to go.
 *
 * On win32 (audit A21, and the phase 0 run where ps was ENOENT at every stop):
 * 7. The stop ends the process Tars spawned alone, `child.kill()`, and every
 *    command under it lives on. Windows has no process groups to signal and
 *    no ps: the tree is ended from the root by taskkill /T /F
 *    (platform/kill-tree.ts), before anything under it has lost its parent.
 * 8. When taskkill cannot be run, nothing is ended, where the process Tars
 *    spawned still has to go (case 6's counterpart: the tool that finds the
 *    tree is taskkill there, not ps).
 * Cases 1 to 6 run on every platform with the same assertions. On win32 the
 * witness that the commands are out of the naive kill's reach is their
 * parentage (each under the one before it, none the root) rather than their
 * group, and ignoring SIGTERM changes nothing there: taskkill /F does not ask.
 *
 * Not constructible here, and guarded in the code instead: a descendant in
 * Tars's own group. The run leads a session of its own (detached is setsid),
 * and a process can only join a group of its own session.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-groups-'));
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
/** The tool the stop finds the tree with: ps on macOS and Linux, taskkill on Windows. */
const treeTool = (file: string) => file === 'ps' || /[\\/]taskkill\.exe$/i.test(file);

/** ps (taskkill on Windows), as the product runs it, unless a case takes it away. */
const psBroken = { value: false };
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
  };
});

import { delegateOverAcp, stopAcpRuns } from '../../../electron/services/acp/delegate';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { Leftovers } from '../../setup/leftover-processes';

const agent = (id: string) => ({
  id, name: id, status: 'running', projectPath: tmp, provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what: string, test: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); }
};

/** win32: each process's parent, from Win32_Process. The filter holds numbers only. */
function parentsOf(pids: number[]): Map<number, number> {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const filter = pids.map(pid => `ProcessId=${Math.trunc(pid)}`).join(' OR ');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`]).toString();
  return new Map(out.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(' ').map(Number) as [number, number]));
}

// Ended by id only while the id is still the process the test saw: see leftover-processes.ts.
const leftovers = new Leftovers();
afterEach(() => {
  psBroken.value = false;
  leftovers.end();
}, 60_000);

/** Starts a delegated run of `tag` and waits until its agent and both commands are up. */
async function runStarted(tag: string, stubborn: boolean) {
  const a = agentWithDetachedWork(tag, stubborn);
  launch = a;
  const running = delegateOverAcp({ agent: agent(`agent-${tag}`), task: 'work', appSettings: {} as AppSettings, timeoutMs: 60_000 });
  await until('the run started its commands', () => fs.existsSync(a.pidFile) && fs.readFileSync(a.pidFile, 'utf-8').split(' ').length === 3);
  const [adapter, command, nested] = fs.readFileSync(a.pidFile, 'utf-8').split(' ').map(Number);
  leftovers.push(adapter, command, nested);
  if (onWindows) {
    // The witness there: each command is a process under the one before it,
    // which ending the root alone does not reach.
    const parents = parentsOf([adapter, command, nested]);
    expect(parents.get(command)).toBe(adapter);
    expect(parents.get(nested)).toBe(command);
    return { running, adapter, command, nested };
  }
  // The witness: each command really is in a group of its own, not the run's.
  const groupOf = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim());
  expect(groupOf(command)).toBe(command);
  expect(groupOf(nested)).toBe(nested);
  expect(groupOf(adapter)).not.toBe(command);
  return { running, adapter, command, nested };
}

describe('a stopped run', { timeout: 30_000 }, () => {
  it('1, 3, 4. ends the commands its CLI started in groups of their own, when nothing there cooperates', async () => {
    const { running, adapter, command, nested } = await runStarted('stubborn', true);

    await stopAcpRuns('agent-stubborn', 'the agent was stopped');
    await running;

    await until('every process of the run is gone', () => !alive(adapter) && !alive(command) && !alive(nested), 6_000);
  });

  it('2. reaches those groups with SIGTERM first, not only with the SIGKILL two seconds on', async () => {
    const { running, command, nested } = await runStarted('polite', false);

    const stopped = Date.now();
    const stop = stopAcpRuns('agent-polite', 'the agent was stopped');
    await until('the commands ended on SIGTERM', () => !alive(command) && !alive(nested), 5_000);
    // stopAcpRuns waits 1.5 s for the cancel to be honoured before it ends
    // the processes; the SIGKILL would come 2 s after that.
    expect(Date.now() - stopped).toBeLessThan(1_500 + 1_500);
    await stop;
    await running;
  });

  it('5. leaves a process group that is not the run\'s alone', async () => {
    const outsider = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
    leftovers.push(outsider.pid!);
    const { running, command } = await runStarted('neighbour', true);

    await stopAcpRuns('agent-neighbour', 'the agent was stopped');
    await running;
    await until('the run\'s command is gone', () => !alive(command), 6_000);
    await new Promise(r => setTimeout(r, 300));

    expect(alive(outsider.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  });

  it('6. still ends the run\'s own group when ps cannot be run', async () => {
    const { running, adapter } = await runStarted('nops', true);
    psBroken.value = true;

    await stopAcpRuns('agent-nops', 'the agent was stopped');
    await running;

    await until('the process Tars spawned is gone', () => !alive(adapter), 6_000);
  });
});
