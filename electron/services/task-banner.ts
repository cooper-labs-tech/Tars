import { agents } from '../core/agent-manager';
import { oneTaskQueue } from '../core/one-task';
import { ptyProcesses, withdrawWaiting } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { broadcastToAllWindows } from '../utils/broadcast';
import { interruptTurn } from './bus-delivery';

/**
 * What the window shows above an agent's terminal (design PR #451): the task
 * in hand, who gave it, since when and its first line, and the tasks that
 * wait, in the order they will run. The window counts the elapsed time.
 * Carried on agent:list and agent:get as `taskBanner`, and pushed as
 * `agent:task` whenever the task in hand or the line changes.
 */
export interface TaskBanner {
  task: { ref: string; from: string; startedAt: string; firstLine: string } | null;
  waiting: Array<{ ref: string; from: string; queuedAt: string; firstLine: string }>;
}

/** A task's first line, for the banner and the queue: 100 characters at most. */
export function firstLineOf(task: string): string {
  return Array.from(task.trim().split(/\r?\n|\r/)[0] ?? '').slice(0, 100).join('');
}

const fromOf = (requesterId?: string) => (requesterId ? agents.get(requesterId)?.name || requesterId : 'Tars');

export function taskBannerOf(agentId: string): TaskBanner {
  const run = oneTaskQueue.busyRun(agentId);
  return {
    task: run?.taskRef
      ? { ref: run.taskRef, from: fromOf(run.requesterId), startedAt: new Date(run.since).toISOString(), firstLine: run.title ?? '' }
      : null,
    waiting: oneTaskQueue.queued(agentId).map((t) => ({
      ref: t.ref, from: fromOf(t.requesterId), queuedAt: new Date(t.queuedAt).toISOString(), firstLine: t.title,
    })),
  };
}

export function announceTask(agentId: string): void {
  broadcastToAllWindows('agent:task', { agentId, ...taskBannerOf(agentId) });
}

/**
 * The banner's stop (`agent:task-stop`): that task only. The task in hand
 * ends its turn (Esc, as the window's own interrupt), never the session,
 * which keeps its conversation and its background work; a task that waits
 * leaves the line and never starts. Any other ref is no task of this agent's.
 * A task in hand whose turn has not begun (held in the terminal's writer by a
 * draft) is taken back there, as a cancel takes it: an Esc then would reach
 * whatever else runs, and the task would go in after (the Audit's L1 on #453).
 */
export async function stopTask(agentId: string, ref: string): Promise<{ success: boolean; stopped?: 'turn' | 'queued'; error?: string }> {
  const agent = agents.get(agentId);
  if (!agent) return { success: false, error: 'Agent not found' };
  const run = oneTaskQueue.busyRun(agentId);
  if (run?.taskRef === ref || (run?.taskId !== undefined && run.taskId === ref)) {
    const pty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
    if (run.taskId === undefined) {
      if (pty && run.taskRef && withdrawWaiting(pty, run.taskRef) > 0) {
        announceTask(agentId);
        return { success: true, stopped: 'queued' };
      }
      return { success: false, error: 'Its task is going into the terminal now, its turn not begun: stop it once its turn runs.' };
    }
    if (!pty || !cliRunningIn(pty)) return { success: false, error: 'No CLI runs in this agent\'s terminal: its task is not in a turn.' };
    await interruptTurn(agent, pty);
    return { success: true, stopped: 'turn' };
  }
  if (oneTaskQueue.queued(agentId).some((t) => t.ref === ref)) {
    oneTaskQueue.cancel(ref, 'taken back in the window', 'taken_back');
    announceTask(agentId);
    return { success: true, stopped: 'queued' };
  }
  return { success: false, error: `${agent.name || agentId} has no task ${ref} in hand or waiting.` };
}
