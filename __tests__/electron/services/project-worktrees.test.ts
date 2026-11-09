import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  newWorktree, listWorktrees, removeWorktree, pruneWorktrees, WORKTREE_MAX, PRUNE_IDLE_MS,
} from '../../../electron/services/project-worktrees';

/**
 * A worktree per task, for any project (2.0.7, W6 of the fresh-install report): what scripts/worktree.mjs does for
 * Tars's own repository, as a tool every agent of every project has (worktree_new, worktree_list, worktree_remove,
 * worktree_prune). On real git repositories in a temporary folder, a bare one standing in for the remote.
 *
 * How it fails, written before the code (2026-11-10):
 * N1. A branch name that leaves the project's .worktrees (`..`, an absolute path) is used: refused, nothing made.
 * N2. A folder that is not a git repository gets a worktree, or an unclear error: refused, with why.
 * N3. A disk under the floor gets one anyway: refused, with the free space and the floor.
 * N4. Past the project's count (WORKTREE_MAX) one more is made: refused.
 * N5. The worktree does not start from the fresh default branch: with a remote, origin's after a fetch, not the
 *     local branch left behind; without a remote, the local default branch. A fetch that fails falls back to the
 *     local branch and says so.
 * N6. .worktrees shows in the project's `git status` (untracked): it must be kept out by .git/info/exclude, never by
 *     a change to the project's own .gitignore.
 * N7. A branch that exists is made anew or refused: it is checked out in the worktree.
 * R1. A worktree with uncommitted or untracked changes is removed, and the work lost: refused.
 * R2. An agent's own worktree (the one it runs in) is removed: refused.
 * R3. The removal forces, or deletes the branch: it never forces, and the branch stays.
 * P1. prune removes an unmerged worktree, a dirty one, an agent's own, or a fresh one whose branch has no commit of
 *     its own yet (its head is the default branch's, merged by definition): only a clean one whose branch is merged
 *     into the default branch and whose HEAD has not moved for PRUNE_IDLE_MS. A dry run removes nothing.
 * P2. A new worktree is made without pruning first, and merged ones pile up.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-project-worktrees-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const plenty = async () => 500 * 1024 ** 3;
let n = 0;

/** A project cloned from a bare origin with one commit on main. */
function project(): { dir: string; origin: string } {
  const base = path.join(root, `p${++n}`);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const dir = path.join(base, 'project');
  git(base, 'clone', '-q', origin, dir);
  return { dir, origin: seed };
}

/** A commit pushed to origin's main from elsewhere: the project's local main is now behind. */
function advanceOrigin(seed: string, file: string): string {
  fs.writeFileSync(path.join(seed, file), file);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', file);
  git(seed, 'push', '-q', 'origin', 'main');
  return git(seed, 'rev-parse', 'HEAD');
}

/** The worktree's HEAD as if it last moved `ms` ago. */
function idle(dir: string, ms: number): void {
  const gitdir = git(dir, 'rev-parse', '--git-dir');
  const when = new Date(Date.now() - ms);
  for (const f of ['HEAD', path.join('logs', 'HEAD')]) {
    const p = path.resolve(dir, gitdir, f);
    if (fs.existsSync(p)) fs.utimesSync(p, when, when);
  }
}

let p: { dir: string; origin: string };
beforeEach(() => { p = project(); });

describe('a new worktree', () => {
  it('N1. refuses a branch that leaves the project\'s .worktrees', async () => {
    for (const branch of ['../escape', '/tmp/x', 'a/../../b']) {
      const r = await newWorktree(p.dir, branch, { freeBytes: plenty });
      expect(r, branch).toMatchObject({ code: 'invalid_branch' });
    }
    expect(fs.existsSync(path.join(p.dir, '..', 'escape'))).toBe(false);
  });

  it('N2. refuses a folder that is not a git repository, saying so', async () => {
    const plain = path.join(root, `plain${++n}`);
    fs.mkdirSync(plain);
    expect(await newWorktree(plain, 'feat/x', { freeBytes: plenty })).toMatchObject({ code: 'not_a_repository' });
  });

  it('N3. refuses under the disk floor, with the free space and the floor', async () => {
    const r = await newWorktree(p.dir, 'feat/x', { freeBytes: async () => 1024 ** 3 });
    expect(r).toMatchObject({ code: 'disk_full' });
    expect((r as { error: string }).error).toMatch(/1 GB free.*10 GB/);
  });

  it('N4. refuses past the project\'s count', async () => {
    for (let i = 0; i < WORKTREE_MAX; i++) expect(await newWorktree(p.dir, `feat/w${i}`, { freeBytes: plenty })).toHaveProperty('path');
    expect(await newWorktree(p.dir, 'feat/one-more', { freeBytes: plenty })).toMatchObject({ code: 'too_many' });
  }, 60_000);

  it('N5. starts from origin\'s fresh default branch, and from the local one when the fetch fails, saying so', async () => {
    const fresh = advanceOrigin(p.origin, 'two.txt');
    const made = await newWorktree(p.dir, 'feat/fresh', { freeBytes: plenty });
    expect(made).toMatchObject({ branch: 'feat/fresh', base: 'origin/main' });
    expect(git((made as { path: string }).path, 'rev-parse', 'HEAD')).toBe(fresh);
    // The remote gone: the local default branch, and the answer says why.
    git(p.dir, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    const offline = await newWorktree(p.dir, 'feat/offline', { freeBytes: plenty });
    expect(offline).toMatchObject({ branch: 'feat/offline', base: 'main' });
    expect((offline as { note?: string }).note).toMatch(/fetch/);
  });

  it('N5. starts from the local default branch in a project with no remote', async () => {
    git(p.dir, 'remote', 'remove', 'origin');
    expect(await newWorktree(p.dir, 'feat/local', { freeBytes: plenty })).toMatchObject({ branch: 'feat/local', base: 'main' });
  });

  it('N6. keeps .worktrees out of git through .git/info/exclude, not the project\'s .gitignore', async () => {
    await newWorktree(p.dir, 'feat/x', { freeBytes: plenty });
    expect(git(p.dir, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(p.dir, '.gitignore'))).toBe(false);
    expect(fs.readFileSync(path.join(p.dir, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.worktrees\/$/m);
  });

  it('N7. checks out a branch that exists', async () => {
    git(p.dir, 'branch', 'feat/old');
    const made = await newWorktree(p.dir, 'feat/old', { freeBytes: plenty });
    expect(git((made as { path: string }).path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/old');
  });
});

describe('removing one', () => {
  it('R1. refuses a worktree with uncommitted or untracked work', async () => {
    const made = await newWorktree(p.dir, 'feat/dirty', { freeBytes: plenty }) as { path: string };
    fs.writeFileSync(path.join(made.path, 'new.txt'), 'work');
    expect(await removeWorktree(p.dir, 'feat/dirty', { protectedPaths: [] })).toMatchObject({ code: 'dirty' });
    expect(fs.existsSync(path.join(made.path, 'new.txt'))).toBe(true);
  });

  it('R2. refuses an agent\'s own worktree', async () => {
    const made = await newWorktree(p.dir, 'feat/agent', { freeBytes: plenty }) as { path: string };
    expect(await removeWorktree(p.dir, 'feat/agent', { protectedPaths: [made.path] })).toMatchObject({ code: 'in_use' });
  });

  it('R3. removes a clean one without force, and keeps its branch', async () => {
    const made = await newWorktree(p.dir, 'feat/done', { freeBytes: plenty }) as { path: string };
    expect(await removeWorktree(p.dir, 'feat/done', { protectedPaths: [] })).toMatchObject({ removed: true });
    expect(fs.existsSync(made.path)).toBe(false);
    expect(git(p.dir, 'branch', '--list', 'feat/done')).toContain('feat/done');
  });
});

describe('pruning', () => {
  it('P1. removes only clean, merged worktrees idle for a while; a dry run removes nothing', async () => {
    const merged = await newWorktree(p.dir, 'feat/merged', { freeBytes: plenty }) as { path: string };
    fs.writeFileSync(path.join(merged.path, 'm.txt'), 'm');
    git(merged.path, 'add', '.');
    git(merged.path, 'commit', '-q', '-m', 'm');
    git(merged.path, 'push', '-q', 'origin', 'feat/merged:main');
    const open = await newWorktree(p.dir, 'feat/open', { freeBytes: plenty }) as { path: string };
    fs.writeFileSync(path.join(open.path, 'o.txt'), 'o');
    git(open.path, 'add', '.');
    git(open.path, 'commit', '-q', '-m', 'o');
    const fresh = await newWorktree(p.dir, 'feat/fresh', { freeBytes: plenty }) as { path: string };
    const own = await newWorktree(p.dir, 'feat/own', { freeBytes: plenty }) as { path: string };
    for (const w of [merged, open, fresh, own]) idle(w.path, PRUNE_IDLE_MS + 60_000);
    idle(fresh.path, 0);

    const dry = await pruneWorktrees(p.dir, { protectedPaths: [own.path], dryRun: true });
    expect(dry.removed).toEqual(['feat/merged']);
    expect(fs.existsSync(merged.path)).toBe(true);

    const done = await pruneWorktrees(p.dir, { protectedPaths: [own.path] });
    expect(done.removed).toEqual(['feat/merged']);
    expect(fs.existsSync(merged.path)).toBe(false);
    for (const w of [open, fresh, own]) expect(fs.existsSync(w.path)).toBe(true);
    const why = Object.fromEntries(done.kept.map(k => [k.branch, k.why]));
    expect(why['feat/open']).toMatch(/not merged/);
    expect(why['feat/fresh']).toMatch(/moved/);
    expect(why['feat/own']).toMatch(/agent/);
  });

  it('P2. a new worktree prunes first', async () => {
    const merged = await newWorktree(p.dir, 'feat/merged', { freeBytes: plenty }) as { path: string };
    fs.writeFileSync(path.join(merged.path, 'm.txt'), 'm');
    git(merged.path, 'add', '.');
    git(merged.path, 'commit', '-q', '-m', 'm');
    git(merged.path, 'push', '-q', 'origin', 'feat/merged:main');
    idle(merged.path, PRUNE_IDLE_MS + 60_000);
    const next = await newWorktree(p.dir, 'feat/next', { freeBytes: plenty });
    expect(next).toMatchObject({ pruned: ['feat/merged'] });
    expect((await listWorktrees(p.dir)).map(w => w.branch)).toEqual(['feat/next']);
  });
});
