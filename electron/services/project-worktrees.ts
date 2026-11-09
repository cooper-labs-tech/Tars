import * as fs from 'fs';
import * as path from 'path';
import { safeGit } from '../utils/safe-git';
import { resolveWorktreePath } from '../utils/worktree-path';
import { gitRefusal } from '../core/chat-slots';

/**
 * A worktree per task, for any project (2.0.7, W6 of the fresh-install report): what scripts/worktree.mjs does for
 * Tars's own repository, as the tools every agent has (worktree_new, worktree_list, worktree_remove, worktree_prune,
 * api-routes/worktree-routes.ts). The worktrees live in the project's `.worktrees/<branch>`, where an agent's own
 * worktree lives (utils/worktree-path.ts), kept out of git by `.git/info/exclude`, never by the project's .gitignore.
 *
 * Every git call goes through safeGit: none of the repository's programs run (hooks, filters, fsmonitor), and no
 * credential helper either, so a fetch from a private https remote fails: the worktree then starts from the local
 * default branch, and the answer says so.
 *
 * Measured against the 46 GB of 59 worktrees nothing removed, on Tars's own repository (CLAUDE.md, Workflow Rule 6):
 * a disk floor, a count per project, a removal that never forces, and a prune of the merged ones before each new one.
 */

/** Free space a new worktree needs on the project's disk, in GB of 1024³ (Tars's unit). */
export const WORKTREE_MIN_FREE_GB = 10;
/** The worktrees one project may hold. */
export const WORKTREE_MAX = 20;
/** A merged worktree whose HEAD moved more recently than this is kept: a fresh one has no commit of its own yet. */
export const PRUNE_IDLE_MS = 60 * 60 * 1000;

const GB = 1024 ** 3;

export interface WorktreeInfo {
  branch: string;
  path: string;
  head: string;
}

export type WorktreeRefusal = { error: string; code: 'invalid_branch' | 'not_a_repository' | 'disk_full' | 'too_many' | 'git_refused' | 'dirty' | 'in_use' | 'not_found' };

export interface NewWorktree {
  path: string;
  branch: string;
  /** What it started from: `origin/<default>` after a fetch, or the local default branch. */
  base: string;
  /** Why it did not start from the remote's, when it did not. */
  note?: string;
  /** The merged worktrees removed first. */
  pruned: string[];
}

const run = (cwd: string, args: string[]) => safeGit(cwd, args, { env: { LC_ALL: 'C' }, timeout: 120_000 });
const out = async (cwd: string, args: string[]) => (await run(cwd, args)).stdout.trim();
const ok = async (cwd: string, args: string[]) => run(cwd, args).then(() => true, () => false);
const refusal = (err: unknown) => gitRefusal(String((err as { stderr?: unknown }).stderr ?? '').trim()) || (err as Error).message;

async function isRepository(projectPath: string): Promise<boolean> {
  if (!fs.existsSync(projectPath)) return false;
  return (await out(projectPath, ['rev-parse', '--is-inside-work-tree']).catch(() => '')) === 'true';
}

async function hasOrigin(projectPath: string): Promise<boolean> {
  return (await out(projectPath, ['remote']).catch(() => '')).split('\n').includes('origin');
}

/** The local default branch: origin's HEAD's name, else main, else master, else the checkout's branch. */
async function localDefault(projectPath: string): Promise<string> {
  const remoteHead = await out(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  for (const name of ['main', 'master']) if (await ok(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
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
  if (await ok(projectPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${local}`])) {
    return { base: `origin/${local}`, ...(failed ? { note: `the fetch from origin failed (${failed}): origin/${local} as last fetched, which may be behind` } : {}) };
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

/** The project's worktrees under its .worktrees, as git lists them. */
export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  if (!(await isRepository(projectPath))) return [];
  // git names a worktree by its real path (/private/var on macOS for /var): compared as such.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const root = path.join(real(projectPath), '.worktrees') + path.sep;
  const list: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  const flush = () => {
    if (current.path && current.branch && real(current.path).startsWith(root)) list.push(current as WorktreeInfo);
    current = {};
  };
  for (const line of (await out(projectPath, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) { flush(); current.path = line.slice('worktree '.length); }
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  flush();
  return list;
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

async function isDirty(worktreePath: string): Promise<boolean> {
  return (await out(worktreePath, ['status', '--porcelain', '--untracked-files=normal'])) !== '';
}

const realOf = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isProtected = (worktreePath: string, protectedPaths: readonly string[]) =>
  protectedPaths.some(p => realOf(p) === realOf(worktreePath));

/** Removes a clean worktree that no agent runs in, never by force; its branch stays. */
export async function removeWorktree(projectPath: string, branch: string, opts: { protectedPaths: readonly string[] }): Promise<{ removed: true; branch: string } | WorktreeRefusal> {
  const found = (await listWorktrees(projectPath)).find(w => w.branch === branch);
  if (!found) return { error: `No worktree of ${branch} in ${path.join(projectPath, '.worktrees')}.`, code: 'not_found' };
  if (isProtected(found.path, opts.protectedPaths)) return { error: `${found.path} is an agent's own worktree: it is removed with the agent, never here.`, code: 'in_use' };
  if (await isDirty(found.path)) {
    return { error: `${found.path} has uncommitted or untracked changes: commit them on ${branch} (or move them), then remove it. Nothing was removed.`, code: 'dirty' };
  }
  try {
    await run(projectPath, ['worktree', 'remove', found.path]);
  } catch (err) {
    return { error: `git would not remove ${found.path}: ${refusal(err)}`, code: 'git_refused' };
  }
  return { removed: true, branch };
}

/**
 * Removes every clean worktree whose branch is merged into the default branch and whose HEAD has not moved for
 * PRUNE_IDLE_MS, but an agent's own; says why it keeps each of the others. A dry run removes nothing.
 */
export async function pruneWorktrees(projectPath: string, opts: { protectedPaths: readonly string[]; dryRun?: boolean; base?: string; now?: number }): Promise<{ removed: string[]; kept: Array<{ branch: string; why: string }> }> {
  const removed: string[] = [];
  const kept: Array<{ branch: string; why: string }> = [];
  if (!(await isRepository(projectPath))) return { removed, kept };
  const base = opts.base ?? (await defaultBase(projectPath)).base;
  const now = opts.now ?? Date.now();
  for (const w of await listWorktrees(projectPath)) {
    if (isProtected(w.path, opts.protectedPaths)) { kept.push({ branch: w.branch, why: 'an agent runs in it' }); continue; }
    if (!(await ok(projectPath, ['merge-base', '--is-ancestor', w.head, base]))) { kept.push({ branch: w.branch, why: `not merged into ${base}` }); continue; }
    if (now - (await lastMoved(w.path)) < PRUNE_IDLE_MS) { kept.push({ branch: w.branch, why: 'its HEAD moved in the last hour (a fresh one has no commit of its own yet)' }); continue; }
    if (await isDirty(w.path)) { kept.push({ branch: w.branch, why: 'uncommitted or untracked changes' }); continue; }
    if (opts.dryRun) { removed.push(w.branch); continue; }
    const r = await removeWorktree(projectPath, w.branch, opts);
    if ('removed' in r) removed.push(w.branch);
    else kept.push({ branch: w.branch, why: r.error });
  }
  return { removed, kept };
}

async function freeBytesOf(projectPath: string): Promise<number> {
  const s = await fs.promises.statfs(projectPath);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * A worktree for one task, in `.worktrees/<branch>`: the merged ones pruned first, then the floor and the count
 * checked, then made from the fresh default branch (or `branch` checked out, when it exists).
 */
export async function newWorktree(
  projectPath: string, branch: string,
  opts: { protectedPaths?: readonly string[]; freeBytes?: (dir: string) => Promise<number> } = {},
): Promise<NewWorktree | WorktreeRefusal> {
  const worktreePath = resolveWorktreePath(projectPath, branch);
  if (!worktreePath || path.isAbsolute(branch)) {
    return { error: `${JSON.stringify(branch)} is not a branch name a worktree can be made for: letters, digits, . _ - and /, no "..".`, code: 'invalid_branch' };
  }
  if (!(await isRepository(projectPath))) {
    return { error: `${projectPath} is not a git repository: a worktree needs one (git init, then a first commit).`, code: 'not_a_repository' };
  }
  const { base, note } = await defaultBase(projectPath);
  const { removed: pruned } = await pruneWorktrees(projectPath, { protectedPaths: opts.protectedPaths ?? [], base });
  const free = await (opts.freeBytes ?? freeBytesOf)(projectPath);
  if (free < WORKTREE_MIN_FREE_GB * GB) {
    return { error: `${Math.floor(free / GB)} GB free on the project's disk, under the ${WORKTREE_MIN_FREE_GB} GB floor: remove merged worktrees (worktree_prune) or free space first.`, code: 'disk_full' };
  }
  const count = (await listWorktrees(projectPath)).length;
  if (count >= WORKTREE_MAX) {
    return { error: `${projectPath} has ${count} worktrees, the most a project keeps (${WORKTREE_MAX}): remove the ones whose work is done (worktree_remove, worktree_prune).`, code: 'too_many' };
  }
  try {
    await excludeWorktrees(projectPath);
    const exists = await ok(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    await run(projectPath, exists ? ['worktree', 'add', worktreePath, branch] : ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base]);
  } catch (err) {
    return { error: `git would not make the worktree: ${refusal(err)}`, code: 'git_refused' };
  }
  return { path: worktreePath, branch, base, ...(note ? { note } : {}), pruned };
}
