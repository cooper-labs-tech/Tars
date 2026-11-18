import * as path from 'path';
import { DATA_DIR, privatePath } from '../constants';
import { agents } from '../core/agent-manager';
import { hasOrchestratorPowers } from '../core/agent-role';
import { agentStatusEmitter } from './agent-events';
import { pendingBackgroundWork } from './agent-truth';
import { createTaskLedger, endingOf, setLiveTaskLedger, liveTaskLedger, type TaskRecord } from './task-ledger';
import { tellDelegationCut } from './agent-watch';
import { readTaskCosts, selectTasks, taskReport, withDescendants, type TaskQuery, type TaskReport } from './task-cost';
import { hasClaudeHooks } from '../core/end-of-turn';
import { accountDir } from './claude-accounts/registry';
import { answerOfTask } from './task-answers';
import type { AgentStatus } from '../types';

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

/** The folder of the Claude account a task ran on, after the first; undefined for account 1 (~/.claude). */
function accountFolderOf(accountId: string | null): string | undefined {
  if (!accountId || accountId === 'default') return undefined;
  try {
    return accountDir(accountId);
  } catch {
    return undefined;
  }
}

/**
 * An ended task's answer, read once (task-answers.ts): from its CLI's transcript where Tars reads one (the provider it
 * ran on, its Claude account's folder), else what its watcher or hook posted during it. What its end keeps, and what
 * the delegation that follows it returns (agent-routes.ts runInTerminal).
 */
export function readAnswerOf(task: TaskRecord): Promise<string | null> {
  const provider = (task.provider ?? agents.get(task.agentId)?.provider) as AgentStatus['provider'];
  return answerOfTask(task, { transcript: hasClaudeHooks({ provider }), configDir: accountFolderOf(task.accountId) });
}

/** Every terminal task's answer kept at its end (2.0.7): a turn the owner typed, a message, a queued one alike. */
function keepAnswerOf(task: TaskRecord): void {
  void readAnswerOf(task).then((answer) => {
    if (answer) liveTaskLedger()?.keepAnswer(task.id, answer);
  });
}

export function startTaskWatch(file = TASK_LEDGER_FILE, textFile = TASK_TEXT_FILE, resultFile = TASK_RESULT_FILE): void {
  if (liveTaskLedger()) return;
  const ledger = createTaskLedger({
    file,
    textFile,
    resultFile,
    onEnded: keepAnswerOf,
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

/** When each agent's turn was last said interrupted by its CLI's own log. */
const interruptedAt = new Map<string, number>();

/**
 * A turn its CLI's own log says was interrupted, Esc in its terminal (codex's
 * turn_aborted, 2.0.4): no answer, and nothing else ends it. The agent's task
 * stops there, before the rest the CLI comes to would end it as completed, and
 * the delegation following it reads it interrupted (agent-routes.ts,
 * runInTerminal). Only from the agent's current session: an older one's is
 * not its task's.
 */
export function turnInterrupted(agentId: string, sessionId: string, at = Date.now()): void {
  const agent = agents.get(agentId);
  if (!agent || agent.currentSessionId !== sessionId) return;
  interruptedAt.set(agentId, at);
  liveTaskLedger()?.stateChanged({ id: agentId, status: 'stopped' });
}

/** When the agent's turn was last said interrupted by its CLI's own log, or undefined. */
export function turnInterruptedAt(agentId: string): number | undefined {
  return interruptedAt.get(agentId);
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
