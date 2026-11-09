import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFullPath } from '../utils/path-builder';
import { githubRepoOf } from './github-watch';

/**
 * A project's git, for the first run (QA's fresh-install report, B4 and W4; Tars-Frontend's first-run-window.md):
 * making a plain folder a repository (project:gitInit), and saying what PR delivery still lacks
 * (project:readiness). A new user's folder is usually not a repository: New team then failed every member that asks
 * for a worktree, and nothing checked a remote or whether `gh` is signed in, so the workflow's agents could not open
 * a PR.
 *
 * Every command is an argv to execFile, never a shell string; the folder is one of Tars's projects, checked by the
 * caller's `isProject`, never the home folder or a filesystem root.
 */

export interface ProjectGitOptions {
  /** Whether the folder is one of Tars's projects (projects.json, or an agent's project). */
  isProject: (projectPath: string) => boolean;
  /** The git and gh to run: by name, found on the shell's PATH, unless a test names others. */
  git?: string;
  gh?: string;
  /** Added to the environment the commands run with. */
  env?: NodeJS.ProcessEnv;
}

export type GitInitResult =
  /** `identity`: `yours` when git had one, `tars` when the first commit alone was signed "Tars", nothing written to a config. */
  | { success: true; branch: string; commit: string; files: number; identity: 'yours' | 'tars' }
  | { success: false; error: string; code: 'not-a-project' | 'already-a-repository' | 'git-missing' | 'failed' };

/** gh, from its own words, not its exit code alone. `account`: the GitHub login it names. */
export interface GhState { installed: boolean; signedIn: boolean | null; account: string | null; error: string | null }

/** What a project lacks for PR delivery, in the order the user fixes it. */
export type ProjectMissing = 'git' | 'repository' | 'commit' | 'remote' | 'gh' | 'gh-sign-in';

export type ProjectReadiness =
  | {
      success: true;
      projectPath: string;
      git: { installed: boolean; repository: boolean; hasCommit: boolean; branch: string | null };
      /** origin, else the first remote; `github`: its owner/repo when it is on GitHub, which gh's PRs need. */
      remote: { name: string; url: string; github: string | null } | null;
      gh: GhState;
      missing: ProjectMissing[];
    }
  | { success: false; error: string; code: 'not-a-project' };

/** The identity the first commit alone carries when git has none: never written to any config. */
const TARS_IDENTITY = ['-c', 'user.name=Tars', '-c', 'user.email=tars@localhost'];

interface Ran { code: number | null; stdout: string; stderr: string; missing: boolean }

function run(binary: string, args: string[], cwd: string, opts: ProjectGitOptions, timeout = 30_000): Promise<Ran> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: buildFullPath(), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...opts.env };
  // The folder is the one named, never a repository an inherited variable points at.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return new Promise(resolve => {
    execFile(binary, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' });
    });
  });
}

/** The folder as a project: a directory Tars knows, never the home folder or a filesystem root. Null when it is not. */
function projectFolder(projectPath: string, opts: ProjectGitOptions): string | null {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return null;
  const p = path.resolve(projectPath);
  if (!opts.isProject(p) && !opts.isProject(projectPath)) return null;
  if (p === path.resolve(os.homedir()) || p === path.parse(p).root) return null;
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n').map(l => l.replace(/^(fatal|error): /, '').trim()).find(Boolean) ?? '';
}

/** Whether the user set a git identity: name and e-mail in their config, or in the environment git reads. */
async function hasIdentity(git: string, cwd: string, opts: ProjectGitOptions): Promise<boolean> {
  const env = { ...process.env, ...opts.env };
  const fromEnv = (who: 'AUTHOR' | 'COMMITTER') => !!env[`GIT_${who}_NAME`]?.trim() && !!env[`GIT_${who}_EMAIL`]?.trim();
  if (fromEnv('AUTHOR') && fromEnv('COMMITTER')) return true;
  const name = await run(git, ['config', '--get', 'user.name'], cwd, opts);
  const email = await run(git, ['config', '--get', 'user.email'], cwd, opts);
  return name.code === 0 && !!name.stdout.trim() && email.code === 0 && !!email.stdout.trim();
}

/**
 * The folder made a repository: `main`, its files added (its own .gitignore applies), and a first commit, allowed
 * empty, so that a worktree can be made from it. When the user set no git identity the first commit alone is signed
 * "Tars" (`-c`, nothing written to a config). A failure after `git init` takes the new .git away again.
 */
export async function gitInit(projectPath: string, opts: ProjectGitOptions): Promise<GitInitResult> {
  const p = projectFolder(projectPath, opts);
  if (!p) return { success: false, code: 'not-a-project', error: `${projectPath} is not one of Tars's projects` };
  const git = opts.git ?? 'git';
  const version = await run(git, ['--version'], p, opts);
  if (version.missing) return { success: false, code: 'git-missing', error: 'git is not installed, or not on the PATH Tars reads' };
  const inside = await run(git, ['rev-parse', '--is-inside-work-tree'], p, opts);
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    return { success: false, code: 'already-a-repository', error: `${p} is already in a git repository` };
  }
  const dotGit = path.join(p, '.git');
  const undo = (why: string): GitInitResult => {
    try { fs.rmSync(dotGit, { recursive: true, force: true }); } catch { /* said below */ }
    return { success: false, code: 'failed', error: why };
  };
  const init = await run(git, ['-c', 'init.defaultBranch=main', 'init', '-q'], p, opts);
  if (init.code !== 0) return { success: false, code: 'failed', error: `git init failed: ${firstLine(init.stderr) || `exit ${init.code}`}` };
  // An older git ignores init.defaultBranch: the unborn HEAD is pointed at main all the same.
  const head = await run(git, ['symbolic-ref', 'HEAD', 'refs/heads/main'], p, opts);
  if (head.code !== 0) return undo(`git could not name the branch main: ${firstLine(head.stderr)}`);
  const add = await run(git, ['add', '-A'], p, opts, 120_000);
  if (add.code !== 0) return undo(`git add failed: ${firstLine(add.stderr) || `exit ${add.code}`}`);
  // The user's own identity only when they set one (their git config, or GIT_AUTHOR_* and GIT_COMMITTER_*): git
  // would otherwise make one up from the machine's name (measured on macOS), and sign as nobody the user chose.
  const identity: 'yours' | 'tars' = (await hasIdentity(git, p, opts)) ? 'yours' : 'tars';
  const commitArgs = ['commit', '-q', '--allow-empty', '-m', 'Initial commit'];
  const commit = await run(git, identity === 'tars' ? [...TARS_IDENTITY, ...commitArgs] : commitArgs, p, opts, 120_000);
  if (commit.code !== 0) return undo(`git commit failed: ${firstLine(commit.stderr) || `exit ${commit.code}`}`);
  const sha = (await run(git, ['rev-parse', 'HEAD'], p, opts)).stdout.trim();
  const files = (await run(git, ['ls-tree', '-r', '--name-only', 'HEAD'], p, opts)).stdout.split('\n').filter(Boolean).length;
  console.log(`[project] ${p} made a git repository: main, ${files} file${files === 1 ? '' : 's'} in its first commit (${identity === 'tars' ? 'signed Tars' : 'your identity'})`);
  return { success: true, branch: 'main', commit: sha, files, identity };
}

/** gh's own words about github.com: signed in (and as whom), signed out, or a sign-in that no longer works. */
function readGh(out: Ran): GhState {
  if (out.missing) return { installed: false, signedIn: null, account: null, error: null };
  const text = `${out.stdout}\n${out.stderr}`;
  const ok = text.match(/Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/);
  if (ok) return { installed: true, signedIn: true, account: ok[1], error: null };
  const failed = text.match(/Failed to log in to github\.com (?:account|as) ([A-Za-z0-9-]+)[^\n]*\n?([\s\S]*)/);
  if (failed) {
    const why = failed[2].split('\n').map(l => l.replace(/^[\s\-X✓]+/, '').trim()).filter(Boolean).join(' ');
    return { installed: true, signedIn: false, account: failed[1], error: why || null };
  }
  if (/not logged in/i.test(text)) return { installed: true, signedIn: false, account: null, error: null };
  return { installed: true, signedIn: null, account: null, error: firstLine(text) || `gh auth status: exit ${out.code}` };
}

/** What PR delivery needs, read for one project: git, the repository and its first commit, a remote, and gh signed in. */
export async function projectReadiness(projectPath: string, opts: ProjectGitOptions): Promise<ProjectReadiness> {
  const p = projectFolder(projectPath, opts);
  if (!p) return { success: false, code: 'not-a-project', error: `${projectPath} is not one of Tars's projects` };
  const git = opts.git ?? 'git';
  const gh = readGh(await run(opts.gh ?? 'gh', ['auth', 'status', '--hostname', 'github.com'], p, opts, 15_000));
  const version = await run(git, ['--version'], p, opts);
  if (version.missing) {
    return { success: true, projectPath: p, git: { installed: false, repository: false, hasCommit: false, branch: null }, remote: null, gh, missing: ['git'] };
  }
  const inside = await run(git, ['rev-parse', '--is-inside-work-tree'], p, opts);
  const repository = inside.code === 0 && inside.stdout.trim() === 'true';
  let hasCommit = false;
  let branch: string | null = null;
  let remote: { name: string; url: string; github: string | null } | null = null;
  if (repository) {
    hasCommit = (await run(git, ['rev-parse', '--verify', '--quiet', 'HEAD'], p, opts)).code === 0;
    const named = await run(git, ['symbolic-ref', '--short', '-q', 'HEAD'], p, opts);
    branch = named.code === 0 ? named.stdout.trim() || null : null;
    const names = (await run(git, ['remote'], p, opts)).stdout.split('\n').map(s => s.trim()).filter(Boolean);
    const name = names.includes('origin') ? 'origin' : names[0];
    if (name) {
      const url = (await run(git, ['remote', 'get-url', name], p, opts)).stdout.trim();
      remote = { name, url, github: githubRepoOf(url) ?? null };
    }
  }
  const missing: ProjectMissing[] = [];
  if (!repository) missing.push('repository');
  if (!hasCommit) missing.push('commit');
  if (!remote) missing.push('remote');
  if (!gh.installed) missing.push('gh');
  else if (gh.signedIn === false) missing.push('gh-sign-in');
  return { success: true, projectPath: p, git: { installed: true, repository, hasCommit, branch }, remote, gh, missing };
}
