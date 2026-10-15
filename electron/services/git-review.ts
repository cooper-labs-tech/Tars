import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { gitCommand } from '../platform/git-command';

const run = promisify(execFile);

/**
 * What an agent actually changed.
 *
 * The Git panel ran `git diff --stat | tail -20` through a shell and showed
 * twenty lines of summary - no patch, no per-file view, and a shell command
 * built by string concatenation. Everything here goes through execFile with an
 * argv array: no shell, so a branch or path containing a quote or a semicolon
 * is data, not syntax.
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
 * `--no-optional-locks`: the Review page reads repositories agents are working
 * in, and `git status` otherwise takes `index.lock` to rewrite the index as it
 * reads, which makes an agent's own `git commit` in that moment fail with
 * "index.lock exists". Measured on git 2.39: the flag keeps `status` off the
 * index, not a diff that compares content (`git diff HEAD`, as before this
 * cache), which still refreshes it. So the check a cached diff costs, a
 * `status`, never writes; only a diff that has to be computed again can.
 */
async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  // core.quotePath=false: a name with accents comes back as it is, where git
  // quoted and escaped it ("caf\303\251.txt") and that text became the path.
  const { stdout } = await run(gitCommand(), ['--no-optional-locks', '-c', 'core.quotePath=false', ...args], { cwd, maxBuffer, timeout: 30_000 });
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
 * A patch, read no further than `limit` bytes, and whether it was cut there.
 *
 * Past git()'s 8 MB buffer, execFile failed and tryGit made that '': a patch
 * above 8 MB came back empty and marked as not cut, in the list and for a
 * single file (the Audit's gate of #272). Asking git for no more than is shown
 * keeps the rest of a huge diff out of memory too.
 */
async function gitPatch(cwd: string, args: string[], limit: number): Promise<{ text: string; cut: boolean }> {
  try {
    return { text: await git(cwd, args, limit), cut: false };
  } catch (err) {
    const { code, stdout } = err as { code?: string; stdout?: string };
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { text: stdout ?? '', cut: true };
    return { text: '', cut: false };
  }
}

/** Whether `inner` is `root` or lies under it. */
function within(root: string, inner: string): boolean {
  const rel = path.relative(root, inner);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * A ref name that git cannot mistake for an option.
 *
 * Every rev range here is interpolated as `${baseBranch}...HEAD`, which lands
 * in an argv slot git still parses for options - `--` only protects the
 * pathspec that comes after it. A "branch" of `--output=/somewhere/else` made
 * `git diff --numstat --output=/somewhere/else...HEAD` write the patch to a
 * file outside the repo. `fileDiff` guarded its path against a leading dash
 * and left the base branch unguarded; both go through here now.
 *
 * The first character excludes `-` and `/` so no value can start an option,
 * and the rest is the branch/remote alphabet (`origin/feat/x-1.2`).
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
 * The branch this work should be compared against.
 *
 * The upstream is the wrong answer when it is just origin/<this branch>:
 * comparing an agent's branch to its own remote copy shows nothing, when the
 * question is what the agent changed relative to the trunk it branched from.
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
 * The last diff of each repository and base, and the state it was taken on.
 *
 * `review:diff` took 366 to 731 ms per branch (the Audit, 2026-09-23): nine git
 * commands one after the other, run again on every visit to the same branch.
 * The state above costs three, run together; when it is unchanged the diff is
 * too. Kept for the last few repositories only.
 */
const diffs = new Map<string, { state: string; diff: ReviewDiff; withPatch: boolean }>();
const MAX_CACHED_DIFFS = 16;

/** Test seam. */
export function resetReviewCache(): void {
  diffs.clear();
}

/**
 * Everything this working tree changed: committed since the base branch, plus
 * whatever is still uncommitted. That is the question a reviewer actually has.
 */
export async function reviewDiff(
  repoPath: string,
  opts: { baseBranch?: string; listOnly?: boolean } = {},
): Promise<ReviewDiff> {
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new Error(`path does not exist: ${repoPath}`);
  }
  // A caller-supplied base is untrusted: it crosses IPC from the renderer.
  if (opts.baseBranch) assertSafeRef(opts.baseBranch);
  // One round of git for what the base choice and the cache key need, then
  // one for the state: a diff answered from the cache costs two, not five.
  const [inside, symbolic, head, candidates] = await Promise.all([
    tryGit(repoPath, ['rev-parse', '--is-inside-work-tree']),
    // A repository with no commit has a branch that rev-parse cannot name.
    tryGit(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']),
    tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    opts.baseBranch === undefined ? baseCandidates(repoPath) : null,
  ]);
  if (inside.trim() !== 'true') throw new Error('not a git repository');

  const branch = symbolic.trim() || head.trim() || 'HEAD';
  const baseBranch = opts.baseBranch ?? chooseBaseBranch(candidates!, branch);

  const key = JSON.stringify([path.resolve(repoPath), branch, baseBranch]);
  const state = await worktreeState(repoPath, baseBranch);
  // A list-only call (the Review page reads each file's patch on its own,
  // through review:file) runs no git for the patches and carries none over
  // IPC. It is answered from a full diff kept, never the other way round.
  const listOnly = opts.listOnly === true;
  const cached = diffs.get(key);
  if (cached?.state === state && (cached.withPatch || listOnly)) {
    return listOnly && cached.withPatch ? { ...cached.diff, patch: '', truncated: false } : cached.diff;
  }

  const diff = await computeDiff(repoPath, branch, baseBranch, !listOnly);
  diffs.delete(key);
  diffs.set(key, { state, diff, withPatch: !listOnly });
  if (diffs.size > MAX_CACHED_DIFFS) diffs.delete(diffs.keys().next().value!);
  return diff;
}

/**
 * What this working tree is compared against, so that one diff answers what it
 * changed: the merge base with the base branch, or HEAD with no base, or the
 * empty tree in a repository with no commit yet.
 *
 * It was two passes, committed since the base then uncommitted since HEAD,
 * merged file by file with the larger count: a file changed in a commit and
 * again since was counted once, and a repository with no commit, where
 * `git diff HEAD` fails, lost its staged files. Adding the two counts instead
 * would double the unstaged changes of a branch with no base, which both
 * passes see. From the starting point to the working tree, each line counts
 * once.
 */
async function startingPoint(repoPath: string, baseBranch: string | null): Promise<string> {
  const head = (await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
  if (!head) {
    // The empty tree of this repository's own hash.
    return (await tryGit(repoPath, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  }
  if (!baseBranch) return head;
  return (await tryGit(repoPath, ['merge-base', baseBranch, 'HEAD'])).trim() || head;
}

/** `--name-status -z`: a code, a path, and for a rename or a copy the new path after the old. */
function namesFrom(out: string): Map<string, { status: ChangedFile['status']; from?: string }> {
  const names = new Map<string, { status: ChangedFile['status']; from?: string }>();
  const fields = out.split('\0');
  for (let i = 0; i + 1 < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = fields[++i];
      const to = fields[++i];
      if (to) names.set(to, { status: statusFromCode(code), from });
    } else {
      const file = fields[++i];
      if (file) names.set(file, { status: statusFromCode(code) });
    }
  }
  return names;
}

/** `--numstat -z`: "add\tdel\tpath", or for a rename "add\tdel\t" then the old and the new path. */
function countsFrom(out: string): Array<{ path: string; additions: number; deletions: number }> {
  const rows: Array<{ path: string; additions: number; deletions: number }> = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i]);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      i++; // the old path
      file = fields[++i] ?? '';
    }
    if (!file) continue;
    rows.push({ path: file, additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return rows;
}

/** git's own test: a NUL in the first 8000 bytes. */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/** Lines as a reader counts them: the last line ends with a newline, which is not one more. */
function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

async function computeDiff(repoPath: string, branch: string, baseBranch: string | null, withPatch: boolean): Promise<ReviewDiff> {
  // Every read below is independent of the others: they run together.
  const from = await startingPoint(repoPath, baseBranch);
  const [counts, numstat, names, untracked, diffPatch] = await Promise.all([
    baseBranch ? tryGit(repoPath, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]) : Promise.resolve(''),
    tryGit(repoPath, ['diff', '-M', '--numstat', '-z', from]),
    tryGit(repoPath, ['diff', '-M', '--name-status', '-z', from]),
    tryGit(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
    // A list-only call runs no git for the patch: the page reads each file's on its own.
    withPatch ? gitPatch(repoPath, ['diff', '-M', from], MAX_PATCH_BYTES) : Promise.resolve({ text: '', cut: false }),
  ]);

  let ahead = 0;
  let behind = 0;
  if (baseBranch) {
    const [b, a] = counts.trim().split(/\s+/).map(Number);
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  const statusByPath = namesFrom(names);
  const files = new Map<string, ChangedFile>();
  for (const { path: file, additions, deletions } of countsFrom(numstat)) {
    files.set(file, { path: file, status: statusByPath.get(file)?.status ?? 'modified', additions, deletions });
  }

  // Untracked files never appear in a diff, and they are usually the point.
  for (const file of untracked.split('\0').filter(Boolean)) {
    if (files.has(file)) continue;
    let additions = 0;
    try {
      const full = path.join(repoPath, file);
      const stat = fs.lstatSync(full);
      // A link is one line, its target path, as git counts it: what it points
      // to can be outside the repository, and is not what the link adds.
      if (stat.isSymbolicLink()) additions = 1;
      else if (stat.size < 512_000) {
        const content = fs.readFileSync(full);
        // A binary has no lines: its bytes split on newlines are not a count.
        if (!isBinary(content)) additions = lineCount(content.toString('utf-8'));
      }
    } catch { /* unreadable: count as 0 */ }
    files.set(file, { path: file, status: 'untracked', additions, deletions: 0 });
  }

  let patch = diffPatch.text;

  const truncated = diffPatch.cut || patch.length > MAX_PATCH_BYTES;
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
  // A path the list gives: relative, and inside the repository. The fallback
  // for untracked files below reads the disk, and '../../x' showed a file
  // outside it (the Audit's gate of #272).
  const full = path.resolve(repoPath, file);
  if (path.isAbsolute(file) || full === path.resolve(repoPath) || !within(repoPath, full)) throw new Error('invalid path');

  // Same guard reviewDiff and repoSummary already have: every git call below
  // goes through tryGit, which swallows failures and returns '' - so on a
  // non-git directory `committed`/`working` both come back empty and this
  // fell through to the "untracked file" fallback, silently reading the file
  // off disk and presenting it as a diff addition instead of erroring.
  const inside = (await tryGit(repoPath, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') throw new Error('not a git repository');

  // The same starting point as the list, so a file shows what the list counts.
  // A rename is listed under its new path, and git shows it as a rename only
  // when it is given both: the old one comes from the same name-status.
  const from = await startingPoint(repoPath, baseBranch ?? null);
  const origin = namesFrom(await tryGit(repoPath, ['diff', '-M', '--name-status', '-z', from])).get(file)?.from;
  const tracked = await gitPatch(repoPath, ['diff', '-M', from, '--', ...(origin ? [origin, file] : [file])], MAX_FILE_PATCH_BYTES);
  if (tracked.text) return tracked.cut ? `${tracked.text}\n… patch truncated` : tracked.text;

  // Untracked: show it as an addition rather than nothing. The folder it is
  // in must be the repository's once links are resolved: a linked folder
  // inside it can point anywhere.
  let folder: string;
  try {
    folder = fs.realpathSync(path.dirname(full));
  } catch {
    return '';
  }
  if (!within(fs.realpathSync(repoPath), folder)) throw new Error('invalid path');
  // A generated bundle can be megabytes, and nobody reviews that in a panel.
  try {
    // A link is shown as git shows one, its target path: never what it points to.
    if (fs.lstatSync(full).isSymbolicLink()) return `--- /dev/null\n+++ b/${file}\n+${fs.readlinkSync(full)}`;
    if (fs.statSync(full).size > MAX_FILE_PATCH_BYTES) {
      return `+++ b/${file}\n… file is too large to show (${Math.round(fs.statSync(full).size / 1024)} KB)`;
    }
    const content = fs.readFileSync(full);
    // As git words it, rather than the bytes printed as added lines.
    if (isBinary(content)) return `Binary files /dev/null and b/${file} differ`;
    const text = content.toString('utf-8');
    const lines = text.endsWith('\n') ? text.slice(0, -1) : text;
    return cap(`--- /dev/null\n+++ b/${file}${lines ? `\n${lines.split('\n').map(l => `+${l}`).join('\n')}` : ''}`);
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
 * Everything the Git panel used to gather with four shell pipelines.
 *
 * It built `git status --porcelain`, `git diff --stat | tail -20` and a
 * `--pretty` log as strings and ran them through a login shell; here git runs
 * with an argv array and the parsing happens once, in one place.
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
