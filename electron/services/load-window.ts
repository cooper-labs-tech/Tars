import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  checkWindow, expectedArrivals, parseTasksJsonl, parseWindowJson, planArrivals,
  type LoadHarness, type LoadSplit, type LoadTask, type LoadWindowParams, type RefusedLine,
} from './load-pool';
import { approvedEndpoint, type LoadGrant } from './load-grants';
import type { LoadRunPlan } from './load-engine';
import { writeSecretFileSync } from '../utils/secret-file';
import {
  createRun, newRunId, readRun, readSnapshot, updateRun,
  LOAD_BLOCK_REASONS, type LoadArrival, type LoadBlockReason, type LoadRunRecord, type LoadTestResult,
} from './load-run-record';

export type { LoadTestResult };

/**
 * The load window (trace feature C3, 27/11): Tars proposes a window from the newest pool under
 * `~/.tars/load-pools`, the owner approves it with a click in the window, and the run starts from a snapshot of the
 * pool as approved.
 *
 * - **The proposal** reads the pool once, validates every line (load-pool.ts), and checks each project: the owner's
 *   grant (load-grants.ts), opted into traces, a git work tree, its repository public as gh says unless the owner
 *   allowed it by name, and each task's repository among its remotes, its base_commit already in it (nothing is ever
 *   fetched), and a load agent of its project running a harness it accepts. A project that fails is refused whole,
 *   with its reason; a task that fails alone is refused as its line. The load agents are planned: the project's
 *   existing ones first, then one per granted harness, at most max_concurrent a project, named Load N.
 * - **The approval** carries what the card showed: the pool's sha256 and the proposal's id. When the file changed, or
 *   the checks would now give another proposal, it is refused as stale and the card is shown again (the Audit's I-1).
 *   The owner's window values are checked. The bytes approved become the run's snapshot; nothing reads the live file
 *   after it.
 * - **Only the owner's click approves**: approve and grant are reached through the window's IPC alone
 *   (handlers/load-handlers.ts), never an API route, an MCP tool, a token or a message (load-approval-boundary.test.ts).
 * - One window at a time. "Not now" sets a pool aside until its file changes; a pool already run, unchanged, is not
 *   proposed again.
 */

export interface LoadWindowDeps {
  poolsDir: string;
  runsDir: string;
  /**
   * The approvals, in the private folder (`~/.tars-private/load-approved.json`): each approved run's id, pool, snapshot
   * sha256, window and time. A run counts only when it is there: a run record under ~/.tars, which any agent can
   * write, is a record, never an approval.
   */
  approvedFile: string;
  /** The pools the owner set aside ("not now"), in the private folder (`~/.tars-private/load-set-aside.json`). */
  setAsideFile: string;
  /** Tars's projects: the Projects view lists them, and a pool's project must be one. */
  projects(): string[];
  grants(): LoadGrant[];
  /** The projects opted into traces (traces.projects). */
  tracedProjects(): string[];
  endpoints(): Array<{ id: string; name: string; baseUrl: string; approved?: boolean; approvedBaseUrl?: string; models?: string[] }>;
  /** The fleet's load agents (`load: true`). */
  loadAgents(): Array<{ id: string; name: string; projectPath: string; provider: string; endpointId?: string; model?: string }>;
  /** git in a folder, through safe-git: its output, or a throw. */
  git(cwd: string, args: string[]): Promise<string>;
  /** gh, read-only: its output, or a throw. */
  gh(args: string[]): Promise<string>;
  now(): number;
  /** Tells the window the state changed (load:changed). */
  emit(): void;
  /** The engine's start of an approved run (the scheduler); none in this part. */
  startRun?(run: LoadRunRecord, agents: LoadProposal['agents']): void;
  /** The engine's stop of a run (its sessions stopped where they are). */
  stopRun?(runId: string): void;
}

export type Visibility = 'public' | 'allowed_by_name' | 'refused';

/**
 * Where a project stands for load windows, decided once (checkProject) for the Projects view, the switch and the
 * proposal, in this order: one of Tars's projects, traced, a git work tree, an endpoint and a model chosen, a harness
 * chosen, a public repository or allowed by name, the switch on.
 */
export const LOAD_PROJECT_STATES = [
  'allowed', 'allowed_by_name', 'off', 'private', 'unknown', 'no_harness', 'no_endpoint', 'no_repo', 'traces_off', 'unknown_project',
] as const;
export type LoadProjectState = typeof LOAD_PROJECT_STATES[number];

/** A project's repository as gh says: never asked for a project allowed by name, with traces off or no work tree. */
export type RepoVisibility = 'public' | 'private' | 'unknown' | 'none' | 'not_asked';

/** A project as the Projects view of #672's frames shows it. */
export interface LoadProjectView {
  path: string;
  name: string;
  /** Its GitHub repository, `owner/name`, from its remotes (origin first); null when none is on GitHub. */
  repo: string | null;
  visibility: RepoVisibility;
  traced: boolean;
  /** Its settings as kept, the switch included; null when never set. */
  grant: LoadGrant | null;
  /** Whether a load window may run its tasks now. */
  allowed: boolean;
  state: LoadProjectState;
  /** The line under the project, as the frames word it. */
  reason: string;
  agents: Array<{ id: string; name: string; harness: string; endpointName?: string; model?: string; inWindow: boolean }>;
}

export interface LoadProjectsView {
  projects: LoadProjectView[];
  /** The endpoints a grant may name: approved, at their approved address, with their models. */
  endpoints: Array<{ id: string; name: string; models: string[] }>;
}

export interface LoadProposal {
  /** What the card shows, digested: approve carries it back, and another one is stale. */
  id: string;
  pool: string;
  dir: string;
  writtenAt: number;
  sha256: string;
  /** Lines with a task in the file, valid or not. */
  total: number;
  runnable: number;
  counts: { train: number; heldout: number; eval: number; tasks: number };
  /** Each project of the pool, decided as the Projects view decides it (`state`, and `reason` when refused). */
  projects: Array<{ path: string; name: string; repo: string | null; visibility: Visibility; state: LoadProjectState; reason?: string; tasks: number }>;
  /** The tasks that will run, in file order, with every setup line and test command as they will run. */
  tasks: Array<{ n: number; line: number; taskId: string; project: string; split: LoadSplit; capMin: number; setup: string[]; testCmd: string | null; harnesses: LoadHarness[] | null }>;
  refused: RefusedLine[];
  endpoints: Array<{ id: string; name: string; baseUrl: string }>;
  harnesses: LoadHarness[];
  agents: Array<{ name: string; project: string; harness: LoadHarness; existing: boolean; agentId?: string }>;
  window: LoadWindowParams;
  plannedArrivals: number;
  expectedArrivals: number;
}

export interface LoadRunView {
  runId: string;
  pool: string;
  snapshotSha256: string;
  approvedAt: number;
  endsAt: number;
  window: LoadWindowParams;
  tasks: number;
  planned: number;
  started: number;
  runningNow: number;
  finishedCount: number;
  blocked: Record<LoadBlockReason, number>;
  blockedArrivals: Array<{ n: number; at: number; taskId: string; project: string; reason: LoadBlockReason; detail?: string }>;
  agents: Array<{ agentId: string; name: string; project: string; harness: LoadHarness; taskId?: string; split?: LoadSplit; capMin?: number; startedAt?: number }>;
  finished: Array<{ n: number; taskId: string; project: string; split: LoadSplit; end?: LoadArrival['end']; startedAt?: number; endedAt?: number; test?: LoadTestResult }>;
  stop?: LoadRunRecord['stop'];
}

/** What the card shows: the window running, else the proposal; and the last window that ended. */
export interface LoadWindowState { running?: LoadRunView; proposal?: LoadProposal; last?: LoadRunView }

export type ApproveAnswer =
  | { ok: true; runId: string }
  | { ok: false; reason: 'stale'; state: LoadWindowState }
  | { ok: false; error: string };

const POOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GH_TTL_MS = 10 * 60_000;
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface PoolFile { name: string; dir: string; bytes: Buffer; sha256: string; writtenAt: number; windowText?: string }

/** The GitHub repository of a git remote URL, as `owner/name` (github-watch.ts githubRepoOf), lower-cased. */
function githubRepo(url: string): string | undefined {
  const m = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** A regular file, never a link: a pool is read from where it is, or not at all. */
function regularFile(p: string): fs.Stats | undefined {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
}

export function createLoadWindow(deps: LoadWindowDeps) {
  const ghSeen = new Map<string, { at: number; visibility?: string; error?: string }>();
  // The pools set aside ("not now"), in the private folder: an agent can neither hide a proposal nor show one again.
  const dismissed = new Map<string, string>(Object.entries((() => {
    try { return JSON.parse(fs.readFileSync(deps.setAsideFile, 'utf8')) as Record<string, string>; } catch { return {}; }
  })()));

  /** The pools, newest written first: real folders, each with a tasks.jsonl that is a regular file. */
  function pools(): Array<{ name: string; writtenAt: number }> {
    let names: string[];
    try { names = fs.readdirSync(deps.poolsDir); } catch { return []; }
    const out: Array<{ name: string; writtenAt: number }> = [];
    for (const name of names) {
      if (!POOL_NAME.test(name)) continue;
      try { if (!fs.lstatSync(path.join(deps.poolsDir, name)).isDirectory()) continue; } catch { continue; }
      const st = regularFile(path.join(deps.poolsDir, name, 'tasks.jsonl'));
      if (st) out.push({ name, writtenAt: st.mtimeMs });
    }
    return out.sort((a, b) => b.writtenAt - a.writtenAt);
  }

  function readPool(name: string): PoolFile | undefined {
    if (!POOL_NAME.test(name)) return undefined;
    const dir = path.join(deps.poolsDir, name);
    try { if (!fs.lstatSync(dir).isDirectory()) return undefined; } catch { return undefined; }
    const st = regularFile(path.join(dir, 'tasks.jsonl'));
    if (!st) return undefined;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(dir, 'tasks.jsonl')); } catch { return undefined; }
    const windowText = regularFile(path.join(dir, 'window.json')) ? (() => { try { return fs.readFileSync(path.join(dir, 'window.json'), 'utf8'); } catch { return undefined; } })() : undefined;
    return { name, dir, bytes, sha256: sha256(bytes), writtenAt: st.mtimeMs, windowText };
  }

  async function visibilityOf(repo: string): Promise<{ visibility?: string; error?: string }> {
    const held = ghSeen.get(repo);
    if (held && deps.now() - held.at < GH_TTL_MS) return held;
    let seen: { at: number; visibility?: string; error?: string };
    try {
      const out = JSON.parse(await deps.gh(['repo', 'view', repo, '--json', 'visibility'])) as { visibility?: unknown };
      seen = { at: deps.now(), visibility: String(out.visibility ?? '').toUpperCase() };
    } catch (err) {
      seen = { at: deps.now(), error: (err as Error).message.split('\n')[0].slice(0, 200) };
    }
    ghSeen.set(repo, seen);
    return seen;
  }

  const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

  /** The load agents a window runs now: those of the run under way's arrivals that have not ended. */
  function agentsInWindow(): Set<string> {
    const run = current();
    return new Set((run?.arrivals ?? []).filter(a => a.actualAt !== undefined && !a.blocked && a.endedAt === undefined && a.agentId).map(a => a.agentId!));
  }

  interface ProjectCheck extends LoadProjectView { remotes: Set<string> }

  /**
   * Where a project stands for load windows: the one decision the Projects view, the switch (settle) and the proposal
   * all take, so they never disagree. `grant` is the project's as kept unless one is given (a change to try).
   */
  async function checkProject(project: string, given?: LoadGrant | null, busy: Set<string> = agentsInWindow()): Promise<ProjectCheck> {
    const name = path.basename(project);
    const grant = given !== undefined ? given : (deps.grants().find(g => g.path === project) ?? null);
    const traced = deps.tracedProjects().includes(project);
    const endpoints = deps.endpoints();
    const agents = deps.loadAgents().filter(a => a.projectPath === project).map(a => ({
      id: a.id, name: a.name, harness: a.provider,
      ...(a.endpointId ? { endpointName: endpoints.find(e => e.id === a.endpointId)?.name ?? a.endpointId } : {}),
      ...(a.model ? { model: a.model } : {}), inWindow: busy.has(a.id),
    }));
    let repo: string | null = null;
    let visibility: RepoVisibility = 'not_asked';
    let remotes = new Set<string>();
    const decide = (state: LoadProjectState, reason: string): ProjectCheck => ({
      path: project, name, repo, visibility, traced, grant, allowed: state === 'allowed' || state === 'allowed_by_name', state, reason, agents, remotes,
    });
    if (!deps.projects().includes(project)) return decide('unknown_project', 'Refused: it is not one of your projects in Tars.');
    if (!traced) return decide('traces_off', `Refused: traces are off for ${name}, and a load window runs only projects that are traced. Opt it in first.`);
    if (!(await ok(deps.git(project, ['rev-parse', '--is-inside-work-tree'])))) {
      return decide('no_repo', `Refused: ${name} is not a git work tree, and a load window starts every task at a commit of its repository.`);
    }
    const listed = (await deps.git(project, ['remote', '-v']).catch(() => '')).split('\n')
      .map(l => l.split(/\s+/)).filter(p => p[1]).map(p => ({ remote: p[0], repo: githubRepo(p[1]) })).filter((r): r is { remote: string; repo: string } => !!r.repo);
    remotes = new Set(listed.map(r => r.repo));
    repo = (listed.find(r => r.remote === 'origin') ?? listed[0])?.repo ?? null;
    let ghError: string | undefined;
    // A project allowed by name is never asked of gh.
    if (!grant?.allowedByName) {
      if (!repo) visibility = 'none';
      else {
        const seen = await visibilityOf(repo);
        if (seen.error) { visibility = 'unknown'; ghError = seen.error; } else visibility = seen.visibility === 'PUBLIC' ? 'public' : 'private';
      }
    }
    const endpoint = approvedEndpoint(endpoints, grant?.endpointId);
    if (!grant || !endpoint || !grant.model || (endpoint.models?.length && !endpoint.models.includes(grant.model))) {
      return decide('no_endpoint', 'No endpoint yet: choose the endpoint and the model its load agents use, then allow it.');
    }
    if (!grant.harnesses.length) return decide('no_harness', 'No harness yet: choose the harnesses its load agents run, then allow it.');
    if (!grant.allowedByName) {
      const byName = 'Allow it by name to let a load window run its tasks.';
      if (visibility === 'private') return decide('private', `Not allowed: its repository is private. ${byName}`);
      if (visibility === 'none') return decide('unknown', `Not allowed: ${name} has no repository on GitHub, so Tars cannot tell whether it is public. ${byName}`);
      if (visibility === 'unknown') return decide('unknown', `Not allowed: gh could not tell whether ${repo} is public (${ghError}). ${byName}`);
    }
    const runsOn = `Its load agents run on ${endpoint.name}, ${grant.model}.`;
    if (!grant.enabled) return decide('off', `Off: turn load windows on to let a window run its tasks. ${runsOn}`);
    return grant.allowedByName
      ? decide('allowed_by_name', `Allowed by name: you allowed it here. ${runsOn}`)
      : decide('allowed', `Allowed by you; its repository is public. ${runsOn}`);
  }

  /** The Projects view: every project of Tars's as checkProject decides it, and the endpoints a grant may name. */
  async function projects(): Promise<LoadProjectsView> {
    const busy = agentsInWindow();
    const checked = await Promise.all([...new Set(deps.projects())].map(p => checkProject(p, undefined, busy)));
    return {
      projects: checked.map(({ remotes: _remotes, ...view }) => view),
      endpoints: deps.endpoints().filter(e => approvedEndpoint([e], e.id)).map(e => ({ id: e.id, name: e.name, models: e.models ?? [] })),
    };
  }

  /** A grant as it can be kept: its settings as asked, its switch on only when the project can then run. */
  async function settle(grant: LoadGrant): Promise<LoadGrant> {
    const can = await checkProject(grant.path, { ...grant, enabled: true });
    return { ...grant, enabled: grant.enabled && can.allowed };
  }

  /** One project of the Projects view. */
  async function project(projectPath: string): Promise<LoadProjectView> {
    const { remotes: _remotes, ...view } = await checkProject(projectPath);
    return view;
  }

  async function buildProposal(pool: PoolFile): Promise<LoadProposal> {
    const parsed = parseTasksJsonl(pool.bytes.toString('utf8'));
    const win = parseWindowJson(pool.windowText);
    const grants = deps.grants();
    const taskRefused: RefusedLine[] = [];
    const refuseTask = (t: LoadTask, reason: string) => taskRefused.push({ file: 'tasks.jsonl', line: t.line, reason });
    const byProject = new Map<string, LoadTask[]>();
    for (const t of parsed.tasks) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);

    const projects: LoadProposal['projects'] = [];
    const runnable: LoadTask[] = [];
    const busy = agentsInWindow();
    for (const [project, tasks] of byProject) {
      // The project as the Projects view decides it: refused whole, with its state and reason, or run.
      const check = await checkProject(project, undefined, busy);
      const { name } = check;
      if (!check.allowed || !check.grant) {
        projects.push({ path: project, name, repo: check.repo ?? tasks.find(t => t.repo)?.repo ?? null, visibility: 'refused', state: check.state, reason: check.reason, tasks: tasks.length });
        continue;
      }
      const grant = check.grant;
      const kept: LoadTask[] = [];
      for (const t of tasks) {
        if (t.repo !== null && !check.remotes.has(t.repo.toLowerCase())) { refuseTask(t, `repo: ${t.repo} is not a remote of ${name}`); continue; }
        if (t.repo === null && !grant.allowedByName) { refuseTask(t, `repo: none, and ${name} is not allowed by name`); continue; }
        // Another of its remotes, not allowed by name: public too, or the task is left out.
        if (t.repo !== null && !grant.allowedByName && t.repo.toLowerCase() !== check.repo) {
          const seen = await visibilityOf(t.repo.toLowerCase());
          if (seen.error || seen.visibility !== 'PUBLIC') { refuseTask(t, `repo: ${t.repo} is ${seen.error ? `of a visibility gh could not tell (${seen.error})` : 'private'}, and ${name} is not allowed by name`); continue; }
        }
        if (!(await ok(deps.git(project, ['cat-file', '-e', `${t.base_commit}^{commit}`])))) {
          refuseTask(t, `base_commit ${t.base_commit.slice(0, 10)} is not in ${name}: nothing is fetched during a window`);
          continue;
        }
        if (t.harnesses && !t.harnesses.some(h => grant.harnesses.includes(h))) {
          refuseTask(t, `harnesses: no load agent of ${name} runs ${t.harnesses.join(' or ')} (it runs ${grant.harnesses.join(', ')})`);
          continue;
        }
        kept.push(t);
      }
      projects.push({ path: project, name, repo: check.repo, visibility: check.state === 'allowed_by_name' ? 'allowed_by_name' : 'public', state: check.state, tasks: kept.length });
      runnable.push(...kept);
    }
    runnable.sort((a, b) => a.line - b.line);

    // The load agents: the project's own first, then one per granted harness, at most max_concurrent a project.
    const existing = deps.loadAgents();
    const used = new Set(existing.map(a => /^Load (\d+)$/.exec(a.name)?.[1]).filter(Boolean).map(Number));
    const nextName = () => { let n = 1; while (used.has(n)) n++; used.add(n); return `Load ${n}`; };
    const agents: LoadProposal['agents'] = [];
    const endpoints = new Map<string, { id: string; name: string; baseUrl: string }>();
    for (const project of [...new Set(runnable.map(t => t.project))]) {
      const grant = grants.find(g => g.path === project)!;
      const mine = existing.filter(a => a.projectPath === project && grant.harnesses.includes(a.provider as LoadHarness));
      const planned: LoadProposal['agents'] = mine.map(a => ({ name: a.name, project, harness: a.provider as LoadHarness, existing: true, agentId: a.id }));
      for (const h of grant.harnesses) if (!planned.some(a => a.harness === h)) planned.push({ name: '', project, harness: h, existing: false });
      for (const a of planned.slice(0, win.window.max_concurrent)) agents.push(a.existing ? a : { ...a, name: nextName() });
      const e = approvedEndpoint(deps.endpoints(), grant.endpointId);
      if (e) endpoints.set(e.id, { id: e.id, name: e.name, baseUrl: e.approvedBaseUrl ?? e.baseUrl });
    }

    const refused = [...parsed.refused, ...taskRefused, ...win.refused].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file === 'tasks.jsonl' ? -1 : 1));
    const counts = { train: 0, heldout: 0, eval: 0, tasks: runnable.length };
    for (const t of runnable) counts[t.split]++;
    const view = {
      pool: pool.name, dir: pool.dir, writtenAt: pool.writtenAt, sha256: pool.sha256,
      total: parsed.tasks.length + parsed.refused.filter(r => r.line > 0).length, runnable: runnable.length, counts, projects,
      tasks: runnable.map((t, i) => ({ n: i + 1, line: t.line, taskId: t.task_id, project: t.project, split: t.split, capMin: t.time_cap_min, setup: t.setup, testCmd: t.test_cmd, harnesses: t.harnesses })),
      refused, endpoints: [...endpoints.values()], harnesses: [...new Set(agents.map(a => a.harness))], agents, window: win.window,
      plannedArrivals: planArrivals(win.window, runnable).length, expectedArrivals: expectedArrivals(win.window),
    };
    return { id: sha256(JSON.stringify(view)), ...view };
  }

  /** The tasks a proposal lets run, from the pool's bytes: what the run takes. */
  function runnableOf(pool: PoolFile, p: LoadProposal): LoadTask[] {
    const lines = new Set(p.tasks.map(t => t.line));
    return parseTasksJsonl(pool.bytes.toString('utf8')).tasks.filter(t => lines.has(t.line));
  }

  function runView(r: LoadRunRecord): LoadRunView {
    const task = new Map(r.tasks.map(t => [t.taskId, t]));
    const blocked = Object.fromEntries(LOAD_BLOCK_REASONS.map(k => [k, 0])) as Record<LoadBlockReason, number>;
    for (const a of r.arrivals) if (a.blocked) blocked[a.blocked]++;
    const started = r.arrivals.filter(a => a.actualAt !== undefined && !a.blocked);
    const open = started.filter(a => a.endedAt === undefined);
    return {
      runId: r.runId, pool: r.pool, snapshotSha256: r.snapshotSha256, approvedAt: r.approvedAt, endsAt: r.endsAt, window: r.window,
      tasks: r.tasks.length, planned: r.planned.length, started: started.length, runningNow: open.length, finishedCount: started.length - open.length,
      blocked,
      blockedArrivals: r.arrivals.filter(a => a.blocked).map(a => ({ n: a.n, at: a.actualAt ?? a.plannedAt, taskId: a.taskId, project: task.get(a.taskId)?.project ?? '', reason: a.blocked!, ...(a.blockedDetail ? { detail: a.blockedDetail } : {}) })),
      agents: r.agents.map((g) => {
        const at = open.find(a => a.agentId === g.agentId);
        const t = at ? task.get(at.taskId) : undefined;
        return { agentId: g.agentId, name: g.name, project: g.project, harness: g.harness, ...(at && t ? { taskId: t.taskId, split: t.split, capMin: t.time_cap_min, startedAt: at.actualAt } : {}) };
      }),
      finished: started.filter(a => a.endedAt !== undefined).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).map(a => ({
        n: a.n, taskId: a.taskId, project: task.get(a.taskId)?.project ?? '', split: task.get(a.taskId)?.split ?? 'train',
        end: a.end, startedAt: a.actualAt, endedAt: a.endedAt, ...(a.test ? { test: a.test } : {}),
      })),
      ...(r.stop ? { stop: r.stop } : {}),
    };
  }

  /**
   * An approval, as kept in the private folder: everything a decision about its run reads (the Audit's M1 at
   * fdd82ca3d). The run's record under ~/.tars/load-runs is a log of it, which any agent can write: read for what the
   * window shows of the run as it goes (its arrivals, its agents), never for whether it runs, what it runs or when.
   */
  interface Approval {
    runId: string; pool: string; snapshotSha256: string; window: LoadWindowParams; approvedAt: number;
    /** The snapshot's lines of the tasks approved: with the window, they give the run's tasks and planned arrivals. */
    lines: number[];
    /** The owner's stop, or the window's end or an error, as Tars recorded it. */
    stop?: LoadRunRecord['stop'];
  }
  function approvals(): Approval[] {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.approvedFile, 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter((a): a is Approval => !!a && typeof a.runId === 'string' && typeof a.snapshotSha256 === 'string' && Array.isArray(a.lines)) : [];
    } catch {
      return [];
    }
  }

  /** A run's stop, kept with its approval (where it is read) and copied into its record (its log). */
  function setStop(runId: string, stop: NonNullable<LoadRunRecord['stop']>): void {
    const all = approvals();
    const a = all.find(x => x.runId === runId);
    if (!a || a.stop) return;
    a.stop = stop;
    writeSecretFileSync(deps.approvedFile, `${JSON.stringify(all, null, 2)}\n`);
    try { updateRun(deps.runsDir, runId, r => ({ ...r, stop })); } catch { /* the log may be gone: the stop holds */ }
  }

  const taskRow = (t: LoadTask): LoadRunRecord['tasks'][number] =>
    ({ taskId: t.task_id, line: t.line, project: t.project, split: t.split, train_ok: t.train_ok, harnesses: t.harnesses, time_cap_min: t.time_cap_min });

  /** A run's tasks and planned arrivals, from its verified snapshot, its approved lines and its approved window. */
  const derivedCache = new Map<string, Pick<LoadRunRecord, 'tasks' | 'planned'>>();
  function derivedOf(a: Approval, snapshot: Buffer): Pick<LoadRunRecord, 'tasks' | 'planned'> {
    const held = derivedCache.get(a.runId);
    if (held) return held;
    const lines = new Set(a.lines);
    const tasks = parseTasksJsonl(snapshot.toString('utf8')).tasks.filter(t => lines.has(t.line));
    const derived = { tasks: tasks.map(taskRow), planned: planArrivals(a.window, tasks).map(p => ({ ...p, plannedAt: a.approvedAt + p.offsetMs })) };
    derivedCache.set(a.runId, derived);
    return derived;
  }

  interface ApprovedRun { run: LoadRunRecord; intact: boolean; log?: LoadRunRecord }

  /**
   * The runs the owner approved, newest first, each as its approval and its snapshot say. Its record adds only what
   * the window shows of it as it goes; `intact` is false when its snapshot is no longer the bytes approved.
   */
  function approvedRuns(): ApprovedRun[] {
    // Newest first; at the same moment, the one approved later in the file.
    return approvals().map((a, i) => ({ a, i })).sort((x, y) => y.a.approvedAt - x.a.approvedAt || y.i - x.i).map(({ a }) => {
      let log: LoadRunRecord | undefined;
      try { log = readRun(deps.runsDir, a.runId); } catch { log = undefined; }
      const snapshot = readSnapshot(deps.runsDir, a.runId);
      const intact = !!snapshot && sha256(snapshot) === a.snapshotSha256;
      const derived = intact ? derivedOf(a, snapshot!) : { tasks: [], planned: [] };
      const run: LoadRunRecord = {
        version: 1, runId: a.runId, pool: a.pool, poolDir: log?.poolDir ?? '', writtenAt: log?.writtenAt ?? a.approvedAt, snapshotSha256: a.snapshotSha256,
        approvedAt: a.approvedAt, approvedBy: 'owner', window: a.window, endsAt: a.approvedAt + a.window.window_min * 60_000,
        ...derived, refused: log?.refused ?? [], refusedProjects: log?.refusedProjects ?? [],
        arrivals: log?.arrivals ?? [], agents: log?.agents ?? [], worktrees: log?.worktrees ?? [],
        ...(a.stop ? { stop: a.stop } : {}),
      };
      return { run, intact, log };
    });
  }

  /**
   * The run under way: one the owner approved and did not stop, its snapshot still the bytes approved, its record
   * still giving the tasks and planned arrivals they make (else it stops, with an error), until its window's end.
   */
  function current(): LoadRunRecord | undefined {
    const now = deps.now();
    for (const { run, intact, log } of approvedRuns()) {
      if (run.stop) continue;
      // The why of "Stopped at <time>: <why>", as the frames word a stop.
      const error = !intact ? 'its snapshot was changed or removed after your approval'
        : !log || JSON.stringify(log.tasks) !== JSON.stringify(run.tasks) || JSON.stringify(log.planned) !== JSON.stringify(run.planned)
          ? 'its run record was changed after your approval'
          : undefined;
      if (error) {
        setStop(run.runId, { reason: 'error', at: now, detail: error });
        deps.stopRun?.(run.runId);
        continue;
      }
      if (now >= run.endsAt) {
        setStop(run.runId, { reason: 'window_end', at: run.endsAt });
        continue;
      }
      return run;
    }
    return undefined;
  }

  async function refresh(): Promise<LoadWindowState> {
    const running = current();
    const runs = approvedRuns().map(x => x.run);
    const lastEnded = runs.find(r => r.stop);
    const last = lastEnded ? runView(lastEnded) : undefined;
    if (running) return { running: runView(running), ...(last ? { last } : {}) };
    for (const { name } of pools()) {
      const pool = readPool(name);
      if (!pool) continue;
      if (dismissed.get(name) === pool.sha256) continue;
      if (runs.some(r => r.pool === name && r.snapshotSha256 === pool.sha256)) continue;
      return { proposal: await buildProposal(pool), ...(last ? { last } : {}) };
    }
    return last ? { last } : {};
  }

  async function approve(input: { pool?: unknown; sha256?: unknown; proposalId?: unknown; window?: unknown }): Promise<ApproveAnswer> {
    if (current()) return { ok: false, error: 'a window runs: stop it before approving another' };
    const pool = typeof input.pool === 'string' ? readPool(input.pool) : undefined;
    // The card's hash, else the card again: a file changed since it was shown is never approved unseen.
    if (!pool || typeof input.sha256 !== 'string' || pool.sha256 !== input.sha256) return { ok: false, reason: 'stale', state: await refresh() };
    const proposal = await buildProposal(pool);
    if (proposal.id !== input.proposalId) return { ok: false, reason: 'stale', state: await refresh() };
    const asked = input.window && typeof input.window === 'object' ? input.window as Record<string, unknown> : {};
    const checked = checkWindow({ ...proposal.window, ...asked });
    if (checked.refused.length) return { ok: false, error: checked.refused.map(r => r.reason).join('; ') };
    if (proposal.runnable === 0) return { ok: false, error: 'no task of this pool can run' };
    const now = deps.now();
    const tasks = runnableOf(pool, proposal);
    const record: LoadRunRecord = {
      version: 1, runId: newRunId(now), pool: pool.name, poolDir: pool.dir, writtenAt: pool.writtenAt, snapshotSha256: pool.sha256,
      approvedAt: now, approvedBy: 'owner', window: checked.window, endsAt: now + checked.window.window_min * 60_000,
      tasks: tasks.map(taskRow),
      refused: proposal.refused,
      refusedProjects: proposal.projects.filter(p => p.visibility === 'refused').map(p => ({ path: p.path, reason: p.reason ?? '', tasks: p.tasks })),
      planned: planArrivals(checked.window, tasks).map(a => ({ ...a, plannedAt: now + a.offsetMs })),
      arrivals: [], agents: [], worktrees: [],
    };
    // The approval first, where no agent is handed it, with all a decision about the run reads; then the record (its
    // log) and the snapshot.
    const approval: Approval = { runId: record.runId, pool: record.pool, snapshotSha256: record.snapshotSha256, window: record.window, approvedAt: now, lines: tasks.map(t => t.line) };
    writeSecretFileSync(deps.approvedFile, `${JSON.stringify([...approvals(), approval], null, 2)}\n`);
    createRun(deps.runsDir, record, pool.bytes);
    // The engine (load-engine.ts): the load agents the proposal planned made where missing, then the arrivals armed.
    deps.startRun?.(record, proposal.agents);
    deps.emit();
    return { ok: true, runId: record.runId };
  }

  async function notNow(input: { pool?: unknown; sha256?: unknown }): Promise<{ ok: boolean }> {
    if (typeof input.pool !== 'string' || typeof input.sha256 !== 'string') return { ok: false };
    dismissed.set(input.pool, input.sha256);
    try {
      writeSecretFileSync(deps.setAsideFile, `${JSON.stringify(Object.fromEntries(dismissed))}\n`);
    } catch (err) {
      console.error(`[load] the pool set aside is not remembered past this run: ${(err as Error).message}`);
    }
    deps.emit();
    return { ok: true };
  }

  async function stop(runId: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const a = typeof runId === 'string' ? approvals().find(x => x.runId === runId) : undefined;
    if (!a) return { ok: false, error: 'no such window' };
    if (a.stop) return { ok: false, error: 'this window has stopped already' };
    setStop(a.runId, { reason: 'switch', at: deps.now() });
    deps.stopRun?.(a.runId);
    deps.emit();
    return { ok: true };
  }

  /**
   * What the engine runs (load-engine.ts): the run's window, its approved tasks whole and its planned arrivals, from
   * the private approval and the verified snapshot alone; none for a run not approved or whose snapshot changed.
   */
  function runPlan(runId: string): LoadRunPlan | undefined {
    const a = approvals().find(x => x.runId === runId);
    const snapshot = a ? readSnapshot(deps.runsDir, a.runId) : undefined;
    if (!a || !snapshot || sha256(snapshot) !== a.snapshotSha256) return undefined;
    const lines = new Set(a.lines);
    return {
      runId: a.runId, endsAt: a.approvedAt + a.window.window_min * 60_000, window: { max_concurrent: a.window.max_concurrent },
      tasks: parseTasksJsonl(snapshot.toString('utf8')).tasks.filter(t => lines.has(t.line)),
      planned: derivedOf(a, snapshot).planned.map(p => ({ n: p.n, taskId: p.taskId, plannedAt: p.plannedAt })),
    };
  }

  /** Whether the run is the one under way. */
  const isRunning = (runId: string): boolean => current()?.runId === runId;

  /** The engine ends a run (an error it met), its stop kept with the approval. */
  function endRun(runId: string, stopped: NonNullable<LoadRunRecord['stop']>): void {
    setStop(runId, stopped);
    deps.emit();
  }

  /** The runs approved and not stopped: at a start, those a quit or a crash cut. */
  const unstoppedRunIds = (): string[] => approvals().filter(a => !a.stop).map(a => a.runId);

  return { refresh, approve, notNow, stop, projects, project, settle, runPlan, isRunning, endRun, unstoppedRunIds };
}

export type LoadWindow = ReturnType<typeof createLoadWindow>;
