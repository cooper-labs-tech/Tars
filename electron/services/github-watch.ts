import { safeGit } from '../utils/safe-git';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { reportEvent, type ReportEvent } from './event-reports';
import { buildFullPath } from '../utils/path-builder';

/**
 * What Tars reads from GitHub for the event reports (step 4 of the relay
 * plan): PRs merged, and changes requested on an open PR, in the repositories
 * of the projects its agents work in. Through `gh`, read-only (`gh pr list
 * --json`, and nothing else), every POLL_MS, and only while the reports go out
 * (the relay is on): there is nobody to tell otherwise.
 *
 * The first poll of a repository is its baseline and reports nothing, and so
 * is a poll that follows a pause of more than an hour: what happened while
 * nobody was listening is not news. What was seen is kept in ~/.tars-private,
 * across restarts. `gh` missing, signed out or failing reports nothing.
 */

export const POLL_MS = 5 * 60_000;
const STALE_MS = 3_600_000;
export const GH_READ_ARGS = ['pr', 'list'] as const;

type Gh = (args: string[]) => Promise<string>;
interface RepoState { polledAt: number; merged: number[]; changes: number[] }
type State = Record<string, RepoState>;
type PrEvent = Extract<ReportEvent, { kind: 'pr-merged' | 'changes-requested' }>;
/** What a poll finds in a repository, before it is put under a project. */
export type PrSeen = Omit<PrEvent, 'projectPath'>;

const FILE = () => privatePath('github-watch.json');
function load(): State {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as State; } catch { return {}; }
}
function save(state: State): void {
  try { writeSecretFileSync(FILE(), JSON.stringify(state)); } catch (err) {
    console.error('[github-watch] could not record what was seen:', err instanceof Error ? err.message : err);
  }
}

interface Pr { number: number; title: string; url: string; reviewDecision?: string }
const list = async (gh: Gh, repo: string, state: 'merged' | 'open', fields: string): Promise<Pr[]> =>
  JSON.parse(await gh([...GH_READ_ARGS, '--repo', repo, '--state', state, '--limit', state === 'merged' ? '30' : '50', '--json', fields])) as Pr[];

/** One poll of these repositories: the events since the last, and what was seen recorded. */
export async function pollGithub(repos: string[], gh: Gh, now: number = Date.now()): Promise<PrSeen[]> {
  const state = load();
  const events: PrSeen[] = [];
  for (const repo of repos) {
    let merged: Pr[];
    let open: Pr[];
    try {
      merged = await list(gh, repo, 'merged', 'number,title,url,mergedAt');
      open = await list(gh, repo, 'open', 'number,title,url,reviewDecision');
    } catch {
      continue;
    }
    const refused = open.filter(p => p.reviewDecision === 'CHANGES_REQUESTED').map(p => p.number);
    const before = state[repo];
    if (before && now - before.polledAt <= STALE_MS) {
      for (const p of merged) {
        if (!before.merged.includes(p.number)) events.push({ kind: 'pr-merged', repo, number: p.number, title: p.title, url: p.url });
      }
      for (const p of open) {
        if (refused.includes(p.number) && !before.changes.includes(p.number)) {
          events.push({ kind: 'changes-requested', repo, number: p.number, title: p.title, url: p.url });
        }
      }
    }
    const seen = new Set([...(before?.merged ?? []), ...merged.map(p => p.number)]);
    state[repo] = { polledAt: now, merged: [...seen].slice(-200), changes: refused };
  }
  save(state);
  return events;
}

/** How a pull request ended, by its branch: what a traced session on that branch records after its end. */
export interface PrState { repo: string; number: number; branch: string; state: 'merged' | 'closed'; at: number }

/**
 * The merged and closed pull requests of these repositories, with their branch: one read-only list each, `--state
 * closed`, which lists the merged ones too (gh 2.88.1, measured 27/11: `state` reads MERGED or CLOSED, `closedAt` set
 * for both). A repository whose list fails gives nothing; the others still read.
 */
export async function prStatesOf(repos: string[], gh: Gh): Promise<PrState[]> {
  const states: PrState[] = [];
  for (const repo of repos) {
    let prs: unknown;
    try {
      prs = JSON.parse(await gh([...GH_READ_ARGS, '--repo', repo, '--state', 'closed', '--limit', '50', '--json', 'number,state,headRefName,mergedAt,closedAt']));
    } catch {
      continue;
    }
    for (const p of Array.isArray(prs) ? prs as Array<Record<string, unknown>> : []) {
      const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : null;
      const at = Date.parse(String(state === 'merged' ? p.mergedAt : p.closedAt));
      if (!state || typeof p.number !== 'number' || typeof p.headRefName !== 'string' || !p.headRefName || !Number.isFinite(at)) continue;
      states.push({ repo, number: p.number, branch: p.headRefName, state, at });
    }
  }
  return states;
}

/** The GitHub repository of each project, by its origin: projects that share one are named together. */
async function projectsByRepo(projectPaths: string[]): Promise<Map<string, string[]>> {
  const byRepo = new Map<string, string[]>();
  for (const project of new Set(projectPaths)) {
    try {
      const repo = githubRepoOf((await safeGit(project, ['remote', 'get-url', 'origin'])).stdout);
      if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), project]);
    } catch { /* not a repository, or no origin */ }
  }
  return byRepo;
}

/** The ends of the pull requests of these projects' repositories, each naming the projects of its repository. */
export async function prStatesOfProjects(projectPaths: string[], gh: Gh = (args) => run(ghBinary, args)): Promise<Array<PrState & { projects: string[] }>> {
  const byRepo = await projectsByRepo(projectPaths);
  if (byRepo.size === 0) return [];
  const states = await prStatesOf([...byRepo.keys()], gh);
  return states.map(s => ({ ...s, projects: byRepo.get(s.repo) ?? [] }));
}

/**
 * The gh an E2E spec stands in for GitHub with (DOROTHY_E2E_GH, an absolute path): read under DOROTHY_E2E only, never
 * in a packaged build. The real gh comes first on the PATH Tars builds (/opt/homebrew/bin), so a stand-in placed on
 * the spec's PATH would never answer, and the real one would reach GitHub.
 */
export function testGhOf(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  if (packaged || env.DOROTHY_E2E !== '1') return null;
  const file = env.DOROTHY_E2E_GH ?? '';
  return path.isAbsolute(file) ? file : null;
}

/** The gh this run reads pull requests with: the E2E's stand-in when one is named (chooseGh), else gh on the PATH. */
let ghBinary = 'gh';

export function chooseGh(packaged: boolean): void {
  ghBinary = testGhOf(process.env, packaged) ?? 'gh';
}

/** The GitHub repository of a git remote URL, as `owner/name`, or undefined for another host. */
export function githubRepoOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * gh and git, found where a shell would find them: Tars opened from the Dock
 * or Finder has /usr/bin:/bin:/usr/sbin:/sbin for a PATH, and gh lives in
 * /opt/homebrew/bin, so every poll failed there, silently (the Audit's gate
 * of #234).
 */
const run = (file: string, args: string[], cwd?: string) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: buildFullPath() } },
    (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/**
 * One poll of the GitHub repositories of these projects. Each event goes under
 * the project its repository was found in, the first when several share it: a
 * reply to its report goes to that project's orchestrator.
 */
export async function pollProjects(projectPaths: string[], now: number = Date.now()): Promise<PrEvent[]> {
  const projectOfRepo = new Map<string, string>();
  for (const project of new Set(projectPaths)) {
    try {
      const repo = githubRepoOf((await safeGit(project, ['remote', 'get-url', 'origin'])).stdout);
      if (repo && !projectOfRepo.has(repo)) projectOfRepo.set(repo, project);
    } catch { /* not a repository */ }
  }
  if (projectOfRepo.size === 0) return [];
  const seen = await pollGithub([...projectOfRepo.keys()], args => run('gh', args), now);
  return seen.map(event => ({ ...event, projectPath: projectOfRepo.get(event.repo) ?? '' }));
}

let timer: NodeJS.Timeout | undefined;

/**
 * Polls the repositories of these projects every POLL_MS, while `isOn` says
 * the reports go out (the relay is on), and hands what it finds to the event
 * reports.
 */
export function startGithubWatch(projectPaths: () => string[], isOn: () => boolean): void {
  if (timer) return;
  const tick = async () => {
    if (!isOn()) return;
    for (const event of await pollProjects(projectPaths())) reportEvent(event);
  };
  timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();
}
