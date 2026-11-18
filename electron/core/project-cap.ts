/**
 * A project's cap on its workers at work at once (2.0.7, for a project whose inference endpoint serves only so many
 * turns at a time). Work handed to a worker beyond it is never refused and never lost: it waits in the
 * agent's own queue (core/one-task.ts), read in the window as waiting for its project's cap, and goes in when a place
 * frees, the oldest of the project first.
 *
 * Who counts: the project's workers at work (a turn in its terminal, a task Tars is handing it, a dialog it waits
 * on), the agent asking excepted (its own turn ending is what frees its place for its next task). The project's
 * orchestrator is neither counted nor held: it directs the workers, and holding its turn could hold the very work it
 * waits on. A chat's runner is no project orchestrator, and counts. Where a CLI never says its turn ended (amp, grok,
 * opencode, pi), an agent counts only while Tars hands it the task (core/one-task.ts, terminalTurnOf).
 *
 * Pure: api-routes/agent-routes.ts reads the fleet and asks capVerdict before a task goes in.
 */

export const CAP_MAX = 64;

export type CapParse = { ok: true; cap: number | null } | { ok: false; error: string; code: 'invalid_cap' };

/** A cap is a whole number from 1 to CAP_MAX; null clears it. */
export function parseCap(raw: unknown): CapParse {
  if (raw === null) return { ok: true, cap: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > CAP_MAX) {
    return { ok: false, code: 'invalid_cap', error: `cap is a whole number from 1 to ${CAP_MAX}, the most workers of the project at work at once, or null to remove it.` };
  }
  return { ok: true, cap: raw };
}

/** An agent of the fleet as the cap reads it. */
export interface CapMember {
  id: string;
  projectPath: string;
  role?: string;
  kind?: string;
  /** A turn in its terminal, a task being handed, a dialog: it holds a place. */
  atWork: boolean;
  /** When the first item of its queue was queued, if that item could go in now (its queue not paused, the agent free). */
  waitingSince?: number;
}

/** The project's own orchestrator (as services/agent-queues.ts queueRight reads it): neither counted nor held. */
export function isProjectOrchestrator(agent: { role?: string; kind?: string }): boolean {
  return agent.role === 'orchestrator' && agent.kind !== 'chat';
}

/**
 * Undefined when `agent`'s next work may go in now; else why it waits, in the words the window and its asker read.
 * `queuedAt`: when that work was queued (Infinity for work not queued yet), to let older work of the project go first.
 */
export function capVerdict(input: { cap: number | undefined; agent: CapMember; fleet: CapMember[]; queuedAt: number }): string | undefined {
  const { cap, agent, fleet, queuedAt } = input;
  if (cap === undefined || isProjectOrchestrator(agent)) return undefined;
  let atWork = 0;
  let older = 0;
  for (const other of fleet) {
    if (other.id === agent.id || other.projectPath !== agent.projectPath || isProjectOrchestrator(other)) continue;
    if (other.atWork) atWork++;
    else if (other.waitingSince !== undefined && other.waitingSince < queuedAt) older++;
  }
  const free = cap - atWork;
  if (free <= 0) return `its project's cap: ${atWork} of ${cap} agents at work`;
  if (older >= free) {
    return `its project's cap: ${atWork} of ${cap} agents at work, and ${older} task${older === 1 ? '' : 's'} of the project waiting longer go${older === 1 ? 'es' : ''} first`;
  }
  return undefined;
}
