import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { safeGit } from '../utils/safe-git';
import { buildFullPath } from '../utils/path-builder';
import { resolveWorktreePath } from '../utils/worktree-path';
import { gitRefusal } from '../core/chat-slots';

/**
 * A worktree per task, for any project (2.0.7, W6 of the fresh-install report): what scripts/worktree.mjs does for
 * Tars's own repository, as the tools every agent has (worktree_new, worktree_list, worktree_remove, worktree_prune,
 * api-routes/worktree-routes.ts). The worktrees live in the project's `.worktrees/<branch>`, where an agent's own
 * worktree lives (utils/worktree-path.ts), kept out of git by `.git/info/exclude`, never by the project's .gitignore.
 *
 * Every git call goes through safeGit: none of the repository's programs run (hooks, filters, fsmonitor), and no
 * credential helper either, so a fetch from a private https remote fails: origin's refs as last fetched are used
 * then, and the answer says so.
 *
 * Measured against the 46 GB of 59 worktrees nothing removed, on Tars's own repository (CLAUDE.md, Workflow Rule 6):
 * a disk floor, a count per project, a removal that never forces, and a prune of the merged ones before each new one.
 *
 * What a branch is checked out as (the Audit's M1 on #585: QA, gating a PR, got the default branch's code under the
 * PR's name): held by another worktree, the worker's, a detached checkout of its head, as pushed when origin has it;
 * a local branch, itself; one only on origin, from origin; else a new one from the default branch. The answer says
 * which (`kind`), and never succeeds on other code.
 */

/** Free space a new worktree needs on the project's disk, in GB of 1024³ (Tars's unit). */
export const WORKTREE_MIN_FREE_GB = 10;
/** The worktrees one project may hold. */
export const WORKTREE_MAX = 20;
/** A merged worktree whose HEAD moved more recently than this is kept. */
export const PRUNE_IDLE_MS = 60 * 60 * 1000;

const GB = 1024 ** 3;

export interface WorktreeInfo {
  /** Its folder under .worktrees, which names it when it has no branch (a detached gate checkout). */
  name: string;
  path: string;
  head: string;
  branch?: string;
  detached?: true;
}

export type WorktreeRefusal = { error: string; code: 'invalid_branch' | 'not_a_repository' | 'disk_full' | 'too_many' | 'git_refused' | 'dirty' | 'in_use' | 'not_found' | 'unknown_branch' };

export interface NewWorktree {
  path: string;
  branch: string;
  /** new: made from `base`; existing: the local branch; from-origin: origin's, which only origin had; detached: the
   *  head of a branch another worktree holds, checked out without the branch. */
  kind: 'new' | 'existing' | 'from-origin' | 'detached';
  /** The commit checked out. */
  head: string;
  /** The default branch it would start from: `origin/<default>` after a fetch, or the local one. */
  base: string;
  /** The worktree that holds the branch, for a detached one. */
  heldBy?: string;
  /** Why it did not start from the remote's, when it did not. */
  note?: string;
  /** The merged worktrees removed first. */
  pruned: string[];
}

/** Whether a branch's pull request is merged, as its host says (a squash or rebase merge is no ancestor of main). */
export type PrMerged = (branch: string) => Promise<boolean>;

const run = (cwd: string, args: string[]) => safeGit(cwd, args, { env: { LC_ALL: 'C' }, timeout: 120_000 });
const out = async (cwd: string, args: string[]) => (await run(cwd, args)).stdout.trim();
const ok = async (cwd: string, args: string[]) => run(cwd, args).then(() => true, () => false);
const refusal = (err: unknown) => gitRefusal(String((err as { stderr?: unknown }).stderr ?? '').trim()) || (err as Error).message;
/** A path as git names it, its links resolved: through its nearest folder that exists, for one that does not yet. */
const real = (p: string): string => {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(real(parent), path.basename(abs));
  }
};

/**
 * gh, when it is there: the branch's pull request merged, read from GitHub; false on any failure. On the full PATH
 * (buildFullPath): a packaged app's own has no /opt/homebrew/bin nor ~/.local/bin (the Audit's L1 on #585).
 */
export function ghPrMerged(projectPath: string): PrMerged {
  return (branch) => new Promise((resolve) => {
    execFile('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'], { cwd: projectPath, timeout: 15_000, windowsHide: true, env: { ...process.env, PATH: buildFullPath() } }, (err, stdout) => {
      if (err) { resolve(false); return; }
      try { resolve((JSON.parse(String(stdout)) as unknown[]).length > 0); } catch { resolve(false); }
    });
  });
}

/** One new worktree at a time per project: the count and the exclude file are read and written as one. */
const locks = new Map<string, Promise<unknown>>();
function oneAtATime<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const key = real(projectPath);
  const before = locks.get(key) ?? Promise.resolve();
  const mine = before.then(fn, fn);
  locks.set(key, mine.catch(() => undefined));
  return mine;
}

async function isRepository(projectPath: string): Promise<boolean> {
  if (!fs.existsSync(projectPath)) return false;
  return (await out(projectPath, ['rev-parse', '--is-inside-work-tree']).catch(() => '')) === 'true';
}

async function hasOrigin(projectPath: string): Promise<boolean> {
  return (await out(projectPath, ['remote']).catch(() => '')).split('\n').includes('origin');
}

const hasRef = (projectPath: string, ref: string) => ok(projectPath, ['rev-parse', '--verify', '--quiet', ref]);

/** The local default branch: origin's HEAD's name, else main, else master, else the checkout's branch. */
export async function localDefault(projectPath: string): Promise<string> {
  const remoteHead = await out(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  for (const name of ['main', 'master']) if (await hasRef(projectPath, `refs/heads/${name}`)) return name;
  return out(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * The default branch to start from and judge merges by: origin's, fetched first; as last fetched when the fetch
 * fails (offline, a private https remote with no credential helper, a remote safeGit does not reach), with why; the
 * local one when origin has none.
 */
async function defaultBase(projectPath: string): Promise<{ base: string; note?: string }> {
  const local = await localDefault(projectPath);
  if (!(await hasOrigin(projectPath))) return { base: local };
  let failed: string | undefined;
  try {
    await run(projectPath, ['fetch', '--quiet', '--prune', 'origin']);
  } catch (err) {
    failed = refusal(err);
  }
  if (await hasRef(projectPath, `refs/remotes/origin/${local}`)) {
    return { base: `origin/${local}`, ...(failed ? { note: `the fetch from origin failed (${failed}): origin's refs as last fetched, which may be behind` } : {}) };
  }
  return { base: local, note: failed ? `the fetch from origin failed (${failed}), and nothing of origin/${local} was ever fetched: the local ${local}` : `origin has no ${local}: the local one` };
}

/** `.worktrees/` in the repository's own exclude file, once: the project's .gitignore is the user's. */
async function excludeWorktrees(projectPath: string): Promise<void> {
  const commonDir = path.resolve(projectPath, await out(projectPath, ['rev-parse', '--git-common-dir']));
  const file = path.join(commonDir, 'info', 'exclude');
  const has = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\/\.worktrees\/$/m.test(has)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${has && !has.endsWith('\n') ? '\n' : ''}# Tars's worktrees, one per task (worktree_new)\n/.worktrees/\n`);
}

/** Every worktree of the repository, as git lists them: its main checkout's included. */
async function allWorktrees(projectPath: string): Promise<Array<{ path: string; head: string; branch?: string }>> {
  const list: Array<{ path: string; head: string; branch?: string }> = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = () => { if (current.path) list.push({ path: current.path, head: current.head ?? '', ...(current.branch ? { branch: current.branch } : {}) }); current = {}; };
  for (const line of (await out(projectPath, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) { flush(); current.path = line.slice('worktree '.length); }
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  flush();
  return list;
}

/** The project's worktrees under its .worktrees (git names them by their real path: /private/var on macOS for /var). */
export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  if (!(await isRepository(projectPath))) return [];
  const root = path.join(real(projectPath), '.worktrees') + path.sep;
  return (await allWorktrees(projectPath))
    .filter(w => real(w.path).startsWith(root))
    .map(w => ({ name: real(w.path).slice(root.length).split(path.sep).join('/'), path: w.path, head: w.head, ...(w.branch ? { branch: w.branch } : { detached: true as const }) }));
}

/** When the worktree's HEAD last moved: its HEAD file's or its reflog's time, whichever is later. */
async function lastMoved(worktreePath: string): Promise<number> {
  const gitDir = path.resolve(worktreePath, await out(worktreePath, ['rev-parse', '--git-dir']));
  let latest = 0;
  for (const f of ['HEAD', path.join('logs', 'HEAD')]) {
    try { latest = Math.max(latest, fs.statSync(path.join(gitDir, f)).mtimeMs); } catch { /* none */ }
  }
  return latest;
}

/** A branch never moved since it was made: one entry in its reflog, its creation (the Audit's L1 on #585). */
async function neverMoved(projectPath: string, branch: string): Promise<boolean> {
  const log = await out(projectPath, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`]).catch(() => '');
  return log.split('\n').filter(Boolean).length <= 1;
}

async function isDirty(worktreePath: string): Promise<boolean> {
  return (await out(worktreePath, ['status', '--porcelain', '--untracked-files=normal'])) !== '';
}

/** An agent works in it: its own worktree, or the folder its terminal was started in, this one or one inside it. */
const isProtected = (worktreePath: string, protectedPaths: readonly string[]) => {
  const wt = real(worktreePath);
  return protectedPaths.some(p => { const r = real(p); return r === wt || r.startsWith(wt + path.sep); });
};

type ProcessCwd = { pid: number; command: string; cwd: string };

/**
 * Every process's working directory, as scripts/worktree.mjs reads it (the Audit's M2 on #585: QA's shell cd'd into
 * its gate checkout is no agent's folder Tars knows): /proc on Linux, lsof on macOS, the lsof Tars runs left out.
 * Null when they cannot be read. Not on Windows, where no process's working folder can be read: occupiedBy asks the
 * folder itself there.
 */
async function processCwds(): Promise<ProcessCwd[] | null> {
  if (process.platform === 'win32') return null;
  const found: ProcessCwd[] = [];
  if (process.platform === 'linux') {
    let pids: string[] = [];
    try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch { return null; }
    for (const pid of pids) {
      try { found.push({ pid: Number(pid), command: fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) }); } catch { /* gone, or not ours */ }
    }
    return found;
  }
  const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(lsof, ['-w', '-a', '-d', 'cwd', '-F', 'pcRn'], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PATH: buildFullPath() } }, (err, out) => {
      resolve(err && !out ? null : String(out ?? ''));
    });
  });
  if (stdout === null) return null;
  let current: (ProcessCwd & { ppid: number }) | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) current = { pid: Number(line.slice(1)), ppid: 0, command: '', cwd: '' };
    else if (current && line.startsWith('R')) current.ppid = Number(line.slice(1));
    else if (current && line.startsWith('c')) current.command = line.slice(1);
    else if (current && line.startsWith('n')) {
      current.cwd = line.slice(1);
      if (!(current.command === 'lsof' && current.ppid === process.pid)) found.push({ pid: current.pid, command: current.command, cwd: current.cwd });
    }
  }
  return found;
}

/** How many times, and how far apart, the Windows probe tries to move a folder back (the Audit's L8 on #585). */
const BACK_TRIES = 10;
const BACK_WAIT_MS = 250;

type Rename = (from: string, to: string) => void;

/**
 * On Windows, whether a process works in the folder: Windows refuses to rename a folder a process works in or holds a
 * file of, so it is renamed and back. Nothing is asked of git's deletion, which removes the files first and fails
 * only on the folder itself, emptying it under the process (the Audit's M3 on #585). An antivirus or an indexer may
 * hold the folder the moment it is moved back: that move is tried BACK_TRIES times, further apart each time, and if
 * it still fails, the folder is said where it is and kept as in use (L8).
 */
async function windowsOccupied(worktreePath: string, rename: Rename, waitMs: number): Promise<string | undefined> {
  const probe = `${worktreePath}.tars-in-use`;
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  try {
    rename(worktreePath, probe);
  } catch (err) {
    return `a process works in it (Windows would not move it: ${code(err)})`;
  }
  let last: unknown;
  for (let tries = 1; tries <= BACK_TRIES; tries++) {
    try {
      rename(probe, worktreePath);
      return undefined;
    } catch (err) {
      last = err;
      await new Promise(resolve => setTimeout(resolve, waitMs * tries));
    }
  }
  return `moved to ${probe} to see whether it was in use, and not moved back after ${BACK_TRIES} tries (${code(last)}): it stays there, kept as in use, until it is moved back by hand`;
}

/**
 * Why a worktree is in use by a process, or undefined; on macOS and Linux, unknown counts as in use. A dry run moves
 * nothing on Windows: whether a process works in the folder is asked by the removal itself (L8).
 */
export async function occupiedBy(
  worktreePath: string, cwds: ProcessCwd[] | null,
  opts: { platform?: NodeJS.Platform; rename?: Rename; waitMs?: number; dryRun?: boolean } = {},
): Promise<string | undefined> {
  if ((opts.platform ?? process.platform) === 'win32') {
    return opts.dryRun ? undefined : windowsOccupied(worktreePath, opts.rename ?? fs.renameSync, opts.waitMs ?? BACK_WAIT_MS);
  }
  if (cwds === null) return 'Tars cannot tell which processes work in it (their working folders could not be read)';
  const wt = real(worktreePath);
  const inIt = cwds.filter(p => { const r = real(p.cwd); return r === wt || r.startsWith(wt + path.sep); });
  return inIt.length ? `a process works in it: ${inIt.slice(0, 3).map(p => `${p.command || 'process'} (${p.pid})`).join(', ')}` : undefined;
}

/** Removes a clean worktree that no agent works in, never by force; its branch stays. By its branch or its name. */
export async function removeWorktree(projectPath: string, branchOrName: string, opts: { protectedPaths: readonly string[]; cwds?: ProcessCwd[] | null }): Promise<{ removed: true; branch: string } | WorktreeRefusal> {
  const found = (await listWorktrees(projectPath)).find(w => w.branch === branchOrName || w.name === branchOrName);
  if (!found) return { error: `No worktree of ${branchOrName} in ${path.join(projectPath, '.worktrees')}.`, code: 'not_found' };
  if (isProtected(found.path, opts.protectedPaths)) return { error: `An agent works in ${found.path}: it is never removed from under it.`, code: 'in_use' };
  const occupied = await occupiedBy(found.path, opts.cwds !== undefined ? opts.cwds : await processCwds());
  if (occupied) return { error: `${found.path} is not removed: ${occupied}.`, code: 'in_use' };
  if (await isDirty(found.path)) {
    return { error: `${found.path} has uncommitted or untracked changes: commit them${found.branch ? ` on ${found.branch}` : ''} (or move them), then remove it. Nothing was removed.`, code: 'dirty' };
  }
  try {
    await run(projectPath, ['worktree', 'remove', found.path]);
  } catch (err) {
    return { error: `git would not remove ${found.path}: ${refusal(err)}`, code: 'git_refused' };
  }
  return { removed: true, branch: found.branch ?? found.name };
}

/**
 * Removes every worktree whose work is done, but one an agent works in, one with changes, and one whose HEAD moved in
 * the last hour: a branch merged into the default branch with commits of its own, or whose pull request its host says
 * is merged (a squash or a rebase), and a detached gate checkout. Says why it keeps each of the others. A dry run
 * removes nothing.
 */
export async function pruneWorktrees(projectPath: string, opts: { protectedPaths: readonly string[]; dryRun?: boolean; base?: string; now?: number; prMerged?: PrMerged; cwds?: ProcessCwd[] | null }): Promise<{ removed: string[]; kept: Array<{ branch: string; why: string }> }> {
  const removed: string[] = [];
  const kept: Array<{ branch: string; why: string }> = [];
  if (!(await isRepository(projectPath))) return { removed, kept };
  const base = opts.base ?? (await defaultBase(projectPath)).base;
  const now = opts.now ?? Date.now();
  const prMerged = opts.prMerged ?? ghPrMerged(projectPath);
  // The processes' working folders, read once, and only when a worktree is otherwise done.
  let cwds: ProcessCwd[] | null | undefined = opts.cwds;
  const scan = async () => (cwds === undefined ? (cwds = await processCwds()) : cwds);
  for (const w of await listWorktrees(projectPath)) {
    const label = w.branch ?? w.name;
    if (isProtected(w.path, opts.protectedPaths)) { kept.push({ branch: label, why: 'an agent works in it' }); continue; }
    if (w.branch) {
      if (await neverMoved(projectPath, w.branch)) { kept.push({ branch: label, why: 'no commit of its own yet' }); continue; }
      const merged = (await ok(projectPath, ['merge-base', '--is-ancestor', w.head, base])) || (await prMerged(w.branch));
      if (!merged) { kept.push({ branch: label, why: `not merged into ${base}, and no merged pull request` }); continue; }
    }
    if (now - (await lastMoved(w.path)) < PRUNE_IDLE_MS) { kept.push({ branch: label, why: 'its HEAD moved in the last hour' }); continue; }
    if (await isDirty(w.path)) { kept.push({ branch: label, why: 'uncommitted or untracked changes' }); continue; }
    const occupied = await occupiedBy(w.path, await scan(), { dryRun: opts.dryRun });
    if (occupied) { kept.push({ branch: label, why: occupied }); continue; }
    if (opts.dryRun) { removed.push(label); continue; }
    const r = await removeWorktree(projectPath, label, { protectedPaths: opts.protectedPaths, cwds: await scan() });
    if ('removed' in r) removed.push(label);
    else kept.push({ branch: label, why: r.error });
  }
  return { removed, kept };
}

async function freeBytesOf(projectPath: string): Promise<number> {
  const s = await fs.promises.statfs(projectPath);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * A worktree for one task, in `.worktrees/<branch>`: the done ones pruned first, then the floor and the count
 * checked, then the branch checked out as it is (see the header), one at a time per project.
 */
export async function newWorktree(
  projectPath: string, branch: string,
  opts: { protectedPaths: readonly string[]; freeBytes?: (dir: string) => Promise<number>; prMerged?: PrMerged; max?: number; existing?: boolean },
): Promise<NewWorktree | WorktreeRefusal> {
  const worktreePath = resolveWorktreePath(projectPath, branch);
  if (!worktreePath || path.isAbsolute(branch)) {
    return { error: `${JSON.stringify(branch)} is not a branch name a worktree can be made for: letters, digits, . _ - and /, no "..".`, code: 'invalid_branch' };
  }
  if (!(await isRepository(projectPath))) {
    return { error: `${projectPath} is not a git repository: a worktree needs one (git init, then a first commit).`, code: 'not_a_repository' };
  }
  return oneAtATime(projectPath, async () => {
    const { base, note } = await defaultBase(projectPath);
    const { removed: pruned } = await pruneWorktrees(projectPath, { protectedPaths: opts.protectedPaths, base, prMerged: opts.prMerged });
    const free = await (opts.freeBytes ?? freeBytesOf)(projectPath);
    if (free < WORKTREE_MIN_FREE_GB * GB) {
      return { error: `${Math.floor(free / GB)} GB free on the project's disk, under the ${WORKTREE_MIN_FREE_GB} GB floor: remove the worktrees whose work is done (worktree_prune) or free space first.`, code: 'disk_full' as const };
    }
    const max = opts.max ?? WORKTREE_MAX;
    const count = (await listWorktrees(projectPath)).length;
    if (count >= max) {
      return { error: `${projectPath} has ${count} worktrees, the most a project keeps (${max}): remove the ones whose work is done (worktree_remove, worktree_prune).`, code: 'too_many' as const };
    }
    try {
      await excludeWorktrees(projectPath);
      const holder = (await allWorktrees(projectPath)).find(w => w.branch === branch);
      const onOrigin = await hasRef(projectPath, `refs/remotes/origin/${branch}`);
      let kind: NewWorktree['kind'];
      let at = worktreePath;
      if (holder) {
        // The worker's worktree holds it: QA gates its head, as pushed when origin has it, without taking the branch.
        const commit = await out(projectPath, ['rev-parse', onOrigin ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`]);
        at = resolveWorktreePath(projectPath, `gate/${branch}-${commit.slice(0, 7)}`)!;
        if (!fs.existsSync(at)) await run(projectPath, ['worktree', 'add', '--detach', at, commit]);
        kind = 'detached';
      } else if (await hasRef(projectPath, `refs/heads/${branch}`)) {
        await run(projectPath, ['worktree', 'add', worktreePath, branch]);
        kind = 'existing';
      } else if (onOrigin) {
        await run(projectPath, ['worktree', 'add', '--track', '-b', branch, worktreePath, `origin/${branch}`]);
        kind = 'from-origin';
      } else if (opts.existing) {
        // A PR's branch, asked as one: never made from the default branch under its name (the Audit's L6 on #585).
        return {
          error: `${branch} is neither a local branch nor on origin${note ? `, and ${note}` : ''}: a new branch under that name would hold the default branch's code, not the pull request's. Nothing was made: fetch it in your terminal (git fetch origin ${branch}), then ask again.`,
          code: 'unknown_branch' as const,
        };
      } else {
        await run(projectPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base]);
        kind = 'new';
      }
      const head = await out(at, ['rev-parse', 'HEAD']);
      return { path: at, branch, kind, head, base, ...(holder ? { heldBy: holder.path } : {}), ...(note ? { note } : {}), pruned };
    } catch (err) {
      return { error: `git would not make the worktree: ${refusal(err)}`, code: 'git_refused' as const };
    }
  });
}
