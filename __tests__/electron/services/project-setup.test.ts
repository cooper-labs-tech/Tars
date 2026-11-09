import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupOffer, writeCi, writeClaudeMd, teamOf, acceptedProject } from '../../../electron/services/project-setup';

/**
 * What Tars offers a project so that the owner's workflow runs there with nothing set up by hand (2.0.7, W3, W5 and W7
 * of the fresh-install report): a CI workflow for a GitHub project, a short CLAUDE.md naming its checks and its
 * team's areas, and one permission level for its whole team. Offered to the owner in the window, written only on
 * their yes (IPC only: no agent reaches these), never over what the project already has. On real folders.
 *
 * How it fails, written before the code (2026-11-10):
 * C1. A folder that is not a git repository, or whose origin is not on GitHub, is offered a GitHub workflow: no
 *     offer, and why.
 * C2. A project that has a workflow already (.github/workflows/*.yml) is offered another.
 * C3. A Node project's workflow runs what the project does not have: only the scripts its package.json has
 *     (typecheck, lint, test, build), `tsc --noEmit` when it has a tsconfig.json and no typecheck script; the
 *     package manager its lock file names; the Node its .nvmrc or engines names, else 22.
 * C4. Python, Go and Rust get the steps of their own tools; a stack Tars does not know gets no offer, and why.
 * C5. The workflow runs on other events than a pull request to the default branch and a push to it.
 * C6. Writing it changes the user's checkout, overwrites a file, or pushes: it is committed on a branch of its own
 *     (chore/ci), in a worktree, and nothing is pushed.
 * K1. A project with a CLAUDE.md is offered or written another.
 * K2. The CLAUDE.md offered does not name the project's checks and its team's areas, or runs past 40 lines.
 * T1. The whole team's permission level reaches an agent of another project, or a chat's runner (whose settings are
 *     its orchestrator's).
 *
 * From the Audit's FIX FIRST on #586 (written before the fixes, 2026-11-10):
 * F1. (M1) Writing the CI prunes an agent's own worktree (the prune before a new worktree, with no agent's folder
 *     protected), and says nothing of what it removed.
 * F2. (L1) The offered workflow is red on its first run: setup-node caching with no lock file to key it, pnpm's setup
 *     with no version when package.json names no packageManager, pytest run without being installed.
 * F3. (L2) Any absolute path is taken: a CLAUDE.md written into the home folder, a commit made in any repository. Only
 *     a project Tars knows, never the home folder nor a root.
 * F4. (L3) A failure once the worktree is made (a file named .github, a commit refused) leaves chore/ci and its
 *     worktree behind, and the next yes answers "exists"; or git with an email and no name refuses the commit.
 */

vi.setConfig({ testTimeout: 60_000 });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-project-setup-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown };
    throw new Error(`git ${args.join(' ')}: ${[e.stderr, e.stdout].map(s => String(s ?? '').trim()).filter(Boolean).join(' / ') || (err as Error).message}`);
  }
};

let n = 0;
/** A git project with files, an origin URL (never fetched) and one commit on main. */
function project(files: Record<string, string>, origin: string | null = 'git@github.com:someone/shop.git'): string {
  const dir = path.join(root, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'shop\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'shop', scripts, ...extra });
const noTeam: Parameters<typeof setupOffer>[1] = [];

describe('the CI offer', () => {
  it('C1. offers nothing to a folder that is not a repository, or whose origin is not on GitHub, and says why', async () => {
    const plain = path.join(root, `plain${++n}`);
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'package.json'), pkg({ test: 'vitest' }));
    expect((await setupOffer(plain, noTeam)).ci).toMatchObject({ state: 'not_a_repository' });
    expect((await setupOffer(project({ 'package.json': pkg({ test: 'vitest' }) }, 'https://gitlab.com/s/shop.git'), noTeam)).ci).toMatchObject({ state: 'not_github' });
    expect((await setupOffer(project({ 'package.json': pkg({ test: 'vitest' }) }, null), noTeam)).ci).toMatchObject({ state: 'no_remote' });
  });

  it('C2. offers nothing to a project that has a workflow', async () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest' }), '.github/workflows/test.yml': 'on: push\n' });
    expect((await setupOffer(dir, noTeam)).ci).toMatchObject({ state: 'present', path: path.join(dir, '.github', 'workflows', 'test.yml') });
  });

  it('C3. runs only what a Node project has, with its package manager and its Node', async () => {
    const dir = project({ 'package.json': pkg({ lint: 'eslint .', test: 'vitest run' }, { engines: { node: '>=20' } }), 'pnpm-lock.yaml': '', 'tsconfig.json': '{}', '.nvmrc': '22.12\n' });
    const ci = (await setupOffer(dir, noTeam)).ci as { state: string; content: string; checks: string[] };
    expect(ci.state).toBe('offer');
    expect(ci.checks).toEqual(['pnpm install --frozen-lockfile', 'pnpm exec tsc --noEmit', 'pnpm run lint', 'pnpm run test']);
    expect(ci.content).toContain("node-version: '22.12'");
    expect(ci.content).not.toContain('run build');
    const npmDir = project({ 'package.json': pkg({ typecheck: 'tsc -b', build: 'next build' }), 'package-lock.json': '{}' });
    const npmCi = (await setupOffer(npmDir, noTeam)).ci as { checks: string[]; content: string };
    expect(npmCi.checks).toEqual(['npm ci', 'npm run typecheck', 'npm run build']);
    expect(npmCi.content).toContain("node-version: '22'");
  });

  it('C4. gives Python, Go and Rust their own tools, and an unknown stack nothing', async () => {
    const py = (await setupOffer(project({ 'pyproject.toml': '[project]\nname = "shop"\n[tool.pytest.ini_options]\n', 'tests/test_a.py': '' }), noTeam)).ci as { checks: string[] };
    expect(py.checks).toEqual(['pip install -e . pytest', 'pytest']);
    expect(((await setupOffer(project({ 'go.mod': 'module shop\n' }), noTeam)).ci as { checks: string[] }).checks).toEqual(['go build ./...', 'go vet ./...', 'go test ./...']);
    expect(((await setupOffer(project({ 'Cargo.toml': '[package]\nname = "shop"\n' }), noTeam)).ci as { checks: string[] }).checks).toEqual(['cargo build --locked', 'cargo test --locked']);
    expect((await setupOffer(project({ 'main.c': 'int main(){}' }), noTeam)).ci).toMatchObject({ state: 'unknown_stack' });
  });

  it('C5. runs on a pull request to the default branch and a push to it, and nothing else', async () => {
    const ci = (await setupOffer(project({ 'package.json': pkg({ test: 'vitest run' }) }), noTeam)).ci as { content: string };
    expect(ci.content).toMatch(/^on:\n {2}pull_request:\n {4}branches: \[main\]\n {2}push:\n {4}branches: \[main\]\n/m);
    expect(ci.content).not.toMatch(/schedule|workflow_dispatch|pull_request_target/);
  });

  it('C6. is committed on chore/ci in a worktree, the user\'s checkout untouched and nothing pushed', async () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest run' }) });
    const before = git(dir, 'status', '--porcelain');
    const written = await writeCi(dir, { freeBytes: async () => 500 * 1024 ** 3, protectedPaths: [] });
    expect(written).toMatchObject({ branch: 'chore/ci' });
    expect(git(dir, 'status', '--porcelain')).toBe(before);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(dir, 'show', 'chore/ci:.github/workflows/ci.yml')).toContain('run: npm run test');
    expect(git(dir, 'for-each-ref', '--format=%(upstream)', 'refs/heads/chore/ci')).toBe('');
    // Asked again, it writes nothing over it.
    expect(await writeCi(dir, { freeBytes: async () => 500 * 1024 ** 3, protectedPaths: [] })).toMatchObject({ code: 'exists' });
  });
});

describe('the CLAUDE.md offer', () => {
  const team = [
    { name: 'Lead', role: 'orchestrator', projectPath: '', savedPrompt: '' },
    { name: 'Frontend Engineer', role: 'worker', projectPath: '', savedPrompt: 'You are the frontend developer. You own the UI: components, pages.' },
  ];

  it('K1. offers and writes nothing over a CLAUDE.md the project has', async () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest run' }), 'CLAUDE.md': '# mine\n' });
    expect((await setupOffer(dir, noTeam)).claudeMd).toMatchObject({ state: 'present' });
    expect(await writeClaudeMd(dir, team)).toMatchObject({ code: 'exists' });
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# mine\n');
  });

  it('K2. names the checks and the team\'s areas, in 40 lines at most, and is written on a yes', async () => {
    const dir = project({ 'package.json': pkg({ lint: 'eslint .', test: 'vitest run' }), 'package-lock.json': '{}' });
    const offer = (await setupOffer(dir, team)).claudeMd as { state: string; content: string };
    expect(offer.state).toBe('offer');
    for (const word of ['npm run lint', 'npm run test', 'Frontend Engineer', 'You own the UI', 'gate loop']) expect(offer.content, word).toContain(word);
    expect(offer.content.trim().split('\n').length).toBeLessThanOrEqual(40);
    expect(await writeClaudeMd(dir, team)).toMatchObject({ path: path.join(dir, 'CLAUDE.md') });
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(offer.content);
  });
});

describe('the whole team', () => {
  it('T1. is the project\'s own agents, never another project\'s nor a chat\'s runner', () => {
    const fleet = [
      { id: 'a', projectPath: '/p/shop' }, { id: 'b', projectPath: '/p/shop', kind: 'chat' as const },
      { id: 'c', projectPath: '/p/other' }, { id: 'd', projectPath: '/p/shop' },
    ];
    expect(teamOf('/p/shop', fleet).map(a => a.id)).toEqual(['a', 'd']);
  });
});

const roomy = async () => 500 * 1024 ** 3;
/** A worktree as an agent's own: on a branch with a commit of its own, merged into main, its HEAD idle for hours. */
function mergedAgentWorktree(dir: string, branch: string): string {
  const wt = path.join(dir, '.worktrees', ...branch.split('/'));
  git(dir, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  fs.writeFileSync(path.join(wt, `${branch.replace(/\//g, '-')}.txt`), branch);
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'x');
  git(dir, 'merge', '-q', '--ff-only', branch);
  const when = new Date(Date.now() - 3 * 3600_000);
  const gitDir = path.resolve(wt, git(wt, 'rev-parse', '--git-dir'));
  for (const f of ['HEAD', path.join('logs', 'HEAD')]) if (fs.existsSync(path.join(gitDir, f))) fs.utimesSync(path.join(gitDir, f), when, when);
  return wt;
}

describe('the Audit\'s FIX FIRST on #586', () => {
  it('F1. never prunes an agent\'s own worktree to write the CI, and names what it pruned', async () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const own = mergedAgentWorktree(dir, 'feat/frontend');
    const other = mergedAgentWorktree(dir, 'feat/done');
    const written = await writeCi(dir, { freeBytes: roomy, protectedPaths: [own] });
    expect(written).toMatchObject({ branch: 'chore/ci', pruned: ['feat/done'] });
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
  });

  it('F2. offers a workflow that can pass its first run', async () => {
    const noLock = (await setupOffer(project({ 'package.json': pkg({ test: 'vitest run' }) }), noTeam)).ci as { content: string; checks: string[] };
    expect(noLock.checks[0]).toBe('npm install');
    expect(noLock.content).not.toMatch(/cache:/);
    const pnpm = (await setupOffer(project({ 'package.json': pkg({ test: 'vitest run' }), 'pnpm-lock.yaml': '' }), noTeam)).ci as { content: string };
    expect(pnpm.content).toMatch(/pnpm\/action-setup@v4\n {8}with:\n {10}version: 9/);
    const pinned = (await setupOffer(project({ 'package.json': pkg({ test: 'vitest run' }, { packageManager: 'pnpm@8.15.4' }), 'pnpm-lock.yaml': '' }), noTeam)).ci as { content: string };
    expect(pinned.content).toMatch(/pnpm\/action-setup@v4\n {6}- uses: actions\/setup-node/);
    const py = (await setupOffer(project({ 'requirements.txt': 'flask\n', 'tests/test_a.py': '' }), noTeam)).ci as { content: string };
    expect(py.content.indexOf('pip install -r requirements.txt pytest')).toBeGreaterThan(-1);
    expect(py.content.indexOf('pip install -r requirements.txt pytest')).toBeLessThan(py.content.indexOf('run: pytest'));
  });

  it('F3. takes only a project Tars knows, never the home folder nor a root', () => {
    const known = ['/Users/u/projects/shop'];
    expect(acceptedProject('/Users/u/projects/shop', known, '/Users/u')).toBe('/Users/u/projects/shop');
    expect(acceptedProject('/Users/u/projects/shop/', known, '/Users/u')).toBe('/Users/u/projects/shop');
    for (const bad of ['/Users/u/projects/other', '/Users/u', '/', 'relative/shop', 42, undefined]) expect(acceptedProject(bad, [...known, '/Users/u', '/'], '/Users/u'), String(bad)).toBeUndefined();
  });

  it('F4. leaves nothing behind when the write fails after the worktree, so the next yes can try again', async () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest run' }), 'package-lock.json': '{}', '.github': 'not a folder\n' });
    const failed = await writeCi(dir, { freeBytes: roomy, protectedPaths: [] });
    expect(failed).toMatchObject({ code: 'write_failed' });
    expect(git(dir, 'branch', '--list', 'chore/ci')).toBe('');
    expect(fs.existsSync(path.join(dir, '.worktrees', 'chore', 'ci'))).toBe(false);
  });

  it('F4. commits under Tars\'s name when git has an email and no name', async () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest run' }), 'package-lock.json': '{}' });
    git(dir, 'config', 'user.useConfigOnly', 'true');
    git(dir, 'config', 'user.email', 'someone@example.com');
    expect(await writeCi(dir, { freeBytes: roomy, protectedPaths: [] })).toMatchObject({ branch: 'chore/ci' });
  });
});
