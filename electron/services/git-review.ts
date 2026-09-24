import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const run = promisify(execFile);

/**
 * What an agent actually changed. Every git call goes through execFile with an
 * argv array, never a shell, so a branch or path holding a quote or a
 * semicolon is data, not syntax.
 */

const MAX_PATCH_BYTES = 2_000_000;

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
}

export interface ReviewDiff {
  repo: string;
  branch: string;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  /** Unified patch, capped. Empty when nothing changed. */
  patch: string;
  truncated: boolean;
}

/**
 * `--no-optional-locks`: `git status` otherwise takes `index.lock` to refresh
 * the index as it reads, and an agent's own `git commit` at that moment fails
 * with "index.lock exists". Measured on git 2.39: the flag keeps `status` off
 * the index but not a content diff (`git diff HEAD`), so the check a cached
 * diff costs never writes; only a diff computed again can.
 */
async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', ['--no-optional-locks', ...args], { cwd, maxBuffer, timeout: 30_000 });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return '';
  }
}

/**
 * A ref name git cannot mistake for an option. A rev range is interpolated as
 * `${baseBranch}...HEAD` into an argv slot git still parses for options (`--`
 * protects only the pathspec after it): a "branch" of `--output=/somewhere`
 * made `git diff --numstat` write the patch outside the repo. Base branches and
 * fileDiff's paths both come through here. The first character excludes `-`
 * and `/`; the rest is the branch/remote alphabet (`origin/feat/x-1.2`).
 */
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function assertSafeRef(ref: string): string {
  if (!SAFE_REF.test(ref)) throw new Error(`invalid base branch: ${ref}`);
  return ref;
}

function statusFromCode(code: string): ChangedFile['status'] {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('?')) return 'untracked';
  return 'modified';
}

/**
 * The branch this work is compared against: the trunk it branched from, not
 * its upstream when that is only origin/<this branch>, which shows nothing.
 */
const BASE_CANDIDATES = ['main', 'master', 'develop'];

/** What the choice below reads, asked all at once: it does not depend on the current branch. */
async function baseCandidates(cwd: string): Promise<{ existing: string[]; upstream: string }> {
  const [found, upstream] = await Promise.all([
    Promise.all(BASE_CANDIDATES.map(candidate => tryGit(cwd, ['rev-parse', '--verify', '--quiet', candidate]))),
    tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ]);
  return { existing: BASE_CANDIDATES.filter((_, i) => found[i].trim()), upstream: upstream.trim() };
}

function chooseBaseBranch({ existing, upstream }: { existing: string[]; upstream: string }, current: string): string | null {
  const candidate = existing.find(name => name !== current);
  if (candidate) return candidate;

  // The upstream is repo-controlled: a .git/config with `[remote "-evil"]`
  // makes this print `-evil/work`, which would reach the rev-range argv slot
  // with no caller involved. An unusable name is the same as no base branch.
  if (upstream && SAFE_REF.test(upstream) && !upstream.endsWith(`/${current}`)) return upstream;

  return null;
}

/**
 * What the diff below depends on, cheaply: the head, the base's commit, and
 * every path `git status` lists with its size and modification time. An agent
 * editing a file it already changed leaves the status line as it was and moves
 * the mtime, so the stat is part of it.
 */
async function worktreeState(repoPath: string, baseBranch: string | null): Promise<string> {
  const [head, base, status] = await Promise.all([
    tryGit(repoPath, ['rev-parse', 'HEAD']),
    baseBranch ? tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`]) : Promise.resolve(''),
    tryGit(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const entries = status.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or a copy is followed by the path it came from.
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(entries[++i] ?? '');
  }
  const stats = await Promise.all(paths.map(async file => {
    try {
      const st = await fs.promises.stat(path.join(repoPath, file));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'gone';
    }
  }));
  return JSON.stringify([head.trim(), base.trim(), status, stats]);
}

/**
 * The last diff of each repository and base, and the state it was taken on:
 * `review:diff` ran nine git commands on every visit (366 to 731 ms a branch,
 * the Audit, 2026-09-23), where the state costs three, run together. Kept for
 * the last few repositories.
 */
const diffs = new Map<string, { state: string; diff: ReviewDiff }>();
const MAX_CACHED_DIFFS = 16;

/** Test seam. */
export function resetReviewCache(): void {
  diffs.clear();
}

/**
 * Everything this working tree changed: committed since the base branch, plus
 * whatever is still uncommitted. That is the question a reviewer actually has.
 */
export async function reviewDiff(repoPath: string, opts: { baseBranch?: string } = {}): Promise<ReviewDiff> {
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new Error(`path does not exist: ${repoPath}`);
  }
  // A caller-supplied base is untrusted: it crosses IPC from the renderer.
  if (opts.baseBranch) assertSafeRef(opts.baseBranch);
  // One round of git for what the base choice and the cache key need, then
  // one for the state: a diff answered from the cache costs two, not five.
  const [inside, head, candidates] = await Promise.all([
    tryGit(repoPath, ['rev-parse', '--is-inside-work-tree']),
    tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    opts.baseBranch === undefined ? baseCandidates(repoPath) : null,
  ]);
  if (inside.trim() !== 'true') throw new Error('not a git repository');

  const branch = head.trim() || 'HEAD';
  const baseBranch = opts.baseBranch ?? chooseBaseBranch(candidates!, branch);

  const key = JSON.stringify([path.resolve(repoPath), branch, baseBranch]);
  const state = await worktreeState(repoPath, baseBranch);
  const cached = diffs.get(key);
  if (cached?.state === state) return cached.diff;

  const diff = await computeDiff(repoPath, branch, baseBranch);
  diffs.delete(key);
  diffs.set(key, { state, diff });
  if (diffs.size > MAX_CACHED_DIFFS) diffs.delete(diffs.keys().next().value!);
  return diff;
}

async function computeDiff(repoPath: string, branch: string, baseBranch: string | null): Promise<ReviewDiff> {
  // Numstat covers committed work since the base plus the working tree. Every
  // read below is independent of the others: they run together.
  const range = baseBranch ? [`${baseBranch}...HEAD`] : [];
  const [counts, numstatBase, numstatHead, nameBase, nameHead, untracked, patchBase, patchHead] = await Promise.all([
    baseBranch ? tryGit(repoPath, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]) : Promise.resolve(''),
    tryGit(repoPath, ['diff', '--numstat', ...range]),
    tryGit(repoPath, ['diff', '--numstat', 'HEAD']),
    tryGit(repoPath, ['diff', '--name-status', ...range]),
    tryGit(repoPath, ['diff', '--name-status', 'HEAD']),
    tryGit(repoPath, ['ls-files', '--others', '--exclude-standard']),
    tryGit(repoPath, ['diff', ...range]),
    tryGit(repoPath, ['diff', 'HEAD']),
  ]);

  let ahead = 0;
  let behind = 0;
  if (baseBranch) {
    const [b, a] = counts.trim().split(/\s+/).map(Number);
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  const numstat = [numstatBase, numstatHead].join('\n');
  const nameStatus = [nameBase, nameHead].join('\n');

  const statusByPath = new Map<string, ChangedFile['status']>();
  for (const line of nameStatus.split('\n')) {
    const [code, ...rest] = line.trim().split('\t');
    const file = rest[rest.length - 1];
    if (code && file) statusByPath.set(file, statusFromCode(code));
  }

  const files = new Map<string, ChangedFile>();
  for (const line of numstat.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const [add, del, file] = parts;
    if (!file) continue;
    const existing = files.get(file);
    const additions = add === '-' ? 0 : Number(add) || 0;
    const deletions = del === '-' ? 0 : Number(del) || 0;
    if (existing) {
      existing.additions = Math.max(existing.additions, additions);
      existing.deletions = Math.max(existing.deletions, deletions);
    } else {
      files.set(file, { path: file, status: statusByPath.get(file) ?? 'modified', additions, deletions });
    }
  }

  // Untracked files never appear in a diff, and they are usually the point.
  for (const file of untracked.trim().split('\n').filter(Boolean)) {
    if (files.has(file)) continue;
    let additions = 0;
    try {
      const full = path.join(repoPath, file);
      if (fs.statSync(full).size < 512_000) {
        additions = fs.readFileSync(full, 'utf-8').split('\n').length;
      }
    } catch { /* binary or unreadable: count as 0 */ }
    files.set(file, { path: file, status: 'untracked', additions, deletions: 0 });
  }

  let patch = [patchBase, patchHead].filter(Boolean).join('\n');

  const truncated = patch.length > MAX_PATCH_BYTES;
  if (truncated) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n… patch truncated`;

  const list = Array.from(files.values()).sort((a, b) =>
    (b.additions + b.deletions) - (a.additions + a.deletions));

  return {
    repo: repoPath,
    branch,
    baseBranch,
    ahead,
    behind,
    files: list,
    totalAdditions: list.reduce((n, f) => n + f.additions, 0),
    totalDeletions: list.reduce((n, f) => n + f.deletions, 0),
    patch,
    truncated,
  };
}

const MAX_FILE_PATCH_BYTES = 400_000;

function cap(patch: string): string {
  return patch.length > MAX_FILE_PATCH_BYTES
    ? `${patch.slice(0, MAX_FILE_PATCH_BYTES)}\n… patch truncated`
    : patch;
}

/** The patch for one file, for a focused read. */
export async function fileDiff(repoPath: string, file: string, baseBranch?: string): Promise<string> {
  // A leading dash would be read as a flag rather than a path.
  if (file.startsWith('-')) throw new Error('invalid path');
  // Same reason, for the value that is *not* behind the `--` separator.
  if (baseBranch) assertSafeRef(baseBranch);

  // Same guard reviewDiff and repoSummary already have: every git call below
  // goes through tryGit, which swallows failures and returns '' - so on a
  // non-git directory `committed`/`working` both come back empty and this
  // fell through to the "untracked file" fallback, silently reading the file
  // off disk and presenting it as a diff addition instead of erroring.
  const inside = (await tryGit(repoPath, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') throw new Error('not a git repository');

  const range = baseBranch ? [`${baseBranch}...HEAD`] : [];
  const committed = await tryGit(repoPath, ['diff', ...range, '--', file]);
  const working = await tryGit(repoPath, ['diff', 'HEAD', '--', file]);
  const both = [committed, working].filter(Boolean).join('\n');
  if (both) return cap(both);

  // Untracked: show it as an addition rather than nothing. A generated
  // bundle can be megabytes, and nobody reviews that in a panel.
  try {
    const full = path.join(repoPath, file);
    if (fs.statSync(full).size > MAX_FILE_PATCH_BYTES) {
      return `+++ b/${file}\n… file is too large to show (${Math.round(fs.statSync(full).size / 1024)} KB)`;
    }
    const content = fs.readFileSync(full, 'utf-8');
    return cap(`--- /dev/null\n+++ b/${file}\n${content.split('\n').map(l => `+${l}`).join('\n')}`);
  } catch {
    return '';
  }
}

export interface RepoSummary {
  branch: string;
  status: { status: string; file: string }[];
  commits: { hash: string; subject: string; author: string; when: string }[];
  additions: number;
  deletions: number;
}

/**
 * Everything the Git panel used to gather with four shell pipelines, from git
 * run with an argv array and parsed in one place.
 */
export async function repoSummary(repoPath: string): Promise<RepoSummary> {
  if (!repoPath || !fs.existsSync(repoPath)) throw new Error('no such directory');
  // Every other check here goes through tryGit, which swallows failures and
  // returns '' - so a plain (non-git) directory used to come back as a
  // "successful" summary with branch "unknown" and nothing else, instead of
  // the error the caller needs to tell a broken project apart from an empty one.
  const inside = (await tryGit(repoPath, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') throw new Error('not a git repository');

  const branch = (await tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'unknown';

  const status = (await tryGit(repoPath, ['status', '--porcelain', '--untracked-files=all']))
    .split('\n')
    .filter(line => line.length >= 3)
    .map(line => {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      const state = code.includes('?') ? 'new'
        : code.includes('A') ? 'added'
        : code.includes('D') ? 'deleted'
        : code.includes('R') ? 'renamed'
        : 'modified';
      return { status: state, file };
    })
    .filter(entry => entry.file);

  const commits = (await tryGit(repoPath, ['log', '--pretty=format:%h%x1f%s%x1f%an%x1f%ar', '-10']))
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, subject, author, when] = line.split('\x1f');
      return { hash, subject, author, when };
    });

  let additions = 0;
  let deletions = 0;
  for (const line of (await tryGit(repoPath, ['diff', '--numstat', 'HEAD'])).split('\n')) {
    const [add, del] = line.split('\t');
    additions += add === '-' ? 0 : Number(add) || 0;
    deletions += del === '-' ? 0 : Number(del) || 0;
  }

  return { branch, status, commits, additions, deletions };
}
