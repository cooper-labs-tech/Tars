import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reviewDiff, resetReviewCache } from '../../../electron/services/git-review';

/**
 * review:diff ran nine git commands one after the other on every visit to a
 * branch, 366 to 731 ms (the Audit, 2026-09-23). It now keeps the last diff of
 * each repository and base, and answers it again while the head, the base and
 * the working tree are as they were. What the Review page shows is uncommitted
 * work as much as commits, and agents edit files while it is open, so what
 * matters here is every way the diff can change without the branch moving.
 */

// Real repositories and real git: a busy machine takes seconds per test.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmp: string;
let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  resetReviewCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-review-cache-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  git(['checkout', '-qb', 'feat']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(['commit', '-qam', 'two']);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A later mtime than the file has, so an edit of the same size still moves it. */
function rewrite(file: string, content: string): void {
  const full = path.join(repo, file);
  const before = fs.existsSync(full) ? fs.statSync(full).mtimeMs : Date.now();
  fs.writeFileSync(full, content);
  const later = new Date(before + 5_000);
  fs.utimesSync(full, later, later);
}

describe('the review diff, kept while nothing changed', () => {
  it('answers the same diff again when the head, the base and the working tree are as they were', async () => {
    const first = await reviewDiff(repo);
    const second = await reviewDiff(repo);

    expect(first.baseBranch).toBe('main');
    expect(first.ahead).toBe(1);
    expect(second).toBe(first);
  });

  it('sees a file edited again that was already modified, with the same status line and the same size', async () => {
    rewrite('a.txt', 'one\ntwo\nAAA\n');
    const first = await reviewDiff(repo);
    rewrite('a.txt', 'one\ntwo\nBBB\n');

    const second = await reviewDiff(repo);

    expect(second).not.toBe(first);
    expect(second.patch).toContain('+BBB');
    expect(second.patch).not.toContain('+AAA');
  });

  it('sees a new untracked file, and one edited after it was listed', async () => {
    const first = await reviewDiff(repo);
    rewrite('new.txt', 'x\n');
    const second = await reviewDiff(repo);
    rewrite('new.txt', 'x\ny\nz\n');
    const third = await reviewDiff(repo);

    expect(first.files.map(f => f.path)).not.toContain('new.txt');
    // One line, then three: these counted 2 and 4 while the last newline was
    // taken for one more line (review-what-changed.test.ts, case 5).
    expect(second.files.find(f => f.path === 'new.txt')).toMatchObject({ status: 'untracked', additions: 1 });
    expect(third.files.find(f => f.path === 'new.txt')).toMatchObject({ additions: 3 });
  });

  it('sees a commit, and the base moving under the branch', async () => {
    const first = await reviewDiff(repo);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'b']);
    const afterCommit = await reviewDiff(repo);
    git(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'main moves']);
    git(['checkout', '-q', 'feat']);
    const afterBase = await reviewDiff(repo);

    expect(afterCommit.ahead).toBe(2);
    expect(afterCommit.files.map(f => f.path)).toContain('b.txt');
    expect(first.behind).toBe(0);
    expect(afterBase.behind).toBe(1);
  });

  it('keeps the diff of each base apart, and sees a deleted file', async () => {
    const onMain = await reviewDiff(repo, { baseBranch: 'main' });
    const onItself = await reviewDiff(repo, { baseBranch: 'feat' });
    fs.rmSync(path.join(repo, 'a.txt'));
    const deleted = await reviewDiff(repo, { baseBranch: 'main' });

    expect(onMain.ahead).toBe(1);
    expect(onItself.ahead).toBe(0);
    expect(deleted.files.find(f => f.path === 'a.txt')?.status).toBe('deleted');
  });

  it('names the base it was asked for, even when two bases are the same commit', async () => {
    git(['branch', 'trunk', 'main']);

    const onMain = await reviewDiff(repo, { baseBranch: 'main' });
    const onTrunk = await reviewDiff(repo, { baseBranch: 'trunk' });

    expect(onMain.baseBranch).toBe('main');
    expect(onTrunk.baseBranch).toBe('trunk');
  });

  it('still refuses a base that git would read as an option, before any git runs', async () => {
    await expect(reviewDiff(repo, { baseBranch: '--output=/tmp/x' })).rejects.toThrow('invalid base branch');
  });
});

describe('reading a repository an agent is working in', () => {
  it('answers from the cache without writing its index, which a plain git status would', async () => {
    const first = await reviewDiff(repo);
    // A clean file touched and not changed: git status lists nothing, so the
    // diff is the same, but the stat git keeps for it is stale, and a status
    // without --no-optional-locks rewrites the index to refresh it (taking
    // index.lock from anyone committing at that moment).
    const file = path.join(repo, 'a.txt');
    const later = new Date(fs.statSync(file).mtimeMs + 60_000);
    fs.utimesSync(file, later, later);
    const index = path.join(repo, '.git', 'index');
    const before = fs.readFileSync(index);

    const second = await reviewDiff(repo);

    expect(second).toBe(first);
    expect(fs.readFileSync(index).equals(before), 'the cached answer rewrote the index').toBe(true);
    // The witness: a plain status does rewrite it.
    git(['status', '--porcelain']);
    expect(fs.readFileSync(index).equals(before)).toBe(false);
  });
});
