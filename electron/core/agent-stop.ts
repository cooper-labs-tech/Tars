import type { AgentStatus } from '../types';
import { stopAcpRuns } from '../services/acp/delegate';
import { dropPermissionAsks } from '../services/permission-asks';
import { emitAgentStatus } from '../services/agent-events';
import { oneLine } from '../utils/waiting-on';
import { ptyProcesses, endTerminalTree } from './pty-manager';
import { endWorkerRequests } from './task-requests';
import { describeBorn, endBornProcesses, stopLabelledContainers } from './born-processes';
import { oneTaskQueue } from './one-task';

/**
 * Stopping an agent: it is ended, and it says who stopped it, when and why
 * (PLAN-1.9.2.md item A, JeanBrasse 28/09).
 *
 * A stop sent the terminal's shell its hangup and marked the agent `idle`.
 * Measured: on 28/09 two frozen CLIs survived stop_agent, reparented to
 * launchd; on 30/09 a stopped QA's bench (gate.sh, then npm exec tsc) survived
 * orphaned and ignored SIGTERM. And `idle` is what an agent never started
 * reads, so the Dashboard resumed a stopped one at the next launch and the
 * kanban handed it work.
 *
 * Now the agent is `stopped`, with `stoppedBy` (an agent's name, "Tars" for its
 * own pass, "you" for the window), `stoppedAt` and `stopReason`, until a new
 * terminal is started for it (clearStop). The state is recorded, saved and
 * announced first, then the terminal's whole tree is ended as the quit ends it
 * (endTerminalTree): its exit, which comes after, finds its pty no longer the
 * agent's and changes nothing.
 *
 * Then what the agent started outside that tree (2.0.5): nohup'd or setsid'd,
 * reparented to launchd or init, found by its birth tag and ended by its PID,
 * and its Docker containers by their label (core/born-processes.ts). After
 * 28/10's evidence: 1212-Capital's Playwright run and Next servers outlived
 * stop_agent. An ansible run, a `fly ssh` session and a shared daemon (colima,
 * docker, VS Code...) are kept with all they started (the owner's limits), and
 * the watch says it (services/born-watch.ts). A terminal the agent got again
 * while the stop ran is its own, and left alone. What was ended and kept is on
 * the record (`stopProcesses`), which the stop route answers with.
 */

export interface StopRequest {
  /** "you", "Tars", or the name of the agent that asked. */
  by: string;
  reason?: string;
}

/** A reason as the record keeps it: one line of a card, or nothing when empty. */
export function stopReasonOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = oneLine(raw);
  return line || undefined;
}

/**
 * What a stop did to the agent's queue (2.0.5, lot 2): kept, paused, and said so in its answer, or dropped when asked
 * (`dropQueue`), each requester told it never ran. A stop used to empty it, and each item had to be sent again by
 * hand (Kotsna's item 16, 27/10).
 */
export interface StopQueueOutcome { kept: number; dropped: number }

export async function stopAgent(
  agent: AgentStatus,
  request: StopRequest,
  notify: { save(): void; announce(agent: AgentStatus): void },
  opts: { dropQueue?: boolean; outcome?: StopQueueOutcome } = {},
): Promise<boolean> {
  // Stopped already: the first stop's who and why stand, and false says so.
  // A second caller used to replace them (the Frontend, on #281).
  if (agent.status === 'stopped') return false;
  // Its delegated run too, which has no terminal (the Audit's table, #6).
  await stopAcpRuns(agent.id, 'the agent was stopped');
  // And a permission question it left with Tars: its CLI is being ended.
  dropPermissionAsks(agent.id);

  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (agent.ptyId) ptyProcesses.delete(agent.ptyId);
  agent.ptyId = undefined;
  agent.status = 'stopped';
  agent.stoppedBy = request.by;
  agent.stoppedAt = new Date().toISOString();
  agent.stopReason = stopReasonOf(request.reason);
  agent.currentTask = undefined;
  agent.waitingReason = undefined;
  // The killed session is a tombstone: its hooks outlive the kill, and a
  // SessionEnd posting `completed` under it would bring the agent back.
  if (agent.currentSessionId) agent.lastKilledSessionId = agent.currentSessionId;
  agent.currentSessionId = undefined;
  agent.lastActivity = agent.stoppedAt;

  // Its queue: kept, paused until someone resumes it (it would start the agent again), or dropped.
  const waiting = oneTaskQueue.queued(agent.id);
  if (opts.dropQueue) for (const item of waiting) oneTaskQueue.cancel(item.ref, `it was dropped with the stop by ${request.by}`);
  else if (waiting.length) oneTaskQueue.pause(agent.id, `stopped by ${request.by}`);
  if (opts.outcome) {
    opts.outcome.kept = opts.dropQueue ? 0 : waiting.length;
    opts.outcome.dropped = opts.dropQueue ? waiting.length : 0;
  }
  // Every request it will not finish: off it, each requester told (the
  // Audit's R3), the one in hand as cut. The stop clears the terminal before
  // its status event, so that event alone never told the asker. What its queue
  // keeps is not ended: it goes in once the queue is resumed.
  endWorkerRequests(agent, 'stopped', { withLinked: true, keep: new Set(opts.dropQueue ? [] : waiting.map((t) => t.ref)) });
  notify.save();
  emitAgentStatus(agent.id);
  notify.announce(agent);

  if (terminal) await endTerminalTree(terminal);
  const ended = await endBornOf(agent, { terminal: () => (agent.ptyId ? ptyProcesses.get(agent.ptyId)?.pid : undefined) });
  // On the record and in what whoever asked is told (stopOf), unless a start came first (the Audit's L2 on #523).
  if (ended && agent.status === 'stopped') {
    agent.stopProcesses = ended;
    notify.save();
  }
  return true;
}

/**
 * What the agent started outside its terminal, ended (core/born-processes.ts), and its containers stopped by their
 * label: said in one line each, `pid <n>: <command>`, the kept ones with why. Undefined when there was nothing.
 * A stop and a removal (agent-remove.ts) run it.
 */
export async function endBornOf(agent: AgentStatus, opts: { terminal?: () => number | undefined } = {}): Promise<AgentStatus['stopProcesses']> {
  const born = await endBornProcesses(agent.id, { terminal: opts.terminal });
  const boxes = await stopLabelledContainers(agent.id);
  if (!born.ended.length && !born.spared.length && !boxes.stopped.length) return undefined;
  const said = {
    ended: born.endedProcesses.map(p => describeBorn(p)),
    kept: born.spared.map(p => describeBorn(p, p.why)),
    containers: boxes.stopped,
  };
  console.log(`[agent-stop] ${agent.name || agent.id}: ended ${said.ended.length} process(es) it started outside its terminal, stopped ${said.containers.length} container(s)`
    + (said.kept.length ? `, kept ${said.kept.join('; ')}` : ''));
  return said;
}

/**
 * A start that undoes a stop, noted beside the stop it undid (JeanBrasse, 05/10: an
 * orchestrator may start again an agent JeanBrasse stopped, whenever it needs to, a
 * scheduled task too). Kept on the agent until the next one; nothing when the
 * agent was not stopped. Called just before clearStop.
 */
export function noteRestartAfterStop(agent: AgentStatus, by: string): void {
  if (agent.status !== 'stopped') return;
  agent.lastRestartAfterStop = {
    stoppedBy: agent.stoppedBy,
    stoppedAt: agent.stoppedAt,
    stopReason: agent.stopReason,
    restartedBy: by,
    restartedAt: new Date().toISOString(),
  };
  console.log(`[agent-stop] ${agent.name || agent.id}, stopped by ${agent.stoppedBy ?? 'someone'}${agent.stopReason ? ` (${agent.stopReason})` : ''}, started again by ${by}`);
}

/**
 * A new terminal for a stopped agent: the stop is over. Called where an agent
 * gets a terminal (initAgentPty, spawnAgentSession), which is the only way out
 * of `stopped`; the caller sets the status the terminal starts in.
 */
export function clearStop(agent: AgentStatus): void {
  if (agent.status === 'stopped') agent.status = 'idle';
  agent.stoppedBy = undefined;
  agent.stoppedAt = undefined;
  agent.stopReason = undefined;
  agent.stopProcesses = undefined;
}
