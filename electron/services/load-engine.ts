import * as fs from 'fs';
import * as path from 'path';
import { writeSecretFileSync } from '../utils/secret-file';
import { resolveWorktreePath } from '../utils/worktree-path';
import { LOAD_HARNESSES, type LoadHarness, type LoadTask } from './load-pool';
import type { LoadArrival, LoadBlockReason, LoadRunAgent } from './load-run-record';
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
  /** Where the project's grant runs its load agents, from the private grant: its endpoint and model, or none. */
  grantTarget(project: string): { endpointId: string | null; model: string | null } | undefined;
  loadAgents(): Array<{ id: string; name: string; projectPath: string; provider: string; status: string; endpointId?: string | null; model?: string | null }>;
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

  /** The private state: the worktrees made (what cleanup reads), and each run's progress (what the card shows). */
  interface State { worktrees: Made[]; progress: Record<string, LoadArrival[]> }
  function readFile(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.stateFile, 'utf8')) as { worktrees?: unknown; progress?: unknown };
      return {
        worktrees: Array.isArray(raw?.worktrees) ? raw.worktrees.filter((w): w is Made => !!w && typeof (w as Made).path === 'string' && typeof (w as Made).project === 'string' && typeof (w as Made).branch === 'string') : [],
        progress: raw?.progress && typeof raw.progress === 'object' ? raw.progress as Record<string, LoadArrival[]> : {},
      };
    } catch {
      return { worktrees: [], progress: {} };
    }
  }
  function writeFile(state: State): void {
    fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true, mode: 0o700 });
    writeSecretFileSync(deps.stateFile, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
  }
  const readState = (): Made[] => readFile().worktrees;
  const writeState = (worktrees: Made[]): void => writeFile({ ...readFile(), worktrees });

  /**
   * The progress the engine holds, run by run: its arrivals as they went. Kept with the private state too, for the
   * card after a restart; the run's log under ~/.tars gets a copy, and is read for nothing (the Audit's Infos on #685).
   */
  const progressOf = new Map<string, Map<number, LoadArrival>>();
  function note(runId: string, arrival: LoadArrival): void {
    const held = progressOf.get(runId) ?? new Map((readFile().progress[runId] ?? []).map(a => [a.n, a] as const));
    held.set(arrival.n, arrival);
    progressOf.set(runId, held);
    const state = readFile();
    writeFile({ ...state, progress: { ...state.progress, [runId]: [...held.values()].sort((x, y) => x.n - y.n) } });
    deps.logArrival(runId, arrival);
  }

  /** A run's progress as the engine holds it: its arrivals, and the load agents that ran them. */
  function progress(runId: string): { arrivals: LoadArrival[]; agents: LoadRunAgent[] } | undefined {
    const arrivals = progressOf.has(runId) ? [...progressOf.get(runId)!.values()].sort((x, y) => x.n - y.n) : readFile().progress[runId];
    if (!arrivals) return undefined;
    const fleet = deps.loadAgents();
    const agents = [...new Set(arrivals.map(a => a.agentId).filter((id): id is string => !!id))].map((agentId) => {
      const a = fleet.find(x => x.id === agentId);
      const first = arrivals.find(x => x.agentId === agentId)!;
      return { agentId, name: a?.name ?? agentId, project: a?.projectPath ?? '', harness: (first.harness ?? a?.provider) as LoadHarness, created: false };
    });
    return { arrivals, agents };
  }

  async function removeWorktree(m: Made): Promise<void> {
    try {
      // Tars made it, at a path the guard gave and the private state kept: a session's changes go with it. Never
      // through a link (the Audit's Info on #691): git resolves the path it is given, so a link a session put in the
      // worktree's place, or above it, would have git remove the worktree it points at. A link in its place goes as a
      // link; a path that reaches anywhere else than where Tars made it is not handed to git.
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(m.path); } catch { /* gone */ }
      if (st?.isSymbolicLink()) {
        fs.unlinkSync(m.path);
      } else if (st?.isDirectory()) {
        const madeAt = path.join(fs.realpathSync(m.project), path.relative(m.project, m.path));
        if (fs.realpathSync(m.path) === madeAt) await deps.git(m.project, ['worktree', 'remove', '--force', m.path]);
        else console.error(`[load] ${m.path} now reaches ${fs.realpathSync(m.path)} through a link: not removed`);
      }
      // The registration of a worktree whose folder is gone goes first, so its branch is no longer checked out.
      await deps.git(m.project, ['worktree', 'prune']).catch(() => '');
      await deps.git(m.project, ['branch', '-D', m.branch]).catch(() => '');
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
    note(s.runId, s.arrival);
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

  /**
   * Whether a load agent runs where the owner allowed it: a harness the task and the grant accept, on the grant's own
   * endpoint and model. The fleet record is not trusted alone (the Audit's M1 on #691): agents.json is every agent's to
   * read and write, and an agent with no endpoint runs its CLI on the owner's own account.
   */
  function onGrant(task: LoadTask, a: ReturnType<LoadEngineDeps['loadAgents']>[number]): boolean {
    const granted = deps.grantHarnesses(task.project);
    const target = deps.grantTarget(task.project);
    if (!target?.endpointId || !target.model) return false;
    const accepted = (task.harnesses ?? [...LOAD_HARNESSES]).filter(h => granted.includes(h));
    return accepted.includes(a.provider as typeof accepted[number]) && a.endpointId === target.endpointId && a.model === target.model;
  }

  async function arrive(runId: string, planned: LoadRunPlan['planned'][number]): Promise<void> {
    const plan = deps.plan(runId);
    if (!plan || !deps.isRunning(runId)) {
      console.log(`[load] arrival ${planned.n} of ${runId} dropped: the run no longer runs${plan ? '' : ' (no plan)'}`);
      cancel(runId);
      return;
    }
    const task = plan.tasks.find(t => t.task_id === planned.taskId);
    if (!task) return;
    const now = deps.now();
    const arrival: LoadArrival = { n: planned.n, taskId: planned.taskId, plannedAt: planned.plannedAt, actualAt: now };
    const block = (reason: LoadBlockReason, detail?: string) => {
      console.log(`[load] arrival ${planned.n} of ${runId} blocked: ${reason}${detail ? ` (${detail})` : ''}`);
      note(runId, { ...arrival, blocked: reason, ...(detail ? { blockedDetail: detail } : {}) });
    };
    if ([...open.values()].filter(s => s.runId === runId).length >= plan.window.max_concurrent) { block('max_concurrent'); return; }
    const cap = deps.busyCap(task.project);
    if (!cap.ok) { block('busy_cap', cap.reason); return; }
    const agent = deps.loadAgents().find(a => a.projectPath === task.project && onGrant(task, a) && !open.has(a.id) && deps.statusOf(a.id) !== 'running');
    if (!agent) { block('no_harness'); return; }

    const started: LoadArrival = { ...arrival, agentId: agent.id, harness: agent.provider as LoadHarness };
    const fail = (detail: string) => {
      console.error(`[load] arrival ${planned.n} of ${runId} did not start: ${detail}`);
      note(runId, { ...started, end: 'error', endedAt: deps.now() });
    };
    const branch = loadBranchOf(runId, task.task_id, planned.n);
    const where = fs.existsSync(task.project) ? resolveWorktreePath(task.project, branch) : undefined;
    if (!where) { fail(`no worktree for ${task.project}: the folder is gone or the guard refused ${branch}`); return; }
    const made: Made = { runId, n: planned.n, project: task.project, path: where, branch, agentId: agent.id };
    // Its place and its agent held before anything awaits: another arrival due at the same moment is admitted against
    // it, never past max_concurrent or onto the same agent.
    const s: Session = { runId, arrival: started, made, capTimer: undefined, sawRunning: false };
    open.set(agent.id, s);
    // Named before git makes it: a crash in between leaves nothing the next start does not know of.
    writeState([...readState(), made]);
    try {
      await deps.git(task.project, ['worktree', 'add', '-b', branch, where, `${task.base_commit}^{commit}`]);
    } catch (err) {
      open.delete(agent.id);
      writeState(readState().filter(w => w.path !== where));
      fail(`git worktree add: ${(err as Error).message.split('\n')[0]}`);
      return;
    }
    console.log(`[load] arrival ${planned.n} of ${runId} starts: ${agent.id} in ${where}`);
    note(runId, started);
    // Its worktree set and its TMPDIR emptied (load-handlers.ts): a session started without either would start on
    // what an earlier one left, so none starts.
    try {
      deps.prepare(agent.id, where);
    } catch (err) {
      console.error(`[load] arrival ${planned.n} of ${runId}: ${agent.id} not prepared: ${(err as Error).message}`);
      await end(s, 'error');
      return;
    }
    // The grant and the record read again at launch: a record moved since the admission runs nothing.
    const now_ = deps.loadAgents().find(a => a.id === agent.id);
    if (!now_ || !onGrant(task, now_)) {
      console.error(`[load] arrival ${planned.n} of ${runId}: ${agent.id} is no longer on its grant's endpoint and model`);
      await end(s, 'error');
      return;
    }
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
    if (!plan) { console.error(`[load] ${runId} not armed: no plan (not approved, or its snapshot changed)`); return; }
    console.log(`[load] ${runId} armed: ${plan.planned.length} arrivals`);
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
      // The session the restart cut: stopped, in the progress the card shows.
      const was = (readFile().progress[m.runId] ?? []).find(a => a.n === m.n);
      if (was && !was.end) note(m.runId, { ...was, end: 'stopped', endedAt: deps.now() });
      deps.release(m.agentId);
      await removeWorktree(m);
    }
    for (const runId of runningRunIds) deps.endRun(runId, { reason: 'error', at: deps.now(), detail: 'Tars restarted during the window' });
  }

  return { start, stop, recover, progress };
}

export type LoadEngine = ReturnType<typeof createLoadEngine>;
