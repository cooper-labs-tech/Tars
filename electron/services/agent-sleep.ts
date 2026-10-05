import type { AgentStatus } from '../types';
import { agents, saveAgents } from '../core/agent-manager';
import { ptyProcesses, endTerminalTree, fieldInUse } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { sessionStarting } from '../core/agent-launch';
import { fallAsleep } from '../core/agent-asleep';
import { terminalSnapshot } from '../core/terminal-mirror';
import { getProvider } from '../providers';
import { isSuperAgent } from '../utils';
import { resolveResumeSessionId } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { emitAgentStatus } from './agent-events';
import { holdsFor } from './agent-watch';
import { owedKanban } from './api-routes/kanban-routes';
import { waitingDeliveries } from './bus-store';
import { openQuestionOf } from './user-questions';
import { cliProcess, readProcesses, signOfLife, toolAtWork, type Proc } from './stall-watch';

/**
 * Agents with no turn for 30 minutes are put to sleep: their CLI and all it
 * started are ended, their conversation kept, and the first thing that needs
 * them wakes them on it (core/agent-asleep.ts). Orchestrators never sleep.
 * JeanBrasse's choices 5 and 6 of 2026-10-05, on RD-RAM.md 2.1: an agent gives back
 * 265 to 600 MB asleep, and resuming took about a second.
 *
 * The rule refuses on any doubt, since asleep, what the CLI held is gone:
 * - what runs under it (a background task, a dev server; stall-watch.ts reads
 *   the tree the same way): it would die with it;
 * - what is owed to it (a held note or room message, a kanban note, an open
 *   question to the user) or owed by others to it (work it handed out): each
 *   is bound to its session, and dropped with it (agent-watch.ts, flush);
 * - a draft in its field, a write on its way, a pause in typing;
 * - a conversation Tars cannot resume: woken, it would start a new one.
 */

export const SLEEP_AFTER_MS = 30 * 60_000;
export const CHECK_EVERY_MS = 60_000;

export type SleepRefusal =
  | 'orchestrator' | 'not-at-rest' | 'no-cli' | 'starting' | 'recent'
  | 'not-resumable' | 'owed' | 'owes' | 'field' | 'no-process-table' | 'busy';

export interface SleepFacts {
  agent: Pick<AgentStatus, 'status' | 'waitingReason' | 'statusSince' | 'lastTurnStartedAt' | 'workHandedAt'>;
  orchestrator: boolean;
  now: number;
  /** A CLI runs in its terminal (cliRunningIn). */
  cliRunning: boolean;
  /** A launch is on its way (sessionStarting). */
  starting: boolean;
  /** Its conversation can be resumed (resolveResumeSessionId, on a CLI that resumes). */
  resumable: boolean;
  /** Something is held for it, owed to it, or asked of the user by it. */
  owed: boolean;
  /** Work it handed out is still open, or its requester is owed a note of it. */
  owes: boolean;
  /** Its field holds a draft, a write or a pause (fieldInUse). */
  fieldInUse: boolean;
  procs: Proc[] | undefined;
  terminalPid: number | undefined;
}

function atRest(agent: SleepFacts['agent']): boolean {
  return agent.status === 'idle' || agent.status === 'completed' || (agent.status === 'waiting' && agent.waitingReason === 'idle');
}

/** Why this agent may not be put to sleep now, or null when it may. */
export function sleepRefusal(f: SleepFacts): SleepRefusal | null {
  if (f.orchestrator) return 'orchestrator';
  if (!atRest(f.agent)) return 'not-at-rest';
  if (!f.cliRunning) return 'no-cli';
  if (f.starting) return 'starting';
  // The status, the last turn and the last work handed over, all 30 minutes
  // old. A status with no time is not known to be old.
  const since = Date.parse(f.agent.statusSince ?? '');
  if (!Number.isFinite(since)) return 'recent';
  const latest = Math.max(since, ...[f.agent.lastTurnStartedAt, f.agent.workHandedAt].map((t) => Date.parse(t ?? '')).filter(Number.isFinite));
  if (f.now - latest < SLEEP_AFTER_MS) return 'recent';
  if (!f.resumable) return 'not-resumable';
  if (f.owed) return 'owed';
  if (f.owes) return 'owes';
  if (f.fieldInUse) return 'field';
  if (!f.procs || f.terminalPid === undefined) return 'no-process-table';
  const cli = cliProcess(f.terminalPid, f.procs);
  if (!cli) return 'no-process-table';
  if (toolAtWork(cli.pid, f.procs) || signOfLife(cli.pid, f.procs)) return 'busy';
  return null;
}

function factsOf(agent: AgentStatus, procs: Proc[] | undefined, now: number): SleepFacts {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  const fleet = [...agents.values()];
  return {
    agent,
    orchestrator: isSuperAgent(agent),
    now,
    cliRunning: cliRunningIn(terminal),
    starting: sessionStarting(agent),
    // Tars resumes the claude binary's conversations, the providers that run
    // it included, and only once their transcript is on disk: what the wake
    // resumes is what this finds (consumeResumeSessionId).
    resumable: getProvider(agent.provider).binaryName === 'claude' && resolveResumeSessionId(agent) !== null,
    owed: holdsFor(agent.id)
      || owedKanban().some((k) => k.agentId === agent.id)
      || waitingDeliveries().some((d) => d.targetAgentId === agent.id)
      || !!openQuestionOf(agent.id),
    owes: !!agent.requestedBy?.backgroundLeft?.length
      || fleet.some((other) => other.id !== agent.id && other.requestedBy?.agentId === agent.id),
    fieldInUse: !!terminal && !!fieldInUse(terminal),
    procs,
    terminalPid: terminal?.pid,
  };
}

/** Its CLI ended, its last screen kept, and the window told. */
async function putToSleep(agent: AgentStatus, now: number): Promise<void> {
  const ptyId = agent.ptyId!;
  const terminal = ptyProcesses.get(ptyId)!;
  const screen = terminalSnapshot(terminal);
  ptyProcesses.delete(ptyId);
  fallAsleep(agent, screen, now);
  saveAgents();
  emitAgentStatus(agent.id);
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: agent.asleepSince });
  scheduleTick();
  console.log(`[sleep] ${agent.name || agent.id}: asleep, no turn for 30 minutes; its CLI ends, its conversation is kept`);
  await endTerminalTree(terminal);
}

export interface SleepOutcome { agentId: string; slept: boolean; why?: SleepRefusal }

/** One look at the fleet, as the minute's pass does. The process table is read only when someone may sleep. */
export async function checkSleep(
  now: number = Date.now(),
  read: { procs?: () => Promise<Proc[] | undefined> } = {},
): Promise<SleepOutcome[]> {
  const candidates = [...agents.values()].filter((a) => atRest(a) && !isSuperAgent(a) && a.ptyId);
  if (candidates.length === 0) return [];
  const procs = await (read.procs ?? readProcesses)();
  const outcomes: SleepOutcome[] = [];
  const ending: Promise<void>[] = [];
  for (const agent of candidates) {
    // Read again now, after the wait on ps: a message may have come in.
    const why = agents.get(agent.id) === agent && agent.ptyId ? sleepRefusal(factsOf(agent, procs, now)) : 'no-cli';
    outcomes.push({ agentId: agent.id, slept: why === null, ...(why ? { why } : {}) });
    if (why === null) ending.push(putToSleep(agent, now));
  }
  await Promise.all(ending);
  return outcomes;
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startSleepWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    checkSleep().catch((err) => console.warn('[sleep] check failed:', err));
  }, CHECK_EVERY_MS);
  timer.unref?.();
}

export function stopSleepWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
