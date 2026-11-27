import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  checkWindow, expectedArrivals, parseTasksJsonl, parseWindowJson, planArrivals,
  type LoadHarness, type LoadSplit, type LoadTask, type LoadWindowParams, type RefusedLine,
} from './load-pool';
import type { LoadGrant } from './load-grants';
import { writeSecretFileSync } from '../utils/secret-file';
import {
  createRun, listRuns, newRunId, readSnapshot, updateRun,
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
  grants(): LoadGrant[];
  /** The projects opted into traces (traces.projects). */
  tracedProjects(): string[];
  endpoints(): Array<{ id: string; name: string; baseUrl: string; approvedBaseUrl?: string }>;
  /** The fleet's load agents (`load: true`). */
  loadAgents(): Array<{ id: string; name: string; projectPath: string; provider: string }>;
  /** git in a folder, through safe-git: its output, or a throw. */
  git(cwd: string, args: string[]): Promise<string>;
  /** gh, read-only: its output, or a throw. */
  gh(args: string[]): Promise<string>;
  now(): number;
  /** Tells the window the state changed (load:changed). */
  emit(): void;
  /** The engine's start of an approved run (the scheduler); none in this part. */
  startRun?(run: LoadRunRecord): void;
  /** The engine's stop of a run (its sessions stopped where they are). */
  stopRun?(runId: string): void;
}

export type Visibility = 'public' | 'allowed_by_name' | 'refused';

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
  projects: Array<{ path: string; name: string; repo: string | null; visibility: Visibility; reason?: string; tasks: number }>;
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
  const dismissedFile = path.join(deps.runsDir, 'set-aside.json');
  const dismissed = new Map<string, string>(Object.entries((() => {
    try { return JSON.parse(fs.readFileSync(dismissedFile, 'utf8')) as Record<string, string>; } catch { return {}; }
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

  async function buildProposal(pool: PoolFile): Promise<LoadProposal> {
    const parsed = parseTasksJsonl(pool.bytes.toString('utf8'));
    const win = parseWindowJson(pool.windowText);
    const grants = deps.grants();
    const traced = deps.tracedProjects();
    const taskRefused: RefusedLine[] = [];
    const refuseTask = (t: LoadTask, reason: string) => taskRefused.push({ file: 'tasks.jsonl', line: t.line, reason });
    const byProject = new Map<string, LoadTask[]>();
    for (const t of parsed.tasks) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);

    const projects: LoadProposal['projects'] = [];
    const runnable: LoadTask[] = [];
    for (const [project, tasks] of byProject) {
      const name = path.basename(project);
      const shownRepo = tasks.find(t => t.repo)?.repo ?? null;
      const refuse = (reason: string) => { projects.push({ path: project, name, repo: shownRepo, visibility: 'refused', reason, tasks: tasks.length }); };
      const grant = grants.find(g => g.path === project);
      if (!grant) { refuse('not allowed for load windows: no grant of yours'); continue; }
      if (!traced.includes(project)) { refuse('not opted into traces: its sessions would not be traced'); continue; }
      if (!(await ok(deps.git(project, ['rev-parse', '--is-inside-work-tree'])))) { refuse('not a git work tree'); continue; }
      const remotes = new Set((await deps.git(project, ['remote', '-v']).catch(() => '')).split('\n')
        .map(l => l.split(/\s+/)[1]).filter(Boolean).map(u => githubRepo(u)).filter((r): r is string => !!r));
      let kept = tasks.filter((t) => {
        if (t.repo !== null && !remotes.has(t.repo.toLowerCase())) { refuseTask(t, `repo: ${t.repo} is not a remote of ${name}`); return false; }
        if (t.repo === null && !grant.allowedByName) { refuseTask(t, `repo: none, and ${name} is not allowed by name`); return false; }
        return true;
      });
      if (!grant.allowedByName) {
        let projectRefusal: string | undefined;
        for (const repo of [...new Set(kept.map(t => t.repo as string))]) {
          const seen = await visibilityOf(repo);
          if (seen.error) { projectRefusal = `gh could not tell whether ${repo} is public (${seen.error}), and ${name} is not allowed by name`; break; }
          if (seen.visibility !== 'PUBLIC') { projectRefusal = `its repository ${repo} is private, not allowed by name`; break; }
        }
        if (projectRefusal) {
          // Its tasks already refused alone stay so; the rest go with the project.
          projects.push({ path: project, name, repo: shownRepo, visibility: 'refused', reason: projectRefusal, tasks: tasks.length });
          continue;
        }
      }
      const checked: LoadTask[] = [];
      for (const t of kept) {
        if (!(await ok(deps.git(project, ['cat-file', '-e', `${t.base_commit}^{commit}`])))) {
          refuseTask(t, `base_commit ${t.base_commit.slice(0, 10)} is not in ${name}: nothing is fetched during a window`);
          continue;
        }
        if (t.harnesses && !t.harnesses.some(h => grant.harnesses.includes(h))) {
          refuseTask(t, `harnesses: no load agent of ${name} runs ${t.harnesses.join(' or ')} (it runs ${grant.harnesses.join(', ')})`);
          continue;
        }
        checked.push(t);
      }
      kept = checked;
      projects.push({ path: project, name, repo: shownRepo, visibility: grant.allowedByName ? 'allowed_by_name' : 'public', tasks: kept.length });
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
      const e = deps.endpoints().find(x => x.id === grant.endpointId);
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

  interface Approval { runId: string; pool: string; snapshotSha256: string; window: LoadWindowParams; approvedAt: number }
  function approvals(): Approval[] {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.approvedFile, 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter((a): a is Approval => !!a && typeof a.runId === 'string' && typeof a.snapshotSha256 === 'string') : [];
    } catch {
      return [];
    }
  }

  /** The runs the owner approved, newest first, each as its approval says (an edited record changes none of it). */
  function approvedRuns(): LoadRunRecord[] {
    const byId = new Map(approvals().map(a => [a.runId, a]));
    return listRuns(deps.runsDir).filter(r => byId.has(r.runId)).map((r) => {
      const a = byId.get(r.runId)!;
      return { ...r, pool: a.pool, snapshotSha256: a.snapshotSha256, window: a.window, approvedAt: a.approvedAt, endsAt: a.approvedAt + a.window.window_min * 60_000 };
    });
  }

  /**
   * The run under way: one the owner approved, its snapshot still the bytes approved (else it stops, with an error),
   * its end recorded when its window has run out and nothing of it runs (the engine's sessions keep their caps).
   */
  function current(): LoadRunRecord | undefined {
    const now = deps.now();
    for (const r of approvedRuns()) {
      if (r.stop) continue;
      const snapshot = readSnapshot(deps.runsDir, r.runId);
      if (!snapshot || sha256(snapshot) !== r.snapshotSha256) {
        updateRun(deps.runsDir, r.runId, x => ({ ...x, stop: { reason: 'error', at: now, detail: 'the snapshot was changed or removed after the approval: nothing more of it runs' } }));
        deps.stopRun?.(r.runId);
        continue;
      }
      if (now >= r.endsAt && !r.arrivals.some(a => a.actualAt !== undefined && !a.blocked && a.endedAt === undefined)) {
        updateRun(deps.runsDir, r.runId, x => ({ ...x, stop: x.stop ?? { reason: 'window_end', at: x.endsAt } }));
        continue;
      }
      return r;
    }
    return undefined;
  }

  async function refresh(): Promise<LoadWindowState> {
    const running = current();
    const runs = approvedRuns();
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
      tasks: tasks.map(t => ({ taskId: t.task_id, line: t.line, project: t.project, split: t.split, train_ok: t.train_ok, harnesses: t.harnesses, time_cap_min: t.time_cap_min })),
      refused: proposal.refused,
      refusedProjects: proposal.projects.filter(p => p.visibility === 'refused').map(p => ({ path: p.path, reason: p.reason ?? '', tasks: p.tasks })),
      planned: planArrivals(checked.window, tasks).map(a => ({ ...a, plannedAt: now + a.offsetMs })),
      arrivals: [], agents: [], worktrees: [],
    };
    // The approval first, where no agent is handed it; then the record and the snapshot.
    writeSecretFileSync(deps.approvedFile, `${JSON.stringify([...approvals(), { runId: record.runId, pool: record.pool, snapshotSha256: record.snapshotSha256, window: record.window, approvedAt: now }], null, 2)}\n`);
    createRun(deps.runsDir, record, pool.bytes);
    deps.startRun?.(record);
    deps.emit();
    return { ok: true, runId: record.runId };
  }

  async function notNow(input: { pool?: unknown; sha256?: unknown }): Promise<{ ok: boolean }> {
    if (typeof input.pool !== 'string' || typeof input.sha256 !== 'string') return { ok: false };
    dismissed.set(input.pool, input.sha256);
    try {
      fs.mkdirSync(deps.runsDir, { recursive: true });
      fs.writeFileSync(dismissedFile, JSON.stringify(Object.fromEntries(dismissed)));
    } catch (err) {
      console.error(`[load] the pool set aside is not remembered past this run: ${(err as Error).message}`);
    }
    deps.emit();
    return { ok: true };
  }

  async function stop(runId: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const run = typeof runId === 'string' ? approvedRuns().find(r => r.runId === runId) : undefined;
    if (!run) return { ok: false, error: 'no such window' };
    if (run.stop) return { ok: false, error: 'this window has stopped already' };
    updateRun(deps.runsDir, run.runId, r => ({ ...r, stop: r.stop ?? { reason: 'switch', at: deps.now() } }));
    deps.stopRun?.(run.runId);
    deps.emit();
    return { ok: true };
  }

  return { refresh, approve, notNow, stop };
}

export type LoadWindow = ReturnType<typeof createLoadWindow>;
