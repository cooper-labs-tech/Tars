import * as fs from 'fs';
import * as path from 'path';
import { safeGit } from '../utils/safe-git';
import { resolveWorktreePath } from '../utils/worktree-path';
import { newWorktree, turnPushOff } from './project-worktrees';

/**
 * An agent's own worktree, made ready in one call (create_agent with worktree, 2.0.7), taken back when the creation
 * does not finish, and read before a removal over the API.
 *
 * Never another holder's checkout, never by force (the Audit's M3 on #595; #585's rules): a branch another worktree
 * holds, a gate checkout of it included, is refused before anything is made, naming that worktree; and what is taken
 * back is only what this call made, removed as git removes a clean worktree, so a worktree that holds anything the
 * call did not put there, or that an agent or a terminal works in, stays where it is.
 */

export interface ReadyWorktree {
  /** The worktree's path as the record keeps it: the project's .worktrees/<branch> (utils/worktree-path.ts). */
  path: string;
  /** The path git names it by (links resolved). */
  gitPath: string;
  branch: string;
  /** The branch was made new by this call, at `head`. */
  madeBranch: boolean;
  head: string;
  /** The project's .mcp.json was copied in by this call. */
  copiedMcp: boolean;
}

const git = (cwd: string, args: string[]) => safeGit(cwd, args, { env: { LC_ALL: 'C' }, timeout: 120_000 });

/** The worktree of the project that has `branch` checked out, the main checkout included, or undefined. */
async function holderOf(projectPath: string, branch: string): Promise<string | undefined> {
  const { stdout } = await git(projectPath, ['worktree', 'list', '--porcelain']);
  let at: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && at) return at;
  }
  return undefined;
}

export async function readyWorktree(
  projectPath: string, branch: string, opts: { noPush: boolean; protectedPaths: string[]; freeBytes?: (dir: string) => Promise<number> },
): Promise<ReadyWorktree | { status: number; error: string; code?: string }> {
  let holder: string | undefined;
  try {
    holder = await holderOf(projectPath, branch);
  } catch (err) {
    return { status: 400, error: `the worktrees of ${projectPath} could not be read (${err instanceof Error ? err.message : String(err)})`, code: 'not_a_repository' };
  }
  if (holder) {
    return { status: 409, error: `${holder} holds branch ${branch}: an agent works on a branch of its own. Name another; nothing was made.`, code: 'branch_held' };
  }
  const made = await newWorktree(projectPath, branch, { protectedPaths: opts.protectedPaths, ...(opts.freeBytes ? { freeBytes: opts.freeBytes } : {}) });
  if ('code' in made) {
    return { status: made.code === 'disk_full' ? 507 : made.code === 'invalid_branch' || made.code === 'not_a_repository' ? 400 : 409, error: made.error, code: made.code };
  }
  const ready: ReadyWorktree = {
    path: resolveWorktreePath(projectPath, made.branch) ?? made.path, gitPath: made.path, branch: made.branch,
    madeBranch: made.kind === 'new' || made.kind === 'from-origin', head: made.head, copiedMcp: false,
  };
  // Held between the look and the make: what git made is a detached checkout of another's branch, never kept.
  if (made.kind === 'detached') {
    await takeBackWorktree(projectPath, { ...ready, madeBranch: false }, opts.protectedPaths);
    return { status: 409, error: `${made.heldBy ?? 'another worktree'} holds branch ${branch}: an agent works on a branch of its own. Name another.`, code: 'branch_held' };
  }
  try {
    if (opts.noPush) await turnPushOff(made.path);
    const source = path.join(projectPath, '.mcp.json');
    const target = path.join(made.path, '.mcp.json');
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.copyFileSync(source, target);
      ready.copiedMcp = true;
    }
  } catch (err) {
    const back = await takeBackWorktree(projectPath, ready, opts.protectedPaths);
    return { status: 500, error: `its worktree could not be made ready (${err instanceof Error ? err.message : String(err)}), and ${back ? 'was taken back' : `was kept at ${made.path}`}` };
  }
  return ready;
}

/**
 * A worktree this call made, taken back: the .mcp.json it copied in, the worktree as git removes a clean one (never
 * by force), and the branch when this call made it and it has not moved. False, with the worktree kept, when an agent
 * or a terminal works in it or it holds anything else.
 */
export async function takeBackWorktree(
  projectPath: string, made: Pick<ReadyWorktree, 'path' | 'branch' | 'madeBranch'> & Partial<Pick<ReadyWorktree, 'gitPath' | 'head' | 'copiedMcp'>>, protectedPaths: string[],
): Promise<boolean> {
  const at = made.gitPath ?? made.path;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (protectedPaths.some((p) => real(p) === real(at) || real(p) === real(made.path))) return false;
  try {
    if (made.copiedMcp) fs.rmSync(path.join(at, '.mcp.json'), { force: true });
    await git(projectPath, ['worktree', 'remove', at]);
  } catch (err) {
    console.warn(`[agent-worktree] ${at} was kept: ${String((err as { stderr?: unknown }).stderr ?? (err as Error).message).trim()}`);
    return false;
  }
  if (made.madeBranch) {
    try {
      const { stdout } = await git(projectPath, ['rev-parse', '--verify', '-q', `refs/heads/${made.branch}`]);
      if (!made.head || stdout.trim() === made.head) await git(projectPath, ['branch', '-D', made.branch]);
    } catch (err) {
      console.warn(`[agent-worktree] the branch ${made.branch} was kept:`, err);
    }
  }
  return true;
}

/** What a worktree holds that no commit has: changed, staged and untracked files, as `git status` names them. */
export async function uncommittedWork(worktreePath: string): Promise<string[]> {
  const { stdout } = await git(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  return stdout.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
}
