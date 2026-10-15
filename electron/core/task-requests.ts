import { randomBytes } from 'crypto';

/**
 * Who asked a worker for each piece of work, one request at a time, in order
 * (ORCHESTRATOR-PER-CHAT.md v2.2, PR A; the Audit's R1 to R4).
 *
 * `requestedBy` was one field per worker, written when a message was sent: a
 * second request sent while the worker was still busy overwrote the first,
 * and the first's result went to the second's sender (the bot and an
 * orchestrator, or two agents, handing work to one worker). A request is now
 * queued on the worker when it is sent, and `requestedBy` is only ever the
 * request whose work the worker is doing:
 *
 * - **delivered**: Tars wrote it into the worker's terminal (typed at rest, a
 *   new session's prompt, a held message released, the bus at turn end). It
 *   takes the link when no other holds it;
 * - **bound by its turn**: the turn whose prompt carries its id, which the
 *   sender line Tars types names (`, task t-xxxxxxxx`), takes the link, even
 *   over another delivered one: Claude Code queues what is typed during a
 *   turn, and runs it in its own turns, in order. A turn with no id (JeanBrasse
 *   typing, a scheduled task, a /loop) takes nothing;
 * - **spent**: its work ended and its requester was told (agent-watch). The
 *   next delivered request takes the link: a CLI with no prompt hook still
 *   reports each result to its own asker, in order.
 *
 * Plain records on the worker's AgentStatus, saved with agents.json by the
 * callers: a request still out when Tars stopped is found at the next launch.
 */

export interface TaskRequest {
  /** `t-` and 8 hex characters: typed in the sender line, and read back from the turn's prompt. */
  ref: string;
  requesterAgentId: string;
  queuedAt: string;
  state: 'queued' | 'delivered';
  /** Its message is a new session's prompt, which carries no sender line: that session's first turn is its turn. */
  newSession?: boolean;
}

/** The fields of an agent these functions read and write. */
export interface RequestWorker {
  id: string;
  ptyId?: string;
  taskQueue?: TaskRequest[];
  requestedBy?: { agentId: string; ptyId: string; backgroundLeft?: string[]; taskRef?: string };
}

/**
 * The envelope Tars types before an agent's request, at the very start of the
 * prompt: `Message from agent "<name>" ("<id>"), task t-xxxxxxxx: `. Name and
 * id are JSON strings (envelopeValue), read as such, so a quote or a
 * `, task t-...: ` inside the name cannot end it early: an agent named after
 * another request's id took that request (the Audit's gate of #351).
 */
const ENVELOPE = /^Message from agent "(?:[^"\\]|\\.)*" \(("(?:[^"\\]|\\.)*")\), task (t-[0-9a-f]{8}): /;

/** The request id and its sender's id, from the envelope at the start of a prompt; undefined without one. */
export function taskOfPrompt(prompt: string | undefined): { ref: string; senderId: string } | undefined {
  const m = prompt ? ENVELOPE.exec(prompt) : null;
  if (!m) return undefined;
  let senderId: unknown;
  try { senderId = JSON.parse(m[1]); } catch { return undefined; }
  return typeof senderId === 'string' ? { ref: m[2], senderId } : undefined;
}

export function newTaskRef(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

/**
 * Each request's first line, by its id, for the note that says which task
 * ended (the Audit's Low after 1.9.5). In memory only: a request is saved with
 * its worker in agents.json, which every agent is handed. Lost at a restart,
 * when the note then names the id alone.
 */
const titles = new Map<string, string>();
const TITLE_MAX = 80;
const TITLES_KEPT = 2_000;

/** The first line of what a request asked, cut to 80 characters; undefined when unknown. */
export function requestTitle(ref: string): string | undefined {
  return titles.get(ref);
}

function keepTitle(ref: string, text: string | undefined): void {
  const line = (text ?? '').trim().split(/\r?\n|\r/)[0]?.trim() ?? '';
  if (!line) return;
  titles.set(ref, Array.from(line).slice(0, TITLE_MAX).join(''));
  if (titles.size > TITLES_KEPT) titles.delete(titles.keys().next().value!);
}

/** Queued on the worker when it is sent. Returns its id, for the sender line. */
export function enqueueRequest(worker: RequestWorker, requesterAgentId: string, opts: { newSession?: boolean; ref?: string; title?: string } = {}): string {
  const ref = opts.ref ?? newTaskRef();
  keepTitle(ref, opts.title);
  worker.taskQueue = [...(worker.taskQueue ?? []), {
    ref, requesterAgentId, queuedAt: new Date().toISOString(), state: 'queued', ...(opts.newSession ? { newSession: true } : {}),
  }];
  return ref;
}

function link(worker: RequestWorker, request: TaskRequest): void {
  worker.requestedBy = { agentId: request.requesterAgentId, ptyId: worker.ptyId ?? '', taskRef: request.ref };
}

/** Written into the worker's terminal: it takes the link when no request holds it. */
export function requestDelivered(worker: RequestWorker, ref: string): void {
  const request = worker.taskQueue?.find(r => r.ref === ref);
  // Once: the write's callback and its answer both report it.
  if (!request || request.state === 'delivered') return;
  request.state = 'delivered';
  // A link holds while its request is still out; one written before requests
  // had ids (an older Tars) holds until its work is spent.
  const holder = worker.requestedBy;
  const holds = !!holder && (!holder.taskRef || worker.taskQueue!.some(r => r.ref === holder.taskRef));
  // Every request waits for the one in hand, the same asker's too: a takeover
  // reported the first turn's end as the follow-up's, and the follow-up's own
  // result reached nobody (the Audit's M2 on #351). Two truthful reports.
  if (!holds) link(worker, request);
}

/**
 * A turn started with this prompt. The request whose id it carries takes the
 * link; failing that, a delivered new session's request, whose prompt carries
 * no sender line. Returns whether one was bound.
 */
export function bindTurn(worker: RequestWorker, prompt: string | undefined): boolean {
  const queue = worker.taskQueue ?? [];
  const task = taskOfPrompt(prompt);
  // Only the request this envelope names, sent by the agent it names.
  const request = task
    ? queue.find(r => r.ref === task.ref && r.requesterAgentId === task.senderId)
    : queue.find(r => r.newSession && r.state === 'delivered');
  if (!request) return false;
  request.state = 'delivered';
  request.newSession = undefined;
  link(worker, request);
  return true;
}

/** The linked request's work is over and its requester told: the next delivered one takes the link. */
export function linkSpent(worker: RequestWorker): void {
  const spent = worker.requestedBy?.taskRef;
  worker.requestedBy = undefined;
  if (spent) worker.taskQueue = (worker.taskQueue ?? []).filter(r => r.ref !== spent);
  const next = worker.taskQueue?.find(r => r.state === 'delivered');
  if (next) link(worker, next);
}

/** Given up before it went in (a held message whose terminal ended). Returns who asked, to be told. */
export function requestDropped(worker: RequestWorker, ref: string): string | undefined {
  const request = worker.taskQueue?.find(r => r.ref === ref);
  if (!request) return undefined;
  worker.taskQueue = worker.taskQueue!.filter(r => r.ref !== ref);
  if (worker.requestedBy?.taskRef === ref) worker.requestedBy = undefined;
  return request.requesterAgentId;
}

/**
 * Every request still out that is not the work in hand, taken off the worker:
 * it is stopped, deleted, or found after Tars stopped. The linked one is told
 * by the end of its own work (agent-watch).
 */
export function takeAllRequests(worker: RequestWorker): TaskRequest[] {
  const linked = worker.requestedBy?.taskRef;
  const out = (worker.taskQueue ?? []).filter(r => r.ref !== linked);
  worker.taskQueue = (worker.taskQueue ?? []).filter(r => r.ref === linked);
  return out;
}

/**
 * At launch, after Tars stopped (the Audit's M1): every request left on a
 * worker is ended and told, the one in hand too unless the resume restarts
 * that worker (an abrupt stop's `working`). After a clean quit nothing is
 * resumed, and a link to a terminal that is gone was never spent.
 */
export function endRequestsAtLaunch(workers: Iterable<RequestWorker>, resumed: ReadonlySet<string>): void {
  for (const worker of workers) endWorkerRequests(worker, 'restart', { withLinked: !resumed.has(worker.id) });
}

/**
 * Whether a send may interrupt this worker (steer) or restart it: not while
 * the work in hand was asked by somebody else, whose work it would cut. The
 * work's own asker, Tars (no caller), and a worker with no work in hand may.
 * Across chats, never: the refusal then names the other chat (cutWorkOf).
 */
export function mayInterrupt(worker: RequestWorker, callerId: string | undefined): boolean {
  const holder = worker.requestedBy?.agentId;
  return !holder || !callerId || holder === callerId;
}

/**
 * Whether a send may restart this worker: as for an interrupt, and not while
 * another asker's request waits in its queue either. The stop ends every
 * request the worker holds, so it would cut that work too (the Audit's L1 on
 * #364). The caller's own queued requests and Tars do not stop it.
 */
export function mayRestart(worker: RequestWorker, callerId: string | undefined): boolean {
  if (!mayInterrupt(worker, callerId)) return false;
  return !callerId || !(worker.taskQueue ?? []).some((r) => r.requesterAgentId !== callerId);
}

/**
 * Whose work a steer or a restart would cut, which mayInterrupt or mayRestart
 * refuses it for: the asker of the work in hand, or, for a restart, the first
 * other asker still waiting in the queue. Undefined when the send may go. The
 * refusal names it: another chat's work, in a chat (PR D).
 */
export function cutWorkOf(worker: RequestWorker, callerId: string | undefined, mode: 'steer' | 'restart'): string | undefined {
  if (!callerId) return undefined;
  const holder = worker.requestedBy?.agentId;
  if (holder && holder !== callerId) return holder;
  if (mode !== 'restart') return undefined;
  return (worker.taskQueue ?? []).find((r) => r.requesterAgentId !== callerId)?.requesterAgentId;
}

/**
 * Once the resume after an abrupt stop has run: the work in hand of each
 * worker it did not relaunch (deleted, stopped or whose folder is gone since,
 * or whose launch failed) is ended and told; a worker launched again, or whose
 * running session took the note, keeps it (the Audit's Low on #351: the set
 * was the workers that had been working, whatever became of their resume).
 */
export function endUnresumed(workers: Iterable<RequestWorker>, outcomes: ReadonlyArray<{ agentId: string; how: string }>): void {
  const resumed = new Set(outcomes.filter((o) => o.how === 'launched' || o.how === 'typed').map((o) => o.agentId));
  const tried = new Set(outcomes.map((o) => o.agentId));
  for (const worker of workers) {
    if (tried.has(worker.id) && !resumed.has(worker.id)) endWorkerRequests(worker, 'restart', { withLinked: true });
  }
}

/** Whether a request of this requester is still out at any worker of the fleet. */
export function isOwedByRequests(fleet: Iterable<RequestWorker>, requesterId: string): boolean {
  for (const worker of fleet) {
    if (worker.id === requesterId) continue;
    if (worker.taskQueue?.some(r => r.requesterAgentId === requesterId)) return true;
  }
  return false;
}

/** A request whose message is about to be a new session's launch prompt. */
export function requestStartsSession(worker: RequestWorker, ref: string): void {
  const request = worker.taskQueue?.find(r => r.ref === ref);
  if (request) request.newSession = true;
}

/** Why a worker's requests ended without being done: told to each requester. */
export type RequestsEndedWhy = 'stopped' | 'deleted' | 'restart' | 'given-up' | 'cut';

type RequestsEndedHook = (worker: RequestWorker, requests: TaskRequest[], why: RequestsEndedWhy) => void;
let requestsEnded: RequestsEndedHook | undefined;

/** Set by agent-watch, which tells the requesters: this module stays free of the fleet. */
export function setRequestsEndedHook(hook: RequestsEndedHook | undefined): void {
  requestsEnded = hook;
}

/**
 * The worker is stopped, deleted, or found with requests still out after Tars
 * stopped (the Audit's R3): every request it will never run is taken off it,
 * and its requesters are told. With `withLinked`, the one in hand too (a
 * deleted worker has no end of its own to tell it).
 */
export function endWorkerRequests(worker: RequestWorker, why: RequestsEndedWhy, opts: { withLinked?: boolean } = {}): TaskRequest[] {
  const ended = takeAllRequests(worker);
  if (ended.length) requestsEnded?.(worker, ended, why);
  if (opts.withLinked && worker.requestedBy?.taskRef) {
    const linked = worker.taskQueue?.find(r => r.ref === worker.requestedBy!.taskRef);
    worker.taskQueue = [];
    worker.requestedBy = undefined;
    // The work in hand was cut, not left undone: told as such. A stop clears
    // the worker's terminal first, so its own end never reaches its asker.
    if (linked) {
      requestsEnded?.(worker, [linked], why === 'deleted' ? 'deleted' : 'cut');
      ended.unshift(linked);
    }
  }
  return ended;
}

/** A held message given up before it went in (its terminal ended): off the queue, its requester told (the Audit's R2). */
export function requestGivenUp(worker: RequestWorker, ref: string): void {
  const request = worker.taskQueue?.find(r => r.ref === ref);
  if (!request) return;
  requestDropped(worker, ref);
  requestsEnded?.(worker, [request], 'given-up');
}
