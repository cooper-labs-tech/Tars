/**
 * A project's git, for the first run (electron/services/project-git.ts): making a plain folder a repository
 * (project:gitInit) and saying what PR delivery still lacks (project:readiness). From QA's fresh-install report
 * (fresh-install-turnkey.md, B4 and W4) and Tars-Frontend's request (first-run-window.md): a new user's folder is
 * usually not a repository, New team then failed five members with git's raw words, and nothing checked a remote or
 * whether `gh` is signed in, so the workflow's agents could not open a PR and improvised.
 *
 * How it fails, written before the code (10/11), git init:
 * 1. Any folder the window names is made a repository: only one of Tars's projects is, else `not-a-project`, nothing
 *    written.
 * 2. A repository, or a folder inside one, is initialised again (a repository inside another, the parent's history
 *    hidden from the agents): refused, `already-a-repository`, nothing written.
 * 3. No git on the machine reads as git's spawn error: `git-missing`.
 * 4. With no git identity on the machine the first commit fails, or Tars writes one into the user's config: the
 *    first commit alone carries one, nothing is written to any config, and the answer says whose identity it is.
 * 5. An empty folder gets no first commit, and no worktree can then be made: the commit is allowed empty.
 * 6. The folder's own .gitignore is not honoured: what it ignores is committed.
 * 7. The branch is whatever the machine's default is: it is `main`, as the window says.
 * 8. A path with a space or a quote breaks the command, or runs one: argv only.
 * Readiness:
 * 9. A folder that is not a project is read: `not-a-project`.
 * 10. A plain folder reads as ready, or its missing list is not in the order the user fixes it: repository, first
 *     commit, remote, then gh.
 * 11. A repository with no commit reads as ready for worktrees.
 * 12. The remote: none, or the first of several instead of origin; and whether it is GitHub (gh's PRs need it), with
 *     its owner/repo.
 * 13. gh read from its exit code alone: missing, signed out and signed in are told apart from its own words, the
 *     account named.
 * 14. No git: installed false, and nothing else claimed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitInit, projectReadiness, type ProjectGitOptions } from '../../../electron/services/project-git';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
let root: string;
let projects: Set<string>;
let opts: ProjectGitOptions;

function folder(name: string): string {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  projects.add(p);
  return p;
}

/** A stand-in gh that answers `auth status` as the real one does (measured on gh 2.88.1). */
function fakeGh(name: string, out: string, code: number): string {
  const file = path.join(root, `gh-${name}`);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(out)} >&2\nexit ${code}\n`, { mode: 0o755 });
  return file;
}

beforeEach(() => {
  // No machine-wide git config: the identity is the test's to give or not (item 4).
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-project-git-')));
  projects = new Set();
  // No gh unless a test gives one: a path where there is none.
  opts = { isProject: p => projects.has(p), gh: path.join(root, 'no-gh-here', 'gh') };
});

describe('git init for a project', () => {
  it('1. refuses a folder that is not a project, and writes nothing', async () => {
    const p = path.join(root, 'stranger');
    fs.mkdirSync(p);
    expect(await gitInit(p, opts)).toMatchObject({ success: false, code: 'not-a-project' });
    expect(fs.existsSync(path.join(p, '.git'))).toBe(false);
  });

  it('2. refuses a repository, and a folder inside one', async () => {
    const repo = folder('repo');
    git(repo, 'init', '-q');
    expect(await gitInit(repo, opts)).toMatchObject({ success: false, code: 'already-a-repository' });
    const inner = folder('repo/packages/web');
    expect(await gitInit(inner, opts)).toMatchObject({ success: false, code: 'already-a-repository' });
    expect(fs.existsSync(path.join(inner, '.git'))).toBe(false);
  });

  it('3. says git is missing', async () => {
    const p = folder('no-git');
    expect(await gitInit(p, { ...opts, git: path.join(root, 'nowhere', 'git') })).toMatchObject({ success: false, code: 'git-missing' });
    expect(fs.existsSync(path.join(p, '.git'))).toBe(false);
  });

  it('4, 5, 7. makes main with a first commit, an empty folder too, an identity for that commit only when there is none', async () => {
    const p = folder('empty');
    const r = await gitInit(p, opts);
    expect(r).toMatchObject({ success: true, branch: 'main', files: 0, identity: 'tars' });
    expect(git(p, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(p, 'log', '--format=%s|%an')).toBe('Initial commit|Tars');
    expect(r.success && r.commit).toBe(git(p, 'rev-parse', 'HEAD'));
    // No identity written anywhere: the repository's config, nor a global one in this home.
    expect(fs.readFileSync(path.join(p, '.git', 'config'), 'utf8')).not.toMatch(/\[user\]/);
    expect(fs.existsSync(path.join(os.homedir(), '.gitconfig'))).toBe(false);
  });

  it('4. uses the user\'s own identity when git has one', async () => {
    const p = folder('mine');
    fs.writeFileSync(path.join(p, 'README.md'), '# mine\n');
    const r = await gitInit(p, { ...opts, env: { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' } });
    expect(r).toMatchObject({ success: true, files: 1, identity: 'yours' });
    expect(git(p, 'log', '--format=%an')).toBe('Ada');
  });

  it('6, 8. honours the folder\'s .gitignore, in a path with a space and a quote', async () => {
    const p = folder("Bob's Projects/my app");
    fs.writeFileSync(path.join(p, '.gitignore'), 'secrets.env\nnode_modules/\n');
    fs.writeFileSync(path.join(p, 'secrets.env'), 'KEY=1\n');
    fs.mkdirSync(path.join(p, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(p, 'node_modules', 'x', 'i.js'), '');
    fs.writeFileSync(path.join(p, 'index.js'), 'console.log(1)\n');
    const r = await gitInit(p, opts);
    expect(r).toMatchObject({ success: true, files: 2 });
    expect(git(p, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'index.js']);
  });
});

describe('what a project lacks for PR delivery', () => {
  it('9. refuses a folder that is not a project', async () => {
    expect(await projectReadiness(path.join(root, 'stranger'), opts)).toMatchObject({ success: false, code: 'not-a-project' });
  });

  it('10. a plain folder lacks everything, in the order the user fixes it', async () => {
    const r = await projectReadiness(folder('plain'), opts);
    expect(r).toMatchObject({
      success: true,
      git: { installed: true, repository: false, hasCommit: false, branch: null },
      remote: null,
      gh: { installed: false, signedIn: null },
      missing: ['repository', 'commit', 'remote', 'gh'],
    });
  });

  it('11, 12. a repository with no commit, then with a commit and remotes: origin first, its GitHub repo named', async () => {
    const p = folder('app');
    git(p, 'init', '-q', '-b', 'main');
    expect(await projectReadiness(p, opts)).toMatchObject({ git: { repository: true, hasCommit: false }, missing: ['commit', 'remote', 'gh'] });
    git(p, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one');
    git(p, 'remote', 'add', 'aaa', 'https://gitlab.example.com/a/b.git');
    git(p, 'remote', 'add', 'origin', 'git@github.com:octo/app.git');
    expect(await projectReadiness(p, opts)).toMatchObject({
      git: { repository: true, hasCommit: true, branch: 'main' },
      remote: { name: 'origin', url: 'git@github.com:octo/app.git', github: 'octo/app' },
      missing: ['gh'],
    });
    git(p, 'remote', 'remove', 'origin');
    expect(await projectReadiness(p, opts)).toMatchObject({ remote: { name: 'aaa', github: null } });
  });

  it.skipIf(process.platform === 'win32')('13. tells gh missing, signed out and signed in apart from its own words', async () => {
    const p = folder('gh');
    const signedIn = fakeGh('in', 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true', 0);
    const signedOut = fakeGh('out', 'You are not logged into any GitHub hosts. To log in, run: gh auth login', 1);
    const badToken = fakeGh('bad', 'github.com\n  X Failed to log in to github.com account octocat (keyring)\n  - The token in keyring is invalid.', 1);
    expect(await projectReadiness(p, { ...opts, gh: path.join(root, 'nowhere', 'gh') })).toMatchObject({ gh: { installed: false, signedIn: null, account: null } });
    expect(await projectReadiness(p, { ...opts, gh: signedOut })).toMatchObject({ gh: { installed: true, signedIn: false, account: null } });
    expect(await projectReadiness(p, { ...opts, gh: badToken })).toMatchObject({ gh: { installed: true, signedIn: false, account: 'octocat', error: expect.stringMatching(/invalid/) } });
    const r = await projectReadiness(p, { ...opts, gh: signedIn });
    expect(r).toMatchObject({ gh: { installed: true, signedIn: true, account: 'octocat' } });
    expect(r.success && r.missing).not.toContain('gh');
    expect(r.success && r.missing).not.toContain('gh-sign-in');
    expect(await projectReadiness(p, { ...opts, gh: signedOut })).toMatchObject({ missing: expect.arrayContaining(['gh-sign-in']) });
  });

  it('14. no git: not installed, nothing else claimed', async () => {
    const r = await projectReadiness(folder('nogit'), { ...opts, git: path.join(root, 'nowhere', 'git') });
    expect(r).toMatchObject({ success: true, git: { installed: false, repository: false, hasCommit: false, branch: null }, remote: null, missing: ['git'] });
  });
});
