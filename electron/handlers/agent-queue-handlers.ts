import { ipcMain } from 'electron';
import { agents, saveAgents } from '../core/agent-manager';
import { oneTaskQueue } from '../core/one-task';
import { requestDropped } from '../core/task-requests';
import { queueView, type QueueView } from '../services/agent-queues';
import { announceTask } from '../services/task-banner';
import { tellCancelled } from '../services/agent-watch';

/**
 * The window's hold on an agent's queue (2.0.5, lot 2, services/agent-queues.ts): the owner reads it, pauses and
 * resumes it, moves and cancels any item. What the API gives the project's orchestrator, with nobody's rights to
 * check: the window is the owner's.
 */

type Answer = { success: true; view: QueueView } | { success: false; error: string };

function answer(agentId: string): Answer {
  return { success: true, view: queueView(oneTaskQueue, agentId) };
}

export function registerAgentQueueHandlers(): void {
  ipcMain.handle('agentQueue:get', (_e, agentId: unknown) => {
    if (typeof agentId !== 'string' || !agents.has(agentId)) return { error: 'not_found' };
    return queueView(oneTaskQueue, agentId);
  });

  ipcMain.handle('agentQueue:pause', (_e, agentId: unknown, reason?: unknown) => {
    if (typeof agentId !== 'string' || !agents.has(agentId)) return { success: false, error: 'No agent has this id.' };
    const why = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    oneTaskQueue.pause(agentId, `paused by you${why ? `: ${why}` : ''}`);
    announceTask(agentId);
    return answer(agentId);
  });

  ipcMain.handle('agentQueue:resume', (_e, agentId: unknown) => {
    if (typeof agentId !== 'string' || !agents.has(agentId)) return { success: false, error: 'No agent has this id.' };
    oneTaskQueue.resume(agentId);
    announceTask(agentId);
    return answer(agentId);
  });

  ipcMain.handle('agentQueue:move', (_e, ref: unknown, before?: unknown) => {
    const item = typeof ref === 'string' ? oneTaskQueue.find(ref) : undefined;
    if (!item) return { success: false, error: 'No queue holds this task: it went in, ended, or was never asked.' };
    if (before !== undefined && typeof before !== 'string') return { success: false, error: 'before is the id of another item of the same queue.' };
    if (!oneTaskQueue.move(item.ref, before)) return { success: false, error: `${String(before)} is not in this agent's queue.` };
    announceTask(item.agentId);
    return answer(item.agentId);
  });

  // An item taken back by the owner: it never goes in, and whoever sent it is told who took it back.
  ipcMain.handle('agentQueue:cancel', (_e, ref: unknown) => {
    const item = typeof ref === 'string' ? oneTaskQueue.find(ref) : undefined;
    if (!item) return { success: false, error: 'No queue holds this task: it went in, ended, or was never asked.' };
    oneTaskQueue.cancel(item.ref, 'it was taken back by you, in the window');
    const worker = agents.get(item.agentId);
    if (worker) {
      requestDropped(worker, item.ref);
      saveAgents();
      if (item.requesterId && item.requesterId !== worker.id) tellCancelled(item.requesterId, worker.id, 'the owner, in the window', 'taken back by the owner');
    }
    announceTask(item.agentId);
    return answer(item.agentId);
  });
}
