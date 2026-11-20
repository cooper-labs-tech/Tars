import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * A restart (the window's, or one that applies changed settings: core/agent-restart.ts) ends the terminal it
 * replaces, and everything its CLI started, before the new one launches, the way a stop does (agent-stop.ts,
 * endTerminalTree).
 *
 * Found by the Cline conformance on 187508db4: the restart only hung up its terminal's process, Cline's node launcher,
 * which waits on its `.cline` binary (spawnSync) and passes it nothing. The launcher died; the `.cline`, in the same
 * group, was left orphaned and stopped (state T), holding the agent's own folder, and was still there after Tars quit.
 *
 * How it fails, written before the code:
 * 1. A CLI deaf to the hangup, or one its launcher does not pass it on to, and what it started, outlive the restart.
 * 2. The new CLI starts while the old one still runs on the same folder: two Clines on one data folder.
 * 3. A restart that ends the tree launches nothing, or more than once, or keeps the old terminal in the map.
 *
 * The "terminal" is a real process group where node-pty's shell would be, as in agent-stop.test.ts: a bash leader
 * that relays the hangup to its job, a job deaf to SIGHUP and SIGTERM, and the job's child, which inherits both.
 */

const h = vi.hoisted(() => ({ launches: [] as Array<{ agentId: string; oldAlive: boolean }>, watch: [] as number[] }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }), Notification: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/core/agent-pty', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cliRunningIn: () => true,
}));
vi.mock('../../../electron/core/agent-launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLI_BOOT_MS: 0,
  dialogOpen: () => false,
  noteCliLaunched: () => {},
  cliLaunchedAt: () => undefined,
  launchAgent: async (agentId: string) => {
    h.launches.push({ agentId, oldAlive: h.watch.some((pid) => alive(pid)) });
    return { success: true };
  },
}));
vi.setConfig({ testTimeout: 20_000 });

import { restartAgent, resetAgentRestarts } from '../../../electron/core/agent-restart';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { IPty } from 'node-pty';
import type { AgentStatus } from '../../../electron/types';

const started: ChildProcess[] = [];
const leftovers: number[] = [];
beforeEach(() => {
  resetAgentRestarts();
  h.launches.length = 0;
  h.watch.length = 0;
});
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const c of started.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
  ptyProcesses.clear();
  agents.clear();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
}

/** A terminal whose job and grandchild ignore the hangup. */
async function deafTerminal(): Promise<{ pty: IPty; job: number; child: number }> {
  const T = `${process.env.TMPDIR || '/tmp'}/tars-restart-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const script = `
    set -m
    bash -c 'trap "" HUP TERM; sleep 300 & echo $! > "$0.child"; wait; wait' "$T" &
    job=$!
    echo $job > "$T.job"
    trap 'kill -HUP -$job 2>/dev/null; exit 0' HUP
    wait
  `;
  const leader = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, T } });
  started.push(leader);
  const read = (f: string) => { try { return Number(fs.readFileSync(f, 'utf-8').trim()); } catch { return 0; } };
  for (let i = 0; i < 100 && !(read(`${T}.job`) && read(`${T}.child`)); i++) await new Promise((r) => setTimeout(r, 20));
  const exits: Array<(e: { exitCode: number }) => void> = [];
  leader.on('exit', (code) => { for (const cb of [...exits]) cb({ exitCode: code ?? 1 }); });
  const pty = {
    pid: leader.pid!,
    kill: (signal = 'SIGHUP') => { process.kill(leader.pid!, signal as NodeJS.Signals); },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose() {} }; },
    write: () => {},
  } as unknown as IPty;
  const job = read(`${T}.job`);
  const child = read(`${T}.child`);
  for (const f of [`${T}.job`, `${T}.child`]) fs.rmSync(f, { force: true });
  leftovers.push(job, child);
  return { pty, job, child };
}

// A bash process group read through ps: POSIX only, as agent-stop.test.ts's.
const posixGroups = it.skipIf(process.platform === 'win32');

describe('a restart', () => {
  posixGroups('ends the CLI deaf to the hangup and its child before the new one launches, once (1, 2, 3)', async () => {
    const t = await deafTerminal();
    expect(alive(t.job) && alive(t.child), 'the fixture did not start').toBe(true);
    h.watch.push(t.job, t.child);
    ptyProcesses.set('pty-old', t.pty);
    const agent = {
      id: 'cline-1', name: 'Worker', status: 'idle', provider: 'cline', permissionMode: 'bypass', projectPath: '/p',
      skills: [], output: [], lastActivity: '', ptyId: 'pty-old', currentSessionId: 'sess-1', resumableSessionId: 'sess-1',
    } as unknown as AgentStatus;
    agents.set(agent.id, agent);

    expect(await restartAgent(agent.id)).toEqual({ success: true });

    expect(alive(t.job), 'the old CLI outlived the restart').toBe(false);
    expect(alive(t.child), 'what it started outlived the restart').toBe(false);
    expect(h.launches, 'one launch, once the old tree was gone').toEqual([{ agentId: 'cline-1', oldAlive: false }]);
    expect(ptyProcesses.has('pty-old')).toBe(false);
    expect(agent.lastKilledSessionId).toBe('sess-1');
  });
});
