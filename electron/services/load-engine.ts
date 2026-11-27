import * as fs from 'fs';
import * as path from 'path';
import { writeSecretFileSync } from '../utils/secret-file';
import { resolveWorktreePath } from '../utils/worktree-path';
import { LOAD_HARNESSES, type LoadHarness, type LoadTask } from './load-pool';
import type { LoadArrival, LoadBlockReason } from './load-run-record';
import { loadBranchOf } from './load-session';

/**
 * The load window's engine (trace feature C3, part 2): an approved run's arrivals at their time, each admitted or
 * blocked, a worktree and a fresh session of a load agent per admitted arrival, the session's end, and its cleanup.
 *
 * - **What it reads to decide:** the run's plan from the private approval and its verified snapshot (deps.plan, the
 *   load window's), whether the run still runs (deps.isRunning), the grants, the fleet, and its own private state.
 *   Never the run's record under ~/.tars, which it only writes to (deps.logArrival): any agent can write it.
 * - **Admission:** an arrival that cannot start is recorded blocked, with the frames' reason, and dropped, never
 *   queued: `max_concurrent` (the run's open sessions at the window's max_concurrent), `busy_cap` (the busy cap's
 *   seam refuses), `no_harness` (no load agent of its project free and running a harness the task and the grant
 *   accept). `heavy_slot` is part 3's, with the setup.
 * - **A session:** the worktree is named in the private state (`~/.tars-private/load-run-state.json`) before git makes
 *   it, at the task's base_commit on `load/<run>/<task>-<n>`, under the project's `.worktrees` (utils/worktree-path.ts).
 *   The load agent works in it, in a fresh session (never a resumed conversation), on the preamble and the task's
 *   prompt. Its push is blocked by its terminal's environment (load-session.ts pushBlockEnv, set by its creation).
 * - **Its end:** its turn ends (the agent rests after running: `done`, or `error`), its cap passes (stopped: `at_cap`),
 *   or the run stops (`stopped`). Then its session is stopped, so the next task starts fresh, the agent handed back,
 *   and its worktree and branch removed, from the private state only.
 * - **After a crash or a quit:** the worktrees the private state names are removed, and a run that was running ends
 *   in error, "Tars restarted during the window": nothing can tell what its sessions did meanwhile.
 */

export interface LoadRunPlan {
  runId: string;
  endsAt: number;
  window: { max_concurrent: number };
  /** The approved tasks, whole, from the verified snapshot. */
  tasks: LoadTask[];
  planned: Array<{ n: number; taskId: string; plannedAt: number }>;
}

export interface LoadEngineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** `~/.tars-private/load-run-state.json`: the worktrees made, what cleanup reads. */
  stateFile: string;
  plan(runId: string): LoadRunPlan | undefined;
  isRunning(runId: string): boolean;
  /** Ends the run in the private approval (load-window.ts), with its reason. */
  endRun(runId: string, stop: { reason: 'error'; at: number; detail: string }): void;
  /** The harnesses the project's grant runs. */
  grantHarnesses(project: string): string[];
  loadAgents(): Array<{ id: string; projectPath: string; provider: string; status: string }>;
  /** The busy cap's seam (#593's capVerdict): ok, or why not. */
  busyCap(project: string): { ok: boolean; reason?: string };
  /** git in a folder, through safe-git: its output, or a throw. */
  git(cwd: string, args: string[]): Promise<string>;
  /** The agent works in this worktree (its worktreePath), until release. */
  prepare(agentId: string, worktreePath: string): void;
  release(agentId: string): void;
  /** A fresh session of the agent on the prompt (core/agent-launch.ts, resumeSessionId null). */
  launch(agentId: string, prompt: string, resumeSessionId: null): Promise<{ ok: boolean; error?: string }>;
  /** Stops the agent's session (core/agent-stop.ts). */
  stopSession(agentId: string): Promise<void>;
  statusOf(agentId: string): string | undefined;
  /** Told of every change of an agent's status (services/agent-events.ts). */
  onStatus(fn: (agentId: string) => void): () => void;
  /** The run's log: an arrival as it now stands. */
  logArrival(runId: string, arrival: LoadArrival): void;
}

interface Made { runId: string; n: number; project: string; path: string; branch: string; agentId: string }
interface Session { runId: string; arrival: LoadArrival; made: Made; capTimer: unknown; sawRunning: boolean }

/** What a load task's session is told before its task. */
export function loadPreamble(projectName: string): string {
  return `[Tars: a load window's task. You work in a worktree of ${projectName} at the task's base commit, and only there. `
    + 'No push (it is blocked here), no pull request, no deploy, no migration, and no call to any production service. '
    + 'When the task is done, say so and stop.]';
}

const RESTING = new Set(['waiting', 'idle', 'completed', 'stopped', 'error']);

export function createLoadEngine(deps: LoadEngineDeps) {
  const timers = new Map<string, unknown[]>();
  const open = new Map<string, Session>();

  function readState(): Made[] {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.stateFile, 'utf8')) as { worktrees?: unknown };
      return Array.isArray(raw?.worktrees) ? raw.worktrees.filter((w): w is Made => !!w && typeof (w as Made).path === 'string' && typeof (w as Made).project === 'string' && typeof (w as Made).branch === 'string') : [];
    } catch {
      return [];
    }
  }
  function writeState(worktrees: Made[]): void {
    fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true, mode: 0o700 });
    writeSecretFileSync(deps.stateFile, `${JSON.stringify({ version: 1, worktrees }, null, 2)}\n`);
  }

  async function removeWorktree(m: Made): Promise<void> {
    try {
      // Tars made it, at a path the guard gave and the private state kept: a session's changes go with it.
      if (fs.existsSync(m.path)) await deps.git(m.project, ['worktree', 'remove', '--force', m.path]);
      await deps.git(m.project, ['branch', '-D', m.branch]).catch(() => '');
      await deps.git(m.project, ['worktree', 'prune']).catch(() => '');
      writeState(readState().filter(w => w.path !== m.path));
    } catch (err) {
      // Kept in the private state: the next start removes it.
      console.error(`[load] the worktree ${m.path} was not removed: ${(err as Error).message}`);
    }
  }

  async function end(s: Session, how: NonNullable<LoadArrival['end']>): Promise<void> {
    if (open.get(s.made.agentId) !== s) return;
    open.delete(s.made.agentId);
    deps.clearTimer(s.capTimer);
    s.arrival = { ...s.arrival, end: how, endedAt: deps.now() };
    deps.logArrival(s.runId, s.arrival);
    await deps.stopSession(s.made.agentId).catch(err => console.error(`[load] the session of ${s.made.agentId} did not stop: ${(err as Error).message}`));
    deps.release(s.made.agentId);
    await removeWorktree(s.made);
  }

  deps.onStatus((agentId) => {
    const s = open.get(agentId);
    if (!s) return;
    const status = deps.statusOf(agentId);
    if (status === 'running') { s.sawRunning = true; return; }
    if (s.sawRunning && status && RESTING.has(status)) void end(s, status === 'error' ? 'error' : 'done');
  });

  async function arrive(runId: string, planned: LoadRunPlan['planned'][number]): Promise<void> {
    const plan = deps.plan(runId);
    if (!plan || !deps.isRunning(runId)) { cancel(runId); return; }
    const task = plan.tasks.find(t => t.task_id === planned.taskId);
    if (!task) return;
    const now = deps.now();
    const arrival: LoadArrival = { n: planned.n, taskId: planned.taskId, plannedAt: planned.plannedAt, actualAt: now };
    const block = (reason: LoadBlockReason, detail?: string) => deps.logArrival(runId, { ...arrival, blocked: reason, ...(detail ? { blockedDetail: detail } : {}) });
    if ([...open.values()].filter(s => s.runId === runId).length >= plan.window.max_concurrent) { block('max_concurrent'); return; }
    const cap = deps.busyCap(task.project);
    if (!cap.ok) { block('busy_cap', cap.reason); return; }
    const granted = deps.grantHarnesses(task.project);
    const accepted = (task.harnesses ?? [...LOAD_HARNESSES]).filter(h => granted.includes(h));
    const agent = deps.loadAgents().find(a => a.projectPath === task.project && accepted.includes(a.provider as typeof accepted[number])
      && !open.has(a.id) && deps.statusOf(a.id) !== 'running');
    if (!agent) { block('no_harness'); return; }

    const started: LoadArrival = { ...arrival, agentId: agent.id, harness: agent.provider as LoadHarness };
    const fail = (detail: string) => {
      console.error(`[load] arrival ${planned.n} of ${runId} did not start: ${detail}`);
      deps.logArrival(runId, { ...started, end: 'error', endedAt: deps.now() });
    };
    const branch = loadBranchOf(runId, task.task_id, planned.n);
    const where = fs.existsSync(task.project) ? resolveWorktreePath(task.project, branch) : undefined;
    if (!where) { fail(`no worktree for ${task.project}: the folder is gone or the guard refused ${branch}`); return; }
    const made: Made = { runId, n: planned.n, project: task.project, path: where, branch, agentId: agent.id };
    // Named before git makes it: a crash in between leaves nothing the next start does not know of.
    writeState([...readState(), made]);
    try {
      await deps.git(task.project, ['worktree', 'add', '-b', branch, where, `${task.base_commit}^{commit}`]);
    } catch (err) {
      writeState(readState().filter(w => w.path !== where));
      fail(`git worktree add: ${(err as Error).message.split('\n')[0]}`);
      return;
    }
    const s: Session = { runId, arrival: started, made, capTimer: undefined, sawRunning: false };
    open.set(agent.id, s);
    deps.logArrival(runId, started);
    deps.prepare(agent.id, where);
    const launched = await deps.launch(agent.id, `${loadPreamble(path.basename(task.project))}\n\n${task.prompt}`, null)
      .catch(err => ({ ok: false, error: (err as Error).message }));
    if (!launched.ok) {
      console.error(`[load] arrival ${planned.n} of ${runId}: the session did not start: ${launched.error ?? 'unknown'}`);
      await end(s, 'error');
      return;
    }
    s.capTimer = deps.setTimer(() => { void end(s, 'at_cap'); }, task.time_cap_min * 60_000);
  }

  function cancel(runId: string): void {
    for (const t of timers.get(runId) ?? []) deps.clearTimer(t);
    timers.delete(runId);
  }

  /** Arms the run's arrivals, each at its planned time (one already due starts at once). */
  function start(runId: string): void {
    const plan = deps.plan(runId);
    if (!plan) return;
    cancel(runId);
    const now = deps.now();
    timers.set(runId, plan.planned.map(p => deps.setTimer(() => { void arrive(runId, p); }, p.plannedAt - now)));
  }

  /** The run stopped: no more arrivals, and every open session of it ended, stopped, and cleaned. */
  async function stop(runId: string): Promise<void> {
    cancel(runId);
    await Promise.all([...open.values()].filter(s => s.runId === runId).map(s => end(s, 'stopped')));
  }

  /**
   * At start, after a crash or a quit: the worktrees the private state names are removed (and their agents handed
   * back), and each run that was running ends in error.
   */
  async function recover(runningRunIds: string[]): Promise<void> {
    for (const m of readState()) {
      deps.release(m.agentId);
      await removeWorktree(m);
    }
    for (const runId of runningRunIds) deps.endRun(runId, { reason: 'error', at: deps.now(), detail: 'Tars restarted during the window' });
  }

  return { start, stop, recover };
}

export type LoadEngine = ReturnType<typeof createLoadEngine>;
