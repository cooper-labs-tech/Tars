import * as path from 'path';
import { DATA_DIR, privatePath } from '../constants';
import { agents } from '../core/agent-manager';
import { hasOrchestratorPowers } from '../core/agent-role';
import { agentStatusEmitter } from './agent-events';
import { pendingBackgroundWork } from './agent-truth';
import { createTaskLedger, endingOf, setLiveTaskLedger, liveTaskLedger, type TaskRecord } from './task-ledger';
import { tellDelegationCut } from './agent-watch';
import { readTaskCosts, selectTasks, taskReport, withDescendants, type TaskQuery, type TaskReport } from './task-cost';

/**
 * The ledger of tasks, live: started by main.ts with the rest of the watches.
 * Hand-offs and turns reach it from where they happen (pty-manager.ts,
 * agent-routes.ts, bot-core.ts, hooks-routes.ts); the end of a task is read
 * here, off every change of an agent's state.
 */

export const TASK_LEDGER_FILE = path.join(DATA_DIR, 'task-ledger.jsonl');
/** Each task's text, where no agent is handed it (JeanBrasse's answer of 2026-10-05). */
export const TASK_TEXT_FILE = privatePath('task-texts.jsonl');
/** What each delegated run answered, beside the texts (PR B, 4.4 item 3). */
export const TASK_RESULT_FILE = privatePath('task-results.jsonl');

function onFleetChange(agentId: string): void {
  const ledger = liveTaskLedger();
  const task = ledger?.openTaskOf(agentId);
  if (!ledger || !task) return;
  const agent = agents.get(agentId);
  // Deleted: its work ended with it.
  if (!agent) {
    ledger.stateChanged({ id: agentId, status: 'stopped' });
    return;
  }
  const ending = endingOf(agent);
  if (!ending) return;
  // Read only at a rest that would end the task: the transcript is megabytes.
  const backgroundLeft = ending === 'completed' && pendingBackgroundWork(agent, task.startedAt).length > 0;
  ledger.stateChanged(agent, { backgroundLeft });
}

export function startTaskWatch(file = TASK_LEDGER_FILE, textFile = TASK_TEXT_FILE, resultFile = TASK_RESULT_FILE): void {
  if (liveTaskLedger()) return;
  const ledger = createTaskLedger({
    file,
    textFile,
    resultFile,
    // As recordRequester has it (#302): a sender writing to the agent that
    // handed it its work, or to one of its project's with the orchestrator's
    // powers (the orchestrator, a chat's runner: core/agent-role.ts), reports.
    leads: (receiverId, senderId) => {
      const receiver = agents.get(receiverId);
      const sender = agents.get(senderId);
      if (!receiver || !sender) return false;
      return sender.requestedBy?.agentId === receiverId
        || (hasOrchestratorPowers(receiver) && receiver.projectPath === sender.projectPath);
    },
  });
  setLiveTaskLedger(ledger);
  // The delegations a quit cut: each asker told, once.
  for (const task of ledger.interruptedAtStart()) {
    if (task.requesterAgentId) tellDelegationCut(task.requesterAgentId, task.agentId, task.text);
  }
  agentStatusEmitter.on('fleet-change', onFleetChange);
}

export function stopTaskWatch(): void {
  agentStatusEmitter.off('fleet-change', onFleetChange);
  setLiveTaskLedger(null);
}

/** The tasks the Usage page asks for, priced: usage:tasks. */
export async function tasksReport(query: TaskQuery = {}, now = Date.now()): Promise<TaskReport & { agentNames: Record<string, string> }> {
  const all: TaskRecord[] = liveTaskLedger()?.tasks() ?? [];
  const priced = withDescendants(selectTasks(all, query, now), all);
  const report = taskReport(priced, await readTaskCosts(priced), query, now);
  // Names as they are now; a deleted agent has none, and the page says so.
  const agentNames: Record<string, string> = Object.create(null);
  for (const t of report.tasks) {
    const name = agents.get(t.agentId)?.name;
    if (name) agentNames[t.agentId] = name;
  }
  return { ...report, agentNames };
}
