import type { TaskEntry } from '@/types/electron';
import { filterTasks, providerText, tokensTotal } from '@/lib/task-costs';
import type { TaskFilter } from '@/lib/task-costs';
import { flat } from '@/lib/stop-line';

/**
 * What the Usage page says of each agent: the tasks of the timeframe and the
 * project picked, one row per agent, beside the view by task (Noah, 13/10).
 * Frame: `Usage · cost per agent`, and its light copy. Its failures are
 * listed, and pinned, in __tests__/lib/agent-costs.test.ts.
 *
 * A row adds up the agent's tasks, which hold every turn of its sessions since
 * Tars records tasks (1.9.3): measured on four agents on 13/10, their tasks
 * held every reply of their transcripts since the ledger's first task.
 */

export type UsageView = 'task' | 'agent';

/** Where the page remembers the view last picked: a convenience of this window's, nothing more. */
export const USAGE_VIEW_KEY = 'tars-usage-view';

/** The view a stored value names; by task for anything else, nothing included. */
export function usageViewOf(stored: string | null | undefined): UsageView {
  return stored === 'agent' ? 'agent' : 'task';
}

/** The agent view keeps the project picked; the agent picked stays the task view's. */
export function agentViewFilter(filter: TaskFilter): TaskFilter {
  return { projectPath: filter.projectPath, agentId: null };
}

/** What the switch counts: the tasks the task view lists, the agents the agent view does. */
export function viewCounts(tasks: TaskEntry[], filter: TaskFilter): { tasks: number; agents: number } {
  return {
    tasks: filterTasks(tasks, filter).length,
    agents: new Set(filterTasks(tasks, agentViewFilter(filter)).map(t => t.agentId)).size,
  };
}

/** A project by its folder's name, from a POSIX or a Windows path, on one line; `-` without one. */
export function projectName(projectPath: string | null): string {
  if (!projectPath) return '-';
  return flat(projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath);
}

export interface AgentTotal {
  agentId: string;
  tasks: number;
  /** Of those, the ones whose cost is known. */
  counted: number;
  /** Of those, the ones still running. */
  running: number;
  /** The counted tasks' own costs added up, never their totals; null when none is counted. */
  costUSD: number | null;
  /** A task of it is not counted, or counted only in part: what it spent is more than the sum. */
  partial: boolean;
  /** Every token of the counted tasks, the cache's included; null when none counted any. */
  tokens: number | null;
  /** The ended tasks' time added up; null when none has ended. */
  durationMs: number | null;
  /** The project of its latest task that names one. */
  projectPath: string | null;
  /** The providers its tasks ran on, with their Claude accounts, the latest first, each once. */
  providers: string[];
}

/**
 * One row per agent, by its id: the dearest first, then the one with the most
 * tasks, then by id; an agent with nothing counted last.
 */
export function totalsByAgent(tasks: TaskEntry[], accountLabels: Record<string, string>): AgentTotal[] {
  const latestFirst = [...tasks].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const rows = new Map<string, AgentTotal>();
  for (const t of latestFirst) {
    let row = rows.get(t.agentId);
    if (!row) {
      row = {
        agentId: t.agentId, tasks: 0, counted: 0, running: 0, costUSD: null, partial: false,
        tokens: null, durationMs: null, projectPath: null, providers: [],
      };
      rows.set(t.agentId, row);
    }
    row.tasks += 1;
    if (t.endedAt === null) row.running += 1;
    if (t.costUSD !== null) {
      row.counted += 1;
      row.costUSD = (row.costUSD ?? 0) + t.costUSD;
    }
    if (t.costUSD === null || t.partial) row.partial = true;
    const tokens = tokensTotal(t);
    if (tokens !== null) row.tokens = (row.tokens ?? 0) + tokens;
    if (t.durationMs !== null) row.durationMs = (row.durationMs ?? 0) + t.durationMs;
    if (row.projectPath === null && t.projectPath) row.projectPath = t.projectPath;
    const provider = providerText(t, accountLabels);
    if (!row.providers.includes(provider)) row.providers.push(provider);
  }
  return [...rows.values()]
    .map(row => (row.counted === 0 ? { ...row, partial: false } : row))
    .sort((a, b) => (b.costUSD ?? -1) - (a.costUSD ?? -1)
      || b.tasks - a.tasks
      || a.agentId.localeCompare(b.agentId));
}
