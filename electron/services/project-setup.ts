import * as fs from 'fs';
import * as path from 'path';
import { safeGit } from '../utils/safe-git';
import { localDefault, newWorktree } from './project-worktrees';

/**
 * What Tars offers a project so that the owner's workflow runs there with nothing set up by hand (2.0.7, W3 and W7
 * of the fresh-install report): a CI workflow for a GitHub project, and a short CLAUDE.md naming its checks and its
 * team's areas. Offered in the window and written only on the owner's yes, through IPC alone (handlers/
 * project-setup-handlers.ts): no agent reaches these, and nothing a project has is ever written over.
 *
 * The CI workflow is committed on `chore/ci`, in a worktree of its own (project-worktrees.ts): the user's checkout is
 * not touched, and nothing is pushed. The project's agents deliver it as any change, through the gate loop.
 */

export interface TeamMember { name?: string; role?: string; kind?: string; projectPath: string; savedPrompt?: string }

export type Stack = 'node' | 'python' | 'go' | 'rust';

export type CiOffer =
  | { state: 'offer'; path: string; content: string; checks: string[]; stack: Stack }
  | { state: 'present'; path: string }
  | { state: 'not_a_repository' | 'no_remote' | 'not_github' | 'unknown_stack'; why: string };

export type ClaudeMdOffer = { state: 'offer'; path: string; content: string } | { state: 'present'; path: string };

const CI_BRANCH = 'chore/ci';
const CI_FILE = path.join('.github', 'workflows', 'ci.yml');

const exists = (p: string) => fs.existsSync(p);
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const git = (cwd: string, args: string[]) => safeGit(cwd, args, { env: { LC_ALL: 'C' }, timeout: 60_000 });

interface Detected { stack: Stack; install: string; checks: string[]; setup: string[] }

/** The project's stack and its checks, from its own files: only commands it has. */
function detect(projectPath: string): Detected | undefined {
  const at = (f: string) => path.join(projectPath, f);
  if (exists(at('package.json'))) {
    let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown } = {};
    try { pkg = JSON.parse(read(at('package.json'))); } catch { /* no scripts */ }
    const scripts = pkg.scripts ?? {};
    const pm = exists(at('pnpm-lock.yaml')) ? 'pnpm' : exists(at('yarn.lock')) ? 'yarn' : 'npm';
    // A first run green (the Audit's L1 on #586): setup-node fails when it is asked to cache with no lock file to key
    // it, and pnpm's setup fails with no version unless package.json names its packageManager.
    const locked = exists(at('pnpm-lock.yaml')) || exists(at('yarn.lock')) || exists(at('package-lock.json'));
    const pnpmPinned = typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('pnpm@');
    const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : exists(at('package-lock.json')) ? 'npm ci' : 'npm install';
    const runScript = (s: string) => `${pm} run ${s}`;
    const checks: string[] = [];
    if (typeof scripts.typecheck === 'string') checks.push(runScript('typecheck'));
    else if (exists(at('tsconfig.json'))) checks.push(pm === 'npm' ? 'npx tsc --noEmit' : `${pm} exec tsc --noEmit`);
    for (const s of ['lint', 'test', 'build']) if (typeof scripts[s] === 'string') checks.push(runScript(s));
    const node = read(at('.nvmrc')).trim().replace(/^v/, '') || '22';
    const setup = [
      ...(pm === 'pnpm' ? ['      - uses: pnpm/action-setup@v4', ...(pnpmPinned ? [] : ['        with:', '          version: 9'])] : []),
      '      - uses: actions/setup-node@v4',
      '        with:',
      `          node-version: '${node}'`,
      ...(locked ? [`          cache: ${pm}`] : []),
    ];
    return { stack: 'node', install, checks, setup };
  }
  if (exists(at('pyproject.toml')) || exists(at('requirements.txt'))) {
    const usesPytest = exists(at('tests')) || /\[tool\.pytest/.test(read(at('pyproject.toml'))) || exists(at('pytest.ini'));
    // pytest installed with the project: a project need not declare it to have tests (the Audit's L1 on #586).
    const install = `${exists(at('pyproject.toml')) ? 'pip install -e .' : 'pip install -r requirements.txt'}${usesPytest ? ' pytest' : ''}`;
    return { stack: 'python', install, checks: usesPytest ? ['pytest'] : [], setup: ['      - uses: actions/setup-python@v5', '        with:', "          python-version: '3.12'"] };
  }
  if (exists(at('go.mod'))) {
    return { stack: 'go', install: '', checks: ['go build ./...', 'go vet ./...', 'go test ./...'], setup: ['      - uses: actions/setup-go@v5', '        with:', '          go-version-file: go.mod'] };
  }
  if (exists(at('Cargo.toml'))) {
    return { stack: 'rust', install: '', checks: ['cargo build --locked', 'cargo test --locked'], setup: [] };
  }
  return undefined;
}

function workflow(d: Detected, branch: string): string {
  return [
    'name: CI',
    '',
    '# Offered by Tars: the checks QA runs at each gate, on every pull request. Edit it: it is yours.',
    'on:',
    '  pull_request:',
    `    branches: [${branch}]`,
    '  push:',
    `    branches: [${branch}]`,
    '',
    'jobs:',
    '  checks:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...d.setup,
    ...[d.install, ...d.checks].filter(Boolean).map(c => `      - run: ${c}`),
    '',
  ].join('\n');
}

async function isRepository(projectPath: string): Promise<boolean> {
  return exists(projectPath) && (await git(projectPath, ['rev-parse', '--is-inside-work-tree']).then(r => r.stdout.trim(), () => '')) === 'true';
}

async function ciOffer(projectPath: string): Promise<CiOffer> {
  if (!(await isRepository(projectPath))) return { state: 'not_a_repository', why: `${projectPath} is not a git repository: CI runs on a repository's pull requests.` };
  const workflows = path.join(projectPath, '.github', 'workflows');
  const present = exists(workflows) ? fs.readdirSync(workflows).find(f => /\.ya?ml$/.test(f)) : undefined;
  if (present) return { state: 'present', path: path.join(workflows, present) };
  const origin = await git(projectPath, ['remote', 'get-url', 'origin']).then(r => r.stdout.trim(), () => '');
  if (!origin) return { state: 'no_remote', why: 'The project has no remote: QA runs its checks locally at each gate.' };
  if (!/github\.com[:/]/.test(origin)) return { state: 'not_github', why: `Its remote is not on GitHub (${origin}): Tars offers GitHub Actions only.` };
  const d = detect(projectPath);
  if (!d || (!d.checks.length && !d.install)) return { state: 'unknown_stack', why: 'Tars finds no package.json, pyproject.toml, requirements.txt, go.mod or Cargo.toml: it does not know what to check.' };
  const branch = await localDefault(projectPath);
  return { state: 'offer', path: path.join(projectPath, CI_FILE), content: workflow(d, branch), checks: [d.install, ...d.checks].filter(Boolean), stack: d.stack };
}

/** A role's first sentences, for the team's line: up to 200 characters, cut at a sentence's end. */
function area(prompt: string | undefined): string {
  const text = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  const end = cut.lastIndexOf('. ');
  return end > 40 ? cut.slice(0, end + 1) : `${cut.trimEnd()}...`;
}

function claudeMd(projectPath: string, team: readonly TeamMember[], branch: string): string {
  const d = detect(projectPath);
  const checks = d?.checks ?? [];
  const members = team.filter(a => a.kind !== 'chat');
  return [
    `# ${path.basename(projectPath)}`,
    '',
    'Instructions for every agent of this project, offered by Tars. Edit them: they are yours.',
    '',
    '## Checks',
    '',
    ...(checks.length
      ? ['Run these before a pull request. QA runs them at each gate, as CI does:', ...checks.map(c => `- \`${c}\``)]
      : ['Tars found no checks to name. Write here the commands that prove a change works in this project.']),
    '',
    '## The team',
    '',
    ...(members.length
      ? members.map(a => {
        // THE project's orchestrator, by its role (__tests__/electron/core/role-sites.test.ts: a team listing).
        const lead = a.role === 'orchestrator';
        return `- **${a.name ?? 'An agent'}**${lead ? ' (orchestrator)' : ''}: ${area(a.savedPrompt) || (lead ? 'splits the work, delegates it and merges.' : 'its area is not written yet.')}`;
      })
      : ['No agent yet: each one the project gets owns an area.']),
    '',
    'Each agent stays in its area: a change elsewhere is asked of its owner through the orchestrator.',
    '',
    '## Delivery',
    '',
    `Every change goes through Tars's gate loop: a branch and a pull request per piece, QA's verdict, the Audit's, CI green, then the merge. An agent never merges its own pull request, and never commits to \`${branch}\`.`,
    '',
  ].join('\n');
}

/** What the window offers for a project: its CI workflow and its CLAUDE.md, or why not. */
export async function setupOffer(projectPath: string, team: readonly TeamMember[]): Promise<{ ci: CiOffer; claudeMd: ClaudeMdOffer }> {
  const file = path.join(projectPath, 'CLAUDE.md');
  const branch = (await isRepository(projectPath)) ? await localDefault(projectPath) : 'main';
  return {
    ci: await ciOffer(projectPath),
    claudeMd: exists(file) ? { state: 'present', path: file } : { state: 'offer', path: file, content: claudeMd(projectPath, team, branch) },
  };
}

/**
 * On the owner's yes: the offered workflow committed on chore/ci in its own worktree. Never pushed. The worktrees
 * agents work in are named by the caller and never pruned (the Audit's M1 on #586); what was pruned is said. A
 * failure once the worktree is made takes the worktree and the branch back, and says what it could not.
 */
export async function writeCi(
  projectPath: string, opts: { protectedPaths: readonly string[]; freeBytes?: (dir: string) => Promise<number> },
): Promise<{ branch: string; worktree: string; file: string; pruned: string[] } | { error: string; code: string; left?: string[] }> {
  const offer = await ciOffer(projectPath);
  if (offer.state !== 'offer') return { error: offer.state === 'present' ? `The project has a workflow already: ${offer.path}.` : offer.why, code: offer.state === 'present' ? 'exists' : offer.state };
  const branchExists = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${CI_BRANCH}`]).then(() => true, () => false);
  if (branchExists) return { error: `The branch ${CI_BRANCH} exists already: Tars writes nothing over it.`, code: 'exists' };
  const made = await newWorktree(projectPath, CI_BRANCH, { protectedPaths: opts.protectedPaths, freeBytes: opts.freeBytes });
  if ('code' in made) return made;
  const file = path.join(made.path, CI_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, offer.content, { flag: 'wx' });
    // The user's own identity when git has both its keys; Tars's, for this commit only, when it lacks either (git set
    // to its config alone refuses a commit with an email and no name).
    const key = (k: string) => git(made.path, ['config', k]).then(r => r.stdout.trim(), () => '');
    const named = (await key('user.name')) !== '' && (await key('user.email')) !== '';
    const who = named ? [] : ['-c', 'user.name=Tars', '-c', 'user.email=tars@localhost'];
    await git(made.path, ['add', CI_FILE]);
    await git(made.path, [...who, 'commit', '-q', '-m', 'chore: ci, the checks qa runs at each gate, on every pull request (offered by tars)']);
  } catch (err) {
    const why = String((err as { stderr?: unknown }).stderr ?? '').trim() || (err as Error).message;
    return { error: `The workflow could not be written (${why}).${await takeBack(projectPath, made.path, file)}`, code: 'write_failed' };
  }
  return { branch: CI_BRANCH, worktree: made.path, file, pruned: made.pruned };
}

/**
 * What a failed write leaves, taken back: the file Tars wrote, the worktree (clean once the file is gone, so never by
 * force), and the branch it made a moment before, which holds no commit of anyone's. Says what it could not take back.
 */
async function takeBack(projectPath: string, worktree: string, file: string): Promise<string> {
  const left: string[] = [];
  try { if (fs.existsSync(file)) fs.rmSync(file); } catch { left.push(file); }
  // Unstaged in the worktree, should the add have run: its index then matches its HEAD again.
  await git(worktree, ['reset', '-q', '--', CI_FILE]).catch(() => undefined);
  if (!(await git(projectPath, ['worktree', 'remove', worktree]).then(() => true, () => false))) left.push(`the worktree ${worktree}`);
  else if (!(await git(projectPath, ['branch', '-D', CI_BRANCH]).then(() => true, () => false))) left.push(`the branch ${CI_BRANCH}`);
  return left.length ? ` Left behind: ${left.join(', ')}.` : ' Nothing was left behind: the next yes tries again.';
}

/**
 * The project a window's call names, if Tars knows it: one of its projects, never the home folder nor a root, so a
 * CLAUDE.md or a commit lands only in a project the user added (the Audit's L2 on #586).
 */
export function acceptedProject(value: unknown, knownProjects: readonly string[], home: string): string | undefined {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return undefined;
  const asked = path.resolve(value);
  if (asked === path.parse(asked).root || asked === path.resolve(home)) return undefined;
  return knownProjects.some(p => path.resolve(p) === asked) ? asked : undefined;
}

/** On the owner's yes: the offered CLAUDE.md, at the project's root, never over one it has. */
export async function writeClaudeMd(projectPath: string, team: readonly TeamMember[]): Promise<{ path: string } | { error: string; code: string }> {
  const offer = (await setupOffer(projectPath, team)).claudeMd;
  if (offer.state === 'present') return { error: `The project has a CLAUDE.md already: ${offer.path}. Tars writes nothing over it.`, code: 'exists' };
  fs.writeFileSync(offer.path, offer.content, { flag: 'wx' });
  return { path: offer.path };
}

/** A project's team: its agents, never another project's, nor a chat's runner, whose settings are its orchestrator's. */
export function teamOf<A extends { projectPath: string; kind?: string }>(projectPath: string, fleet: Iterable<A>): A[] {
  return Array.from(fleet).filter(a => a.projectPath === projectPath && a.kind !== 'chat');
}
