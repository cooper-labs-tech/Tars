import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { AgentStatus } from '../types';
import { agents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { emitAgentStatus } from './agent-events';
import { reportStall } from './agent-watch';
import { spellingsOf, transcriptPath } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';

/**
 * A running agent that is doing nothing (PLAN-1.9.2.md item B).
 *
 * Measured on 28/09: a Claude Code 2.1.283 froze mid-turn, its main thread in
 * openat, 0 % CPU, one child a zombie nobody reaped; Tars showed it running
 * all night, and the messages sent to it were never read. Measured on 01/10
 * over 21 live claude processes: during a turn each keeps a
 * `caffeinate -i -t 300` child, renewed (all under 300 s old); a Bash tool runs
 * as a `<shell> -c source ...shell-snapshots...` child; the MCP servers are
 * children too. A frozen event loop renews nothing: the last caffeinate exits
 * and stays a zombie.
 *
 * So an agent is stalled when it is `running`, its transcript has had no write
 * for STALL_AFTER_MS, nothing works under its CLI but its MCP servers and
 * caffeinate, and no caffeinate there is live and renewed (signOfLife: a long
 * MCP wait or a subagent shows nothing else, the Audit's gate of #283). A long Bash command writes nothing to the transcript while it
 * runs, and it is a live process under the CLI: not a stall. An MCP server
 * whose command names neither `mcp` nor `bundle.js` reads as a tool at work,
 * which can only hide a stall, never invent one.
 *
 * Claude Code only, whose transcript Tars knows where to find. Checked every
 * CHECK_EVERY_MS; `stalledSince` (the last write) is set on the agent, the
 * window is told, and so is whoever handed it the work, or else its project's
 * orchestrator, once per stall. A write, or a status other than running, ends it.
 */

export const STALL_AFTER_MS = 30 * 60_000;
export const CHECK_EVERY_MS = 60_000;

/** `age`: seconds since the process started, from ps's etime. */
export type Proc = { pid: number; ppid: number; stat: string; age?: number; command: string };

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
function seconds(etime: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  return m ? Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : undefined;
}

/** `ps -A -o pid=,ppid=,stat=,etime=,command=`, read: the command keeps its spaces. */
export function parseProcesses(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    const age = m ? seconds(m[4]) : undefined;
    if (m && age !== undefined) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], age, command: m[5].trim() });
  }
  return procs;
}

export function readProcesses(): Promise<Proc[] | undefined> {
  return new Promise(done => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,stat=,etime=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }, (err, stdout) => {
      done(err ? undefined : parseProcesses(String(stdout)));
    });
  });
}

/** claude itself, or the script node runs for it: Claude Code installed by npm is `node <...>/bin/claude`. */
const isClaude = (command: string) => {
  const [first, second] = command.split(/\s+/).map(word => path.basename(word));
  return first === 'claude' || (first === 'node' && second === 'claude');
};
const isMcpServer = (command: string) => /mcp|bundle\.js/i.test(command);
const isCaffeinate = (command: string) => /(^|\/|\()caffeinate\b/.test(command);
const isZombie = (proc: Proc) => proc.stat.startsWith('Z');

function childrenOf(pid: number, procs: Proc[]): Proc[] {
  return procs.filter(proc => proc.ppid === pid);
}

/** The claude process of a terminal: the terminal's own process when the shell exec'd it, else the first under it. */
export function cliProcess(terminalPid: number, procs: Proc[]): Proc | undefined {
  const queue = procs.filter(proc => proc.pid === terminalPid);
  for (let i = 0; i < queue.length && i < 64; i++) {
    if (isClaude(queue[i].command)) return queue[i];
    queue.push(...childrenOf(queue[i].pid, procs));
  }
  return undefined;
}

/** The command of a live process under the CLI that is neither an MCP server nor caffeinate, if any. */
export function toolAtWork(cliPid: number, procs: Proc[]): string | undefined {
  const queue = childrenOf(cliPid, procs);
  for (let i = 0; i < queue.length && i < 512; i++) {
    const proc = queue[i];
    if (isZombie(proc)) continue;
    if (isMcpServer(proc.command) || isCaffeinate(proc.command)) continue;
    return proc.command;
  }
  return undefined;
}

/**
 * How long a turn's caffeinate lives: Claude Code starts `caffeinate -i -t 300`
 * and starts another while its event loop runs.
 */
const CAFFEINATE_SECONDS = 300;

/**
 * A live caffeinate under the CLI, younger than its 300 s: its event loop is
 * renewing it, so the CLI is alive. That is what an agent inside a long MCP
 * call (wait_for_agent, delegate_task) or a subagent shows, with nothing else
 * at work and nothing written to its transcript (the Audit's gate of #283). A
 * frozen loop renews nothing: the last one exits and stays a zombie (28/09).
 * Linux has no caffeinate, and the rule is then silence and no tool at work.
 */
export function signOfLife(cliPid: number, procs: Proc[]): boolean {
  return childrenOf(cliPid, procs).some(proc => isCaffeinate(proc.command) && !isZombie(proc)
    && (proc.age === undefined || proc.age < CAFFEINATE_SECONDS));
}

/** When the agent's stall began (its last transcript write), or undefined when it is not stalled or nothing is known. */
export function stallOf(input: {
  status: string;
  provider?: string;
  transcriptWrittenAt: number | undefined;
  terminalPid: number | undefined;
  procs: Proc[] | undefined;
  now: number;
}): number | undefined {
  if (input.status !== 'running') return undefined;
  if (input.provider && input.provider !== 'claude') return undefined;
  if (input.transcriptWrittenAt === undefined || input.terminalPid === undefined || !input.procs) return undefined;
  if (input.now - input.transcriptWrittenAt < STALL_AFTER_MS) return undefined;
  const cli = cliProcess(input.terminalPid, input.procs);
  if (!cli) return undefined;
  if (toolAtWork(cli.pid, input.procs)) return undefined;
  if (signOfLife(cli.pid, input.procs)) return undefined;
  return input.transcriptWrittenAt;
}

/** The last write to the agent's current transcript, from the folder its CLI runs in. */
export function transcriptWrittenAt(agent: AgentStatus): number | undefined {
  const sessionId = agent.currentSessionId;
  if (!sessionId) return undefined;
  let latest: number | undefined;
  for (const root of [agent.ptyCwd, agent.worktreePath, agent.projectPath]) {
    if (!root) continue;
    for (const spelling of spellingsOf(root)) {
      try {
        const written = fs.statSync(transcriptPath(spelling, sessionId)).mtimeMs;
        latest = latest === undefined ? written : Math.max(latest, written);
      } catch { /* not this spelling */ }
    }
  }
  return latest;
}

function announce(agent: AgentStatus): void {
  emitAgentStatus(agent.id);
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: new Date().toISOString() });
  scheduleTick();
}

/** One look at the fleet. `procs` and `writtenAt` for the tests; ps and the transcripts otherwise. */
export async function checkStalls(
  now: number = Date.now(),
  read: { procs?: () => Promise<Proc[] | undefined>; writtenAt?: (agent: AgentStatus) => number | undefined } = {},
): Promise<void> {
  const candidates = [...agents.values()].filter(a => a.status === 'running' && a.ptyId);
  const procs = candidates.length ? await (read.procs ?? readProcesses)() : undefined;
  for (const agent of agents.values()) {
    const since = agent.status === 'running' && agent.ptyId
      ? stallOf({
        status: agent.status,
        provider: agent.provider,
        transcriptWrittenAt: (read.writtenAt ?? transcriptWrittenAt)(agent),
        terminalPid: ptyProcesses.get(agent.ptyId)?.pid,
        procs,
        now,
      })
      : undefined;
    const sinceIso = since === undefined ? undefined : new Date(since).toISOString();
    if (sinceIso === agent.stalledSince) continue;
    const isNew = !!sinceIso;
    agent.stalledSince = sinceIso;
    announce(agent);
    if (isNew) reportStall(agent, Math.floor((now - since!) / 60_000));
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startStallWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    checkStalls().catch(err => console.warn('[stall-watch] check failed:', err));
  }, CHECK_EVERY_MS);
  timer.unref?.();
}

export function stopStallWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
