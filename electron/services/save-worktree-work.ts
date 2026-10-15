import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * An agent's uncommitted work, saved on wip/<name> before its worktree goes
 * (JeanBrasse, 05/10: deleting an agent saves it first, without asking). The window's
 * delete removed the worktree with `git worktree remove --force`, and whatever
 * was not committed went with it.
 *
 * Made with a throwaway index and `commit-tree`: the worktree's files and
 * branch are not touched, the agent's own branch does not move, and no hook of
 * the repository runs. The commit's parent is the worktree's HEAD.
 */

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout).trim());
    });
  });
}

/** wip/<name>, a ref git takes whatever the agent is called. */
export function wipBranchName(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `wip/${slug || 'agent'}`;
}

/**
 * Commits what `worktreePath` has not committed (changes and untracked files)
 * on a new wip/<name>, the next free one. Null when there is nothing to save.
 * Throws when it could not save: the caller must then keep the worktree.
 */
export async function saveUncommittedWork(worktreePath: string, name: string): Promise<{ branch: string; nestedRepos: string[] } | null> {
  const status = await git(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  if (!status) return null;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-wip-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    await git(worktreePath, ['read-tree', 'HEAD'], env);
    await git(worktreePath, ['add', '-A'], env);
    const tree = await git(worktreePath, ['write-tree'], env);
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    const commit = await git(worktreePath, ['commit-tree', tree, '-p', head, '-m', `wip: ${name}'s uncommitted work, saved by Tars when the agent was deleted`]);

    // A git repository inside the worktree (one the agent cloned or made) is
    // committed as a gitlink only: a pointer to a commit that exists in its own
    // .git and nowhere else (QA's gate of #312). Named, so that the caller
    // keeps the worktree.
    const gitlinks = async (rev: string) => (await git(worktreePath, ['ls-tree', '-r', rev]))
      .split('\n').filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
    const before = new Set(await gitlinks(head));
    const nestedRepos = (await gitlinks(commit)).filter(p => !before.has(p));

    const base = wipBranchName(name);
    for (let n = 1; n < 100; n++) {
      const branch = n === 1 ? base : `${base}-${n}`;
      try {
        await git(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      } catch {
        await git(worktreePath, ['branch', branch, commit]);
        return { branch, nestedRepos };
      }
    }
    throw new Error(`no free name for ${base}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What git ignores in the worktree, but the rebuildable caches: a .env, an e2e
 * run directory under test-results/, a local database. The wip commit cannot
 * keep them (`add -A` leaves out what .gitignore names), and a forced removal
 * deleted them with no word (the Audit's gate of #312). The same caches as
 * scripts/worktree.mjs; a folder git lists once, as it folds it.
 */
const CACHES = [
  /(^|\/)node_modules\/?$/, /^\.next\/?$/, /^out\/?$/, /^electron\/dist\/?$/, /^mcp-[^/]+\/dist\/?$/,
  /\.tsbuildinfo$/, /(^|\/)next-env\.d\.ts$/, /(^|\/)\.DS_Store$/, /(^|\/)\.vite(-temp)?\/?$/,
];

export async function ignoredNotCaches(worktreePath: string): Promise<string[]> {
  const status = await git(worktreePath, ['status', '--porcelain', '--ignored', '--untracked-files=normal']);
  return status.split('\n')
    .filter(line => line.startsWith('!! '))
    .map(line => line.slice(3))
    .filter(file => !CACHES.some(cache => cache.test(file)));
}

/**
 * The submodules checked out in the worktree that hold work no remote has:
 * commits on no remote-tracking branch (from any ref: a branch, a tag, a
 * stash, the Audit's gate of #335), changes not committed, or files git
 * ignores that are not caches (a .env), which the worktree's own ignored-files
 * check does not see, its git status not going into a submodule. A worktree's
 * submodule keeps its git store in the worktree's own
 * (.git/worktrees/<name>/modules/), which a forced removal deletes; measured
 * on 06/10, a commit made in one is gone after it (the Info of #312's gate).
 * The wip save cannot keep them either: it commits a submodule as a pointer.
 * Nested submodules are looked into the same way; one that cannot be read is
 * named, never taken for empty. One never checked out holds nothing.
 */
export async function submodulesWithWork(worktreePath: string, prefix = ''): Promise<string[]> {
  let staged: string;
  try {
    staged = await git(worktreePath, ['ls-files', '--stage']);
  } catch {
    return [];
  }
  const found: string[] = [];
  const paths = staged.split('\n').filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
  for (const sub of paths) {
    const dir = path.join(worktreePath, sub);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const named = prefix + sub;
    try {
      const dirty = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
      const unpushed = await git(dir, ['rev-list', '-n', '1', 'HEAD', '--all', '--not', '--remotes']);
      if (dirty || unpushed || (await ignoredNotCaches(dir)).length) found.push(named);
      else found.push(...await submodulesWithWork(dir, `${named}/`));
    } catch {
      found.push(named);
    }
  }
  return found;
}
