import type { AgentStatus } from '../types';

/**
 * The checkpoint line an agent writes about itself (2.0.5, taken from Orca), with the MCP tool `checkpoint`:
 * where it stands in the task in hand, in one line of 120 characters at most. Kept with the agent (saved in
 * agents.json), shown on its card, and given to task_status for the running task it belongs to and to what
 * list_agents and get_agent answer. One line only: no control character reaches the window or a report.
 */

export const CHECKPOINT_MAX = 120;

// C0 controls (newline, tab, escape included), DEL and C1.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Why `line` cannot be a checkpoint, or null when it can. */
export function checkpointProblem(line: unknown): string | null {
  if (typeof line !== 'string') return 'line is the checkpoint, one line of text';
  if (CONTROL.test(line)) return 'a checkpoint is one line: no newline, tab or other control character';
  const trimmed = line.trim();
  if (!trimmed) return 'a checkpoint says something: it is empty';
  const length = [...trimmed].length;
  if (length > CHECKPOINT_MAX) return `a checkpoint is ${CHECKPOINT_MAX} characters at most: this one has ${length}`;
  return null;
}

/** Keeps `line` (checked with checkpointProblem first) as the agent's checkpoint, with its time. */
export function writeCheckpoint(agent: AgentStatus, line: string, now = new Date()): void {
  agent.checkpoint = { line: line.trim(), at: now.toISOString() };
}

/** The agent's checkpoint, for a task still running that started before it was written; else none. */
export function checkpointOfTask(agent: AgentStatus | undefined, task: { outcome: string; startedAt: number }): AgentStatus['checkpoint'] {
  if (!agent?.checkpoint || task.outcome !== 'running') return undefined;
  return Date.parse(agent.checkpoint.at) >= task.startedAt ? agent.checkpoint : undefined;
}
