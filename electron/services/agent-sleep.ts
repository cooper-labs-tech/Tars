import { hasClaudeHooks } from '../core/end-of-turn';
import type { AgentStatus } from '../types';
import { agents, saveAgents } from '../core/agent-manager';
import { ptyProcesses, endTerminalTree, fieldInUse } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { cliLaunchedAt, sessionStarting } from '../core/agent-launch';
import { fallAsleep, waitsOnItself } from '../core/agent-asleep';
export { restPendingOf, waitsOnItself } from '../core/agent-asleep';
import { terminalSnapshot } from '../core/terminal-mirror';
import { getProvider } from '../providers';
import { isSuperAgent } from '../utils';
import { resolveResumeSessionId } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { emitAgentStatus } from './agent-events';
import { holdsFor } from './agent-watch';
import { pendingBackgroundWork } from './agent-truth';
import { owedKanban } from './api-routes/kanban-routes';
import { waitingDeliveries } from './bus-store';
import { openQuestionOf } from './user-questions';
import { cliProcess, readProcesses, signOfLife, toolAtWork, type Proc } from './stall-watch';
import { isOwedByRequests } from '../core/task-requests';
import { readBornProcesses, type BornProcess } from '../core/born-processes';

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
 * - a conversation Tars cannot resume: woken, it would start a new one;
 * - what it started outside its terminal's tree, found by its birth tag
 *   (core/born-processes.ts): a dev server started with nohup, its parent gone.
 *   The sleep ends the tree only, and that one would run on with no session to
 *   answer for it (2.0.5).
 */

/**
 * 30 minutes, and a pass every minute. An E2E run may shorten the delay
 * (DOROTHY_SLEEP_AFTER_MS, under DOROTHY_E2E only, 2 s at least) to watch the
 * real pass put an agent to sleep: the pass then runs four times per delay,
 * every 500 ms at the most often.
 */
export function sleepTiming(env: Record<string, string | undefined>): { afterMs: number; everyMs: number } {
  const asked = Number(env.DOROTHY_SLEEP_AFTER_MS);
  const afterMs = env.DOROTHY_E2E === '1' && env.DOROTHY_SLEEP_AFTER_MS?.trim() && Number.isFinite(asked) && asked >= 2_000 ? asked : 30 * 60_000;
  return { afterMs, everyMs: Math.min(60_000, Math.max(500, afterMs / 4)) };
}

export const { afterMs: SLEEP_AFTER_MS, everyMs: CHECK_EVERY_MS } = sleepTiming(process.env);

export type SleepRefusal =
  | 'orchestrator' | 'not-at-rest' | 'no-cli' | 'starting' | 'recent'
  | 'not-resumable' | 'owed' | 'owes' | 'pending' | 'field' | 'no-process-table' | 'busy' | 'detached';

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
  /** Its CLI holds a timer or a background task (waitsOnItself): no process shows them. */
  pending: boolean;
  /** Its field holds a draft, a write or a pause (fieldInUse). */
  fieldInUse: boolean;
  procs: Proc[] | undefined;
  terminalPid: number | undefined;
  /** Which CLI runs in the terminal, as the process table names it: claude, unless codex (2.0.4). */
  binary?: 'claude' | 'codex';
  /** What it started that runs outside its terminal's tree (bornOutsideOf); undefined where it cannot be read (Windows). */
  bornOutside?: number[];
}

function atRest(agent: SleepFacts['agent']): boolean {
  return agent.status === 'idle' || agent.status === 'completed' || (agent.status === 'waiting' && agent.waitingReason === 'idle');
}

/**
 * Why this agent may not be put to sleep now, or null when it may. `anyAge`:
 * every rule but the 30 minutes, for a chat's runner put to sleep to free a
 * slot for another chat, or because its chat was settled (services/chat-runners.ts).
 */
export function sleepRefusal(f: SleepFacts, opts: { anyAge?: boolean } = {}): SleepRefusal | null {
  if (f.orchestrator) return 'orchestrator';
  if (!atRest(f.agent)) return 'not-at-rest';
  if (!f.cliRunning) return 'no-cli';
  if (f.starting) return 'starting';
  // The status, the last turn and the last work handed over, all 30 minutes
  // old. A status with no time is not known to be old.
  if (!opts.anyAge) {
    const since = Date.parse(f.agent.statusSince ?? '');
    if (!Number.isFinite(since)) return 'recent';
    const latest = Math.max(since, ...[f.agent.lastTurnStartedAt, f.agent.workHandedAt].map((t) => Date.parse(t ?? '')).filter(Number.isFinite));
    if (f.now - latest < SLEEP_AFTER_MS) return 'recent';
  }
  if (!f.resumable) return 'not-resumable';
  if (f.owed) return 'owed';
  if (f.owes) return 'owes';
  if (f.pending) return 'pending';
  if (f.bornOutside?.length) return 'detached';
  if (f.fieldInUse) return 'field';
  if (!f.procs || f.terminalPid === undefined) return 'no-process-table';
  const cli = cliProcess(f.terminalPid, f.procs, f.binary);
  if (!cli) return 'no-process-table';
  if (toolAtWork(cli.pid, f.procs) || signOfLife(cli.pid, f.procs)) return 'busy';
  return null;
}

/**
 * The pids of what the agent started (its birth tag) that are not under its terminal: its CLI and its MCP
 * servers carry the tag and are inside. Undefined when the tags or the tree cannot be read.
 */
export function bornOutsideOf(agentId: string, terminalPid: number | undefined, procs: Proc[] | undefined, born: BornProcess[] | undefined): number[] | undefined {
  if (!born || !procs || terminalPid === undefined) return undefined;
  const inside = new Set([terminalPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!inside.has(p.pid) && inside.has(p.ppid)) { inside.add(p.pid); grew = true; }
  }
  return born.filter(p => p.agentId === agentId && !inside.has(p.pid)).map(p => p.pid);
}

/** What the sleep rule reads of an agent, from the fleet as it is. Exported for its tests. */
export function factsOf(agent: AgentStatus, procs: Proc[] | undefined, now: number, born?: BornProcess[]): SleepFacts {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  const fleet = [...agents.values()];
  return {
    agent,
    orchestrator: isSuperAgent(agent),
    now,
    cliRunning: cliRunningIn(terminal),
    starting: sessionStarting(agent),
    // Tars resumes the claude binary's conversations, the providers that run
    // it included, qwen code's (the same hooks), and codex's (2.0.4, `codex
    // resume`), and only once their transcript or rollout is on disk: what the
    // wake resumes is what this finds (consumeResumeSessionId).
    resumable: (hasClaudeHooks(agent) || getProvider(agent.provider).binaryName === 'codex') && resolveResumeSessionId(agent) !== null,
    owed: holdsFor(agent.id)
      || owedKanban().some((k) => k.agentId === agent.id)
      || waitingDeliveries().some((d) => d.targetAgentId === agent.id)
      || !!openQuestionOf(agent.id),
    owes: !!agent.requestedBy?.backgroundLeft?.length
      || fleet.some((other) => other.id !== agent.id && other.requestedBy?.agentId === agent.id)
      // A request still out at a worker, queued or written: its answer comes to this agent.
      || isOwedByRequests(fleet, agent.id),
    // Its timers and background agents live inside its CLI: what its last Stop
    // counted, or the transcript's background work since this CLI started.
    pending: waitsOnItself(agent.restPending, () => pendingBackgroundWork(agent, cliLaunchedAt(terminal) ?? 0)),
    fieldInUse: !!terminal && !!fieldInUse(terminal),
    procs,
    terminalPid: terminal?.pid,
    binary: getProvider(agent.provider).binaryName === 'codex' ? 'codex' : 'claude',
    bornOutside: bornOutsideOf(agent.id, terminal?.pid, procs, born),
  };
}

/** Its CLI ended, its last screen kept, and the window told. */
async function putToSleep(agent: AgentStatus, now: number, why = 'no turn for 30 minutes'): Promise<void> {
  const ptyId = agent.ptyId!;
  const terminal = ptyProcesses.get(ptyId)!;
  const screen = terminalSnapshot(terminal);
  ptyProcesses.delete(ptyId);
  agent.sleepHeld = undefined;
  fallAsleep(agent, screen, now);
  saveAgents();
  emitAgentStatus(agent.id);
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: agent.asleepSince });
  scheduleTick();
  console.log(`[sleep] ${agent.name || agent.id}: asleep, ${why}; its CLI ends, its conversation is kept`);
  await endTerminalTree(terminal);
}

/**
 * A chat's runner put to sleep now, the caller having read the rule
 * (sleepRefusal with anyAge) with nothing awaited since: services/chat-runners.ts,
 * to free a slot or for a settled chat. Synchronous up to the end of its
 * terminal's tree, so no delivery can slip in between the check and the sleep.
 */
export function sleepNow(agent: AgentStatus, why: string): Promise<void> {
  if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) return Promise.resolve();
  return putToSleep(agent, Date.now(), why);
}

export interface SleepOutcome { agentId: string; slept: boolean; why?: SleepRefusal }

/**
 * One look at the fleet, as the minute's pass does. The process table is read
 * only when someone may sleep. Each agent with a terminal keeps why the pass
 * left it awake (`sleepHeld`), where the window and the Audit read it: an agent
 * at rest for an hour that never slept said nothing of why (the DB brief of 28/10).
 */
export async function checkSleep(
  now: number = Date.now(),
  read: { procs?: () => Promise<Proc[] | undefined>; born?: () => Promise<BornProcess[] | undefined> } = {},
): Promise<SleepOutcome[]> {
  const watched = [...agents.values()].filter((a) => a.ptyId);
  const outcomes: SleepOutcome[] = [];
  const held = (agent: AgentStatus, why: SleepRefusal) => {
    agent.sleepHeld = { why, at: new Date(now).toISOString() };
    outcomes.push({ agentId: agent.id, slept: false, why });
  };
  const candidates: AgentStatus[] = [];
  for (const agent of watched) {
    if (isSuperAgent(agent)) held(agent, 'orchestrator');
    else if (!atRest(agent)) held(agent, 'not-at-rest');
    else candidates.push(agent);
  }
  if (candidates.length === 0) return outcomes;
  const procs = await (read.procs ?? readProcesses)();
  // One read of the birth tags for every candidate: about 0.2 s on macOS (two ps), a walk of /proc on Linux.
  const born = await (read.born ?? (() => readBornProcesses()))();
  const ending: Promise<void>[] = [];
  for (const agent of candidates) {
    // Read again now, after the wait on ps: a message may have come in.
    const why = agents.get(agent.id) === agent && agent.ptyId ? sleepRefusal(factsOf(agent, procs, now, born)) : 'no-cli';
    if (why) held(agent, why);
    else {
      outcomes.push({ agentId: agent.id, slept: true });
      ending.push(putToSleep(agent, now));
    }
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
