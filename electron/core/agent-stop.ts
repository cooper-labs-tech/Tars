import type { AgentStatus } from '../types';
import { stopAcpRuns } from '../services/acp/delegate';
import { dropPermissionAsks } from '../services/permission-asks';
import { emitAgentStatus } from '../services/agent-events';
import { oneLine } from '../utils/waiting-on';
import { ptyProcesses, endTerminalTree } from './pty-manager';
import { endWorkerRequests } from './task-requests';

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

export async function stopAgent(
  agent: AgentStatus,
  request: StopRequest,
  notify: { save(): void; announce(agent: AgentStatus): void },
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

  // Every request it will not finish: off it, each requester told (the
  // Audit's R3), the one in hand as cut. The stop clears the terminal before
  // its status event, so that event alone never told the asker.
  endWorkerRequests(agent, 'stopped', { withLinked: true });
  notify.save();
  emitAgentStatus(agent.id);
  notify.announce(agent);

  if (terminal) await endTerminalTree(terminal);
  return true;
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
}
