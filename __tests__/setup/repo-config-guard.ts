import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import { configChange, sharedGitConfig } from './repo-config';

/**
 * A test file never changes the git configuration of the repository the suite runs in.
 *
 * Found on 2026-10-28 in the main checkout's .git/config: a remote `a` with the URL `testx::foo` and
 * `protocol.testx.allow=always`, which together run a program named git-remote-testx on that
 * repository's next fetch. Every worktree shares that file, so a git a test starts with no cwd, or
 * with one inside the checkout, writes into it, and the run passed. A rule each file has to remember
 * is how home-isolation.ts's class got three members, so this reads the file as the test file starts
 * and again when it ends, and fails the file when anything but a tracking branch changed in it
 * (another agent's `git push -u` adds those while the suite runs). It names the file, the
 * configuration and the entries, and it puts nothing back: what to undo is for whoever reads it.
 *
 * What it cannot tell: which file of those running at once wrote it, when several do (each one that
 * ran across the write fails, the writer among them), nor a write into another repository of the
 * user's. See repo-config-guard.test.ts for the ways it was written against.
 */

const config = sharedGitConfig(process.cwd());
const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const before = config ? read(config) : '';

afterAll(() => {
  if (!config) return;
  const change = configChange(before, read(config));
  if (!change) return;
  throw new Error(
    `This test file changed the git configuration of the repository the suite runs in, ${config}, which every worktree shares:`
    + `${change.added.length ? `\n  added: ${change.added.join(', ')}` : ''}`
    + `${change.removed.length ? `\n  removed: ${change.removed.join(', ')}` : ''}`
    + '\nA test writes into a repository of its own, made in its temporary folder (fixtures/hostile-repo.ts does), and runs every git with that repository as its cwd.',
  );
});
