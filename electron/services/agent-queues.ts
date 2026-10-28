import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import type { OneTaskQueue, QueuedTask, QueueSnapshot } from '../core/one-task';

/**
 * An agent's queue, kept across a stop and a restart of Tars, and who may act on it (2.0.5, lot 2, item I of the
 * resources plan; the DB brief lot2-agent-queue-2810.md).
 *
 * What the projects' orchestrators hit on 27 and 28/10 (their tars-feedback-2810.md): every task waiting its turn
 * was lost at a restart, with no list of what was lost, and a stop emptied the queue, so each item had to be sent
 * again by hand. The line of core/one-task.ts is written here at each change, with what hands each item over again
 * (its `replay`, set by the route that queued it), and restored at the next launch, paused: nothing goes in before
 * the owner or the orchestrator resumes it, and the orchestrator is told what waits.
 *
 * In ~/.tars-private (0600): what one agent sent another is not for every agent to read, and ~/.tars is handed to
 * every agent. Only an item Tars can hand over again is kept.
 */

export const QUEUES_FILE = () => privatePath('agent-queues.json');

const VERSION = 1;

/** Only what can be handed over again: an item with no replay died with the run that queued it. */
function keptOf(snapshot: QueueSnapshot): QueueSnapshot {
  return { items: snapshot.items.filter((item) => item.replay !== undefined), paused: snapshot.paused };
}

let unsubscribe: (() => void) | undefined;

/** Writes the queue at each change from now on. */
export function keepQueue(queue: OneTaskQueue): void {
  unsubscribe?.();
  const save = () => {
    try {
      writeSecretFileSync(QUEUES_FILE(), `${JSON.stringify({ version: VERSION, ...keptOf(queue.snapshot()) }, null, 2)}\n`);
    } catch (err) {
      console.warn('[agent-queues] the queues could not be kept:', err instanceof Error ? err.message : err);
    }
  };
  unsubscribe = queue.onChange(save);
  save();
}

export function stopQueueKeeping(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}

/** What the file holds, or nothing when it is not a queue file of this version: said once, never thrown. */
function readKept(): QueueSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(QUEUES_FILE(), 'utf-8');
  } catch {
    return { items: [], paused: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; items?: unknown; paused?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) throw new Error('no list of items');
    const items = parsed.items.filter((i): i is QueuedTask => !!i && typeof i === 'object'
      && typeof (i as QueuedTask).ref === 'string' && typeof (i as QueuedTask).agentId === 'string' && typeof (i as QueuedTask).title === 'string'
      && typeof (i as QueuedTask).queuedAt === 'number' && (i as QueuedTask).replay !== undefined);
    if (items.length !== parsed.items.length) throw new Error('an item of another shape');
    const paused = parsed.paused && typeof parsed.paused === 'object' && !Array.isArray(parsed.paused) ? parsed.paused as QueueSnapshot['paused'] : {};
    return { items, paused };
  } catch (err) {
    console.warn(`[agent-queues] ${QUEUES_FILE()} is not a queue Tars can read (${err instanceof Error ? err.message : err}): nothing restored from it`);
    return { items: [], paused: {} };
  }
}

/** The ids the kept queues hold: their requests are not ended at launch (core/task-requests.ts endRequestsAtLaunch). */
export function keptQueueRefs(): Set<string> {
  return new Set(readKept().items.map((item) => item.ref));
}

/**
 * The kept queues back in the line, each agent's paused (`Tars restarted`, unless it was paused already, which keeps
 * its reason), and each item handed to `replay`, in order, which waits for its turn as the route that queued it did.
 */
export function restoreQueues(queue: OneTaskQueue, replay: (item: QueuedTask) => void, now: number = Date.now()): QueuedTask[] {
  const kept = readKept();
  const restored = queue.restore(kept);
  for (const agentId of new Set(restored.map((item) => item.agentId))) {
    if (!queue.pausedOf(agentId)) queue.pause(agentId, 'Tars restarted', now);
  }
  for (const item of restored) {
    try { replay(item); } catch (err) { console.warn(`[agent-queues] ${item.ref} could not be handed over again:`, err); }
  }
  return restored;
}

export interface QueueItemView {
  ref: string;
  position: number;
  requesterId?: string;
  from?: string;
  how?: QueuedTask['how'];
  title: string;
  queuedAt: string;
}

export interface QueueView {
  agentId: string;
  paused?: { since: string; why: string };
  items: QueueItemView[];
}

/** An agent's queue as the window, the API and get_agent show it; `only`: the items one requester sent. */
export function queueView(queue: OneTaskQueue, agentId: string, only?: string): QueueView {
  const pause = queue.pausedOf(agentId);
  return {
    agentId,
    ...(pause ? { paused: { since: new Date(pause.since).toISOString(), why: pause.why } } : {}),
    items: queue.queued(agentId)
      .map((t, i) => ({ t, position: i + 1 }))
      .filter(({ t }) => only === undefined || t.requesterId === only)
      .map(({ t, position }) => ({
        ref: t.ref, position,
        ...(t.requesterId ? { requesterId: t.requesterId } : {}),
        ...(t.from ? { from: t.from } : {}),
        ...(t.how ? { how: t.how } : {}),
        title: t.title, queuedAt: new Date(t.queuedAt).toISOString(),
      })),
  };
}

export type QueueOp = 'list' | 'pause' | 'resume' | 'move' | 'cancel';
export type QueueCaller =
  | { kind: 'tars' }
  | { kind: 'owner' }
  | { kind: 'agent'; agent: { id: string; role?: string; kind?: string; projectPath: string } };
export type QueueRight = { ok: true; all: boolean } | { ok: false; reason: string };

/**
 * Who may act on an agent's queue: Tars and the owner (the window), and the project's orchestrator, on everything;
 * any other agent of the project (a worker, a chat's runner) only on what it sent itself: it reads only its own
 * items, moves and cancels only those, and pauses or resumes nothing. Another project's agent, nothing.
 */
export function queueRight(caller: QueueCaller, target: { id: string; projectPath: string }, op: QueueOp, item?: Pick<QueuedTask, 'requesterId'>): QueueRight {
  if (caller.kind !== 'agent') return { ok: true, all: true };
  const { agent } = caller;
  if (agent.projectPath !== target.projectPath) return { ok: false, reason: 'This agent belongs to another project: its queue is not yours to act on.' };
  if (agent.role === 'orchestrator' && agent.kind !== 'chat') return { ok: true, all: true };
  if (op === 'list') return { ok: true, all: false };
  if (op === 'pause' || op === 'resume') return { ok: false, reason: "Only the project's orchestrator or the owner pauses or resumes an agent's queue: ask your orchestrator." };
  if (item?.requesterId === agent.id) return { ok: true, all: false };
  return { ok: false, reason: 'You did not send this item: only its sender, the project\'s orchestrator or the owner may act on it.' };
}

/**
 * Where a worker's own item may go when it moves it (the Audit's L1 on #536): only among its own items, never ahead
 * of what someone else queued (the orchestrator's, the owner's, another's). To the head means just after the last
 * item ahead of it that it does not own (`stays` when that is where it is already); before one of its own, only with
 * nothing of another's between. `before` is what to hand the line's move.
 */
export function moveWithin(line: Array<Pick<QueuedTask, 'ref' | 'requesterId'>>, ref: string, before: string | undefined, callerId: string):
  { ok: true; before: string | undefined; stays?: true } | { ok: false; reason: string } {
  const at = line.findIndex((t) => t.ref === ref);
  if (at < 0) return { ok: false, reason: `${ref} is not in this queue.` };
  const notMine = (t: Pick<QueuedTask, 'requesterId'>) => t.requesterId !== callerId;
  if (before === undefined) {
    let target = 0;
    for (let i = at - 1; i >= 0; i--) if (notMine(line[i])) { target = i + 1; break; }
    return target === at ? { ok: true, before: undefined, stays: true } : { ok: true, before: line[target].ref };
  }
  const to = line.findIndex((t) => t.ref === before);
  if (to < 0) return { ok: false, reason: `${before} is not in this queue.` };
  const passed = to < at ? line.slice(to, at) : [line[to]];
  if (passed.some(notMine)) return { ok: false, reason: 'You may move your item only among your own: never ahead of what the orchestrator, the owner or another agent queued.' };
  return { ok: true, before };
}
