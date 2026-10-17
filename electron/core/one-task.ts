import { hasOrchestratorPowers } from './agent-role';
import { newTaskRef } from './task-requests';
import { envelopeValue } from '../utils/envelope-value';

/**
 * One agent, one task at a time, and a worker never orders work from another
 * agent (2.0.4). The maintainer's two decisions of 2026-10-18, after a worker
 * delegated a gate to the QA while the orchestrator's gate of the same PR ran
 * there: Tars opened a second QA session beside the first, and both worked.
 *
 * 1. A task handed to an agent already working (a run over ACP in progress,
 *    or a turn in its terminal) never starts a second session: it waits here,
 *    first come first served, and starts once the agent is free. It has a
 *    task id from the moment it is queued, so its asker can follow it
 *    (GET /api/tasks/:id) and cancel it (POST /api/tasks/:ref/cancel).
 * 2. Only Tars, the user's window, an agent with an orchestrator's powers
 *    (the project's orchestrator, a chat's runner) or the agent itself hand an
 *    agent work. A worker is refused, and told to ask its orchestrator; what
 *    it sends another worker arrives as a note, once that agent's turn ends.
 *
 * In memory: a queued task has not started, and a quit of Tars drops it as it
 * drops the request that asked for it.
 */

/** What an agent is busy with: a run over ACP (queued first or not), or a turn in its terminal. */
export interface Busy {
  kind: 'run' | 'turn';
  /** The ledger's task, once the run has one. */
  taskId?: string;
  /** The queued task's id, for a run that waited its turn. */
  taskRef?: string;
  requesterId?: string;
  since: number;
}

export interface QueuedTask {
  ref: string;
  agentId: string;
  requesterId?: string;
  title: string;
  queuedAt: number;
}

type Taken = { task: QueuedTask; taskId?: string; error?: string };

/** Who may cancel: the fleet as the queue reads it. */
type FleetMember = { id: string; role?: string; kind?: string; projectPath?: string };

export interface OneTaskQueue {
  /** A run is on the agent from now: the check and the mark are one step for a queued task (takeTurn). */
  runStarted(agentId: string, run: Omit<Busy, 'kind'>): void;
  /** The ledger named the run's task. */
  runNamed(agentId: string, taskId: string): void;
  runEnded(agentId: string): void;
  busyRun(agentId: string): Busy | undefined;
  /** Whether a task asked now waits: the agent works, or others wait before it. */
  mustQueue(agentId: string, turn: Busy | undefined): boolean;
  enqueue(agentId: string, task: { requesterId?: string; title: string }, now?: number): QueuedTask;
  /**
   * Its turn: first in line and the agent free (no run, and `turn` undefined).
   * Taken, it leaves the line and its run is on record at once.
   */
  takeTurn(agentId: string, ref: string, turn: Busy | undefined, now?: number): boolean;
  find(ref: string): QueuedTask | undefined;
  /**
   * Where a task that waited here is, by its ref, for the caller following it:
   * still queued, taken and starting, started as the ledger's task, or ended
   * before any run started (its error).
   */
  lookup(ref: string):
    | { state: 'queued'; task: QueuedTask }
    | { state: 'starting'; task: QueuedTask }
    | { state: 'started'; task: QueuedTask; taskId: string }
    | { state: 'failed'; task: QueuedTask; error: string }
    | undefined;
  /** The run of a task taken from the queue ended before it started: no ledger task will follow. */
  notStarted(ref: string, error: string): void;
  queued(agentId: string): QueuedTask[];
  mayCancel(ref: string, callerId: string | undefined, fleet: ReadonlyMap<string, FleetMember>): boolean;
  cancel(ref: string): QueuedTask | undefined;
}

/** How many started tasks are remembered by their ref, for a caller that follows one late. */
const STARTED_KEPT = 200;

export function createOneTaskQueue(): OneTaskQueue {
  const runs = new Map<string, Busy>();
  const lines = new Map<string, QueuedTask[]>();
  const taken = new Map<string, Taken>();
  const lineOf = (agentId: string) => lines.get(agentId) ?? [];
  const leave = (task: QueuedTask) => {
    const line = lineOf(task.agentId).filter((t) => t.ref !== task.ref);
    if (line.length) lines.set(task.agentId, line);
    else lines.delete(task.agentId);
  };
  const find = (ref: string) => {
    for (const line of lines.values()) {
      const task = line.find((t) => t.ref === ref);
      if (task) return task;
    }
    return undefined;
  };
  return {
    runStarted(agentId, run) {
      runs.set(agentId, { kind: 'run', ...run });
    },
    runNamed(agentId, taskId) {
      const run = runs.get(agentId);
      if (!run) return;
      run.taskId = taskId;
      const was = run.taskRef ? taken.get(run.taskRef) : undefined;
      if (was) was.taskId = taskId;
    },
    runEnded(agentId) {
      runs.delete(agentId);
    },
    busyRun(agentId) {
      return runs.get(agentId);
    },
    mustQueue(agentId, turn) {
      return runs.has(agentId) || !!turn || lineOf(agentId).length > 0;
    },
    enqueue(agentId, task, now = Date.now()) {
      let ref = newTaskRef();
      while (find(ref)) ref = newTaskRef();
      const queued: QueuedTask = { ref, agentId, ...(task.requesterId ? { requesterId: task.requesterId } : {}), title: task.title, queuedAt: now };
      lines.set(agentId, [...lineOf(agentId), queued]);
      return queued;
    },
    takeTurn(agentId, ref, turn, now = Date.now()) {
      const line = lineOf(agentId);
      if (line[0]?.ref !== ref || runs.has(agentId) || turn) return false;
      const task = line[0];
      leave(task);
      taken.set(ref, { task });
      while (taken.size > STARTED_KEPT) taken.delete(taken.keys().next().value as string);
      runs.set(agentId, { kind: 'run', taskRef: ref, ...(task.requesterId ? { requesterId: task.requesterId } : {}), since: now });
      return true;
    },
    find,
    lookup(ref) {
      const queued = find(ref);
      if (queued) return { state: 'queued', task: queued };
      const was = taken.get(ref);
      if (!was) return undefined;
      if (was.taskId) return { state: 'started', task: was.task, taskId: was.taskId };
      if (was.error !== undefined) return { state: 'failed', task: was.task, error: was.error };
      return { state: 'starting', task: was.task };
    },
    notStarted(ref, error) {
      const was = taken.get(ref);
      if (was && !was.taskId) was.error = error;
    },
    queued(agentId) {
      return [...lineOf(agentId)];
    },
    mayCancel(ref, callerId, fleet) {
      const task = find(ref);
      if (!task) return false;
      if (!callerId || callerId === task.requesterId) return true;
      const caller = fleet.get(callerId);
      const agent = fleet.get(task.agentId);
      return !!caller && !!agent && hasOrchestratorPowers(caller) && caller.projectPath === agent.projectPath;
    },
    cancel(ref) {
      const task = find(ref);
      if (task) leave(task);
      return task;
    },
  };
}

/** What a queued task waits behind, said for its asker. */
export function behindText(busy: Busy, nameOf: (id: string) => string | undefined): string {
  const since = new Date(busy.since).toISOString();
  const from = busy.requesterId ? ` from ${envelopeValue(nameOf(busy.requesterId) || busy.requesterId)}` : '';
  if (busy.kind === 'turn') return `a turn in its terminal${from}, since ${since}`;
  const id = busy.taskId ?? busy.taskRef;
  return `${id ? `task ${id}` : 'a run'}${from}, since ${since}`;
}

/** The caller as the drive routes resolve it (agent-routes.ts, resolveDriver). */
export type WorkCaller = { kind: 'tars' } | { kind: 'agent'; agent: { id: string; name?: string; role?: string; kind?: string } };

/**
 * Null when this caller may hand `target` work: Tars, an agent with an
 * orchestrator's powers, or the agent itself. Else the refusal a worker reads.
 */
export function workerOrderRefusal(caller: WorkCaller, target: { id: string; name?: string }): string | null {
  if (caller.kind === 'tars' || caller.agent.id === target.id || hasOrchestratorPowers(caller.agent)) return null;
  const name = envelopeValue(target.name || target.id);
  return `A worker does not hand work to another agent: only Tars, the user's window and your project's orchestrator start ${name} `
    + `or give it a task. Ask your orchestrator for it (send_message to "orchestrator"), or send ${name} a note for information `
    + `with send_message: it reads it once its turn has ended, and it is not a task.`;
}

/**
 * A worker writing to whoever leads it is reporting, not ordering: its
 * requester, or an agent with an orchestrator's powers in its project (as
 * requestFor in agent-routes.ts reads it).
 */
export function isReportTo(
  caller: { id: string; projectPath?: string; requestedBy?: { agentId?: string } },
  target: { id: string; role?: string; kind?: string; projectPath?: string },
): boolean {
  return caller.requestedBy?.agentId === target.id || (hasOrchestratorPowers(target) && target.projectPath === caller.projectPath);
}

/** A worker's message to another agent, as it is typed in: a note, labelled so, never an order. */
export function noteFrom(senderName: string, message: string): string {
  return `[Note for information from ${envelopeValue(senderName)}, a worker: it is not a task, and asks nothing of you unless your own work needs it.] ${message}`;
}

/** The fleet's queue: one for the process, read by the drive routes and the task routes. */
export const oneTaskQueue = createOneTaskQueue();
