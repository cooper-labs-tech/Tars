import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLoadEngine, type LoadEngineDeps, type LoadRunPlan } from '../../../electron/services/load-engine';
import type { LoadTask } from '../../../electron/services/load-pool';
import type { StepResult } from '../../../electron/services/load-steps';

/**
 * The load window's engine (trace feature C3, part 2, 27/11): the approved run's arrivals at their time, each admitted
 * or blocked, a worktree and a fresh session of a load agent per admitted arrival, its end, and its cleanup.
 *
 * How it fails, written before the code:
 *  E1. An arrival starts before its time or not at it; one that cannot start waits and starts later (queued), or is
 *      not recorded; its reason is not the frames' (`max_concurrent`: the run's open sessions at max_concurrent;
 *      `no_harness`: no load agent of its project free and running a harness the task and the grant accept;
 *      `busy_cap`: the busy cap's seam refuses).
 *  E2. The worktree: not at the task's base_commit, not on `load/<run>/<task>-<n>`, outside the project's
 *      `.worktrees`, made before the private state names it (a crash in between leaves one nothing knows of), or left
 *      behind with its branch after the session ends.
 *  E3. The session: not the load agent's own, not in the worktree, a resumed conversation instead of a fresh one,
 *      without the preamble (no push, no pull request, no deploy, no migration, no production) or the task's prompt;
 *      the agent not handed back (its worktree kept) after.
 *  E4. The end: the session's turn ends (the agent rests after running) and nothing ends it, or its cap passes and it
 *      runs on (it must be stopped, `at_cap`); a stop of the run leaves sessions running or worktrees behind.
 *  E5. A run that is no longer running (stopped, ended) still starts arrivals.
 *  E6. After a crash or a quit: worktrees the private state names are not removed, or one the run's log names (any
 *      agent can write it) is; a run without a stop runs on, when Tars cannot know what its sessions did ("Tars
 *      restarted during the window", an error).
 *  E7. A worktree path the guard refuses still reaches git.
 *  E8. (Found by the E2E's first runs, written before its fix.) Two arrivals due at once (the agents' creation took
 *      longer than their gap) are both admitted past max_concurrent, or take one agent, the second's admission running
 *      while the first waits on git: an admitted arrival must hold its place and its agent before anything awaits.
 *  E9. (The Audit's Infos on #685 at d43af8072, written before their code.) The log under ~/.tars, which any agent
 *      can write, decides something or is what the card shows: an edited log admits an arrival past max_concurrent,
 *      ends a session, or changes the progress. The engine holds the progress itself (its arrivals and the agents
 *      that run them), kept privately for after a restart, where the session a restart cut reads `stopped`.
 *  E10. (The no-memory rule, written before its code.) The agent's preparation for the session (its worktree set, its
 *      TMPDIR emptied: load-handlers.ts) fails, and the session starts anyway on what an earlier one left, or the
 *      arrival stays open for ever, its place held and its worktree kept.
 *  E11. (The Audit's M1 at 51a8a21f8, written before its fix.) A load agent runs where its fleet record says, never
 *      checked against the grant: one whose endpoint was cleared (its CLI then runs on the owner's own account) or
 *      set to another endpoint or model is picked; or one that matched when admitted is launched after its record
 *      moved. Only an agent on the grant's endpoint and model, read from the private grant at admission and again at
 *      launch, runs a task; otherwise the arrival is blocked `no_harness`, or ends in error before any session.
 *  E12. (The Audit's Info at 51a8a21f8, written before its fix.) Cleanup follows a link planted in place of a
 *      worktree: `git worktree remove --force` on a path that is now a link to another worktree of the repository
 *      removes that one. A link is removed as a link, never handed to git.
 * Part 3 (setup, test, tags, stops), written before the code:
 *  E13. The setup: its lines run out of order, outside the worktree, after the session started, without the heavy-run
 *      slot, or past their 10-minute cap; a line that fails or reaches its cap lets the task go on (a session starts),
 *      runs the lines after it, keeps the slot, or leaves its worktree; the record does not say which line and why.
 *  E14. `heavy_slot`: a task with setup lines whose slot is not free when it arrives waits for it (queued), or makes a
 *      worktree first; a task without setup lines asks for the slot when it arrives.
 *  E15. The test: it runs before the session ends, without the slot, or past the task's cap without its tree killed;
 *      the time it waited for the slot is counted in the session's; a slot not free within the cap is a failure, or
 *      stops the window (the next arrival does not start); passed, failed, at its cap, not run (none, heavy_slot, a
 *      stop) are not told apart; the diff stat counts the setup's files, or what the test wrote.
 *  E16. The trace: the session's trace is not tagged `load:<run>` with its task, arrival, split, train_ok, diff stat
 *      and test result, or the tags are written before the test ended.
 *  E17. The disk floor: under it the window goes on, or stops without its reason, or leaves a session, a setup or a
 *      test running, or a worktree behind.
 *  E18. The window's end by time stops a running session (it keeps its cap) or its test, or starts an arrival after it.
 */

let dir: string;
let project: string;
let head: string;
let stateFile: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

/** A clock and timers the test runs by hand. */
function clock(start: number) {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    /** Runs every timer due by `to`, in time order, the clock moving with them. */
    async advance(to: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      }
      now = to;
      // What a status change started (an end, its cleanup) runs out before the test reads.
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    },
  };
}

const RUN = '20261127-140000-a1b2';
const T0 = Date.parse('2026-11-27T14:00:00Z');
const task = (over: Partial<LoadTask>): LoadTask => ({
  line: 1, task_id: 'fix-retry', project, repo: null, base_commit: head, prompt: 'Fix the retry header.', language: null, setup: [],
  test_cmd: null, time_cap_min: 10, expected_tools: [], harnesses: null, weight: 1, max_runs: 3, split: 'train', train_ok: true, source: null, licence: null,
  ...over,
} as LoadTask);

interface Fakes {
  agents: Array<{ id: string; name: string; projectPath: string; provider: string; status: string; worktreePath?: string; endpointId?: string | null; model?: string | null }>;
  /** The project's grant, as the private file has it: where its load agents run. */
  grant: { endpointId: string | null; model: string | null } | undefined;
  /** The heavy-run slot: free now or not, and how long a wait for it lasts (within its limit) when it is granted. */
  slot: { free: boolean; waitMs?: number };
  leases: { taken: number; released: number };
  steps: Array<{ command: string; cwd: string; capMs: number }>;
  /** How each step ends (a setup line or a test_cmd), and what it does in its folder. */
  step: (o: { command: string; cwd: string; capMs: number; signal: AbortSignal }) => Promise<StepResult>;
  disk: number | null;
  tags: Array<{ traceId: string; load: Record<string, unknown> }>;
  launches: Array<{ agentId: string; prompt: string; resume: unknown; cwd?: string }>;
  stops: string[];
  log: Array<Record<string, unknown>>;
  running: boolean;
  cap: { ok: boolean; reason?: string };
  listeners: Array<(id: string) => void>;
}
let f: Fakes;
let c: ReturnType<typeof clock>;

function plan(tasks: LoadTask[], planned: Array<{ n: number; taskId: string; offsetMs: number }>, maxConcurrent = 2): LoadRunPlan {
  return {
    runId: RUN, endsAt: T0 + 60 * 60_000, window: { max_concurrent: maxConcurrent }, tasks,
    planned: planned.map(p => ({ n: p.n, taskId: p.taskId, plannedAt: T0 + p.offsetMs })),
  };
}

function deps(p: LoadRunPlan, over: Partial<LoadEngineDeps> = {}): LoadEngineDeps {
  return {
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, stateFile,
    plan: (runId) => (runId === RUN ? p : undefined),
    isRunning: () => f.running,
    endRun: (_runId, stop) => { f.running = false; f.log.push({ stop }); },
    grantHarnesses: () => ['codex', 'qwen-code'],
    grantTarget: () => f.grant,
    loadAgents: () => f.agents,
    busyCap: () => f.cap,
    git: async (cwd, args) => git(cwd, ...args),
    prepare: (agentId, worktreePath) => { f.agents.find(a => a.id === agentId)!.worktreePath = worktreePath; },
    release: (agentId) => { delete f.agents.find(a => a.id === agentId)!.worktreePath; },
    launch: async (agentId, prompt, resumeSessionId) => {
      const a = f.agents.find(x => x.id === agentId)!;
      f.launches.push({ agentId, prompt, resume: resumeSessionId, cwd: a.worktreePath });
      return { ok: true };
    },
    stopSession: async (agentId) => { f.stops.push(agentId); f.agents.find(a => a.id === agentId)!.status = 'stopped'; },
    statusOf: (agentId) => f.agents.find(a => a.id === agentId)?.status,
    onStatus: (fn) => { f.listeners.push(fn); return () => {}; },
    logArrival: (_runId, a) => { f.log.push({ ...a }); },
    minuteMs: 60_000,
    slot: {
      takeNow: async () => (f.slot.free ? lease() : undefined),
      takeWithin: async (_ask, ms, signal) => {
        if (signal.aborted) return { waitedMs: 0 };
        return f.slot.free ? { lease: lease(), waitedMs: f.slot.waitMs ?? 0 } : { waitedMs: ms };
      },
    },
    runStep: async (o) => { f.steps.push({ command: o.command, cwd: o.cwd, capMs: o.capMs }); return f.step(o); },
    freeDiskGb: () => f.disk,
    diskFloorGb: () => 15,
    traceOf: (agentId) => `tr-${agentId}`,
    tagTrace: (traceId, load) => { f.tags.push({ traceId, load }); },
    ...over,
  };
}
const lease = () => { f.leases.taken++; let back = false; return { release: () => { if (!back) { back = true; f.leases.released++; } } }; };
const ok = (exitCode = 0): StepResult => ({ exitCode, atCap: false, aborted: false, durationMs: 5 });
const setStatus = (id: string, status: string) => { f.agents.find(a => a.id === id)!.status = status; for (const l of f.listeners) l(id); };
const worktrees = () => git(project, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).filter(p => p !== fs.realpathSync(project) && p !== project);
const branches = () => git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/load').split('\n').filter(Boolean);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-engine-'));
  project = path.join(dir, 'atlas');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), 'first\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  head = git(project, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(project, 'README.md'), 'second\n');
  git(project, 'commit', '-q', '-am', 'second');
  stateFile = path.join(dir, 'private', 'load-run-state.json');
  c = clock(T0);
  f = {
    agents: [
      { id: 'a1', name: 'Load 1', projectPath: project, provider: 'codex', status: 'idle', endpointId: 'ep-0a0b0c', model: 'open-coder-1' },
      { id: 'a2', name: 'Load 2', projectPath: project, provider: 'qwen-code', status: 'idle', endpointId: 'ep-0a0b0c', model: 'open-coder-1' },
    ],
    grant: { endpointId: 'ep-0a0b0c', model: 'open-coder-1' },
    slot: { free: true }, leases: { taken: 0, released: 0 }, steps: [], step: async () => ok(), disk: 200, tags: [],
    launches: [], stops: [], log: [], running: true, cap: { ok: true }, listeners: [],
  };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('arrivals', () => {
  it('E1 and E5: each at its time; blocked ones recorded with the frames\' reason and dropped, never started later', async () => {
    const p = plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 1000 }, { n: 3, taskId: 'fix-retry', offsetMs: 2000 }], 1);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(f.launches).toHaveLength(1);
    await c.advance(T0 + 1000);
    expect(f.log.find(x => x.n === 2)).toMatchObject({ blocked: 'max_concurrent', actualAt: T0 + 1000 });
    // The first ends; the blocked one is never started after.
    setStatus('a1', 'running');
    setStatus('a1', 'waiting');
    await c.advance(T0 + 1500);
    expect(f.launches).toHaveLength(1);
    // No free agent with a harness the task takes: no_harness. A busy cap refusing: busy_cap.
    f.cap = { ok: false, reason: 'the project is at its busy cap' };
    await c.advance(T0 + 2000);
    expect(f.log.find(x => x.n === 3)).toMatchObject({ blocked: 'busy_cap', blockedDetail: 'the project is at its busy cap' });
    // A stopped run starts nothing more, whatever else would let it (found by the mutation bench: the busy cap still
    // refusing here hid the check).
    f.cap = { ok: true };
    f.running = false;
    const e2 = createLoadEngine(deps(plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 3000 }])));
    e2.start(RUN);
    await c.advance(T0 + 4000);
    expect(f.launches).toHaveLength(1);
  });

  it('E1: no load agent of the project running a harness the task and the grant accept is no_harness', async () => {
    const p = plan([task({ harnesses: ['pi'] }), task({ line: 2, task_id: 'two', harnesses: ['codex'] })],
      [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'two', offsetMs: 10 }, { n: 3, taskId: 'two', offsetMs: 20 }], 3);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0 + 30);
    expect(f.log.find(x => x.n === 1)).toMatchObject({ blocked: 'no_harness' });
    expect(f.log.find(x => x.n === 2)).toMatchObject({ agentId: 'a1', harness: 'codex' });
    // a1 is busy, a2 runs qwen-code, which the task does not take.
    expect(f.log.find(x => x.n === 3)).toMatchObject({ blocked: 'no_harness' });
  });
});

describe('two arrivals due at once', () => {
  it('E8: the first holds its place and its agent before it awaits anything; the second is blocked, max_concurrent', async () => {
    const p = plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 0 }], 1);
    const due: Array<() => void> = [];
    const e = createLoadEngine(deps(p, { setTimer: (fn) => { due.push(fn); return due.length; } }));
    e.start(RUN);
    // Both fire in one go, as overdue timers do, nothing awaited between them.
    for (const fn of due) fn();
    await c.advance(T0);
    expect(f.launches).toHaveLength(1);
    expect(f.log.find(x => x.n === 2)).toMatchObject({ blocked: 'max_concurrent' });
  });
});

describe('a session', () => {
  it('E2 to E4: a worktree at base_commit on its branch, named privately first; a fresh session with the preamble; cleaned at its end', async () => {
    const p = plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    let stateWhenGitRan: unknown;
    const e = createLoadEngine(deps(p, {
      git: async (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'add') stateWhenGitRan = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        return git(cwd, ...args);
      },
    }));
    e.start(RUN);
    await c.advance(T0);
    const where = path.join(project, '.worktrees', 'load', RUN, 'fix-retry-1');
    expect(worktrees().map(w => fs.realpathSync(w))).toEqual([fs.realpathSync(where)]);
    expect(git(where, 'rev-parse', 'HEAD')).toBe(head);
    expect(branches()).toEqual([`load/${RUN}/fix-retry-1`]);
    expect(stateWhenGitRan).toMatchObject({ worktrees: [{ runId: RUN, n: 1, project, path: where, branch: `load/${RUN}/fix-retry-1`, agentId: 'a1' }] });
    expect(f.launches).toEqual([{ agentId: 'a1', prompt: expect.stringContaining('Fix the retry header.'), resume: null, cwd: where }]);
    expect(f.launches[0].prompt).toMatch(/no push/i);
    expect(f.launches[0].prompt).toMatch(/production/i);
    // Its turn ends: done, the session stopped, the agent handed back, the worktree and its branch gone, nothing named.
    setStatus('a1', 'running');
    setStatus('a1', 'waiting');
    await c.advance(T0 + 10);
    expect(f.log.find(x => x.n === 1 && x.end)).toMatchObject({ end: 'done', endedAt: T0 });
    expect(f.stops).toEqual(['a1']);
    expect(f.agents[0].worktreePath).toBeUndefined();
    expect(worktrees()).toEqual([]);
    expect(branches()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).worktrees).toEqual([]);
  });

  it('E4: at its cap it is stopped, at_cap; a stop of the run ends every open session, stopped, and cleans', async () => {
    const p = plan([task({ time_cap_min: 10 })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 60_000 }]);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0 + 60_000);
    setStatus('a1', 'running');
    await c.advance(T0 + 10 * 60_000);
    expect(f.log.find(x => x.n === 1 && x.end)).toMatchObject({ end: 'at_cap' });
    expect(f.stops).toContain('a1');
    expect(f.log.find(x => x.n === 2)).toMatchObject({ agentId: 'a2' });
    await e.stop(RUN);
    expect(f.log.find(x => x.n === 2 && x.end)).toMatchObject({ end: 'stopped' });
    expect(f.stops).toContain('a2');
    expect(worktrees()).toEqual([]);
    expect(branches()).toEqual([]);
  });

  it('E7: a worktree the guard refuses never reaches git; the arrival ends in error', async () => {
    const calls: string[][] = [];
    const p = plan([task({ project: path.join(dir, 'gone') })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    f.agents[0].projectPath = path.join(dir, 'gone');
    const e = createLoadEngine(deps(p, { git: async (cwd, args) => { calls.push(args); return git(cwd, ...args); } }));
    e.start(RUN);
    await c.advance(T0);
    expect(f.log.find(x => x.n === 1)).toMatchObject({ end: 'error' });
    expect(calls.filter(a => a[0] === 'worktree')).toEqual([]);
    expect(f.launches).toEqual([]);
  });

  it('E10: a preparation that fails starts no session; the arrival ends in error, its worktree removed, its place freed', async () => {
    const p = plan([task()], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 60_000 }]);
    let fails = true;
    const e = createLoadEngine(deps(p, { prepare: (agentId, worktreePath) => {
      if (fails) throw new Error('the TMPDIR could not be emptied');
      f.agents.find(a => a.id === agentId)!.worktreePath = worktreePath;
    } }));
    e.start(RUN);
    await c.advance(T0);
    expect(f.launches).toEqual([]);
    // Each write of the arrival is logged: its last says how it ended.
    await vi.waitFor(() => expect(f.log.filter(x => x.n === 1).at(-1)).toMatchObject({ end: 'error' }));
    expect(fs.existsSync(path.join(project, '.worktrees', 'load', RUN, 'fix-retry-1'))).toBe(false);
    // Its place is free: the next arrival starts.
    fails = false;
    await c.advance(T0 + 60_000);
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
  });

  it('E11: a load agent off the grant\'s endpoint or model is never picked; with none on it, no_harness', async () => {
    const p = plan([task()], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    // Its endpoint cleared (update_agent with endpointId null, or agents.json edited): its CLI would run on the owner's account.
    f.agents[0].endpointId = null;
    // Moved to another model of the endpoint.
    f.agents[1].model = 'another-model';
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(f.launches).toEqual([]);
    expect(f.log.find(x => x.n === 1)).toMatchObject({ blocked: 'no_harness' });
    expect(worktrees()).toEqual([]);
  });

  it('E11: the one on the grant\'s endpoint and model runs the task; none runs without a grant', async () => {
    f.agents[0].endpointId = 'ep-ffffff';
    const p = plan([task()], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 60_000 }]);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(f.launches.map(l => l.agentId)).toEqual(['a2']);
    setStatus('a2', 'running');
    setStatus('a2', 'idle');
    await c.advance(T0 + 1000);
    // The grant withdrawn: no agent runs where the owner allowed nothing.
    f.grant = undefined;
    await c.advance(T0 + 60_000);
    expect(f.launches.map(l => l.agentId)).toEqual(['a2']);
    expect(f.log.filter(x => x.n === 2).at(-1)).toMatchObject({ blocked: 'no_harness' });
  });

  it('E11: an agent whose record moves after its admission is never launched; the arrival ends in error and is cleaned', async () => {
    const p = plan([task()], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    const e = createLoadEngine(deps(p, {
      git: async (cwd, args) => {
        const out = git(cwd, ...args);
        // While git makes the worktree, the record moves (agents.json, or the window's own edit).
        if (args[0] === 'worktree' && args[1] === 'add') { f.agents[0].endpointId = null; f.agents[1].endpointId = null; }
        return out;
      },
    }));
    e.start(RUN);
    await c.advance(T0);
    expect(f.launches).toEqual([]);
    await vi.waitFor(() => expect(f.log.filter(x => x.n === 1).at(-1)).toMatchObject({ end: 'error' }));
    expect(worktrees()).toEqual([]);
    expect(branches()).toEqual([]);
  });

  it('E12: a link planted in place of the worktree is removed as a link; the worktree it points at stays', async () => {
    const p = plan([task()], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    const where = path.join(project, '.worktrees', 'load', RUN, 'fix-retry-1');
    expect(fs.existsSync(where)).toBe(true);
    // Another worktree of the repository, the owner's.
    const keep = path.join(dir, 'keep');
    git(project, 'worktree', 'add', '-q', '-b', 'keep-branch', keep);
    fs.writeFileSync(path.join(keep, 'work.txt'), 'the owner\'s work\n');
    // The session moves its worktree away and puts a link to that one in its place.
    fs.renameSync(where, `${where}-moved`);
    fs.symlinkSync(keep, where);
    setStatus('a1', 'running');
    setStatus('a1', 'idle');
    await c.advance(T0 + 1000);
    await vi.waitFor(() => expect(f.log.filter(x => x.n === 1).at(-1)).toMatchObject({ end: 'done' }));
    expect(fs.readFileSync(path.join(keep, 'work.txt'), 'utf8')).toBe('the owner\'s work\n');
    expect(worktrees().map(w => fs.realpathSync(w))).toContain(fs.realpathSync(keep));
    expect(fs.existsSync(where)).toBe(false);
    expect(branches()).toEqual([]);
  });
});

describe('after a crash or a quit', () => {
  it('E6: the worktrees the private state names are removed, never one the log names; a run without a stop ends in error', async () => {
    const p = plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(worktrees()).toHaveLength(1);
    // Another worktree, planted in a run.json as a forged log would name it: never removed.
    const other = path.join(project, '.worktrees', 'keep-me');
    git(project, 'worktree', 'add', '-q', '-b', 'keep-me', other, head);
    fs.mkdirSync(path.join(dir, 'runs', RUN), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', RUN, 'run.json'), JSON.stringify({ runId: RUN, worktrees: [{ path: other, branch: 'keep-me', project }] }));
    // A new Tars, its engine starting over: nothing in memory.
    const after = createLoadEngine(deps(p));
    await after.recover([RUN]);
    expect(worktrees().map(w => fs.realpathSync(w))).toEqual([fs.realpathSync(other)]);
    expect(branches()).toEqual([]);
    expect(f.log.find(x => x.stop)).toMatchObject({ stop: { reason: 'error', detail: 'Tars restarted during the window' } });
    // The progress, kept privately: the session the restart cut reads stopped.
    expect(after.progress(RUN)?.arrivals).toMatchObject([{ n: 1, agentId: 'a1', end: 'stopped' }]);
  });
});

describe('the log decides nothing', () => {
  it('E9: an edited log admits nothing past max_concurrent, ends no session, and is not the progress the engine holds', async () => {
    const logFile = path.join(dir, 'runs', RUN, 'run.json');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const written: Array<Record<string, unknown>> = [];
    const p = plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 1000 }], 1);
    const e = createLoadEngine(deps(p, { logArrival: (_r, a) => { written.push({ ...a }); fs.writeFileSync(logFile, JSON.stringify({ arrivals: written, agents: [] })); } }));
    e.start(RUN);
    await c.advance(T0);
    // An agent edits the log: the open session ended, and some progress that never was.
    fs.writeFileSync(logFile, JSON.stringify({
      arrivals: [{ n: 1, taskId: 'fix-retry', plannedAt: T0, actualAt: T0, agentId: 'a1', end: 'done', endedAt: T0 }, { n: 9, taskId: 'fix-retry', plannedAt: T0, actualAt: T0, end: 'done' }],
      agents: [],
    }));
    await c.advance(T0 + 1000);
    expect(f.launches).toHaveLength(1);
    const held = e.progress(RUN)!;
    expect(held.arrivals.map(a => [a.n, a.agentId ?? null, a.blocked ?? null, a.end ?? null])).toEqual([[1, 'a1', null, null], [2, null, 'max_concurrent', null]]);
    expect(held.agents).toEqual([{ agentId: 'a1', name: 'Load 1', project, harness: 'codex', created: false }]);
    // The session ends only when it does.
    setStatus('a1', 'running');
    setStatus('a1', 'waiting');
    await c.advance(T0 + 1010);
    expect(e.progress(RUN)!.arrivals.find(a => a.n === 1)).toMatchObject({ end: 'done' });
  });
});

const WHERE = () => path.join(project, '.worktrees', 'load', RUN, 'fix-retry-1');
const last = (n: number) => f.log.filter(x => x.n === n).at(-1) as Record<string, unknown> | undefined;
/** The agent works until `at`, then rests: its turn ends. What it wrote is in its worktree. */
async function sessionEnds(agentId: string, at: number, wrote?: Record<string, string>) {
  await c.advance(at);
  for (const [file, text] of Object.entries(wrote ?? {})) fs.writeFileSync(path.join(WHERE(), file), text);
  setStatus(agentId, 'running');
  setStatus(agentId, 'waiting');
  await c.advance(at);
}

describe('the setup (part 3)', () => {
  it('E13: its lines run in order, in the worktree, under one lease of the slot, before the session, within 10 minutes; its files are no change of the session', async () => {
    const p = plan([task({ setup: ['npm ci', 'npm run build'] })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    let leasesAtLaunch = -1;
    f.step = async (o) => { if (o.command === 'npm ci') fs.writeFileSync(path.join(o.cwd, 'setup-ran.txt'), 'x\n'); return ok(); };
    const e = createLoadEngine(deps(p, { launch: async (agentId, prompt, resume) => {
      leasesAtLaunch = f.leases.taken - f.leases.released;
      f.launches.push({ agentId, prompt, resume, cwd: f.agents.find(a => a.id === agentId)!.worktreePath });
      return { ok: true };
    } }));
    e.start(RUN);
    await c.advance(T0);
    expect(f.steps.map(s => s.command)).toEqual(['npm ci', 'npm run build']);
    expect(f.steps.every(s => fs.realpathSync(s.cwd) === fs.realpathSync(WHERE()))).toBe(true);
    expect(f.steps[0].capMs).toBeLessThanOrEqual(10 * 60_000);
    expect(f.steps[1].capMs).toBeLessThanOrEqual(10 * 60_000);
    expect(f.leases).toEqual({ taken: 1, released: 1 });
    expect(leasesAtLaunch).toBe(0);
    expect(f.launches).toHaveLength(1);
    await sessionEnds('a1', T0 + 1000, { 'fix.txt': 'a\nb\n' });
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'done', setup: { result: 'passed', lines: 2 }, diffStat: { files: 1, insertions: 2, deletions: 0 } }));
  });

  it('E13: a line that fails ends the task there: no session, the lines after it not run, the slot back, the worktree gone, the record says which line and why', async () => {
    const p = plan([task({ setup: ['npm ci', 'npm run build', 'npm run seed'] })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    f.step = async (o) => ok(o.command === 'npm run build' ? 1 : 0);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'error', setup: { result: 'failed', line: 2, exitCode: 1, lines: 3 } }));
    expect(String(last(1)!.endDetail)).toMatch(/setup line 2 .*exit/);
    expect(f.steps.map(s => s.command)).toEqual(['npm ci', 'npm run build']);
    expect(f.launches).toEqual([]);
    expect(f.leases).toEqual({ taken: 1, released: 1 });
    expect(worktrees()).toEqual([]);
    expect(branches()).toEqual([]);
  });

  it('E13: a line at its cap ends the task the same way, at_cap', async () => {
    const p = plan([task({ setup: ['npm ci'] })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    f.step = async () => ({ exitCode: null, atCap: true, aborted: false, durationMs: 600_000 });
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'error', setup: { result: 'at_cap', line: 1 } }));
    expect(String(last(1)!.endDetail)).toMatch(/10-minute cap/);
    expect(f.launches).toEqual([]);
    expect(f.leases).toEqual({ taken: 1, released: 1 });
    expect(worktrees()).toEqual([]);
  });

  it('E14: with setup lines and the slot not free, blocked heavy_slot at once, never queued, no worktree; without setup lines, the slot is not asked for', async () => {
    f.slot.free = false;
    const p = plan([task({ setup: ['npm ci'] }), task({ task_id: 'plain', line: 2 })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'plain', offsetMs: 1000 }]);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(last(1)).toMatchObject({ blocked: 'heavy_slot' });
    expect(worktrees()).toEqual([]);
    expect(f.steps).toEqual([]);
    // Freed later, it starts nothing: dropped, never queued.
    f.slot.free = true;
    await c.advance(T0 + 1000);
    expect(f.steps).toEqual([]);
    expect(f.launches.map(l => l.agentId)).toEqual(['a1']);
    expect(last(2)).toMatchObject({ agentId: 'a1' });
    expect(f.leases.taken).toBe(0);
  });
});

describe('the test (part 3)', () => {
  it('E15: after the session, under the slot, its wait apart from the session\'s time; passed; the diff taken before it', async () => {
    const p = plan([task({ test_cmd: 'npm test' })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    f.slot.waitMs = 4000;
    f.step = async (o) => { fs.writeFileSync(path.join(o.cwd, 'coverage.txt'), 'x\n'); return ok(0); };
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(f.steps).toEqual([]);
    await sessionEnds('a1', T0 + 30_000, { 'fix.txt': 'one\n' });
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'done', test: { result: 'passed', exitCode: 0, slotWaitMs: 4000 }, diffStat: { files: 1, insertions: 1, deletions: 0 } }));
    expect(f.steps).toEqual([{ command: 'npm test', cwd: expect.any(String), capMs: 10 * 60_000 }]);
    expect(last(1)!.sessionMs).toBe(30_000);
    expect(f.leases).toEqual({ taken: 1, released: 1 });
  });

  it('E15: failed, with its exit code; at its cap, failed at_cap', async () => {
    const p = plan([task({ test_cmd: 'npm test' })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 60_000 }], 1);
    f.step = async () => ok(2);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    await sessionEnds('a1', T0 + 1000);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ test: { result: 'failed', exitCode: 2 } }));
    f.step = async () => ({ exitCode: null, atCap: true, aborted: false, durationMs: 600_000 });
    await c.advance(T0 + 60_000);
    await sessionEnds('a1', T0 + 61_000);
    await vi.waitFor(() => expect(last(2)).toMatchObject({ test: { result: 'failed', atCap: true } }));
  });

  it('E15: the slot not free within the cap: not_run heavy_slot, no failure, and the window goes on', async () => {
    const p = plan([task({ test_cmd: 'npm test' })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 60_000 }], 1);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    f.slot.free = false;
    await sessionEnds('a1', T0 + 1000);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'done', test: { result: 'not_run', reason: 'heavy_slot', slotWaitMs: 10 * 60_000 } }));
    expect(f.steps).toEqual([]);
    expect(f.log.find(x => (x as { stop?: unknown }).stop)).toBeUndefined();
    await c.advance(T0 + 60_000);
    expect(f.launches).toHaveLength(2);
  });

  it('E15: no test_cmd: not_run none; a stop during the test: not_run stopped, the step ended', async () => {
    const p = plan([task(), task({ task_id: 'tested', line: 2, test_cmd: 'npm test' })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'tested', offsetMs: 60_000 }], 1);
    let aborted = false;
    f.step = (o) => new Promise((resolve) => { o.signal.addEventListener('abort', () => { aborted = true; resolve({ exitCode: null, atCap: false, aborted: true, durationMs: 1 }); }); });
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    await sessionEnds('a1', T0 + 1000);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ test: { result: 'not_run', reason: 'none' } }));
    await c.advance(T0 + 60_000);
    await sessionEnds('a1', T0 + 61_000);
    await vi.waitFor(() => expect(f.steps).toHaveLength(1));
    f.running = false;
    await e.stop(RUN);
    await vi.waitFor(() => expect(last(2)).toMatchObject({ test: { result: 'not_run', reason: 'stopped' } }));
    expect(aborted).toBe(true);
    expect(f.leases.taken).toBe(f.leases.released);
    expect(worktrees()).toEqual([]);
  });
});

describe('the trace and the stops (part 3)', () => {
  it('E16: the session\'s trace is tagged load:<run>, task, arrival, split, train_ok, diff stat and test, once the test ended', async () => {
    const p = plan([task({ test_cmd: 'npm test', split: 'heldout', train_ok: false })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    let tagsWhenTested = -1;
    f.step = async () => { tagsWhenTested = f.tags.length; return ok(0); };
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(f.log.filter(x => x.n === 1).at(-1)).toMatchObject({ traceId: 'tr-a1' });
    await sessionEnds('a1', T0 + 1000, { 'fix.txt': 'x\n' });
    await vi.waitFor(() => expect(f.tags).toHaveLength(1));
    expect(tagsWhenTested).toBe(0);
    expect(f.tags[0]).toEqual({
      traceId: 'tr-a1',
      load: {
        tag: `load:${RUN}`, runId: RUN, taskId: 'fix-retry', n: 1, split: 'heldout', trainOk: false,
        diffStat: { files: 1, insertions: 1, deletions: 0 }, test: expect.objectContaining({ result: 'passed' }),
      },
    });
  });

  it('E17: under the disk floor the window stops, disk_floor with its reason; its session and a setup in flight stopped; nothing arrives after', async () => {
    const p = plan([task(), task({ task_id: 'built', line: 2, setup: ['npm ci'] })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'built', offsetMs: 0 }, { n: 3, taskId: 'fix-retry', offsetMs: 5 * 60_000 }], 2);
    let aborted = false;
    f.step = (o) => new Promise((resolve) => { o.signal.addEventListener('abort', () => { aborted = true; resolve({ exitCode: null, atCap: false, aborted: true, durationMs: 1 }); }); });
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(f.launches.map(l => l.agentId)).toEqual(['a1']);
    expect(f.steps).toHaveLength(1);
    f.disk = 14.2;
    await c.advance(T0 + 60_000);
    const stop = f.log.find(x => (x as { stop?: { reason: string } }).stop) as { stop: { reason: string; detail: string } } | undefined;
    expect(stop?.stop).toMatchObject({ reason: 'disk_floor' });
    expect(stop?.stop.detail).toMatch(/14\.2 GB free, under the 15 GB floor/);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'stopped' }));
    await vi.waitFor(() => expect(last(2)).toMatchObject({ end: 'stopped', setup: { result: 'stopped' } }));
    expect(aborted).toBe(true);
    expect(f.stops).toContain('a1');
    await c.advance(T0 + 5 * 60_000);
    expect(f.launches).toHaveLength(1);
    await vi.waitFor(() => expect(worktrees()).toEqual([]));
    expect(f.leases.taken).toBe(f.leases.released);
  });

  it('E18: at the window\'s end by time a running session keeps its cap and its test; nothing arrives after', async () => {
    const p = plan([task({ test_cmd: 'npm test' })], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }, { n: 2, taskId: 'fix-retry', offsetMs: 2 * 60_000 }], 2);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    // The window ends: the owner did not stop it, its time did (load-window.ts sets window_end and calls no stop).
    f.running = false;
    await c.advance(T0 + 2 * 60_000);
    expect(f.launches).toHaveLength(1);
    expect(f.stops).toEqual([]);
    await sessionEnds('a1', T0 + 3 * 60_000);
    await vi.waitFor(() => expect(last(1)).toMatchObject({ end: 'done', test: { result: 'passed' } }));
  });
});
