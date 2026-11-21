import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Review, every repository of a project (2.0.4, the frames "Review · projects
 * and their repositories" of #457, the Audit's requirements for 2.0.4, section
 * 2): a project is one repository, holds repositories at any depth (1212's
 * holds 29), has no git, or is gone; the search covers every repository's
 * name and path and every changed file, in every project, with no limit.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  R1. The scan stops at a depth or a count, misses a repository deep down,
 *      descends into node_modules, .git, .worktrees, .claude/worktrees or a
 *      hidden folder, looks inside a repository for more, or follows a link
 *      (R2.2: a link to the home would bring its repositories in).
 *  R2. A folder it cannot open makes the whole scan fail, or is not said; a
 *      repository found is not said until the scan ends (the frames: each
 *      shows as it is found).
 *  R3. The project's state is wrong: gone, no git, one repository, or
 *      repositories; a folder gone is taken for one without git.
 *  R4. A repository's state is wrong or costs a program: its branch, its
 *      changed files (status, lines added and removed), commits ahead of its
 *      base, the agents working there; a program its config names runs
 *      (core.fsmonitor, the guard of #463).
 *  R5. The search misses a repository's name or path, or a changed file, is
 *      cut at a number of results, is case sensitive, takes a query starting
 *      with a dash for an option, or answers an empty query with everything.
 *  R6. (R2.4) Review reads a repository the window names that is not one Tars
 *      found in a project or an agent's worktree.
 */

import { scanProject, repositoryState, searchRepositories, mayReview } from '../../../electron/services/review-repositories';

const home = () => os.homedir();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
const put = (file: string, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

function repo(dir: string, files: Record<string, string> = { 'README.md': '# r\n' }): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) put(path.join(dir, f), t);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

let project: string;

beforeEach(() => {
  project = path.join(home(), 'projects', `p-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(project, { recursive: true });
});

describe('R1, R2, R3. the scan', () => {
  it('finds every repository at any depth, skips the folders it must, and does not look inside a repository', async () => {
    const deep = path.join(project, ...Array.from({ length: 12 }, (_, i) => `d${i}`), 'deep-repo');
    repo(deep);
    repo(path.join(project, 'services', 'api'));
    const outer = repo(path.join(project, 'contracts'));
    repo(path.join(outer, 'inner-not-listed'));
    repo(path.join(project, 'node_modules', 'pkg'));
    repo(path.join(project, '.worktrees', 'wt'));
    repo(path.join(project, '.claude', 'worktrees', 'wt'));
    repo(path.join(project, '.hidden', 'h'));
    const linked = repo(path.join(home(), 'elsewhere', 'linked-repo'));
    fs.symlinkSync(path.dirname(linked), path.join(project, 'link-to-elsewhere'));
    const found: string[] = [];
    const scan = await scanProject(project, { onRepo: (r) => found.push(r) });
    const rel = scan.repos.map((r) => path.relative(project, r)).sort();
    expect(rel).toEqual([path.relative(project, outer), path.relative(project, deep), 'services/api'].sort());
    expect(scan.state).toBe('repositories');
    expect(found.sort()).toEqual([...scan.repos].sort());
    expect(scan.foldersRead).toBeGreaterThanOrEqual(14);
  });

  it('says a folder it cannot open, and lists the rest', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    repo(path.join(project, 'ok'));
    const locked = path.join(project, 'vendor', 'private');
    repo(path.join(locked, 'hidden-repo'));
    fs.chmodSync(locked, 0o000);
    try {
      const scan = await scanProject(project);
      expect(scan.repos.map((r) => path.basename(r))).toEqual(['ok']);
      expect(scan.skipped).toEqual([{ path: locked, why: expect.stringMatching(/permission denied/i) }]);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('tells gone, no git, one repository and repositories apart', async () => {
    expect((await scanProject(path.join(home(), 'no-such-folder'))).state).toBe('gone');
    put(path.join(project, 'notes.txt'));
    expect((await scanProject(project)).state).toBe('no-git');
    const single = repo(path.join(home(), 'projects', 'single'), { 'a.ts': 'a\n' });
    const one = await scanProject(single);
    expect(one).toMatchObject({ state: 'repository', repos: [single] });
  });
});

describe('R4. a repository\'s state', () => {
  it('its branch, changed files with their lines, commits ahead of main, and the agents working there; no program of its own runs', async () => {
    const r = repo(path.join(project, 'sdk'), { 'src/client.ts': 'a\nb\nc\n', 'src/index.ts': 'x\n' });
    git(r, 'checkout', '-q', '-b', 'feat/indexer');
    put(path.join(r, 'src/client.ts'), 'a\nB\nc\nd\n');
    git(r, 'commit', '-qam', 'two');
    put(path.join(r, 'src/index.ts'), 'y\nz\n');
    put(path.join(r, 'test/new.test.ts'), '1\n2\n3\n');
    const marker = path.join(home(), 'fsmonitor-ran');
    git(r, 'config', 'core.fsmonitor', `touch ${marker}; false`);
    const state = await repositoryState(r, [{ id: 'a1', name: 'Frontend', path: r }, { id: 'a2', name: 'Other', path: path.join(home(), 'x') }]);
    expect(state).toMatchObject({ path: r, branch: 'feat/indexer', base: 'main', ahead: 1, agents: [{ id: 'a1', name: 'Frontend' }] });
    const byFile = Object.fromEntries(state.changed.map((c) => [c.file, c]));
    expect(byFile['src/index.ts']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byFile['test/new.test.ts']).toMatchObject({ status: 'untracked', additions: 3 });
    expect(fs.existsSync(marker), 'core.fsmonitor ran').toBe(false);
  });
});

describe('R5. the search', () => {
  it('finds names, paths and changed files in every project, with no limit, case aside, a dash as text', async () => {
    const a = repo(path.join(project, 'sdk-js'));
    for (let i = 0; i < 1500; i++) put(path.join(a, 'gen', `client-${i}.ts`));
    const b = repo(path.join(home(), 'projects', 'atlas', 'web'));
    put(path.join(b, 'src/api/Client.ts'), 'x\n');
    put(path.join(b, '-rf.md'), 'x\n');
    const entries = [
      { project, repos: [await repositoryState(a, [])] },
      { project: path.dirname(b), repos: [await repositoryState(b, [])] },
    ];
    const batches: Array<Array<{ repo: string; files: string[]; nameMatch: boolean }>> = [];
    const total = await searchRepositories('CLIENT', entries, (batch) => batches.push(batch));
    const files = batches.flat().flatMap((g) => g.files);
    expect(files.filter((f) => f.startsWith('gen/client-')).length).toBe(1500);
    expect(files).toContain('src/api/Client.ts');
    expect(total).toBe(1501);
    expect(batches.length).toBeGreaterThan(1);
    const byName = await new Promise<Array<{ repo: string; nameMatch: boolean }>>((resolve) => {
      const got: Array<{ repo: string; nameMatch: boolean }> = [];
      void searchRepositories('sdk-JS', entries, (batch) => got.push(...batch)).then(() => resolve(got));
    });
    expect(byName.find((g) => g.repo === a)?.nameMatch).toBe(true);
    const dash: string[] = [];
    await searchRepositories('-rf', entries, (batch) => dash.push(...batch.flatMap((g) => g.files)));
    expect(dash).toEqual(['-rf.md']);
    const none: unknown[] = [];
    expect(await searchRepositories('   ', entries, (batch) => none.push(...batch))).toBe(0);
    expect(none).toEqual([]);
  });
});

describe('R6. only what Tars found', () => {
  it('reviews a repository found in a project or an agent\'s worktree, nothing else', () => {
    const known = new Set([path.join(project, 'sdk'), path.join(home(), 'wt', 'agent-1')]);
    expect(mayReview(path.join(project, 'sdk'), known)).toBe(true);
    expect(mayReview(path.join(home(), 'wt', 'agent-1'), known)).toBe(true);
    expect(mayReview(path.join(project, 'sdk', '..', 'sdk'), known)).toBe(true);
    expect(mayReview(home(), known)).toBe(false);
    expect(mayReview(path.join(home(), '.ssh'), known)).toBe(false);
    expect(mayReview('relative/sdk', known)).toBe(false);
    expect(mayReview('', known)).toBe(false);
  });
});
