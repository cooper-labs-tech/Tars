import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pushBlockEnv, loadBranchOf } from '../../../electron/services/load-session';
import { isValidBranchName, resolveWorktreePath } from '../../../electron/utils/worktree-path';

/**
 * What a load task's session is given (trace feature C3, part 2, 27/11): its branch and the environment that blocks
 * any push, through the session's environment alone (never the shared git config, never a hook).
 *
 * How it fails, written before the code:
 *  1. The push block: a push to a named remote or to a URL goes through; a fetch is blocked too; the block is written
 *     into a git config file; an environment that already carries GIT_CONFIG_COUNT has its entries overwritten (its
 *     settings lost) or ignored (the block not applied); a bogus count makes every git command of the session fail.
 *  2. The branch: two arrivals of one task (max_runs over 1, concurrent) take one branch; a task id the worktree guard
 *     refuses (a `:`, a space, `..`, a trailing `.` or `.lock`, a Windows device name, over the length) gives no branch
 *     or one outside `load/<run>/`; the branch lands its worktree outside the project's `.worktrees`.
 */

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });

describe('the push block', () => {
  it('1: a push to a remote or a URL is refused, a fetch is not, and nothing is written to a git config', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-push-'));
    execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'origin.git')]);
    execFileSync('git', ['clone', '-q', path.join(dir, 'origin.git'), path.join(dir, 'work')], { stdio: 'ignore' });
    const work = path.join(dir, 'work');
    git(work, ['commit', '-q', '--allow-empty', '-m', 'one']);
    expect(git(work, ['push', '-q', 'origin', 'HEAD:refs/heads/main']).status).toBe(0);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'two']);
    const env = { ...process.env, ...pushBlockEnv(process.env) };
    expect(git(work, ['push', 'origin', 'HEAD:refs/heads/main'], env).status).not.toBe(0);
    expect(git(work, ['push', path.join(dir, 'origin.git'), 'HEAD:refs/heads/other'], env).status).not.toBe(0);
    expect(execFileSync('git', ['-C', path.join(dir, 'origin.git'), 'branch', '--list'], { encoding: 'utf8' }).trim()).toBe('main');
    expect(execFileSync('git', ['-C', path.join(dir, 'origin.git'), 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('one');
    expect(git(work, ['fetch', 'origin'], env).status).toBe(0);
    expect(fs.readFileSync(path.join(work, '.git', 'config'), 'utf8')).not.toContain('pushInsteadOf');
  });

  it('1: entries already in the environment are kept, the block added after them; a bogus count is replaced', () => {
    expect(pushBlockEnv({})).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.tars-load-push-blocked://.pushInsteadOf', GIT_CONFIG_VALUE_0: '' });
    const kept = pushBlockEnv({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'x' });
    expect(kept).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'url.tars-load-push-blocked://.pushInsteadOf', GIT_CONFIG_VALUE_2: '' });
    expect(pushBlockEnv({ GIT_CONFIG_COUNT: 'many' })).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.tars-load-push-blocked://.pushInsteadOf', GIT_CONFIG_VALUE_0: '' });
  });
});

describe('the branch of an arrival', () => {
  const RUN = '20261127-140000-a1b2';
  it('2: one per arrival, under load/<run>/, valid for the worktree guard, whatever the task id', () => {
    expect(loadBranchOf(RUN, 'retry-header', 1)).toBe(`load/${RUN}/retry-header-1`);
    expect(loadBranchOf(RUN, 'retry-header', 2)).not.toBe(loadBranchOf(RUN, 'retry-header', 1));
    for (const id of ['repo:issue 42', 'a..b', 'ends.', 'x.lock', 'nul', 'CON', ' spaced ', 'é/ü', '-dash', 'a'.repeat(300), '...']) {
      const b = loadBranchOf(RUN, id, 3);
      expect(b, id).toMatch(new RegExp(`^load/${RUN}/[^/]+-3$`));
      expect(isValidBranchName(b, 'win32'), `${id} on Windows`).toBe(true);
      expect(isValidBranchName(b, 'linux'), id).toBe(true);
      const where = resolveWorktreePath('/work/atlas', b);
      expect(where, id).toBeTruthy();
      expect(where!.startsWith(path.join('/work/atlas', '.worktrees') + path.sep), id).toBe(true);
    }
  });
});
