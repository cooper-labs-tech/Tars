import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * Stopping an agent ends it, and says who stopped it, when and why
 * (PLAN-1.9.2.md item A, JeanBrasse 28/09).
 *
 * Measured: on 28/09 two frozen CLIs survived stop_agent, reparented to
 * launchd; on 30/09, after a stopped QA, its bench (gate.sh, then npm exec
 * tsc) survived orphaned and ignored SIGTERM. The stop sent the terminal's
 * shell its hangup and nothing more, and the agent then read `idle`, as one
 * never started, so the Dashboard resumed it at the next launch and the
 * kanban handed it work.
 *
 * How it fails, written before the code (2026-10-01):
 * 1. A CLI that ignores the hangup, and what it started, outlive the stop.
 * 2. The stop is not recorded: who (an agent, Tars, or you), when, why.
 * 3. The agent reads `idle`, like one that was never started.
 * 4. The terminal's exit, delivered after the stop, writes `completed` or
 *    `error` over `stopped`.
 * 5. The killed session is not a tombstone: its hooks bring the agent back.
 * 6. The stop is announced before it is recorded, or not at all.
 * 7. An agent with no terminal (a delegated run only) is not stopped.
 * 9. A second stop of an agent already stopped replaces the first one's who
 *    and why (the Frontend, on #281): the record says who stopped it last,
 *    not who stopped it.
 * 8. A pid that is not a child of Tars (a process that took the number
 *    since, or a stand-in a test gave as 4242) is SIGKILLed with its tree.
 *
 * Each "terminal" here is a real process group where node-pty's shell would
 * be: a bash leader that relays SIGHUP to its job, a job that ignores SIGHUP
 * and SIGTERM, and the job's child, which inherits both.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }) }));
vi.setConfig({ testTimeout: 20_000 });

import { stopAgent } from '../../../electron/core/agent-stop';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { agentStatusEmitter } from '../../../electron/services/agent-events';
import type { IPty } from 'node-pty';
import type { AgentStatus } from '../../../electron/types';

const started: ChildProcess[] = [];
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const c of started.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
  ptyProcesses.clear();
});

const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};

/** A terminal whose job and grandchild ignore the hangup. */
async function deafTerminal(): Promise<{ pty: IPty; job: number; child: number; exits: Array<(e: { exitCode: number }) => void> }> {
  const T = `${process.env.TMPDIR || '/tmp'}/tars-stop-${process.pid}-${Math.random().toString(36).slice(2)}`;
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
  for (let i = 0; i < 100 && !(read(`${T}.job`) && read(`${T}.child`)); i++) await new Promise(r => setTimeout(r, 20));
  const exits: Array<(e: { exitCode: number }) => void> = [];
  leader.on('exit', code => { for (const cb of [...exits]) cb({ exitCode: code ?? 1 }); });
  const pty = {
    pid: leader.pid!,
    kill: (signal = 'SIGHUP') => { process.kill(leader.pid!, signal as NodeJS.Signals); },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose() {} }; },
  } as unknown as IPty;
  const job = read(`${T}.job`);
  const child = read(`${T}.child`);
  leftovers.push(job, child);
  return { pty, job, child, exits };
}

function runningAgent(ptyId?: string): AgentStatus {
  return {
    id: 'a1', name: 'Worker', status: 'running', provider: 'claude', projectPath: '/p', skills: [], output: [],
    lastActivity: '2026-10-01T00:00:00.000Z', ptyId, currentSessionId: 'sess-1', currentTask: 'build', waitingReason: undefined,
  } as AgentStatus;
}

// 1, 3, 4 and 8 run a bash process group and a reparented perl, read through
// ps: POSIX only. On Windows a stop ends the ConPTY console through killPty
// (pty-kill.test.ts); its whole tree is not read there yet.
const posixGroups = it.skipIf(process.platform === 'win32');

describe('stopping an agent', () => {
  posixGroups('1, 3. ends a CLI deaf to the hangup and its child, and leaves the agent stopped, not idle', async () => {
    const t = await deafTerminal();
    expect(alive(t.job) && alive(t.child), 'the fixture did not start').toBe(true);
    ptyProcesses.set('pty-1', t.pty);
    const agent = runningAgent('pty-1');

    await stopAgent(agent, { by: 'Tars-Orchestrator', reason: 'frozen in openat for 40 minutes' }, { save: vi.fn(), announce: vi.fn() });

    expect(alive(t.job), 'the CLI outlived the stop').toBe(false);
    expect(alive(t.child), 'its child outlived the stop').toBe(false);
    expect(agent.status).toBe('stopped');
    expect(ptyProcesses.has('pty-1')).toBe(false);
  });

  it('2, 5. records who, when and why, and makes the killed session a tombstone', async () => {
    const agent = runningAgent();
    const before = Date.now();

    await stopAgent(agent, { by: 'you', reason: 'wrong branch' }, { save: vi.fn(), announce: vi.fn() });

    expect(agent.stoppedBy).toBe('you');
    expect(agent.stopReason).toBe('wrong branch');
    expect(Date.parse(agent.stoppedAt!)).toBeGreaterThanOrEqual(before - 1);
    expect(agent.lastKilledSessionId).toBe('sess-1');
    expect(agent.currentSessionId).toBeUndefined();
    expect(agent.currentTask).toBeUndefined();
    expect(agent.ptyId).toBeUndefined();
  });

  posixGroups('4. stays stopped when its terminal exits afterwards, with an error code or not', async () => {
    const t = await deafTerminal();
    ptyProcesses.set('pty-1', t.pty);
    const agent = runningAgent('pty-1');
    // What every agent terminal's exit handler checks first (main.ts,
    // agent-manager, ipc-handlers, agent-routes): its pty is still the agent's.
    t.exits.push(({ exitCode }) => { if (agent.ptyId === 'pty-1') agent.status = exitCode === 0 ? 'completed' : 'error'; });

    await stopAgent(agent, { by: 'you' }, { save: vi.fn(), announce: vi.fn() });
    await new Promise(r => setTimeout(r, 300));

    expect(agent.status).toBe('stopped');
  });

  it('6. saves and announces once, after the stop is recorded, and tells whoever waits on the agent', async () => {
    const agent = runningAgent();
    const seen: string[] = [];
    const heard = vi.fn(() => seen.push(`emitted:${agent.status}`));
    agentStatusEmitter.on('status:a1', heard);
    const save = vi.fn(() => seen.push(`saved:${agent.status}:${agent.stoppedBy}`));
    const announce = vi.fn(() => seen.push(`announced:${agent.status}`));

    await stopAgent(agent, { by: 'Tars', reason: 'asked by JeanBrasse' }, { save, announce });
    agentStatusEmitter.off('status:a1', heard);

    expect(seen).toEqual(['saved:stopped:Tars', 'emitted:stopped', 'announced:stopped']);
  });

  posixGroups('8. never SIGKILLs a process that is not a child of Tars, whatever pid the terminal names', async () => {
    // A sleep leading a group of its own, whose parent exits at once:
    // reparented to launchd, nobody's child here, as a process that took a
    // terminal's old pid would be.
    const stranger = Number(execFileSync('/bin/bash', ['-c',
      `perl -e 'setpgrp(0, 0); $SIG{HUP} = "IGNORE"; $SIG{TERM} = "IGNORE"; exec "sleep", "300"' >/dev/null 2>&1 & echo $!`,
    ]).toString().trim());
    leftovers.push(stranger);
    expect(alive(stranger)).toBe(true);
    const pty = { pid: stranger, kill: () => {}, onExit: () => ({ dispose() {} }) } as unknown as IPty;
    ptyProcesses.set('pty-x', pty);

    await stopAgent(runningAgent('pty-x'), { by: 'you' }, { save: vi.fn(), announce: vi.fn() });
    await new Promise(r => setTimeout(r, 2_000));

    expect(alive(stranger), 'a process Tars did not start was killed').toBe(true);
  });

  it('9. keeps the first stop when an agent already stopped is stopped again, and says so', async () => {
    const agent = runningAgent();
    await stopAgent(agent, { by: 'Tars-Orchestrator', reason: 'frozen' }, { save: vi.fn(), announce: vi.fn() });
    const first = { stoppedBy: agent.stoppedBy, stoppedAt: agent.stoppedAt, stopReason: agent.stopReason };
    const save = vi.fn();
    const announce = vi.fn();

    const stoppedNow = await stopAgent(agent, { by: 'Other Agent', reason: 'tidying up' }, { save, announce });

    expect(stoppedNow).toBe(false);
    expect({ stoppedBy: agent.stoppedBy, stoppedAt: agent.stoppedAt, stopReason: agent.stopReason }).toEqual(first);
    expect(save).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('7. stops an agent that has no terminal, only a delegated run', async () => {
    const agent = { ...runningAgent(), ptyId: undefined };
    await stopAgent(agent, { by: 'you' }, { save: vi.fn(), announce: vi.fn() });
    expect(agent.status).toBe('stopped');
  });
});
