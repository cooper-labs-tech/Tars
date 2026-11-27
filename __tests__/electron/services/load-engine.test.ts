import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLoadEngine, type LoadEngineDeps, type LoadRunPlan } from '../../../electron/services/load-engine';
import type { LoadTask } from '../../../electron/services/load-pool';

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
  agents: Array<{ id: string; name: string; projectPath: string; provider: string; status: string; worktreePath?: string }>;
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
    ...over,
  };
}
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
      { id: 'a1', name: 'Load 1', projectPath: project, provider: 'codex', status: 'idle' },
      { id: 'a2', name: 'Load 2', projectPath: project, provider: 'qwen-code', status: 'idle' },
    ],
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
    // A stopped run starts nothing more.
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
});

describe('after a crash or a quit', () => {
  it('E6: the worktrees the private state names are removed, never one the log names; a run without a stop ends in error', async () => {
    const p = plan([task({})], [{ n: 1, taskId: 'fix-retry', offsetMs: 0 }]);
    const e = createLoadEngine(deps(p));
    e.start(RUN);
    await c.advance(T0);
    expect(worktrees()).toHaveLength(1);
    // Another worktree, which only a forged log would name.
    const other = path.join(project, '.worktrees', 'keep-me');
    git(project, 'worktree', 'add', '-q', '-b', 'keep-me', other, head);
    // A new Tars, its engine starting over: nothing in memory.
    const after = createLoadEngine(deps(p));
    await after.recover([RUN]);
    expect(worktrees().map(w => fs.realpathSync(w))).toEqual([fs.realpathSync(other)]);
    expect(branches()).toEqual([]);
    expect(f.log.find(x => x.stop)).toMatchObject({ stop: { reason: 'error', detail: 'Tars restarted during the window' } });
  });
});
