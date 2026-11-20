import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * An agent's own worktree, made ready for it in one call (create_agent with worktree, 2.0.7), taken back when the
 * creation does not finish, checked before a removal; and a worktree's push turned off (turnPushOff). On real git
 * repositories in a folder of this file's own.
 *
 * How it fails, written before the code (the Audit's M3 and L2 on #595, 2026-11-19):
 * 1. A branch another worktree holds (a gate checkout already there, with work in it) gets a checkout made over it,
 *    or that checkout is taken back, by force, files and all: it must be refused before anything is made, naming its
 *    holder, the checkout untouched.
 * 2. A new worktree that a later step fails for is left behind, or the new branch made for it: both taken back.
 * 3. A worktree taken back that holds what the call did not put there is removed by force: it must be kept, and so
 *    must one an agent or a terminal works in.
 * 4. The push turned off is pushed all the same to the remote's own pushurl, kept in the shared settings (a
 *    multi-valued setting the worktree's own adds to): the push must fail, the worktree's push list holding the marker
 *    alone, and the main checkout's push must be untouched.
 * 5. A push by the remote's name, an absolute path, a file:// or an https:// address goes through: each must fail,
 *    naming the marker.
 * 6. The uncommitted work of a worktree is read wrong: its changed, staged and untracked files must be named, and a
 *    clean one has none.
 */

import { readyWorktree, takeBackWorktree, uncommittedWork } from '../../../electron/services/agent-worktree';
import { newWorktree, turnPushOff, NO_PUSH_URL } from '../../../electron/services/project-worktrees';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-worktree-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const tryGit = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  return { code: r.status ?? -1, err: r.stderr ?? '' };
};

let n = 0;
let dir: string;
let origin: string;
beforeEach(() => {
  const base = path.join(root, `p${++n}`);
  origin = path.join(base, 'origin.git');
  dir = path.join(base, 'project');
  fs.mkdirSync(dir, { recursive: true });
  git(base, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
});

/** A disk with room: the floor is the module's own tests' to measure. */
const plenty = async () => 500 * 1024 ** 3;
const worktrees = () => git(dir, 'worktree', 'list', '--porcelain');

describe('an agent\'s ready worktree', () => {
  it('1. refuses a branch another worktree holds, naming it, and leaves that checkout and its work alone', async () => {
    await newWorktree(dir, 'feat/held', { protectedPaths: [], freeBytes: plenty });
    // QA's gate checkout of it, with a file in it nobody committed.
    const gate = await newWorktree(dir, 'feat/held', { protectedPaths: [], freeBytes: plenty });
    expect('code' in gate ? gate.code : gate.kind).toBe('detached');
    const gatePath = (gate as { path: string }).path;
    fs.writeFileSync(path.join(gatePath, 'qa-notes.txt'), 'mid-gate\n');
    const before = worktrees();
    const answer = await readyWorktree(dir, 'feat/held', { noPush: true, protectedPaths: [gatePath], freeBytes: plenty });
    expect(answer).toMatchObject({ code: 'branch_held' });
    expect((answer as { error: string }).error).toContain('.worktrees');
    expect(worktrees()).toBe(before);
    expect(fs.readFileSync(path.join(gatePath, 'qa-notes.txt'), 'utf8')).toBe('mid-gate\n');
  });

  it('2. takes back a new worktree and the branch made for it', async () => {
    const made = await readyWorktree(dir, 'work/a', { noPush: false, protectedPaths: [], freeBytes: plenty });
    expect('error' in made).toBe(false);
    const ready = made as { path: string; branch: string; madeBranch: boolean };
    expect(ready.madeBranch).toBe(true);
    expect(await takeBackWorktree(dir, ready, [])).toBe(true);
    expect(fs.existsSync(ready.path)).toBe(false);
    expect(tryGit(dir, 'rev-parse', '--verify', '-q', 'refs/heads/work/a').code).not.toBe(0);
  });

  it('3. keeps a worktree that holds what the call did not put there, or that an agent works in', async () => {
    const made = (await readyWorktree(dir, 'work/b', { noPush: false, protectedPaths: [], freeBytes: plenty })) as { path: string; branch: string; madeBranch: boolean };
    fs.writeFileSync(path.join(made.path, 'agent-wrote.txt'), 'keep me\n');
    expect(await takeBackWorktree(dir, made, [])).toBe(false);
    expect(fs.existsSync(path.join(made.path, 'agent-wrote.txt'))).toBe(true);
    const other = (await readyWorktree(dir, 'work/c', { noPush: false, protectedPaths: [], freeBytes: plenty })) as { path: string; branch: string; madeBranch: boolean };
    expect(await takeBackWorktree(dir, other, [other.path])).toBe(false);
    expect(fs.existsSync(other.path)).toBe(true);
  });

  it('6. names a worktree\'s changed, staged and untracked files, and none for a clean one', async () => {
    const made = (await readyWorktree(dir, 'work/d', { noPush: false, protectedPaths: [], freeBytes: plenty })) as { path: string };
    expect(await uncommittedWork(made.path)).toEqual([]);
    fs.writeFileSync(path.join(made.path, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(made.path, 'staged.txt'), 's\n');
    git(made.path, 'add', 'staged.txt');
    fs.writeFileSync(path.join(made.path, 'loose.txt'), 'l\n');
    expect((await uncommittedWork(made.path)).sort()).toEqual(['README.md', 'loose.txt', 'staged.txt']);
  });
});

describe('a worktree\'s push turned off', () => {
  it('4. holds when the remote has a pushurl of its own in the shared settings, and the main checkout still pushes there', async () => {
    const elsewhere = path.join(path.dirname(origin), 'elsewhere.git');
    git(path.dirname(origin), 'init', '-q', '--bare', elsewhere);
    git(dir, 'config', 'remote.origin.pushurl', elsewhere);
    const made = (await newWorktree(dir, 'work/e', { protectedPaths: [], freeBytes: plenty })) as { path: string };
    await turnPushOff(made.path);
    expect(git(made.path, 'remote', 'get-url', '--push', '--all', 'origin').split('\n')).toEqual([NO_PUSH_URL]);
    const pushed = tryGit(made.path, 'push', 'origin', 'HEAD:refs/heads/work/e');
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain(NO_PUSH_URL);
    expect(tryGit(elsewhere, 'rev-parse', '--verify', '-q', 'refs/heads/work/e').code).not.toBe(0);
    expect(git(dir, 'remote', 'get-url', '--push', '--all', 'origin')).toBe(elsewhere);
    expect(tryGit(dir, 'push', '-q', 'origin', 'main:refs/heads/from-main').code).toBe(0);
  });

  it.each([
    ['the remote by name', ['origin']],
    ['an absolute path', ['ORIGIN']],
    ['a file:// address', ['file://ORIGIN']],
    ['an https:// address', ['https://example.com/x.git']],
  ])('5. refuses a push to %s, naming why', async (_what, [target]) => {
    const made = (await newWorktree(dir, 'work/f', { protectedPaths: [], freeBytes: plenty })) as { path: string };
    await turnPushOff(made.path);
    const pushed = tryGit(made.path, 'push', target.replace('ORIGIN', origin), 'HEAD:refs/heads/work/f');
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain(NO_PUSH_URL);
  });
});
