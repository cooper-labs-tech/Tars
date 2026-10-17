/**
 * The agents' kanban, on the Hermes board.
 *
 * The board lives in Hermes; the Kanban page shows it and nothing else. The
 * agents' kanban tools used to write ~/.dorothy/kanban-tasks.json, a board no
 * page shows, so a task an agent said it had filed was nowhere to be seen. They
 * now go through Tars to Hermes, and this decides where an agent's task sits on
 * that board and who may move it.
 *
 * Measured against Hermes 0.21.1's own code (its kanban_db and its HTTP
 * handlers, in a throwaway HERMES_HOME):
 * - the dispatcher spawns a `ready` task assigned to a Hermes profile;
 * - it promotes `todo`, and `blocked` with no block event, to `ready` by itself;
 * - the gateway decomposes `triage` with its aux model (`kanban.auto_decompose`);
 * - `scheduled` is never dispatched nor promoted: an explicit unblock is the
 *   only way out, which is JeanBrasse dragging it on the board;
 * - a `ready` task assigned to what cannot be a Hermes profile (profile ids are
 *   `[a-z0-9][a-z0-9_-]*`: never a colon) is skipped as `skipped_nonspawnable`,
 *   Hermes's own provision for lanes that are not its workers;
 * - the API refuses `running`, and `done` from `scheduled`; a PATCH applies the
 *   assignee before the status.
 *
 * So:
 * - parked: `scheduled` on the Tars lane (`tars:unclaimed`). Hermes never takes
 *   it; JeanBrasse hands it to Hermes by moving it and giving it a Hermes profile.
 * - claimed: `ready` on the claiming agent's lane (`tars:<agent id>`), set in one
 *   PATCH whose assignee lands first, so the task is never `ready` on no lane.
 * - done: `done`, from the claim.
 * - deleted: by the agent that claimed it, or by the one that filed it while
 *   nobody has; the rest is another agent's, Hermes's or JeanBrasse's.
 *
 * Claims are atomic among Tars's agents, which all come through this process: a
 * claim reads and writes a task under that task's own lock. Hermes has no
 * compare-and-set, so this is no guard against a person moving the task on the
 * board at the same moment; that person is JeanBrasse, and the move is his to make.
 *
 * Each project is a Hermes tenant (its path), which the board filters on.
 */

import * as fs from 'fs';
import { writeAtomicSync } from '../utils/secret-file';
import { envelopeValue } from '../utils/envelope-value';
import type { MessageSender } from '../core/pty-manager';
import { samePath, isUnder } from '../platform/path-compare';

export const PARKED = 'scheduled';
/** The lane a parked task sits on: Tars's, taken by no agent yet. */
export const TARS_LANE = 'tars:unclaimed';

/** The lane of one agent. Lowercase, as Hermes stores assignees. */
export function laneOf(agentId: string): string {
  return `tars:${agentId}`.toLowerCase();
}

function agentOfLane(assignee: string | null | undefined): string | null {
  if (!assignee || !assignee.startsWith('tars:') || assignee === TARS_LANE) return null;
  return assignee.slice('tars:'.length);
}

/** The four columns the kanban tools speak, which predate the Hermes board. */
export type AgentColumn = 'backlog' | 'planned' | 'ongoing' | 'done';

interface HermesTask {
  id: string;
  title?: string;
  body?: string | null;
  status?: string;
  assignee?: string | null;
  priority?: number;
  tenant?: string | null;
  result?: string | null;
}

type Reply<T> = { success: true } & T | { success: false; error?: string };

/** The part of hermes-client this needs, so tests can stand a fake Hermes in its place. */
export interface KanbanHermes {
  board(tenant?: string): Promise<Reply<{ board: unknown }>>;
  get(id: string): Promise<Reply<{ detail: unknown }>>;
  create(task: Record<string, unknown>): Promise<Reply<{ task: unknown }>>;
  update(id: string, patch: Record<string, unknown>): Promise<Reply<{ task: unknown }>>;
  remove(id: string): Promise<Reply<object>>;
  comment(id: string, body: string): Promise<Reply<object>>;
}

/** Who is calling, as Tars knows it from the token presented. */
export interface KanbanCaller {
  agentId: string;
  name?: string;
  projectPath: string;
}

export interface AgentTask {
  id: string;
  title: string;
  column: AgentColumn;
  /** Hermes's own status, which the board shows. */
  status: string;
  /** Who holds it, in words: an agent, "Hermes (<profile>)", or nobody. */
  holder: string | null;
  priority: 'low' | 'medium' | 'high';
  description: string;
  heldByCaller: boolean;
}

export interface AgentTaskDetail extends AgentTask {
  comments: string[];
  result: string | null;
}

export type KanbanResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

// ── Names ─────────────────────────────────────────────────────────────────

/** Tars's agents by id, wired by main.ts: a lane is an id, a person reads a name. */
let directory: (agentId: string) => { name?: string } | undefined = () => undefined;
const claimedNames = new Map<string, string>();

export function setKanbanAgentDirectory(fn: (agentId: string) => { name?: string } | undefined): void {
  directory = fn;
}

function nameOfLane(assignee: string | null | undefined): string | null {
  const id = agentOfLane(assignee);
  if (!id) return null;
  const name = directory(id)?.name ?? claimedNames.get(id);
  return name ? `${name} (${id.slice(0, 8)})` : `agent ${id.slice(0, 8)}`;
}

// ── Reading the board ─────────────────────────────────────────────────────

export function columnOf(task: { status?: string | null; assignee?: string | null }): AgentColumn {
  const status = task.status ?? '';
  if (status === 'done' || status === 'archived') return 'done';
  if (agentOfLane(task.assignee)) return 'ongoing';
  if (status === PARKED) return 'backlog';
  if (status === 'running' || status === 'review') return 'ongoing';
  return 'planned';
}

function holderOf(task: HermesTask): string | null {
  const agent = nameOfLane(task.assignee);
  if (agent) return agent;
  if (!task.assignee || task.assignee === TARS_LANE) return null;
  return `Hermes (${task.assignee})`;
}

const PRIORITY_TO_HERMES = { low: -1, medium: 0, high: 1 } as const;

function priorityOf(n: number | undefined): 'low' | 'medium' | 'high' {
  if ((n ?? 0) > 0) return 'high';
  if ((n ?? 0) < 0) return 'low';
  return 'medium';
}

function toAgentTask(t: HermesTask, caller: KanbanCaller): AgentTask {
  return {
    id: t.id,
    title: t.title ?? '',
    column: columnOf(t),
    status: t.status ?? '',
    holder: holderOf(t),
    priority: priorityOf(t.priority),
    description: t.body ?? '',
    heldByCaller: t.assignee === laneOf(caller.agentId),
  };
}

/** A connection file that is there and cannot be used, with why (hermes-config's configuredHermesConnection). */
export interface HermesUnusable {
  unusable: string;
}

type Conn = KanbanHermes | HermesUnusable | null;

/**
 * The task in a create or a patch answer. The gateway sends `{ "task": {...} }`
 * (its create_task and update_task); read at the top level it has no id, which
 * is how the local board's move failed on every task in the first in-app run.
 */
function taskIn(answer: unknown): HermesTask {
  const wrapped = (answer as { task?: HermesTask } | null)?.task;
  return (wrapped && typeof wrapped === 'object' ? wrapped : answer) as HermesTask;
}

/**
 * What an agent does when the board cannot be had, said in every refusal: an
 * agent that read a bare "Hermes refused: Unauthorized" retried, or dropped the
 * task, since nothing said that only the user can fix it and where.
 */
const USER_FIXES = 'they connect or sign in to Hermes in Tars (Settings, Hermes). ';
const WHAT_TO_DO = `Only the user can fix this: ${USER_FIXES}`
  + 'Tell the user or your requester once, keep the task in your project folder\'s notes/ (tars_guide, project-folder), '
  + 'and go on with your work without calling the kanban again until then.';

function notConfigured(): { ok: false; status: number; error: string } {
  return fail(503, `Hermes is not configured in Tars: the kanban lives on the Hermes board, and there is no other. Nothing was written. ${WHAT_TO_DO}`);
}

/**
 * A connection Hermes never took: what nothing reached cannot have written
 * anything. Any other failure (a timeout, a reset, a hang up) may have come
 * after Hermes did the work, and only the board says whether it did.
 */
const NEVER_REACHED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;

function unreachable(err: unknown): { ok: false; status: number; error: string } {
  const why = err instanceof Error ? err.message : String(err);
  const written = NEVER_REACHED.test(why)
    ? 'Nothing was written, here or anywhere else.'
    : 'Hermes may have done it before its answer was lost: once it answers, read the task on the board (get_task, list_tasks) before you write it again.';
  return fail(502, `Hermes did not answer: ${why}. ${written} ${WHAT_TO_DO}`);
}

/** Hermes said no. `done`: what the call had already written before it did. */
function refused(reply: { success: false; error?: string }, done?: string): { ok: false; status: number; error: string } {
  // A refusal may be of the call (a transition Hermes does not allow) and not
  // of the caller: what to do is said for the one only the user can fix.
  return fail(502, `Hermes refused: ${reply.error || 'no reason given'}. ${done ?? 'Nothing was written.'} If it refused access (a token, a sign-in): ${WHAT_TO_DO.replace(/^Only/, 'only')}`);
}

/** Every task of one project, as the board has it now. */
async function projectTasks(h: KanbanHermes, projectPath: string): Promise<KanbanResult<HermesTask[]>> {
  const r = await h.board(projectPath);
  if (!r.success) return refused(r);
  const columns = (r.board as { columns?: Array<{ tasks?: HermesTask[] }> } | null)?.columns;
  const tasks = Array.isArray(columns) ? columns.flatMap(c => (Array.isArray(c.tasks) ? c.tasks : [])) : [];
  // The gateway filters on the tenant; this is the same rule, kept here so a
  // gateway that ignored the filter could not hand an agent another project.
  return { ok: true, value: tasks.filter(t => t && t.tenant === projectPath) };
}

/** One task of the caller's project, from its id or the start of it. */
async function resolve(h: KanbanHermes, caller: KanbanCaller, idOrPrefix: string): Promise<KanbanResult<HermesTask>> {
  const want = (idOrPrefix ?? '').trim();
  if (!want) return fail(400, 'task_id is required');
  const all = await projectTasks(h, caller.projectPath);
  if (!all.ok) return all;
  const exact = all.value.find(t => t.id === want);
  if (exact) return { ok: true, value: exact };
  const matches = all.value.filter(t => t.id.startsWith(want));
  if (matches.length === 1) return { ok: true, value: matches[0] };
  if (matches.length > 1) return fail(409, `"${want}" matches ${matches.length} tasks of this project: give more of the id.`);
  return fail(404, `No task "${want}" in this project (${caller.projectPath}).`);
}

async function fresh(h: KanbanHermes, id: string): Promise<KanbanResult<{ task: HermesTask; comments: string[] }>> {
  const r = await h.get(id);
  if (!r.success) return refused(r);
  const detail = r.detail as { task?: HermesTask; comments?: Array<{ body?: string }> } | null;
  if (!detail?.task) return fail(502, `Hermes returned no task for ${id}`);
  return { ok: true, value: { task: detail.task, comments: (detail.comments ?? []).map(c => String(c.body ?? '')) } };
}

/** Runs `fn` with the connection, turning "none", a broken one and a transport failure into answers. */
async function withHermes<T>(h: Conn, fn: (h: KanbanHermes) => Promise<KanbanResult<T>>): Promise<KanbanResult<T>> {
  if (!h) return notConfigured();
  if ('unusable' in h) return fail(503, `The Hermes connection cannot be used: ${h.unusable} Until it can, the kanban has no board. Nothing was written. ${WHAT_TO_DO}`);
  try {
    return await fn(h);
  } catch (err) {
    return unreachable(err);
  }
}

// ── One task at a time ────────────────────────────────────────────────────

const taskLocks = new Map<string, Promise<unknown>>();

/** Everything that reads a task and then writes it, for that task, one after another. */
function underTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prior = taskLocks.get(taskId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const settled = run.catch(() => undefined);
  taskLocks.set(taskId, settled);
  void settled.then(() => { if (taskLocks.get(taskId) === settled) taskLocks.delete(taskId); });
  return run;
}

/** Why the caller may not act on a task someone else holds, or null. */
function heldElsewhere(t: HermesTask, caller: KanbanCaller): string | null {
  if (t.assignee === laneOf(caller.agentId)) return null;
  const agent = nameOfLane(t.assignee);
  if (agent) return `Task ${t.id} is claimed by ${agent}: only that agent can act on it.`;
  if (t.status !== PARKED && t.status !== 'done') {
    return `Task ${t.id} is Hermes's (${t.status}${t.assignee && t.assignee !== TARS_LANE ? `, ${t.assignee}` : ''}): only the user moves it back.`;
  }
  return null;
}

/**
 * The agent that filed a task, from the line Tars writes last in its body:
 * "Filed by <name> (Tars agent <id>)." The gateway records every creation as
 * "dashboard", so this line is the only record of who filed a task, and written
 * after the agent's own description it cannot be put there by the agent. Null
 * for a task nobody filed through Tars: made on the board, or moved from the
 * local one.
 */
function filerOf(t: HermesTask): string | null {
  const signed = /\(Tars agent ([^()\s]+)\)\.$/.exec((t.body ?? '').trimEnd());
  return signed ? signed[1] : null;
}

/**
 * Why the caller may not delete a task, or null. An agent deletes a task it
 * claimed, done or not, or one it filed that nobody took. heldElsewhere let any
 * parked or done task through, whoever it was: a scheduled task JeanBrasse gave to a
 * Hermes profile, one Hermes finished, another agent's (the Backend's gate of
 * #171, W2). JeanBrasse deletes those on the Kanban page.
 */
function whyNotDeletable(t: HermesTask, caller: KanbanCaller): string | null {
  if (t.assignee === laneOf(caller.agentId)) return null;
  if (t.assignee === TARS_LANE && filerOf(t) === caller.agentId) return null;
  return heldElsewhere(t, caller)
    ?? `Task ${t.id} is not yours to delete: an agent deletes a task it filed and nobody claimed, or one it claimed. The user deletes the others on the Kanban page.`;
}

// ── The tools ─────────────────────────────────────────────────────────────

export async function listTasks(h: Conn, caller: KanbanCaller, opts: { column?: AgentColumn; mine?: boolean }): Promise<KanbanResult<AgentTask[]>> {
  return withHermes(h, async h => {
    const all = await projectTasks(h, caller.projectPath);
    if (!all.ok) return all;
    let tasks = all.value.map(t => toAgentTask(t, caller));
    if (opts.column) tasks = tasks.filter(t => t.column === opts.column);
    if (opts.mine) tasks = tasks.filter(t => t.heldByCaller);
    return { ok: true, value: tasks };
  });
}

export async function getTask(h: Conn, caller: KanbanCaller, idOrPrefix: string): Promise<KanbanResult<AgentTaskDetail>> {
  return withHermes(h, async h => {
    const found = await resolve(h, caller, idOrPrefix);
    if (!found.ok) return found;
    const detail = await fresh(h, found.value.id);
    if (!detail.ok) return detail;
    return { ok: true, value: { ...toAgentTask(detail.value.task, caller), comments: detail.value.comments, result: detail.value.task.result ?? null } };
  });
}

/** The project a task is filed under: the caller's own, which a worktree of it also names. */
function projectFor(caller: KanbanCaller, asked?: string): KanbanResult<string> {
  if (!asked) return { ok: true, value: caller.projectPath };
  if (samePath(asked, caller.projectPath) || isUnder(asked, caller.projectPath)) return { ok: true, value: caller.projectPath };
  return fail(403, `An agent files tasks in its own project (${caller.projectPath}), not in ${asked}.`);
}

export async function createParkedTask(
  h: Conn,
  caller: KanbanCaller,
  input: { title: string; description: string; projectPath?: string; priority?: 'low' | 'medium' | 'high'; labels?: string[] },
): Promise<KanbanResult<AgentTask>> {
  if (!input.title?.trim()) return fail(400, 'title is required');
  const project = projectFor(caller, input.projectPath);
  if (!project.ok) return project;
  return withHermes(h, async h => {
    const labels = (input.labels ?? []).filter(Boolean);
    const body = [input.description ?? '', labels.length ? `Labels: ${labels.join(', ')}` : '', `Filed by ${caller.name || caller.agentId} (Tars agent ${caller.agentId}).`]
      .filter(Boolean).join('\n\n');
    // Created on the Tars lane, so that in the moment before it is parked it is
    // `ready` on something Hermes cannot spawn, never on no lane at all.
    const created = await h.create({
      title: input.title.trim(), body, tenant: project.value, assignee: TARS_LANE,
      priority: PRIORITY_TO_HERMES[input.priority ?? 'medium'] ?? 0,
    });
    if (!created.success) return refused(created);
    const task = taskIn(created.task);
    // Left `ready` on the Tars lane, where Hermes skips it, and said so: the
    // task exists, and an agent told "nothing was written" filed it again.
    const notParked = (why: string) => fail(502, `Task ${task.id} was created but not parked: ${why}. `
      + 'Do not create it again: it is on the board, on the Tars lane, where Hermes does not start it; '
      + 'the user parks it on the Kanban page.');
    let parked: Awaited<ReturnType<KanbanHermes['update']>>;
    try {
      parked = await h.update(task.id, { status: PARKED });
    } catch (err) {
      return notParked(`Hermes did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!parked.success) return notParked(parked.error || 'no reason given');
    return { ok: true, value: toAgentTask(taskIn(parked.task), caller) };
  });
}

/**
 * Claim a parked task for the caller, or for `target`, an agent of the same
 * project the caller hands it to. Atomic among Tars's agents: the second claim
 * reads the first one's lane and is refused.
 */
export async function claimTask(
  h: Conn,
  caller: KanbanCaller,
  idOrPrefix: string,
  target?: KanbanCaller,
): Promise<KanbanResult<AgentTask>> {
  const holder = target ?? caller;
  if (holder.projectPath !== caller.projectPath) {
    return fail(403, `${holder.name || holder.agentId} works on ${holder.projectPath}, not on this project (${caller.projectPath}).`);
  }
  return withHermes(h, async h => {
    const found = await resolve(h, caller, idOrPrefix);
    if (!found.ok) return found;
    return underTaskLock(found.value.id, async () => {
      const now = await fresh(h, found.value.id);
      if (!now.ok) return now;
      const t = now.value.task;
      const lane = laneOf(holder.agentId);
      if (t.assignee === lane && t.status === 'ready') return { ok: true as const, value: toAgentTask(t, caller) };
      const other = nameOfLane(t.assignee);
      if (other) return fail(409, `Task ${t.id} is already claimed by ${other}.`);
      if (t.status === 'done' || t.status === 'archived') return fail(409, `Task ${t.id} is done.`);
      if (t.status !== PARKED || (t.assignee && t.assignee !== TARS_LANE)) {
        return fail(409, `Task ${t.id} is not parked: Hermes has it (${t.status}${t.assignee ? `, ${t.assignee}` : ''}). Only the user moves it back.`);
      }
      // The lane lands before the status, in the same request: `ready` on the
      // agent's lane, which Hermes skips, never `ready` on no lane.
      const claimed = await h.update(t.id, { assignee: lane, status: 'ready' });
      if (!claimed.success) return refused(claimed);
      const after = taskIn(claimed.task);
      if (after.assignee !== lane || after.status !== 'ready') {
        return fail(502, `Hermes did not record the claim of ${t.id} (${after.status}, ${after.assignee}).`);
      }
      if (holder.name) claimedNames.set(holder.agentId.toLowerCase(), holder.name);
      const by = holder === caller ? '' : ` (handed by ${caller.name || caller.agentId})`;
      await h.comment(t.id, `Claimed by ${holder.name || holder.agentId}, Tars agent ${holder.agentId}${by}.`).catch(() => undefined);
      return { ok: true as const, value: toAgentTask(after, caller) };
    });
  });
}

export async function reportProgress(h: Conn, caller: KanbanCaller, idOrPrefix: string, progress: number): Promise<KanbanResult<AgentTask>> {
  return withHermes(h, async h => {
    const found = await resolve(h, caller, idOrPrefix);
    if (!found.ok) return found;
    const t = found.value;
    if (t.assignee !== laneOf(caller.agentId)) {
      return fail(409, heldElsewhere(t, caller) ?? `Task ${t.id} is not claimed by you: claim it first with assign_task.`);
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    const r = await h.comment(t.id, `Progress: ${pct}% (${caller.name || caller.agentId}).`);
    if (!r.success) return refused(r);
    return { ok: true, value: toAgentTask(t, caller) };
  });
}

export async function completeTask(h: Conn, caller: KanbanCaller, idOrPrefix: string, summary: string): Promise<KanbanResult<AgentTask>> {
  return withHermes(h, async h => {
    const found = await resolve(h, caller, idOrPrefix);
    if (!found.ok) return found;
    return underTaskLock(found.value.id, async () => {
      const now = await fresh(h, found.value.id);
      if (!now.ok) return now;
      const t = now.value.task;
      if (t.status === 'done') return { ok: true as const, value: toAgentTask(t, caller) };
      if (t.assignee !== laneOf(caller.agentId)) {
        return fail(409, heldElsewhere(t, caller) ?? `Task ${t.id} is parked: claim it first with assign_task, then mark it done.`);
      }
      const r = await h.update(t.id, { status: 'done', summary, result: summary });
      if (!r.success) return refused(r);
      return { ok: true as const, value: toAgentTask(taskIn(r.task), caller) };
    });
  });
}

/** Back to the parked state, on the Tars lane: status first, lane second, so it is never ready on no lane. */
async function release(h: KanbanHermes, caller: KanbanCaller, t: HermesTask): Promise<KanbanResult<AgentTask>> {
  if (t.status === PARKED && (!t.assignee || t.assignee === TARS_LANE)) return { ok: true, value: toAgentTask(t, caller) };
  const parked = await h.update(t.id, { status: PARKED });
  if (!parked.success) return refused(parked);
  const lane = await h.update(t.id, { assignee: TARS_LANE });
  if (!lane.success) return refused(lane, `Task ${t.id} is parked again, still on its lane.`);
  await h.comment(t.id, `Released by ${caller.name || caller.agentId}, back to the parked tasks.`).catch(() => undefined);
  return { ok: true, value: toAgentTask(taskIn(lane.task), caller) };
}

export async function moveTask(h: Conn, caller: KanbanCaller, idOrPrefix: string, column: AgentColumn): Promise<KanbanResult<AgentTask>> {
  if (column === 'planned') {
    return fail(403, 'Handing a task to Hermes is the user\'s choice: they move it on the Kanban page. An agent parks a task (backlog), claims it (ongoing) or finishes it (done).');
  }
  if (column === 'ongoing') return claimTask(h, caller, idOrPrefix);
  if (column === 'done') return completeTask(h, caller, idOrPrefix, `Moved to done by ${caller.name || caller.agentId}.`);
  return withHermes(h, async h => {
    const found = await resolve(h, caller, idOrPrefix);
    if (!found.ok) return found;
    return underTaskLock(found.value.id, async () => {
      const now = await fresh(h, found.value.id);
      if (!now.ok) return now;
      const why = heldElsewhere(now.value.task, caller);
      if (why) return fail(409, why);
      if (now.value.task.status === 'done') return fail(409, `Task ${now.value.task.id} is done.`);
      return release(h, caller, now.value.task);
    });
  });
}

export async function deleteTask(h: Conn, caller: KanbanCaller, idOrPrefix: string): Promise<KanbanResult<{ id: string }>> {
  return withHermes(h, async h => {
    const found = await resolve(h, caller, idOrPrefix);
    if (!found.ok) return found;
    return underTaskLock(found.value.id, async () => {
      const now = await fresh(h, found.value.id);
      if (!now.ok) return now;
      const why = whyNotDeletable(now.value.task, caller);
      if (why) return fail(409, why);
      const r = await h.remove(found.value.id);
      if (!r.success) return refused(r);
      return { ok: true as const, value: { id: found.value.id } };
    });
  });
}

// ── The local board, moved once ───────────────────────────────────────────

/**
 * Whether a task is still exactly as it was created: `ready` on the Tars lane,
 * with no event but its creation (measured on Hermes 0.21.1: a fresh task has
 * one event, `created`; a park, a claim or a drag each adds one). Null when the
 * gateway could not say.
 */
async function asCreated(h: KanbanHermes, id: string): Promise<boolean | null> {
  const r = await h.get(id);
  if (!r.success) return null;
  const detail = r.detail as { task?: HermesTask; events?: Array<{ kind?: string }> } | null;
  if (!detail?.task || !Array.isArray(detail.events)) return null;
  return detail.task.status === 'ready' && detail.task.assignee === TARS_LANE
    && detail.events.length === 1 && detail.events[0]?.kind === 'created';
}

/**
 * A task Tars files itself, parked on a project: created on the Tars lane under
 * an idempotency key, then parked. The key hands back the task a previous run
 * created, whatever became of it since: claimed, run by Hermes, dragged back,
 * done. Hermes would take `scheduled` from ready and running and clear the claim
 * and the worker (the Backend's gate of #171, W1), so only a task still as it
 * was created, with no event but `created`, is owed a park. `parkedNow` says
 * whether this call parked it: false for a task the key handed back, parked by
 * an earlier run or moved on since. Throws when Hermes does not answer.
 */
export async function fileParkedTask(
  h: KanbanHermes,
  task: { title: string; body: string; tenant: string; priority?: 'low' | 'medium' | 'high'; key: string },
): Promise<{ ok: true; id: string; parkedNow: boolean } | { ok: false; error: string }> {
  const created = await h.create({
    title: task.title, body: task.body, tenant: task.tenant, assignee: TARS_LANE,
    priority: PRIORITY_TO_HERMES[task.priority ?? 'medium'] ?? 0,
    idempotency_key: task.key,
  });
  if (!created.success) return { ok: false, error: created.error || 'refused' };
  const t = taskIn(created.task);
  if (t.status === PARKED) return { ok: true, id: t.id, parkedNow: false };
  const untouched = await asCreated(h, t.id);
  if (untouched === null) return { ok: false, error: `created as ${t.id}, and Hermes did not say what became of it` };
  if (!untouched) return { ok: true, id: t.id, parkedNow: false };
  const parked = await h.update(t.id, { status: PARKED });
  if (!parked.success) return { ok: false, error: `created as ${t.id} but not parked: ${parked.error || 'refused'}` };
  return { ok: true, id: t.id, parkedNow: true };
}

interface LocalTask {
  id: string;
  title: string;
  description?: string;
  column?: string;
  projectPath?: string;
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
}

/**
 * Every task of ~/.dorothy/kanban-tasks.json that is not done, onto the Hermes
 * board, parked on its project. Once: `record` keeps what moved, and Hermes's
 * idempotency key catches a task whose record was lost. The local file is read
 * and never written: it stays as the backup. What fails is left for the next
 * launch.
 */
export async function migrateLocalTasks(h: KanbanHermes, file: string, record: string): Promise<{ moved: number; skipped: number; errors: string[] }> {
  const out = { moved: 0, skipped: 0, errors: [] as string[] };
  let local: LocalTask[] = [];
  try {
    if (!fs.existsSync(file)) return out;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    local = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    out.errors.push(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  let moved: Record<string, string> = {};
  try {
    if (fs.existsSync(record)) moved = JSON.parse(fs.readFileSync(record, 'utf-8')) ?? {};
  } catch { moved = {}; }

  for (const t of local) {
    if (!t?.id || !t.title || t.column === 'done') continue;
    if (moved[t.id]) { out.skipped++; continue; }
    if (!t.projectPath) { out.errors.push(`${t.id}: no project`); continue; }
    try {
      const labels = (t.labels ?? []).filter(Boolean);
      const body = [t.description ?? '', labels.length ? `Labels: ${labels.join(', ')}` : '', `Moved from the local Tars board (${t.id}).`].filter(Boolean).join('\n\n');
      const filed = await fileParkedTask(h, { title: t.title, body, tenant: t.projectPath, priority: t.priority, key: `tars-local:${t.id}` });
      if (!filed.ok) { out.errors.push(`${t.id}: ${filed.error}`); continue; }
      moved[t.id] = filed.id;
      out.moved++;
      writeAtomicSync(record, JSON.stringify(moved, null, 2));
    } catch (err) {
      out.errors.push(`${t.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ── What is typed into an agent, and when ─────────────────────────────────

/**
 * A task handed to an agent, typed as the agent that handed it.
 *
 * Its title and description are an agent's words, not Tars's: typed under
 * "Message from Tars:" they read as Tars's, which is the forged line #128's gate
 * found (the Backend's gate of #171). So the sender is the agent whose token made
 * the call, and the title, which shares a line with the words Tars adds, goes
 * through envelopeValue and cannot start a line of its own. The writer strips
 * every control character from the rest.
 */
export function handOffNote(task: AgentTask, by: KanbanCaller): { message: string; sender: MessageSender } {
  return {
    message: [
      `Kanban task ${task.id} is yours, handed to you by ${envelopeValue(by.name || by.agentId)}: ${envelopeValue(task.title)}`,
      task.description,
      `Report progress with update_task_progress and finish with mark_task_done (task_id ${task.id}).`,
    ].filter(Boolean).join('\n\n'),
    sender: { kind: 'agent', id: by.agentId, name: by.name },
  };
}

/** A task that landed on a project, told to its orchestrator as the agent that filed it. One line. */
export function landingNote(filer: KanbanCaller, task: AgentTask): { message: string; sender: MessageSender } {
  return {
    message: `Filed a task on this project's Kanban board: ${envelopeValue(task.title)} (${task.id}). It is parked, and Hermes will not take it. Hand it to one of your agents with assign_task (task_id ${task.id}, agent_id), or leave it for the user.`,
    sender: { kind: 'agent', id: filer.agentId, name: filer.name },
  };
}

/**
 * When a hand-off (work) or a note may be typed into an agent.
 *
 * Never mid-turn and never into a permission dialog: both wait for the agent to
 * rest. A stopped agent is started for work, as handing work to it means, and
 * never for a note.
 */
export function whenToType(
  agent: { cliRunning: boolean; status?: string; waitingReason?: string },
  purpose: 'work' | 'note',
): 'now' | 'at-rest' | 'start' | 'skip' {
  if (!agent.cliRunning) return purpose === 'work' ? 'start' : 'skip';
  if (agent.status === 'running') return 'at-rest';
  if (agent.status === 'waiting' && agent.waitingReason === 'permission') return 'at-rest';
  return 'now';
}

