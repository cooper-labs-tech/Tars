import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupOffer, writeCi, writeClaudeMd, teamOf } from '../../../electron/services/project-setup';

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
 */

vi.setConfig({ testTimeout: 60_000 });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-project-setup-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

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
    expect(py.checks).toEqual(['pip install -e .', 'pytest']);
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
    const written = await writeCi(dir, { freeBytes: async () => 500 * 1024 ** 3 });
    expect(written).toMatchObject({ branch: 'chore/ci' });
    expect(git(dir, 'status', '--porcelain')).toBe(before);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(dir, 'show', 'chore/ci:.github/workflows/ci.yml')).toContain('run: npm run test');
    expect(git(dir, 'for-each-ref', '--format=%(upstream)', 'refs/heads/chore/ci')).toBe('');
    // Asked again, it writes nothing over it.
    expect(await writeCi(dir, { freeBytes: async () => 500 * 1024 ** 3 })).toMatchObject({ code: 'exists' });
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
