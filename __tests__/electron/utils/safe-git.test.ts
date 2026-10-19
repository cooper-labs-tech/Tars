import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostileRepo, type HostileRepo } from '../../fixtures/hostile-repo';

/**
 * No program a repository names runs in Tars's main process (the Audit's
 * Hole 3 on 2.0.4). Opening Review ran git status and diff on a project
 * folder, and git runs what that repository's configuration names: any agent
 * of the project, or anything it runs, can write .git/config.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  G1. `status` runs core.fsmonitor, or refreshes the index through a clean
 *      filter; `diff` runs diff.external, a diff command or a textconv; `log -p`
 *      and `show` the same.
 *  G2. A filter's clean, smudge or process runs when a file is compared to the
 *      index or checked out (`worktree add`, `add`), or a filter marked
 *      required makes the call fail instead of passing the file as it is.
 *  G3. A hook runs: post-checkout on `worktree add`, pre-commit, commit-msg
 *      and post-commit on a commit, reference-transaction on a ref update; or
 *      gpg.program signs a commit.
 *  G4. Git recurses into a submodule, whose own config runs its fsmonitor.
 *  G5. A file of Review is read through a link out of the repository.
 *  G6. The environment Tars runs in reaches git: GIT_DIR or GIT_WORK_TREE
 *      point it elsewhere, GIT_CONFIG_PARAMETERS turns a program back on, or
 *      the system configuration names one.
 *  G7. Any git call of the main process skips all this: one written
 *      elsewhere, with execFile('git', ...) of its own.
 *  G8. (The Audit's M1 on #463, written before its code.) `log`, `show` or
 *      `whatchanged` verify a signed commit, log.showSignature on, and run the
 *      verifier the repository names: gpg.program and gpg.openpgp.program,
 *      gpg.ssh.program, gpg.x509.program. Review's log is one of them.
 */

import { safeGit, safeGitSync, safeGitEnv } from '../../../electron/utils/safe-git';
import { reviewDiff, fileDiff, repoSummary, resetReviewCache } from '../../../electron/services/git-review';

let h: HostileRepo;
beforeEach(() => {
  h = hostileRepo();
  resetReviewCache();
});

describe('a repository\'s own programs never run', () => {
  it('G1. Review: its status, its diff, a file, its summary and its log run nothing the repository names', async () => {
    const diff = await reviewDiff(h.repo, 'main');
    await fileDiff(h.repo, 'a.txt');
    await repoSummary(h.repo);
    await safeGit(h.repo, ['log', '-p', '-2']);
    await safeGit(h.repo, ['show', 'HEAD~1']);
    expect(h.ran(), 'programs the repository named').toEqual([]);
    // And the work is still read: the change, and the untracked file.
    expect(diff.files.map((f) => f.path).sort()).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
  });

  it('G8. a signed commit\'s verifier never runs: log, show and whatchanged, Review\'s log included', async () => {
    // The witness: the repository's own git runs a verifier for each format.
    execFileSync('git', ['log', '-3'], { cwd: h.repo, stdio: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(h.ran().map((l) => l.split(' ')[0]).sort(), 'the fixture names no verifier git runs').toEqual(expect.arrayContaining(['openpgp-verify', 'ssh-verify', 'x509-verify']));
    fs.rmSync(h.marker, { force: true });
    await repoSummary(h.repo);
    await safeGit(h.repo, ['log', '-3']);
    await safeGit(h.repo, ['log', '--show-signature', '-3']);
    await safeGit(h.repo, ['show', 'HEAD']);
    await safeGit(h.repo, ['whatchanged', '-3']);
    safeGitSync(h.repo, ['log', '-1', '--format=%G?']);
    expect(h.ran(), 'programs the repository named').toEqual([]);
  });

  it('G2, G3. a worktree, an add and a commit: no filter, no hook, no signature, and a required filter does not fail them', async () => {
    const wt = path.join(h.root, 'wt');
    safeGitSync(h.repo, ['worktree', 'add', '-b', 'side', wt, 'HEAD']);
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('one\n');
    await safeGit(h.repo, ['add', 'a.txt', 'b.txt']);
    await safeGit(h.repo, ['commit', '-q', '-m', 'saved'], { env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    safeGitSync(h.repo, ['worktree', 'remove', '--force', wt]);
    expect(h.ran(), 'programs the repository named').toEqual([]);
  });

  it('G4. a submodule is not entered', async () => {
    await safeGit(h.repo, ['status', '--porcelain']);
    await safeGit(h.repo, ['diff', 'HEAD']);
    expect(h.ran().filter((l) => l.startsWith('sub-'))).toEqual([]);
  });

  it('G5. Review never reads a file through a link out of the repository', async () => {
    const shown = await fileDiff(h.repo, 'out/secret.txt').catch((e: Error) => `refused: ${e.message}`);
    expect(shown).not.toContain('OUTSIDE-SECRET');
    const all = await reviewDiff(h.repo, 'main');
    expect(all.patch).not.toContain('OUTSIDE-SECRET');
  });

  it('G6. the environment it runs git in is its own', async () => {
    const env = safeGitEnv({ PATH: '/usr/bin', HOME: '/h', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'", GIT_EXTERNAL_DIFF: 'x', GIT_EDITOR: 'x', GIT_ASKPASS: 'x', SSH_ASKPASS: 'x', LANG: 'fr_FR.UTF-8' });
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS']) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/h', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    const prior = { ...process.env };
    try {
      process.env.GIT_CONFIG_PARAMETERS = `'core.fsmonitor'='${path.join(h.root, 'program.sh')} from-env'`;
      process.env.GIT_DIR = path.join(h.root, 'nowhere');
      await safeGit(h.repo, ['status', '--porcelain']);
    } finally {
      process.env = prior;
    }
    expect(h.ran()).toEqual([]);
  });

  it('G7. no git call of the main process is made anywhere but through safe-git', () => {
    const root = path.resolve('electron');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'dist' && e.name !== 'node_modules') walk(p); continue; }
        if (!/\.ts$/.test(e.name) || p.endsWith(path.join('utils', 'safe-git.ts'))) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (/(execFile|execFileSync|spawn|spawnSync|run)\(\s*['"]git['"]/.test(text)) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
