import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repoSummary, reviewDiff, fileDiff } from '../../../electron/services/git-review';

/**
 * repoSummary() used to skip the "is this even a git repository" check that
 * reviewDiff() has: every git call goes through tryGit(), which swallows a
 * failure and returns '', so a plain directory came back as a "successful"
 * summary with branch "unknown" and nothing else instead of an error - the
 * Review panel then showed a blank, misleading git state for a project that
 * was never a git repo at all.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-git-review-'));
const notGitDir = path.join(tmp, 'not-a-repo');
const gitDir = path.join(tmp, 'a-repo');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd });
}

beforeAll(() => {
  fs.mkdirSync(notGitDir, { recursive: true });
  fs.writeFileSync(path.join(notGitDir, 'file.txt'), 'hello\n');

  fs.mkdirSync(gitDir, { recursive: true });
  git(gitDir, ['init', '-q', '-b', 'main']);
  git(gitDir, ['config', 'user.email', 't@t.com']);
  git(gitDir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(gitDir, 'a.txt'), 'one\n');
  git(gitDir, ['add', '-A']);
  git(gitDir, ['commit', '-qm', 'init']);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repoSummary', () => {
  it('rejects a directory that is not a git repository', async () => {
    await expect(repoSummary(notGitDir)).rejects.toThrow('not a git repository');
  });

  it('rejects a path that does not exist', async () => {
    await expect(repoSummary(path.join(tmp, 'nope'))).rejects.toThrow('no such directory');
  });

  it('summarizes a real repository', async () => {
    const summary = await repoSummary(gitDir);
    expect(summary.branch).toBe('main');
    expect(summary.commits[0]?.subject).toBe('init');
  });
});

describe('reviewDiff', () => {
  it('rejects a directory that is not a git repository', async () => {
    await expect(reviewDiff(notGitDir)).rejects.toThrow('not a git repository');
  });
});

describe('fileDiff', () => {
  it('rejects a directory that is not a git repository instead of showing the file as an untracked addition', async () => {
    await expect(fileDiff(notGitDir, 'file.txt')).rejects.toThrow('not a git repository');
  });

  it('shows an untracked file in a real repository as an addition', async () => {
    fs.writeFileSync(path.join(gitDir, 'untracked.txt'), 'new stuff\n');
    const patch = await fileDiff(gitDir, 'untracked.txt');
    expect(patch).toContain('+new stuff');
  });
});
