import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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
 * N5. The worktree does not start from the default branch as fetched: with a remote, origin's, not the local branch
 *     left behind it; without a remote, the local default branch. A fetch that fails starts from origin's as last
 *     fetched, and says so. (The remote here is a path, a transport safeGit refuses, GIT_ALLOW_PROTOCOL: every fetch
 *     of Tars's here fails, so the test fetches origin's refs itself with plain git, as a fetch that worked would.)
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
 *
 * From the Audit's FIX FIRST on #585 (written before the fixes, 2026-11-10):
 * A1. (M1) A branch only on origin (a PR pushed from elsewhere) gets a new branch from the default branch under its
 *     name: QA gates the default branch's code and writes MERGE for a PR it never ran. It is checked out from origin.
 * A2. (M1) A branch another worktree holds (the worker's) is refused, and QA is left to find it: it gets a detached
 *     checkout of the PR's head (origin's when fetched, else the local branch's), and the answer says whose it is.
 * A3. (L1) A branch never moved since it was made (no commit of its own: its head is an ancestor of the base) counts
 *     as merged, and an hour later the prune takes the folder an agent is reading in.
 * A4. (L1) A squash or rebase merge (the branch never an ancestor of the default branch) never counts as merged: the
 *     PR's own state, when it can be read (gh), does.
 * A5. (L2) A worktree an agent's terminal was started in (ptyCwd), or one inside it, is removed or pruned.
 * A6. (L2) Two new worktrees asked at once both pass the count, or both append to .git/info/exclude: one at a time
 *     per project.
 */

vi.setConfig({ testTimeout: 60_000 });
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
      const r = await newWorktree(p.dir, branch, { freeBytes: plenty, protectedPaths: [] });
      expect(r, branch).toMatchObject({ code: 'invalid_branch' });
    }
    expect(fs.existsSync(path.join(p.dir, '..', 'escape'))).toBe(false);
  });

  it('N2. refuses a folder that is not a git repository, saying so', async () => {
    const plain = path.join(root, `plain${++n}`);
    fs.mkdirSync(plain);
    expect(await newWorktree(plain, 'feat/x', { freeBytes: plenty, protectedPaths: [] })).toMatchObject({ code: 'not_a_repository' });
  });

  it('N3. refuses under the disk floor, with the free space and the floor', async () => {
    const r = await newWorktree(p.dir, 'feat/x', { freeBytes: async () => 1024 ** 3, protectedPaths: [] });
    expect(r).toMatchObject({ code: 'disk_full' });
    expect((r as { error: string }).error).toMatch(/1 GB free.*10 GB/);
  });

  it('N4. refuses past the project\'s count', async () => {
    for (let i = 0; i < WORKTREE_MAX; i++) expect(await newWorktree(p.dir, `feat/w${i}`, { freeBytes: plenty, protectedPaths: [] })).toHaveProperty('path');
    expect(await newWorktree(p.dir, 'feat/one-more', { freeBytes: plenty, protectedPaths: [] })).toMatchObject({ code: 'too_many' });
  }, 300_000);

  it('N5. starts from origin\'s default branch as fetched, not the local one behind it, and says when its fetch failed', async () => {
    const fresh = advanceOrigin(p.origin, 'two.txt');
    git(p.dir, 'fetch', '-q', 'origin');
    const localMain = git(p.dir, 'rev-parse', 'main');
    expect(localMain).not.toBe(fresh);
    const made = await newWorktree(p.dir, 'feat/fresh', { freeBytes: plenty, protectedPaths: [] });
    expect(made).toMatchObject({ branch: 'feat/fresh', base: 'origin/main' });
    expect(git((made as { path: string }).path, 'rev-parse', 'HEAD')).toBe(fresh);
    expect((made as { note?: string }).note).toMatch(/fetch from origin failed.*as last fetched/);
  });

  it('N5. starts from the local default branch in a project with no remote', async () => {
    git(p.dir, 'remote', 'remove', 'origin');
    expect(await newWorktree(p.dir, 'feat/local', { freeBytes: plenty, protectedPaths: [] })).toMatchObject({ branch: 'feat/local', base: 'main' });
  });

  it('N6. keeps .worktrees out of git through .git/info/exclude, not the project\'s .gitignore', async () => {
    await newWorktree(p.dir, 'feat/x', { freeBytes: plenty, protectedPaths: [] });
    expect(git(p.dir, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(p.dir, '.gitignore'))).toBe(false);
    expect(fs.readFileSync(path.join(p.dir, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.worktrees\/$/m);
  });

  it('N7. checks out a branch that exists', async () => {
    git(p.dir, 'branch', 'feat/old');
    const made = await newWorktree(p.dir, 'feat/old', { freeBytes: plenty, protectedPaths: [] });
    expect(git((made as { path: string }).path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/old');
  });
});

describe('removing one', () => {
  it('R1. refuses a worktree with uncommitted or untracked work', async () => {
    const made = await newWorktree(p.dir, 'feat/dirty', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    fs.writeFileSync(path.join(made.path, 'new.txt'), 'work');
    expect(await removeWorktree(p.dir, 'feat/dirty', { protectedPaths: [] })).toMatchObject({ code: 'dirty' });
    expect(fs.existsSync(path.join(made.path, 'new.txt'))).toBe(true);
  });

  it('R2. refuses an agent\'s own worktree', async () => {
    const made = await newWorktree(p.dir, 'feat/agent', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    expect(await removeWorktree(p.dir, 'feat/agent', { protectedPaths: [made.path] })).toMatchObject({ code: 'in_use' });
  });

  it('R3. removes a clean one without force, and keeps its branch', async () => {
    const made = await newWorktree(p.dir, 'feat/done', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    expect(await removeWorktree(p.dir, 'feat/done', { protectedPaths: [] })).toMatchObject({ removed: true });
    expect(fs.existsSync(made.path)).toBe(false);
    expect(git(p.dir, 'branch', '--list', 'feat/done')).toContain('feat/done');
  });
});

describe('pruning', () => {
  it('P1. removes only clean, merged worktrees idle for a while; a dry run removes nothing', async () => {
    const merged = await newWorktree(p.dir, 'feat/merged', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    fs.writeFileSync(path.join(merged.path, 'm.txt'), 'm');
    git(merged.path, 'add', '.');
    git(merged.path, 'commit', '-q', '-m', 'm');
    git(merged.path, 'push', '-q', 'origin', 'feat/merged:main');
    git(p.dir, 'fetch', '-q', 'origin');
    const open = await newWorktree(p.dir, 'feat/open', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    fs.writeFileSync(path.join(open.path, 'o.txt'), 'o');
    git(open.path, 'add', '.');
    git(open.path, 'commit', '-q', '-m', 'o');
    const fresh = await newWorktree(p.dir, 'feat/fresh', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    const own = await newWorktree(p.dir, 'feat/own', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
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
    const merged = await newWorktree(p.dir, 'feat/merged', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    fs.writeFileSync(path.join(merged.path, 'm.txt'), 'm');
    git(merged.path, 'add', '.');
    git(merged.path, 'commit', '-q', '-m', 'm');
    git(merged.path, 'push', '-q', 'origin', 'feat/merged:main');
    git(p.dir, 'fetch', '-q', 'origin');
    idle(merged.path, PRUNE_IDLE_MS + 60_000);
    const next = await newWorktree(p.dir, 'feat/next', { freeBytes: plenty, protectedPaths: [] });
    expect(next).toMatchObject({ pruned: ['feat/merged'] });
    expect((await listWorktrees(p.dir)).map(w => w.branch)).toEqual(['feat/next']);
  });
});

/** A branch with one commit, pushed to origin from the seed clone (a PR opened from elsewhere), then fetched. */
function remoteBranch(seed: string, branch: string): string {
  git(seed, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(seed, `${branch.replace(/\//g, '-')}.txt`), branch);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', branch);
  git(seed, 'push', '-q', 'origin', branch);
  const head = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', 'main');
  return head;
}

describe('the Audit\'s FIX FIRST on #585', () => {
  it('A1. checks out a branch that is only on origin from origin, never a new one from the default branch', async () => {
    const head = remoteBranch(p.origin, 'feat/remote');
    git(p.dir, 'fetch', '-q', 'origin');
    const made = await newWorktree(p.dir, 'feat/remote', { freeBytes: plenty, protectedPaths: [] });
    expect(made).toMatchObject({ branch: 'feat/remote', kind: 'from-origin' });
    expect(git((made as { path: string }).path, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('A2. gives a branch another worktree holds a detached checkout of its head, and says whose', async () => {
    const worker = await newWorktree(p.dir, 'feat/held', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    fs.writeFileSync(path.join(worker.path, 'w.txt'), 'w');
    git(worker.path, 'add', '.');
    git(worker.path, 'commit', '-q', '-m', 'w');
    const head = git(worker.path, 'rev-parse', 'HEAD');
    const gate = await newWorktree(p.dir, 'feat/held', { freeBytes: plenty, protectedPaths: [] });
    expect(gate).toMatchObject({ kind: 'detached', head, heldBy: worker.path });
    const gatePath = (gate as { path: string }).path;
    expect(gatePath).not.toBe(worker.path);
    expect(git(gatePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(gatePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });

  it('A3. keeps a branch never moved since it was made, however long its HEAD has been idle', async () => {
    const fresh = await newWorktree(p.dir, 'feat/reading', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    idle(fresh.path, PRUNE_IDLE_MS * 3);
    const r = await pruneWorktrees(p.dir, { protectedPaths: [] });
    expect(r.removed).toEqual([]);
    expect(r.kept.find(k => k.branch === 'feat/reading')?.why).toMatch(/no commit of its own/);
    expect(fs.existsSync(fresh.path)).toBe(true);
  });

  it('A4. counts a squash merge as merged when the PR says so, and only then', async () => {
    const w = await newWorktree(p.dir, 'feat/squashed', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    fs.writeFileSync(path.join(w.path, 's.txt'), 's');
    git(w.path, 'add', '.');
    git(w.path, 'commit', '-q', '-m', 's');
    advanceOrigin(p.origin, 's.txt');
    git(p.dir, 'fetch', '-q', 'origin');
    idle(w.path, PRUNE_IDLE_MS * 2);
    expect((await pruneWorktrees(p.dir, { protectedPaths: [] })).removed).toEqual([]);
    const byPr = await pruneWorktrees(p.dir, { protectedPaths: [], prMerged: async b => b === 'feat/squashed' });
    expect(byPr.removed).toEqual(['feat/squashed']);
  });

  it('A5. never removes or prunes a worktree an agent\'s terminal was started in, or one inside it', async () => {
    const w = await newWorktree(p.dir, 'feat/inside', { freeBytes: plenty, protectedPaths: [] }) as { path: string };
    const inner = path.join(w.path, 'src');
    expect(await removeWorktree(p.dir, 'feat/inside', { protectedPaths: [inner] })).toMatchObject({ code: 'in_use' });
    expect(fs.existsSync(w.path)).toBe(true);
  });

  it('A6. makes one at a time per project: two asked at once at the count, one is refused; the exclude line once', async () => {
    const both = await Promise.all([
      newWorktree(p.dir, 'feat/one', { freeBytes: plenty, protectedPaths: [], max: 1 }),
      newWorktree(p.dir, 'feat/two', { freeBytes: plenty, protectedPaths: [], max: 1 }),
    ]);
    expect(both.filter(r => 'path' in r)).toHaveLength(1);
    expect(both.filter(r => 'code' in r && r.code === 'too_many')).toHaveLength(1);
    const exclude = fs.readFileSync(path.join(p.dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.worktrees\/$/gm)).toHaveLength(1);
  });
});
