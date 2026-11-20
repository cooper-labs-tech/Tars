import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reviewDiff, fileDiff, resetReviewCache } from '../../../electron/services/git-review';
import { cannotSymlink } from '../../setup/symlink-privilege';

/**
 * The Review page reads what is in the repository, and says when a patch was cut.
 *
 * The Audit's gate of #272 (GATE-PR272.md, 01/10) found two defects older than it, both measured on main:
 * `review:file` showed a file outside the repository when the renderer named it with `../..` (the untracked fallback
 * read `path.join(repoPath, file)`), and a patch larger than git()'s 8 MB buffer came back empty, marked as not cut.
 *
 * How this can fail, written before the code:
 * 1. a path with `../..` gets a file outside the repository shown, through the fallback for untracked files;
 * 2. an absolute path does the same;
 * 3. a link inside the repository that points out has its target's content shown, or its target's lines counted in
 *    the list;
 * 4. a file reached through a linked folder inside the repository, a folder that points out, is shown;
 * 5. a patch larger than git()'s 8 MB buffer comes back empty and marked as not cut, in the list's patch; and a file's
 *    own patch that large is replaced by "file is too large to show", as if the file were untracked.
 * And what must not change: an untracked file inside the repository is shown, as before.
 *
 * Real git, real repositories and links in a temporary folder, the real reviewDiff and fileDiff.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-review-stays-')));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const SECRET = 'SECRET OUTSIDE ONE\nSECRET OUTSIDE TWO\nSECRET OUTSIDE THREE\n';
const repo = path.join(tmp, 'repo');
const big = path.join(tmp, 'big');
/** Over git()'s 8 MB buffer: 300 000 lines of 31 bytes, 9.3 MB. */
const BIG_LINES = 300_000;

beforeAll(() => {
  fs.writeFileSync(path.join(tmp, 'secret-outside.txt'), SECRET);
  fs.mkdirSync(path.join(tmp, 'outside-dir'));
  fs.writeFileSync(path.join(tmp, 'outside-dir', 'secret.txt'), SECRET);

  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'inside.txt'), 'inside\n');
  // Only where this account may make a link (symlink-privilege.ts): 3 and 4 need them, the rest runs everywhere.
  if (!cannotSymlink()) {
    fs.symlinkSync('../secret-outside.txt', path.join(repo, 'link-out'));
    fs.symlinkSync('../outside-dir', path.join(repo, 'dir-out'));
  }

  fs.mkdirSync(big);
  git(big, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(big, 'big.txt'), 'first\n');
  git(big, 'add', '-A');
  git(big, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(big, 'big.txt'), Array.from({ length: BIG_LINES }, (_, i) => `line ${String(i).padStart(24, '0')}`).join('\n') + '\n');
});

afterAll(async () => {
  // Retried, and not synchronously: a patch past the cut ends git at
  // maxBuffer, and execFile answers without waiting for git to exit. On
  // Windows the folder git works in cannot be removed until it has, and rmSync
  // does not retry that refusal at all (EBUSY on the folder's first rmdir);
  // fs.promises.rm retries the whole removal, here for at most 5.5 s.
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  resetReviewCache();
});

describe('review:file reads the repository and nothing else', () => {
  it('1. a path with ../.. is refused, and the file outside is never shown', async () => {
    // Refused before git or the disk is asked: a folder outside that does not exist is refused too, not read as empty.
    for (const file of ['../secret-outside.txt', 'sub/../../secret-outside.txt', '../outside-dir/secret.txt', '../no-such-folder/x.txt']) {
      const shown = await fileDiff(repo, file).catch((e: Error) => `refused: ${e.message}`);
      expect(shown, file).toMatch(/^refused: /);
      expect(shown, file).not.toContain('SECRET OUTSIDE');
    }
  });

  it('2. an absolute path is refused, even one that names a file inside', async () => {
    for (const file of [path.join(tmp, 'secret-outside.txt'), path.join(repo, 'inside.txt')]) {
      const shown = await fileDiff(repo, file).catch((e: Error) => `refused: ${e.message}`);
      expect(shown, file).toMatch(/^refused: /);
      expect(shown, file).not.toContain('SECRET OUTSIDE');
    }
  });

  it.skipIf(cannotSymlink())('3. a link that points out is shown as the link it is: its target path, never what it points to', async () => {
    const shown = await fileDiff(repo, 'link-out');

    // The target as the link holds it: Node writes a Windows link's target
    // with backslashes (Windows links take no forward slash), and git shows it so.
    expect(shown).toContain(process.platform === 'win32' ? '+..\\secret-outside.txt' : '+../secret-outside.txt');
    expect(shown).not.toContain('SECRET OUTSIDE');
    const listed = (await reviewDiff(repo)).files.find((f) => f.path === 'link-out');
    expect(listed, 'the link is listed').toMatchObject({ status: 'untracked', additions: 1 });
  });

  it.skipIf(cannotSymlink())('4. a file reached through a linked folder that points out is refused', async () => {
    const shown = await fileDiff(repo, 'dir-out/secret.txt').catch((e: Error) => `refused: ${e.message}`);

    expect(shown).toMatch(/^refused: /);
    expect(shown).not.toContain('SECRET OUTSIDE');
  });

  it('what must not change: an untracked file inside the repository is shown', async () => {
    expect(await fileDiff(repo, 'inside.txt')).toContain('+inside');
  });
});

describe('a patch larger than git\'s buffer', () => {
  it('5. the list\'s patch is cut and says so, rather than empty and "not cut"', async () => {
    const diff = await reviewDiff(big);

    expect(diff.truncated).toBe(true);
    expect(diff.patch.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    expect(diff.patch.endsWith('… patch truncated')).toBe(true);
    expect(diff.files).toEqual([expect.objectContaining({ path: 'big.txt', additions: BIG_LINES, deletions: 1 })]);
  }, 30_000);

  it('5. a file\'s own patch is cut and says so, rather than read as an untracked file too large to show', async () => {
    const shown = await fileDiff(big, 'big.txt');

    expect(shown.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    expect(shown).toContain('+line 000000000000000000000000');
    expect(shown.endsWith('… patch truncated')).toBe(true);
  }, 30_000);
});
