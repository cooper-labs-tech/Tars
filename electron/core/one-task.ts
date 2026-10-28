import { hasOrchestratorPowers } from './agent-role';
import { newTaskRef } from './task-requests';
import { hasEndOfTurn } from './end-of-turn';
import { envelopeValue } from '../utils/envelope-value';
import type { AgentProvider } from '../types';

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
 *    (GET /api/tasks/:id) and cancel it (POST /api/tasks/:ref/cancel). A task
 *    typed into a live terminal waits here as one sent to an agent with no
 *    session does, while a run holds the agent or tasks wait before it; a
 *    note, or Tars's own word, waits for the run's end instead, and is no
 *    task (holdsMessages). A turn in the terminal counts only where Tars can
 *    see it end (terminalTurnOf): amp, grok, opencode and pi tell Tars
 *    nothing of their turns, so only their runs hold them (codex's turns are
 *    read from its session log, services/codex-sessions.ts).
 * 2. Only Tars, the user's window, an agent with an orchestrator's powers
 *    (the project's orchestrator, a chat's runner) or the agent itself hand an
 *    agent work. A worker is refused, and told to ask its orchestrator; what
 *    it sends another worker arrives as a note, once that agent's turn ends.
 *    Stopping, restarting or removing an agent is reserved to the same
 *    callers (the maintainer's decision of the same day).
 *
 * 2.0.5 (lot 2 of the resources plan): the line is the agent's queue. A message sent to wait for the agent's
 * rest waits here too, and so does anything sent to an agent whose queue is paused. It can be read in order,
 * paused, reordered and cancelled, and it is kept, paused, across a stop and a restart of Tars
 * (services/agent-queues.ts writes it to ~/.tars-private).
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
  /** The task's first line, for the window's banner (2.0.4). */
  title?: string;
}

export interface QueuedTask {
  ref: string;
  agentId: string;
  requesterId?: string;
  title: string;
  queuedAt: number;
  /** How it goes in (2.0.5, the agent's queue): a task, a message sent to wait for the agent's rest, a worker's note. */
  how?: 'task' | 'message' | 'note';
  /** Who sent it, as the panel names them. */
  from?: string;
  /**
   * What hands it over again after a restart of Tars (services/agent-queues.ts): plain JSON, read by the route
   * that queued it. Kept in ~/.tars-private only, never in agents.json, which every agent is handed.
   */
  replay?: unknown;
}

/** Why and since when an agent's queue holds what waits in it (2.0.5): nothing goes in while it is paused. */
export interface QueuePause { since: number; why: string }

/** The line and the pauses, as services/agent-queues.ts keeps them across a restart of Tars. */
export interface QueueSnapshot {
  items: QueuedTask[];
  paused: Record<string, QueuePause>;
}

/**
 * Handed over in the agent's terminal once its turn came: typed into its
 * session, or a session started on it. `note`, for a CLI whose turns Tars
 * cannot see (no hook): what is not read of it (2.0.4).
 */
type Delivered = { how: 'typed' | 'started'; at: number; note?: string };

type Taken = { task: QueuedTask; taskId?: string; error?: string; delivered?: Delivered };

export interface OneTaskQueue {
  /** When this queue began, with this run of Tars: a task queued before it is gone. */
  readonly since: number;
  /** A run is on the agent from now: the check and the mark are one step for a queued task (takeTurn). */
  runStarted(agentId: string, run: Omit<Busy, 'kind'>): void;
  /** The ledger named the run's task. */
  runNamed(agentId: string, taskId: string): void;
  runEnded(agentId: string): void;
  busyRun(agentId: string): Busy | undefined;
  /** Whether a task asked now waits: the agent works, or others wait before it. */
  mustQueue(agentId: string, turn: Busy | undefined): boolean;
  /** Queued last; under `ref` when given (a request's id, which its sender line names), refused if that id is in line. */
  enqueue(agentId: string, task: { requesterId?: string; title: string; how?: QueuedTask['how']; from?: string; replay?: unknown }, now?: number, ref?: string): QueuedTask;
  /** To the head of its agent's line, or just before `before`, an item of the same line. False when either is not there. */
  move(ref: string, before?: string): boolean;
  /** Nothing in the agent's line takes its turn until it is resumed; the turn or run in progress is not touched. */
  pause(agentId: string, why: string, now?: number): void;
  resume(agentId: string): void;
  pausedOf(agentId: string): QueuePause | undefined;
  /** A request typed straight into the agent's terminal, known by its id from now: task_status finds it (2.0.5). */
  noteDelivered(task: QueuedTask, how: Delivered['how'], now?: number): void;
  /** Every line, in order, and the pauses. */
  snapshot(): QueueSnapshot;
  /** A snapshot's items queued again, after what the line holds, and its pauses kept; an id already known is not. Returns those queued. */
  restore(snapshot: QueueSnapshot): QueuedTask[];
  /** Told of every change of the lines or the pauses, to keep them (services/agent-queues.ts). */
  onChange(listener: () => void): () => void;
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
    | { state: 'delivered'; task: QueuedTask; how: Delivered['how']; at: number; note?: string }
    | { state: 'failed'; task: QueuedTask; error: string }
    | undefined;
  /** The run of a task taken from the queue ended before it started: no ledger task will follow. */
  notStarted(ref: string, error: string): void;
  /**
   * A task taken from the queue went into the agent's terminal: no ledger task
   * will follow, and nothing more is waited for. `note`: what is not read of
   * a CLI whose turns Tars cannot see.
   */
  delivered(ref: string, how: Delivered['how'], note?: string, now?: number): void;
  queued(agentId: string): QueuedTask[];
  /** Out of the line, never to start: still known by its ref, as failed with `why`, to whoever follows it. */
  cancel(ref: string, why?: string): QueuedTask | undefined;
}

/** How many tasks that left the line are remembered by their ref, for a caller that follows one late. */
const STARTED_KEPT = 200;

export function createOneTaskQueue(since: number = Date.now()): OneTaskQueue {
  const runs = new Map<string, Busy>();
  const lines = new Map<string, QueuedTask[]>();
  const taken = new Map<string, Taken>();
  const pauses = new Map<string, QueuePause>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try { listener(); } catch (err) { console.warn('[one-task] a listener of the queue failed:', err); }
    }
  };
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
  const remember = (ref: string, was: Taken) => {
    taken.set(ref, was);
    while (taken.size > STARTED_KEPT) taken.delete(taken.keys().next().value as string);
  };
  return {
    since,
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
      return runs.has(agentId) || !!turn || lineOf(agentId).length > 0 || pauses.has(agentId);
    },
    enqueue(agentId, task, now = Date.now(), asked) {
      if (asked && find(asked)) throw new Error(`${asked} is already in a queue`);
      let ref = asked ?? newTaskRef();
      while (!asked && find(ref)) ref = newTaskRef();
      const queued: QueuedTask = {
        ref, agentId, ...(task.requesterId ? { requesterId: task.requesterId } : {}), title: task.title, queuedAt: now,
        ...(task.how ? { how: task.how } : {}), ...(task.from ? { from: task.from } : {}), ...(task.replay !== undefined ? { replay: task.replay } : {}),
      };
      lines.set(agentId, [...lineOf(agentId), queued]);
      changed();
      return queued;
    },
    move(ref, before) {
      const task = find(ref);
      if (!task || before === ref) return false;
      const line = lineOf(task.agentId).filter((t) => t.ref !== ref);
      const at = before === undefined ? 0 : line.findIndex((t) => t.ref === before);
      if (at < 0) return false;
      line.splice(at, 0, task);
      lines.set(task.agentId, line);
      changed();
      return true;
    },
    pause(agentId, why, now = Date.now()) {
      pauses.set(agentId, { since: now, why });
      changed();
    },
    resume(agentId) {
      if (pauses.delete(agentId)) changed();
    },
    pausedOf(agentId) {
      return pauses.get(agentId);
    },
    noteDelivered(task, how, now = Date.now()) {
      if (find(task.ref) || taken.has(task.ref)) return;
      remember(task.ref, { task, delivered: { how, at: now } });
    },
    snapshot() {
      return { items: [...lines.values()].flat(), paused: Object.fromEntries(pauses) };
    },
    restore(snapshot) {
      const queued: QueuedTask[] = [];
      for (const item of snapshot.items ?? []) {
        if (!item?.ref || !item.agentId || find(item.ref) || taken.has(item.ref)) continue;
        lines.set(item.agentId, [...lineOf(item.agentId), item]);
        queued.push(item);
      }
      for (const [agentId, pause] of Object.entries(snapshot.paused ?? {})) pauses.set(agentId, pause);
      changed();
      return queued;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    takeTurn(agentId, ref, turn, now = Date.now()) {
      const line = lineOf(agentId);
      if (line[0]?.ref !== ref || runs.has(agentId) || turn || pauses.has(agentId)) return false;
      const task = line[0];
      leave(task);
      remember(ref, { task });
      runs.set(agentId, { kind: 'run', taskRef: ref, ...(task.requesterId ? { requesterId: task.requesterId } : {}), since: now, title: task.title });
      changed();
      return true;
    },
    find,
    lookup(ref) {
      const queued = find(ref);
      if (queued) return { state: 'queued', task: queued };
      const was = taken.get(ref);
      if (!was) return undefined;
      if (was.taskId) return { state: 'started', task: was.task, taskId: was.taskId };
      if (was.delivered) return { state: 'delivered', task: was.task, how: was.delivered.how, at: was.delivered.at, ...(was.delivered.note ? { note: was.delivered.note } : {}) };
      if (was.error !== undefined) return { state: 'failed', task: was.task, error: was.error };
      return { state: 'starting', task: was.task };
    },
    notStarted(ref, error) {
      const was = taken.get(ref);
      if (was && !was.taskId && !was.delivered) was.error = error;
    },
    delivered(ref, how, note, now = Date.now()) {
      const was = taken.get(ref);
      if (was && !was.taskId && was.error === undefined) was.delivered = { how, at: now, ...(note ? { note } : {}) };
    },
    queued(agentId) {
      return [...lineOf(agentId)];
    },
    cancel(ref, why = 'it was cancelled') {
      const task = find(ref);
      if (!task) return undefined;
      leave(task);
      remember(ref, { task, error: why });
      changed();
      return task;
    },
  };
}

/** What the busy rule reads of an agent: agent-routes.ts and agent-manager.ts hand it an AgentStatus. */
export interface TurnView {
  id: string;
  provider?: AgentProvider;
  status?: string;
  waitingReason?: string;
  /** Set by the stall watch on a `running` agent that does nothing (services/stall-watch.ts). */
  stalledSince?: string;
  workHandedAt?: string;
  lastActivity?: string;
  requestedBy?: { agentId?: string };
}

/**
 * A turn in the agent's terminal, as Tars can tell one: its CLI up, and
 * working or asking (a permission, a question). `waiting` on the idle prompt
 * is Claude Code's word for a CLI at rest at its prompt: no turn.
 *
 * Only where the CLI tells Tars its turn ended (hasEndOfTurn): amp, codex,
 * grok, opencode and pi stay `running` for as long as their TUI is open, so a
 * turn read from that never ended, and every task delegated to one of them
 * waited in its queue for ever (the Audit's H1 on #449). Their terminal is
 * taken as at rest, as it was before the queue: only their runs hold them.
 * And a turn the stall watch found doing nothing for half an hour is none: a
 * claude whose Stop was lost reads `running` at its prompt.
 */
export function terminalTurnOf(agent: TurnView, cliRunning: boolean): Busy | undefined {
  if (!hasEndOfTurn(agent) || agent.stalledSince) return undefined;
  if (agent.status !== 'running' && !(agent.status === 'waiting' && agent.waitingReason !== 'idle')) return undefined;
  if (!cliRunning) return undefined;
  const since = Date.parse(agent.workHandedAt ?? agent.lastActivity ?? '') || Date.now();
  return { kind: 'turn', ...(agent.requestedBy?.agentId ? { requesterId: agent.requestedBy.agentId } : {}), since };
}

/**
 * Whether a message sent to wait for the agent's rest (pty-manager.ts,
 * WriteOrigin.untilRest) still waits: a run holds the agent, or a turn Tars
 * can see end runs in its terminal. Read by the terminals' writer, so a note,
 * or Tars's own word, never goes in beside a run, whatever the agent's status
 * reads (the Audit's M1 on #449); and never waits for an end of turn a CLI
 * without hooks never says. Never for the tasks in line: they may wait for
 * the very turn this message ends, an answer to a question (the Audit's H-A on
 * 9d9a7ad9), and a note between two tasks goes in at the rest between them.
 */
export function holdsMessages(agent: TurnView, queue: OneTaskQueue = oneTaskQueue): boolean {
  if (queue.busyRun(agent.id)) return true;
  return agent.status === 'running' && hasEndOfTurn(agent) && !agent.stalledSince;
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

/** Who hands `target` work, and stops it: Tars, an agent with an orchestrator's powers, or the agent itself. */
function leads(caller: WorkCaller, target: { id: string }): boolean {
  return caller.kind === 'tars' || caller.agent.id === target.id || hasOrchestratorPowers(caller.agent);
}

/**
 * Null when this caller may hand `target` work: Tars, an agent with an
 * orchestrator's powers, or the agent itself. Else the refusal a worker reads.
 */
export function workerOrderRefusal(caller: WorkCaller, target: { id: string; name?: string }): string | null {
  if (leads(caller, target)) return null;
  const name = envelopeValue(target.name || target.id);
  return `A worker does not hand work to another agent: only Tars, the user's window and your project's orchestrator start ${name} `
    + `or give it a task. Ask your orchestrator for it (send_message to "orchestrator"), or send ${name} a note for information `
    + `with send_message: it reads it once its turn has ended, and it is not a task.`;
}

/**
 * Null when this caller may stop, restart or remove `target` (its CLI ended,
 * started again, or the agent deleted): the callers that hand it work. Else
 * the refusal a worker reads.
 */
export function workerStopRefusal(caller: WorkCaller, target: { id: string; name?: string }): string | null {
  if (leads(caller, target)) return null;
  const name = envelopeValue(target.name || target.id);
  return `A worker does not stop, restart or remove another agent: only Tars, the user's window and your project's orchestrator do. `
    + `Ask your orchestrator to stop ${name} (send_message to "orchestrator"), and say why.`;
}

/**
 * What a follower of a task id this run of Tars does not know is told. A task
 * still waiting its turn when Tars quit was in this queue's memory only: gone,
 * and never started.
 */
export function unknownTaskText(since: number): string {
  return `No such task. This Tars started at ${new Date(since).toISOString()} and keeps no task that was still waiting its turn `
    + 'before a restart: such a task never started, and must be asked again.';
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
