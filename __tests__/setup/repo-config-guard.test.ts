import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { configEntries, configChange, sharedGitConfig } from './repo-config';

/**
 * A test file never changes the git configuration of the repository the suite runs in.
 *
 * Found on 2026-10-28 in the main checkout's .git/config: `[remote "a"] url = testx::foo` and
 * `[protocol "testx"] allow = always`, a remote that runs a program named git-remote-testx. Every
 * worktree of the repository shares that one file, so a git started from any of them with no cwd of
 * its own, or with one inside the checkout, writes into it. safe-git.test.ts, run alone from a
 * worktree, leaves that file byte for byte as it was (its writes go to its own throwaway repository,
 * fixtures/hostile-repo.ts); the names are those of the Audit's probe of #495 on 2026-10-20, its
 * cases A and A2. Whoever wrote them, nothing failed: a suite that changes the repository's own
 * configuration passed. repo-config-guard.ts makes it fail, file by file.
 *
 * How it can fail, each written down before the guard was:
 * 1. A test runs git with no cwd (so in the checkout) and writes the repository's configuration,
 *    `git config remote.a.url testx::foo`, and the run passes.
 * 2. The same from a worktree, where every agent runs the suite: there `.git` is a file, and the
 *    configuration all worktrees share is the main checkout's (its `commondir`), which the guard
 *    does not look at.
 * 3. A key changed or removed (`git config --unset`) is not seen: only additions are.
 * 4. A tracking branch another process adds while the suite runs (an agent's `git push -u` writes
 *    branch.<name>.remote and .merge into that shared file) fails the run.
 * 5. A test's own throwaway repository is taken for the real one: a test that writes its own
 *    repository's configuration, as it should, fails.
 * 6. Outside a git checkout (a source tarball), the guard throws at load and every file fails.
 * 7. The failure says neither which file nor which configuration nor what changed in it.
 */

const FIXTURES = path.resolve('__tests__/setup/fixtures/repo-config-guard');
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository of its own in this file's temporary folder, one commit, and a key the fixtures may remove. */
function throwawayRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-guard-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'core.guardprobe', 'kept']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'one']);
  return repo;
}

/**
 * vitest, run in a child on the fixtures named, with the guard as its only setup file and a throwaway
 * repository as the folder it runs in: that repository plays the suite's own, so nothing a fixture
 * writes reaches the real one. Its output as plain text (see tmpdir-isolation.test.ts on reporters).
 */
function runFixtures(cwd: string, fixtures: string[]): { status: number | null; output: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const child = spawnSync(process.execPath, [VITEST, 'run', '--config', path.join(FIXTURES, 'vitest.config.mts'), '--reporter=default', ...fixtures], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: child.status, output: stripVTControlCharacters(`${child.stdout}${child.stderr}`) };
}

describe('the repository\'s own git configuration', () => {
  it('2. is the shared one, found from a worktree as from the main checkout and from a folder inside either', () => {
    const repo = throwawayRepo();
    const worktree = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
    git(repo, ['worktree', 'add', '-q', '-b', 'side', worktree]);
    fs.mkdirSync(path.join(worktree, 'deep', 'er'), { recursive: true });
    const shared = fs.realpathSync(path.join(repo, '.git', 'config'));
    expect(fs.realpathSync(sharedGitConfig(repo)!)).toBe(shared);
    expect(fs.realpathSync(sharedGitConfig(worktree)!)).toBe(shared);
    expect(fs.realpathSync(sharedGitConfig(path.join(worktree, 'deep', 'er'))!)).toBe(shared);
    // git's own answer for the checkout this suite runs in.
    const common = git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    expect(fs.realpathSync(sharedGitConfig(process.cwd())!)).toBe(fs.realpathSync(path.join(common, 'config')));
    git(repo, ['worktree', 'remove', '--force', worktree]);
  });

  it('6. is none outside a checkout, and asking does not throw', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    expect(sharedGitConfig(plain)).toBeNull();
  });

  it('3, 4. a change is an entry added, changed or removed, and a branch\'s entries are not one', () => {
    const before = '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.invalid/x.git\n';
    expect(configEntries(before)).toEqual(['core.bare=false', 'remote.origin.url=https://example.invalid/x.git']);
    expect(configChange(before, `${before}[branch "side"]\n\tremote = origin\n\tmerge = refs/heads/side\n`)).toBeNull();
    expect(configChange(before, before.replace('bare = false', 'bare = true'))).toEqual({ added: ['core.bare=true'], removed: ['core.bare=false'] });
    expect(configChange(before, '[core]\n\tbare = false\n')).toEqual({ added: [], removed: ['remote.origin.url=https://example.invalid/x.git'] });
    expect(configChange(before, `${before}[remote "a"]\n\turl = testx::foo\n[protocol "testx"]\n\tallow = always\n`))
      .toEqual({ added: ['remote.a.url=testx::foo', 'protocol.testx.allow=always'], removed: [] });
  });

  it('1, 3, 7. a file that writes into it fails, by name, with the configuration and what changed', () => {
    const repo = throwawayRepo();
    const run = runFixtures(repo, ['writes-remote', 'unsets-key']);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/writes-remote\.fixture\.ts[\s\S]*changed the git configuration of the repository the suite runs in/);
    expect(run.output).toContain(fs.realpathSync(path.join(repo, '.git', 'config')));
    expect(run.output).toContain('remote.a.url=testx::foo');
    expect(run.output).toContain('protocol.testx.allow=always');
    expect(run.output).toMatch(/unsets-key\.fixture\.ts[\s\S]*removed: core\.guardprobe=kept/);
  });

  it('4, 5. a file that writes its own repository, or adds a tracking branch, passes', () => {
    const repo = throwawayRepo();
    const run = runFixtures(repo, ['own-repo', 'adds-branch']);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/Test Files {2}2 passed/);
  });
});
