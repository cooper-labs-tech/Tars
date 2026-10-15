/**
 * Deleting an agent saves its uncommitted work first, on wip/<name>, without
 * asking (JeanBrasse, 05/10). The window's delete removed the agent's worktree with
 * `git worktree remove --force`, and everything not committed went with it
 * (electron/services/save-worktree-work.ts, agent:remove).
 *
 * How it fails, written before the code (2026-10-05):
 * 1. Changes to tracked files, or new untracked files, are lost.
 * 2. The work goes onto the agent's own branch, which then carries a
 *    commit nobody reviewed, or the branch is moved.
 * 3. A wip branch of the same name is overwritten.
 * 4. A clean worktree gets an empty commit or a branch for nothing.
 * 5. The repository's hooks run on that commit (a pre-commit that fails, a
 *    commit-msg that rewrites), and the save fails or is altered.
 * 6. The name is taken as a ref name as given: a space or `..` makes git
 *    refuse, and the work is lost on the error path.
 * 7. A save that fails is reported as done: the caller would remove the
 *    worktree and lose the work it could not save.
 * And from QA's gate of #312 (probe-312/):
 * 8. A git repository the agent cloned or made inside its worktree is saved as
 *    a gitlink only, a pointer to a commit that exists in that repository's own
 *    .git and nowhere else: its files are in no saved tree. The save must name
 *    it, so that its worktree is kept.
 * And from the Audit's gate of #335 (L1):
 * 12. A submodule that cannot be read (its .git names a gitdir that is gone)
 *     is taken for one with nothing in it, and its worktree removed.
 * 13. A submodule inside a submodule is not looked into: work its parent's
 *     status cannot see (a stash) goes with the worktree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { saveUncommittedWork, submodulesWithWork, wipBranchName } from '../../../electron/services/save-worktree-work';
import { skipOnWindows } from '../../setup/platform-limits';

/** Why 7 cannot hold on Windows. */
const READ_ONLY_FOLDER_REASON = 'chmod 0o555 only sets the read-only attribute on Windows, which it ignores on a folder: '
  + 'git still writes its objects, and the save cannot be made to fail this way; test 7 runs on macOS, Linux and CI';
/** The submodule tests run some thirty git commands, about 6 s on Windows alone and more under load. */
const SUBMODULE_TIMEOUT_MS = 30_000;

let root: string;
let repo: string;
let wt: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-save-wip-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.example');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  wt = path.join(repo, '.worktrees', 'feat-x');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the uncommitted work of a worktree, saved before it goes', () => {
  it('1, 2. tracked changes and new files are committed on wip/<name>, and the agent\'s branch does not move', async () => {
    const before = git(repo, 'rev-parse', 'feat/x');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'fresh\n');

    const saved = await saveUncommittedWork(wt, 'Backend Engineer');

    expect(saved).toEqual({ branch: 'wip/backend-engineer', nestedRepos: [] });
    expect(git(repo, 'rev-parse', 'feat/x')).toBe(before);
    expect(git(repo, 'show', 'wip/backend-engineer:a.txt')).toBe('one\ntwo');
    expect(git(repo, 'show', 'wip/backend-engineer:new.txt')).toBe('fresh');
    expect(git(repo, 'rev-parse', 'wip/backend-engineer~1')).toBe(before);
    // The worktree itself is left as it was: its branch and its files.
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x');
    expect(fs.readFileSync(path.join(wt, 'new.txt'), 'utf8')).toBe('fresh\n');
  });

  it('3. a wip branch of that name is kept, and the next free name is taken', async () => {
    git(repo, 'branch', 'wip/backend-engineer', 'main');
    const kept = git(repo, 'rev-parse', 'wip/backend-engineer');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');

    expect(await saveUncommittedWork(wt, 'Backend Engineer')).toEqual({ branch: 'wip/backend-engineer-2', nestedRepos: [] });
    expect(git(repo, 'rev-parse', 'wip/backend-engineer')).toBe(kept);
  });

  it('4. a clean worktree saves nothing and makes no branch', async () => {
    expect(await saveUncommittedWork(wt, 'Backend Engineer')).toBeNull();
    expect(git(repo, 'branch', '--list', 'wip/*')).toBe('');
  });

  it('5. runs none of the repository\'s hooks', async () => {
    const hooks = path.join(repo, '.git', 'hooks');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho rewritten > "$1"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');

    const saved = await saveUncommittedWork(wt, 'QA');
    expect(saved).toEqual({ branch: 'wip/qa', nestedRepos: [] });
    expect(git(repo, 'log', '-1', '--format=%s', 'wip/qa')).toContain('QA');
  });

  it('6. any name makes a ref git takes', () => {
    expect(wipBranchName('Backend Engineer')).toBe('wip/backend-engineer');
    expect(wipBranchName('../../etc passwd')).toBe('wip/etc-passwd');
    expect(wipBranchName('Dé ploy ✓ v2.0.')).toBe('wip/d-ploy-v2-0');
    expect(wipBranchName('...')).toBe('wip/agent');
    expect(wipBranchName('x'.repeat(200)).length).toBeLessThanOrEqual(4 + 60);
  });

  it('8. names a git repository inside the worktree, which the save can only point at', async () => {
    const nested = path.join(wt, 'vendor-lib');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'config', 'user.email', 't@t.example');
    git(nested, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(nested, 'lib.js'), 'module.exports = 1;\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-qm', 'lib');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');

    const saved = await saveUncommittedWork(wt, 'QA');
    expect(saved).toEqual({ branch: 'wip/qa', nestedRepos: ['vendor-lib'] });
  });

  it('8. names none for a worktree without one', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
    expect(await saveUncommittedWork(wt, 'QA')).toEqual({ branch: 'wip/qa', nestedRepos: [] });
  });

  it.skipIf(skipOnWindows(READ_ONLY_FOLDER_REASON))('7. a save that fails says so, and leaves the work where it was', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'kept\n');
    // An object store git cannot write to: nothing can be committed.
    const objects = path.join(repo, '.git', 'objects');
    fs.chmodSync(objects, 0o555);
    try {
      await expect(saveUncommittedWork(wt, 'QA')).rejects.toThrow();
    } finally {
      fs.chmodSync(objects, 0o755);
    }
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('kept\n');
    expect(git(repo, 'branch', '--list', 'wip/*')).toBe('');
  });
});

describe('the submodules of a worktree', () => {
  it('12. names one that cannot be read, never taking it for empty', async () => {
    const lib = path.join(root, 'lib');
    fs.mkdirSync(lib);
    git(lib, 'init', '-q', '-b', 'main');
    git(lib, 'config', 'user.email', 't@t.example');
    git(lib, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(lib, 'l.txt'), 'one\n');
    git(lib, 'add', '-A');
    git(lib, 'commit', '-qm', 'lib');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    git(repo, 'commit', '-qm', 'lib as a submodule');
    git(wt, 'merge', '-q', 'main');
    git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    expect(await submodulesWithWork(wt)).toEqual([]);

    // Removed first: Git for Windows hides a .git, and Windows refuses to open
    // a hidden file for overwriting (EPERM).
    fs.rmSync(path.join(wt, 'vendor', 'lib', '.git'));
    fs.writeFileSync(path.join(wt, 'vendor', 'lib', '.git'), `gitdir: ${path.join(repo, '.git', 'gone')}\n`);
    expect(await submodulesWithWork(wt)).toEqual(['vendor/lib']);
  }, SUBMODULE_TIMEOUT_MS);

  it('13. looks into a submodule inside a submodule, and names the inner one', async () => {
    const repoAt = (dir: string) => {
      fs.mkdirSync(dir);
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@t.example');
      git(dir, 'config', 'user.name', 'T');
      fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'first');
    };
    const inner = path.join(root, 'inner');
    const lib = path.join(root, 'lib');
    repoAt(inner);
    repoAt(lib);
    git(lib, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'inner');
    git(lib, 'commit', '-qm', 'inner as a submodule');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    git(repo, 'commit', '-qm', 'lib as a submodule');
    git(wt, 'merge', '-q', 'main');
    git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q');
    const nested = path.join(wt, 'vendor', 'lib', 'inner');
    expect(await submodulesWithWork(wt)).toEqual([]);

    git(nested, 'config', 'user.email', 't@t.example');
    git(nested, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(nested, 'f.txt'), 'one\nstashed\n');
    git(nested, 'stash', '-q');
    expect(git(path.join(wt, 'vendor', 'lib'), 'status', '--porcelain')).toBe('');
    expect(await submodulesWithWork(wt)).toEqual(['vendor/lib/inner']);
  }, SUBMODULE_TIMEOUT_MS);
});

