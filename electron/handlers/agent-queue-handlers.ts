import { ipcMain } from 'electron';
import { agents, saveAgents } from '../core/agent-manager';
import { oneTaskQueue } from '../core/one-task';
import { requestDropped } from '../core/task-requests';
import { queueView, type QueueView } from '../services/agent-queues';
import { announceTask } from '../services/task-banner';
import { tellCancelled } from '../services/agent-watch';
import { broadcastToAllWindows } from '../utils/broadcast';

/**
 * The window's hold on an agent's queue (2.0.5, lot 2, services/agent-queues.ts): the owner reads it, pauses and
 * resumes it, moves and cancels any item. What the API gives the project's orchestrator, with nobody's rights to
 * check: the window is the owner's.
 */

type Answer = { success: true; view: QueueView } | { success: false; error: string };

function answer(agentId: string): Answer {
  return { success: true, view: queueView(oneTaskQueue, agentId) };
}

/** An item taken back by the owner: it never goes in, and whoever sent it is told who took it back. */
function takeBack(ref: string, why: string): void {
  const item = oneTaskQueue.cancel(ref, why);
  const worker = item ? agents.get(item.agentId) : undefined;
  if (!item || !worker) return;
  requestDropped(worker, item.ref);
  if (item.requesterId && item.requesterId !== worker.id) tellCancelled(item.requesterId, worker.id, 'the owner, in the window', 'taken back by the owner');
}

/** Why a cancel found no item in a queue: it started (its turn taken, or typed in), or no queue ever held it. */
function notWaiting(ref: string): { success: false; error: string; code: 'already_started' | 'not_found' } {
  const was = oneTaskQueue.lookup(ref);
  if (was && (was.state === 'starting' || was.state === 'started' || was.state === 'delivered')) {
    return { success: false, code: 'already_started', error: 'It has started: it is no longer waiting in the queue. Its turn can be stopped from the task banner.' };
  }
  return { success: false, code: 'not_found', error: 'No queue holds this task: it ended, or was never asked.' };
}

/** What each window was last told of each queue, so a burst of changes is told once, and only what moved. */
const told = new Map<string, string>();
let telling: ReturnType<typeof setTimeout> | undefined;

/** agentQueue:changed, with the queue as it now reads, for each agent whose queue moved. */
function tellChanges(): void {
  telling = undefined;
  const snapshot = oneTaskQueue.snapshot();
  const ids = new Set([...snapshot.items.map((i) => i.agentId), ...Object.keys(snapshot.paused), ...told.keys()]);
  for (const agentId of ids) {
    const view = queueView(oneTaskQueue, agentId);
    const json = JSON.stringify(view);
    if (told.get(agentId) === json) continue;
    if (!view.items.length && !view.paused) told.delete(agentId);
    else told.set(agentId, json);
    broadcastToAllWindows('agentQueue:changed', view);
  }
}

export function registerAgentQueueHandlers(): void {
  oneTaskQueue.onChange(() => { telling ??= setTimeout(tellChanges, 0); });

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

  ipcMain.handle('agentQueue:cancel', (_e, ref: unknown) => {
    const item = typeof ref === 'string' ? oneTaskQueue.find(ref) : undefined;
    if (!item) return notWaiting(String(ref));
    takeBack(item.ref, 'it was taken back by you, in the window');
    saveAgents();
    announceTask(item.agentId);
    return answer(item.agentId);
  });

  // Everything that waits, taken back at once; the pause, if any, stays as it was.
  ipcMain.handle('agentQueue:drop', (_e, agentId: unknown) => {
    if (typeof agentId !== 'string' || !agents.has(agentId)) return { success: false, error: 'No agent has this id.' };
    const items = oneTaskQueue.queued(agentId);
    for (const item of items) takeBack(item.ref, 'it was dropped by you, in the window, with the rest of the queue');
    saveAgents();
    announceTask(agentId);
    return { ...answer(agentId), dropped: items.length };
  });
}
