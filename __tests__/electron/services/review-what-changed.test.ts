import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reviewDiff, fileDiff, resetReviewCache, type ReviewDiff } from '../../../electron/services/git-review';

/**
 * What the Review page lists as changed, and the patch it shows for a file.
 *
 * The Audit reproduced the page in a sandboxed Tars on throwaway repositories (DIAG-REVIEW.md, 01/10): every case
 * below came back without an error, and wrong.
 *
 * How this can fail, written before the code:
 * 1. a renamed file is listed as "old => new", modified, +0 -0, and its patch is empty;
 * 2. a name with accents comes back quoted and escaped ("caf\303\251 ..."), and its patch is empty;
 * 3. an untracked binary is counted in "lines" and its bytes are shown as added text;
 * 4. a file changed both in a commit since the base and in the working tree is counted once, by the larger of the two;
 *    and a fix that adds the two counts doubles the unstaged changes of a branch with no base;
 * 5. a one-line untracked file counts +2, and its patch ends on an empty added line;
 * 6. in a repository with no commit yet, a staged file is missing and the branch reads "HEAD".
 * And what must not change: a modified, a deleted, a tracked binary and an oddly named file, and the commits ahead.
 *
 * Real git, real repositories in a temporary folder, the real reviewDiff and fileDiff.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-review-changed-')));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (repo: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
};
const binary = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i % 7 === 0 ? 0 : 65 + (i % 26))));

/** A branch with work since main: a rename, an accented name, edits committed and not, untracked text and binary. */
const branch = path.join(tmp, 'branch');
/** On main, no base to compare to: one file staged, then changed again without staging. */
const onMain = path.join(tmp, 'on-main');
/** git init, one file staged, one untracked, no commit at all. */
const fresh = path.join(tmp, 'no-commit');

beforeAll(() => {
  fs.mkdirSync(branch);
  git(branch, 'init', '-q', '-b', 'main');
  write(branch, 'old-name.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
  write(branch, 'keep.txt', '1\n2\n3\n');
  write(branch, 'gone.txt', 'bye\n');
  write(branch, 'tracked.bin', binary);
  write(branch, "it's a dir/with space.txt", 'x\n');
  git(branch, 'add', '-A');
  git(branch, 'commit', '-qm', 'base');
  git(branch, 'checkout', '-qb', 'feat');
  git(branch, 'mv', 'old-name.txt', 'new-name.txt');
  write(branch, 'café é.txt', 'é\n');
  write(branch, 'keep.txt', '1\nTWO\n3\n');
  git(branch, 'rm', '-q', 'gone.txt');
  write(branch, 'tracked.bin', Buffer.concat([binary, Buffer.from([0, 1, 2])]));
  git(branch, 'add', '-A');
  git(branch, 'commit', '-qm', 'work');
  // Still uncommitted: one more line in keep.txt, an edit in the oddly named file, untracked text and binary.
  write(branch, 'keep.txt', '1\nTWO\n3\n4\n');
  write(branch, "it's a dir/with space.txt", 'x\ny\n');
  write(branch, 'one.txt', 'only line\n');
  write(branch, 'image.bin', binary);

  fs.mkdirSync(onMain);
  git(onMain, 'init', '-q', '-b', 'main');
  write(onMain, 'f.txt', 'a\n');
  git(onMain, 'add', '-A');
  git(onMain, 'commit', '-qm', 'base');
  write(onMain, 'f.txt', 'a\nb\n');
  git(onMain, 'add', 'f.txt');
  write(onMain, 'f.txt', 'a\nb\nc\n');

  fs.mkdirSync(fresh);
  git(fresh, 'init', '-q', '-b', 'main');
  write(fresh, 'staged.txt', 's\n');
  git(fresh, 'add', 'staged.txt');
  write(fresh, 'untracked.txt', 'u\n');
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => resetReviewCache());

const byPath = (diff: ReviewDiff) => new Map(diff.files.map((f) => [f.path, f]));

describe('the list of what changed', () => {
  it('1. a renamed file is listed once, under its new name, as renamed', async () => {
    const files = byPath(await reviewDiff(branch));

    expect([...files.keys()].filter((p) => p.includes('=>'))).toEqual([]);
    expect(files.get('new-name.txt')).toMatchObject({ status: 'renamed', additions: 0, deletions: 0 });
    expect(files.has('old-name.txt')).toBe(false);
  });

  it('2. a name with accents is listed as it is', async () => {
    const files = byPath(await reviewDiff(branch));

    expect(files.get('café é.txt')).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect([...files.keys()].filter((p) => p.includes('\\') || p.startsWith('"'))).toEqual([]);
  });

  it('3. an untracked binary counts no lines', async () => {
    const files = byPath(await reviewDiff(branch));

    expect(files.get('image.bin')).toMatchObject({ status: 'untracked', additions: 0, deletions: 0 });
  });

  it('4. a file changed in a commit and again since counts both, and the totals add every file up', async () => {
    const diff = await reviewDiff(branch);
    const files = byPath(diff);

    // TWO replaced 2 in the commit, 4 was added since: two lines in, one out, from main to the working tree.
    expect(files.get('keep.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(diff.totalAdditions).toBe(diff.files.reduce((n, f) => n + f.additions, 0));
    expect(diff.totalDeletions).toBe(diff.files.reduce((n, f) => n + f.deletions, 0));
  });

  it('4. with no base, a change staged then changed again is counted once', async () => {
    const diff = await reviewDiff(onMain);

    expect(diff.baseBranch).toBeNull();
    expect(byPath(diff).get('f.txt')).toMatchObject({ additions: 2, deletions: 0 });
  });

  it('5. a one-line untracked file counts one line', async () => {
    expect(byPath(await reviewDiff(branch)).get('one.txt')).toMatchObject({ status: 'untracked', additions: 1 });
  });

  it('6. a repository with no commit lists its staged file and names its branch', async () => {
    const diff = await reviewDiff(fresh);
    const files = byPath(diff);

    expect(diff.branch).toBe('main');
    expect(files.get('staged.txt')).toMatchObject({ status: 'added', additions: 1 });
    expect(files.get('untracked.txt')).toMatchObject({ status: 'untracked', additions: 1 });
  });

  it('what must not change: a modified, a deleted, a tracked binary, an oddly named file, the commits ahead', async () => {
    const diff = await reviewDiff(branch);
    const files = byPath(diff);

    expect(diff.branch).toBe('feat');
    expect(diff.baseBranch).toBe('main');
    expect(diff.ahead).toBe(1);
    expect(files.get('gone.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(files.get('tracked.bin')).toMatchObject({ status: 'modified', additions: 0, deletions: 0 });
    expect(files.get("it's a dir/with space.txt")).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
  });
});

describe('the patch of one file', () => {
  it('1. a renamed file shows the rename', async () => {
    const patch = await fileDiff(branch, 'new-name.txt', 'main');

    expect(patch).toContain('rename from old-name.txt');
    expect(patch).toContain('rename to new-name.txt');
  });

  it('2. a name with accents shows its content, under its name as it is', async () => {
    const patch = await fileDiff(branch, 'café é.txt', 'main');

    expect(patch).toContain('+é');
    expect(patch).toContain('+++ b/café é.txt');
  });

  it('3. an untracked binary is said to be binary, not shown as text', async () => {
    const patch = await fileDiff(branch, 'image.bin', 'main');

    expect(patch).toMatch(/binary/i);
    expect(patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))).toEqual([]);
  });

  it('4. a file changed in a commit and again since shows each line once', async () => {
    const patch = await fileDiff(branch, 'keep.txt', 'main');
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

    expect(added).toEqual(['+TWO', '+4']);
  });

  it('5. a one-line untracked file ends on its line, not on an empty one', async () => {
    const lines = (await fileDiff(branch, 'one.txt', 'main')).split('\n');

    expect(lines.at(-1)).toBe('+only line');
  });

  it('6. a staged file in a repository with no commit shows its content', async () => {
    expect(await fileDiff(fresh, 'staged.txt')).toContain('+s');
  });
});
