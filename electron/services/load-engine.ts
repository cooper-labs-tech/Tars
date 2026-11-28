import * as fs from 'fs';
import * as path from 'path';
import { writeSecretFileSync } from '../utils/secret-file';
import { resolveWorktreePath } from '../utils/worktree-path';
import { LOAD_HARNESSES, type LoadHarness, type LoadTask } from './load-pool';
import type { LoadArrival, LoadBlockReason, LoadRunAgent, LoadTestResult } from './load-run-record';
import { loadBranchOf } from './load-session';
import type { StepResult } from './load-steps';

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
 *
 * Part 3:
 * - **The setup** (the task's lines, from the snapshot): a task with lines asks for the heavy-run slot when it
 *   arrives and never waits for it (not free: blocked `heavy_slot`, before any worktree); granted, its lines run one
 *   after the other in the worktree, within 10 minutes in all, before the session; a line that fails or reaches the cap
 *   ends the task there (`error`, with the line and why), with no session.
 * - **The test** (its test_cmd), after the session, in the worktree: it waits for the slot up to the task's cap (the
 *   wait recorded apart from the session's own time), then runs with that cap: `passed`, `failed` (its exit code, or at
 *   its cap, its tree killed), or `not_run` (`none`, `heavy_slot` within the cap: never a failure, the window goes on;
 *   `stopped`). The diff stat is taken before it, between the worktree's tree after the setup and at the session's end.
 * - **The trace** of the session is tagged once its test ended (`outcome.load`): `load:<run>`, its task, arrival,
 *   split, train_ok, diff stat and test.
 * - **The disk floor:** checked every quarter of a minute while the run has anything open, and at each arrival; under
 *   it the run ends `disk_floor`, its sessions are stopped and every setup or test in flight killed. The window's end by
 *   time stops nothing: a running session keeps its cap and its test.
 * - A minute is `deps.minuteMs` (60 000; a test build's DOROTHY_E2E_LOAD_MINUTE_MS, load-handlers.ts).
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
  endRun(runId: string, stop: { reason: 'error' | 'disk_floor'; at: number; detail: string }): void;
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
  /** A minute of the window's clocks, in ms: 60 000, or a test build's DOROTHY_E2E_LOAD_MINUTE_MS. */
  minuteMs: number;
  /** The heavy-run slot (services/heavy-slot-runtime.ts): granted now or not (a setup), or within a time (a test). */
  slot: {
    takeNow(ask: LoadSlotAsk): Promise<LoadLease | undefined>;
    takeWithin(ask: LoadSlotAsk, ms: number, signal: AbortSignal): Promise<{ lease?: LoadLease; waitedMs: number }>;
  };
  /** Runs one step of a task, a setup line or its test_cmd (load-steps.ts, in a step's environment). */
  runStep(o: { command: string; cwd: string; capMs: number; signal: AbortSignal }): Promise<StepResult>;
  /** The free disk, in GB (health/machine.ts), and the floor under which the run stops (the heavy runs' floor). */
  freeDiskGb(): number | null;
  diskFloorGb(): number;
  /** The trace the agent's current terminal records (traces-runtime.ts liveTraceOf). */
  traceOf(agentId: string): string | undefined;
  /** Merges a load session's tags into its trace's outcome (trace-store.ts mergeLoadOutcome). */
  tagTrace(traceId: string, load: Record<string, unknown>): void;
}

export interface LoadSlotAsk { label: string; agentId: string; agentName: string; projectPath: string }
export interface LoadLease { release(): void }

interface Made { runId: string; n: number; project: string; path: string; branch: string; agentId: string }
interface Session {
  runId: string; arrival: LoadArrival; made: Made; task: LoadTask; agentName: string; capTimer: unknown; sawRunning: boolean;
  /** Stops a setup line in flight. */
  ac: AbortController;
  /** The setup under way: the line it runs, and since when. */
  setupLine?: number; setupAt?: number;
  /** The worktree's tree after the setup: what the diff stat starts from. */
  baseTree?: string;
  launchedAt?: number;
}

/** What a load task's session is told before its task. */
export function loadPreamble(projectName: string): string {
  return `[Tars: a load window's task. You work in a worktree of ${projectName} at the task's base commit, and only there. `
    + 'No push (it is blocked here), no pull request, no deploy, no migration, and no call to any production service. '
    + 'When the task is done, say so and stop.]';
}

const RESTING = new Set(['waiting', 'idle', 'completed', 'stopped', 'error']);

/** An arrival without what it was doing: the step it was at is over. */
function withoutPhase(a: LoadArrival): LoadArrival {
  const copy = { ...a };
  delete copy.phase;
  return copy;
}

export function createLoadEngine(deps: LoadEngineDeps) {
  const timers = new Map<string, unknown[]>();
  const open = new Map<string, Session>();
  /** Each run's steps in flight (a setup line, a test, a wait for the slot): what a stop of the run kills. */
  const inFlight = new Map<string, Set<AbortController>>();
  /** Each run's tasks between their session's end and their cleanup (the test, the tags). */
  const finishing = new Map<string, number>();
  const diskTimers = new Map<string, unknown>();
  const SETUP_CAP_MIN = 10;

  const track = (runId: string, ac: AbortController) => {
    const set = inFlight.get(runId) ?? new Set();
    set.add(ac);
    inFlight.set(runId, set);
    return () => { set.delete(ac); };
  };
  const askOf = (s: Session, what: 'setup' | 'test'): LoadSlotAsk => ({
    label: `load window ${s.runId}: ${what} of ${s.task.task_id} (arrival ${s.arrival.n})`,
    agentId: s.made.agentId, agentName: s.agentName, projectPath: s.made.project,
  });

  /** The worktree is still the folder Tars made, reached through no link: else git and the steps stay out of it. */
  function intact(m: Made): boolean {
    try {
      if (fs.lstatSync(m.path).isSymbolicLink()) return false;
      return fs.realpathSync(m.path) === path.join(fs.realpathSync(m.project), path.relative(m.project, m.path));
    } catch {
      return false;
    }
  }

  /** The worktree's tree as it stands, its ignored files left out (`git add -A`, `git write-tree`). */
  async function treeOf(m: Made): Promise<string | undefined> {
    if (!intact(m)) return undefined;
    try {
      await deps.git(m.path, ['add', '-A']);
      return (await deps.git(m.path, ['write-tree'])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** What the session changed: from the tree after the setup to the tree at its end. */
  async function diffStatOf(s: Session): Promise<LoadArrival['diffStat']> {
    if (!s.baseTree) return undefined;
    const end = await treeOf(s.made);
    if (!end) return undefined;
    try {
      const out = await deps.git(s.made.path, ['diff', '--shortstat', s.baseTree, end]);
      const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
      return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) };
    } catch {
      return undefined;
    }
  }

  /** The task's test after its session: the slot within its cap, then its run with that cap. */
  async function runTest(s: Session): Promise<LoadTestResult> {
    if (!s.task.test_cmd) return { result: 'not_run', reason: 'none' };
    if (!intact(s.made)) return { result: 'not_run', reason: 'worktree_moved' };
    const capMs = s.task.time_cap_min * deps.minuteMs;
    const ac = new AbortController();
    const untrack = track(s.runId, ac);
    try {
      const got = await deps.slot.takeWithin(askOf(s, 'test'), capMs, ac.signal);
      if (ac.signal.aborted) { got.lease?.release(); return { result: 'not_run', reason: 'stopped', slotWaitMs: got.waitedMs }; }
      if (!got.lease) return { result: 'not_run', reason: 'heavy_slot', slotWaitMs: got.waitedMs };
      try {
        const r = await deps.runStep({ command: s.task.test_cmd, cwd: s.made.path, capMs, signal: ac.signal });
        const timed = { slotWaitMs: got.waitedMs, durationMs: r.durationMs };
        if (r.aborted) return { result: 'not_run', reason: 'stopped', ...timed };
        if (r.atCap) return { result: 'failed', atCap: true, ...timed };
        return r.exitCode === 0 ? { result: 'passed', exitCode: 0, ...timed } : { result: 'failed', ...(r.exitCode !== null ? { exitCode: r.exitCode } : {}), ...timed };
      } finally {
        got.lease.release();
      }
    } finally {
      untrack();
    }
  }

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

  async function end(s: Session, how: NonNullable<LoadArrival['end']>, detail?: string): Promise<void> {
    if (open.get(s.made.agentId) !== s) return;
    open.delete(s.made.agentId);
    deps.clearTimer(s.capTimer);
    s.ac.abort();
    const at = deps.now();
    const ran = s.launchedAt !== undefined;
    const arrival = withoutPhase(s.arrival);
    s.arrival = {
      ...arrival, end: how, endedAt: at,
      ...(detail ? { endDetail: detail } : {}),
      ...(ran ? { sessionMs: at - s.launchedAt! } : {}),
      // A setup the stop cut: which line it was at.
      ...(s.setupLine !== undefined && !arrival.setup && how === 'stopped'
        ? { setup: { result: 'stopped' as const, lines: s.task.setup.length, line: s.setupLine, durationMs: at - (s.setupAt ?? at) } } : {}),
      ...(ran && how !== 'stopped' ? { phase: 'test' as const } : {}),
    };
    note(s.runId, s.arrival);
    finishing.set(s.runId, (finishing.get(s.runId) ?? 0) + 1);
    try {
      await deps.stopSession(s.made.agentId).catch(err => console.error(`[load] the session of ${s.made.agentId} did not stop: ${(err as Error).message}`));
      if (ran) {
        // What the session changed, before its test writes anything; then the test; then the trace's tags.
        const diffStat = await diffStatOf(s);
        const test: LoadTestResult = how === 'stopped' ? { result: 'not_run', reason: 'stopped' } : await runTest(s);
        const done = withoutPhase(s.arrival);
        s.arrival = { ...done, ...(diffStat ? { diffStat } : {}), test };
        note(s.runId, s.arrival);
        if (s.arrival.traceId) {
          try {
            deps.tagTrace(s.arrival.traceId, {
              tag: `load:${s.runId}`, runId: s.runId, taskId: s.task.task_id, n: s.arrival.n, split: s.task.split, trainOk: s.task.train_ok,
              ...(diffStat ? { diffStat } : {}), test,
            });
          } catch (err) {
            console.error(`[load] the trace ${s.arrival.traceId} was not tagged: ${(err as Error).message}`);
          }
        }
      }
      deps.release(s.made.agentId);
      await removeWorktree(s.made);
    } finally {
      finishing.set(s.runId, (finishing.get(s.runId) ?? 1) - 1);
    }
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
    if (await underFloor(runId)) return;
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
    const s: Session = { runId, arrival: started, made, task, agentName: agent.name, capTimer: undefined, sawRunning: false, ac: new AbortController() };
    open.set(agent.id, s);
    // Setup lines take the heavy-run slot now or never: not free, blocked heavy_slot, before any worktree.
    let lease: LoadLease | undefined;
    if (task.setup.length > 0) {
      lease = await deps.slot.takeNow(askOf(s, 'setup')).catch(() => undefined);
      if (!lease) {
        open.delete(agent.id);
        block('heavy_slot', 'the heavy-run slot was not free for its setup');
        return;
      }
    }
    // Named before git makes it: a crash in between leaves nothing the next start does not know of.
    writeState([...readState(), made]);
    try {
      await deps.git(task.project, ['worktree', 'add', '-b', branch, where, `${task.base_commit}^{commit}`]);
    } catch (err) {
      lease?.release();
      open.delete(agent.id);
      writeState(readState().filter(w => w.path !== where));
      fail(`git worktree add: ${(err as Error).message.split('\n')[0]}`);
      return;
    }
    console.log(`[load] arrival ${planned.n} of ${runId} starts: ${agent.id} in ${where}`);
    s.arrival = { ...started, ...(lease ? { phase: 'setup' as const } : {}) };
    note(runId, s.arrival);
    // Its worktree set and its TMPDIR emptied (load-handlers.ts): a session started without either would start on
    // what an earlier one left, so none starts.
    try {
      deps.prepare(agent.id, where);
    } catch (err) {
      lease?.release();
      console.error(`[load] arrival ${planned.n} of ${runId}: ${agent.id} not prepared: ${(err as Error).message}`);
      await end(s, 'error');
      return;
    }
    if (lease) {
      // Its lines one after the other, in the worktree, within 10 minutes in all; one that fails ends the task there.
      const lines = task.setup.length;
      const startedAt = deps.now();
      const deadline = startedAt + SETUP_CAP_MIN * deps.minuteMs;
      s.setupAt = startedAt;
      const untrack = track(runId, s.ac);
      try {
        for (let i = 0; i < lines; i++) {
          s.setupLine = i + 1;
          const r = await deps.runStep({ command: task.setup[i], cwd: where, capMs: Math.max(0, deadline - deps.now()), signal: s.ac.signal });
          // A stop of the run ended the task meanwhile (end() records the line it was at).
          if (r.aborted || open.get(agent.id) !== s) return;
          if (r.atCap || r.exitCode !== 0) {
            s.arrival = { ...s.arrival, setup: { result: r.atCap ? 'at_cap' : 'failed', lines, line: i + 1, ...(r.exitCode !== null && !r.atCap ? { exitCode: r.exitCode } : {}), durationMs: deps.now() - startedAt } };
            await end(s, 'error', r.atCap ? `setup line ${i + 1} reached the ${SETUP_CAP_MIN}-minute cap` : `setup line ${i + 1} exited ${r.exitCode ?? 'without a code'}`);
            return;
          }
        }
      } finally {
        untrack();
        lease.release();
      }
      s.setupLine = undefined;
      s.arrival = { ...s.arrival, setup: { result: 'passed', lines, durationMs: deps.now() - startedAt } };
    }
    // What the session changes is measured from here: the setup's files are no change of its.
    s.baseTree = await treeOf(made);
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
    if (open.get(agent.id) !== s) return;
    s.launchedAt = deps.now();
    const traceId = deps.traceOf(agent.id);
    const after = withoutPhase(s.arrival);
    s.arrival = { ...after, phase: 'session', ...(traceId ? { traceId } : {}) };
    note(runId, s.arrival);
    s.capTimer = deps.setTimer(() => { void end(s, 'at_cap'); }, task.time_cap_min * deps.minuteMs);
  }

  function cancel(runId: string): void {
    for (const t of timers.get(runId) ?? []) deps.clearTimer(t);
    timers.delete(runId);
  }

  /** Whether the run has anything of its own under way: a session, a setup, a test. */
  const busy = (runId: string) => [...open.values()].some(s => s.runId === runId) || (finishing.get(runId) ?? 0) > 0;

  /**
   * Under the disk floor: the run ends `disk_floor` (when it still ran), its sessions are stopped and every step in
   * flight killed. True when it was.
   */
  async function underFloor(runId: string): Promise<boolean> {
    const free = deps.freeDiskGb();
    const floor = deps.diskFloorGb();
    if (free === null || free >= floor) return false;
    const detail = `${free} GB free, under the ${floor} GB floor`;
    console.error(`[load] ${runId} stops at the disk floor: ${detail}`);
    if (deps.isRunning(runId)) deps.endRun(runId, { reason: 'disk_floor', at: deps.now(), detail });
    await stop(runId);
    return true;
  }

  /** Reads the disk every quarter of a minute while the run runs or has anything under way. */
  function watchDisk(runId: string): void {
    const tick = () => {
      diskTimers.delete(runId);
      void (async () => {
        if (!deps.isRunning(runId) && !busy(runId)) return;
        if (await underFloor(runId)) return;
        diskTimers.set(runId, deps.setTimer(tick, deps.minuteMs / 4));
      })();
    };
    const was = diskTimers.get(runId);
    if (was !== undefined) deps.clearTimer(was);
    diskTimers.set(runId, deps.setTimer(tick, deps.minuteMs / 4));
  }

  /** Arms the run's arrivals, each at its planned time (one already due starts at once). */
  function start(runId: string): void {
    const plan = deps.plan(runId);
    if (!plan) { console.error(`[load] ${runId} not armed: no plan (not approved, or its snapshot changed)`); return; }
    console.log(`[load] ${runId} armed: ${plan.planned.length} arrivals`);
    cancel(runId);
    const now = deps.now();
    timers.set(runId, plan.planned.map(p => deps.setTimer(() => { void arrive(runId, p); }, p.plannedAt - now)));
    watchDisk(runId);
  }

  /** The run stopped: no more arrivals, every step in flight killed, and every open session ended, stopped, and cleaned. */
  async function stop(runId: string): Promise<void> {
    cancel(runId);
    const disk = diskTimers.get(runId);
    if (disk !== undefined) { deps.clearTimer(disk); diskTimers.delete(runId); }
    for (const ac of inFlight.get(runId) ?? []) ac.abort();
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
