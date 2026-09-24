/**
 * The agents' kanban, on the Hermes board the Kanban page shows (their tools
 * used to write ~/.dorothy/kanban-tasks.json, which no page shows). This
 * decides where an agent's task sits on that board and who may move it.
 *
 * Hermes 0.21.1, measured against its own code: the dispatcher spawns a `ready`
 * task assigned to a Hermes profile; it promotes `todo`, and `blocked` with no
 * block event, to `ready`; the gateway decomposes `triage`; `scheduled` leaves
 * only by an explicit unblock (JeanBrasse dragging it); a `ready` task on a lane that
 * cannot be a profile (ids are `[a-z0-9][a-z0-9_-]*`, never a colon) is skipped
 * as `skipped_nonspawnable`; the API refuses `running`, and `done` from
 * `scheduled`; a PATCH applies the assignee before the status. So:
 * - parked: `scheduled` on the Tars lane (`tars:unclaimed`), which Hermes never
 *   takes until JeanBrasse gives it a profile;
 * - claimed: `ready` on the claimer's lane (`tars:<agent id>`), in one PATCH
 *   whose assignee lands first, so it is never `ready` on no lane;
 * - done: `done`, from the claim;
 * - deleted: by its claimer, or by its filer while nobody claimed it.
 *
 * Claims are atomic among Tars's agents (a task's own lock in this process).
 * Hermes has no compare-and-set: JeanBrasse moving a task at the same moment wins,
 * and the move is his. Each project is a Hermes tenant (its path).
 */

import * as fs from 'fs';
import { writeAtomicSync } from '../utils/secret-file';
import { envelopeValue } from '../utils/envelope-value';
import type { MessageSender } from '../core/pty-manager';

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

function notConfigured(): { ok: false; status: number; error: string } {
  return fail(503, 'Hermes is not configured in Tars (Settings, Hermes): the kanban lives on the Hermes board, and there is no other.');
}

function unreachable(err: unknown): { ok: false; status: number; error: string } {
  return fail(502, `Hermes did not answer: ${err instanceof Error ? err.message : String(err)}. Nothing was written, here or anywhere else.`);
}

function refused(reply: { success: false; error?: string }): { ok: false; status: number; error: string } {
  return fail(502, `Hermes refused: ${reply.error || 'no reason given'}`);
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
  if ('unusable' in h) return fail(503, `The Hermes connection cannot be used: ${h.unusable} Until it can, the kanban has no board, and nothing was written.`);
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
    return `Task ${t.id} is Hermes's (${t.status}${t.assignee && t.assignee !== TARS_LANE ? `, ${t.assignee}` : ''}): only JeanBrasse moves it back.`;
  }
  return null;
}

/**
 * The agent that filed a task, from the line Tars writes last in its body,
 * "Filed by <name> (Tars agent <id>).": the gateway records every creation as
 * "dashboard", and written after the agent's description it cannot be forged
 * by the agent. Null for a task not filed through Tars.
 */
function filerOf(t: HermesTask): string | null {
  const signed = /\(Tars agent ([^()\s]+)\)\.$/.exec((t.body ?? '').trimEnd());
  return signed ? signed[1] : null;
}

/**
 * Why the caller may not delete a task, or null. An agent deletes a task it
 * claimed, done or not, or one it filed that nobody took; anyone else's (JeanBrasse's,
 * Hermes's, another agent's) JeanBrasse deletes on the Kanban page (the Backend's gate
 * of #171, W2).
 */
function whyNotDeletable(t: HermesTask, caller: KanbanCaller): string | null {
  if (t.assignee === laneOf(caller.agentId)) return null;
  if (t.assignee === TARS_LANE && filerOf(t) === caller.agentId) return null;
  return heldElsewhere(t, caller)
    ?? `Task ${t.id} is not yours to delete: an agent deletes a task it filed and nobody claimed, or one it claimed. JeanBrasse deletes the others on the Kanban page.`;
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
  const own = caller.projectPath.replace(/\/+$/, '');
  const want = asked.replace(/\/+$/, '');
  if (want === own || want.startsWith(`${own}/`)) return { ok: true, value: caller.projectPath };
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
    const parked = await h.update(task.id, { status: PARKED });
    if (!parked.success) {
      // Left `ready` on the Tars lane, where Hermes skips it, and said so.
      return fail(502, `Task ${task.id} was created but not parked: ${parked.error || 'no reason given'}. Hermes will not start it (it is on the Tars lane); park it on the Kanban page.`);
    }
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
        return fail(409, `Task ${t.id} is not parked: Hermes has it (${t.status}${t.assignee ? `, ${t.assignee}` : ''}). Only JeanBrasse moves it back.`);
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
  if (!lane.success) return refused(lane);
  await h.comment(t.id, `Released by ${caller.name || caller.agentId}, back to the parked tasks.`).catch(() => undefined);
  return { ok: true, value: toAgentTask(taskIn(lane.task), caller) };
}

export async function moveTask(h: Conn, caller: KanbanCaller, idOrPrefix: string, column: AgentColumn): Promise<KanbanResult<AgentTask>> {
  if (column === 'planned') {
    return fail(403, 'Handing a task to Hermes is JeanBrasse\'s choice: he moves it on the Kanban page. An agent parks a task (backlog), claims it (ongoing) or finishes it (done).');
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
      const created = await h.create({
        title: t.title, body, tenant: t.projectPath, assignee: TARS_LANE,
        priority: PRIORITY_TO_HERMES[t.priority ?? 'medium'] ?? 0,
        idempotency_key: `tars-local:${t.id}`,
      });
      if (!created.success) { out.errors.push(`${t.id}: ${created.error || 'refused'}`); continue; }
      const task = taskIn(created.task);
      if (task.status !== PARKED) {
        // The key hands back the task a previous run created, whatever became
        // of it since: claimed, run by Hermes, dragged back, done. Hermes would
        // take `scheduled` from ready and running and clear the claim and the
        // worker (the Backend's gate of #171, W1). Only a task still as it was
        // created, with no event but `created`, is one this migration owes a park.
        const untouched = await asCreated(h, task.id);
        if (untouched === null) { out.errors.push(`${t.id}: created as ${task.id}, and Hermes did not say what became of it`); continue; }
        if (untouched) {
          const parked = await h.update(task.id, { status: PARKED });
          if (!parked.success) { out.errors.push(`${t.id}: created as ${task.id} but not parked: ${parked.error || 'refused'}`); continue; }
        }
      }
      moved[t.id] = task.id;
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
 * A task handed to an agent, typed as the agent that handed it: its title and
 * description are an agent's words, and under "Message from Tars:" they would
 * read as Tars's (#128's forged line; the Backend's gate of #171). The title,
 * sharing a line with Tars's words, goes through envelopeValue; the writer
 * strips every control character from the rest.
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
    message: `Filed a task on this project's Kanban board: ${envelopeValue(task.title)} (${task.id}). It is parked, and Hermes will not take it. Hand it to one of your agents with assign_task (task_id ${task.id}, agent_id), or leave it for JeanBrasse.`,
    sender: { kind: 'agent', id: filer.agentId, name: filer.name },
  };
}

/**
 * When a hand-off (work) or a note may be typed into an agent: never mid-turn
 * nor into a permission dialog. A stopped agent is started for work, never for
 * a note.
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

