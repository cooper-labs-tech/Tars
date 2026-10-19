import { safeGit } from '../utils/safe-git';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diskUsage } from '../platform/disk-usage';

/**
 * The folders no agent owns (JeanBrasse's choice 16 of 05/10; the frames merged in
 * #315, "Settings · System · folders no agent owns").
 *
 * A folder under a project's `.worktrees` that no git worktree holds: git
 * forgot it (its `.git` points to a gitdir that is gone), or it never had a
 * `.git`. Nothing says whether it holds work, so Tars lists each with its
 * project, its size and when it last changed, and never removes one on its
 * own. The window confirms, then asks for all of them to go: each is checked
 * again at that moment (still an orphan, no agent's, no process working in
 * it, no link) and removed one at a time, the progress told as it goes. Git is
 * never told --force: these are folders git no longer knows.
 *
 * What a folder is comes from its own `.git`, not from this project's
 * `git worktree list` alone (the Audit's gate of #334, which lost a clone,
 * another repository's worktree and a repository nested two levels down that
 * way): a `.git` folder is a repository, a `.git` file whose gitdir exists is
 * a live worktree of some repository, and neither is ever listed, nor is a
 * folder with either anywhere below it. When anything cannot be read (the
 * project's git, a `.git`, a folder too deep to look through), the folder is
 * kept.
 */

/** Tars warns below this much free space on the disk (the frames' 30 GB). */
export const DISK_FLOOR_BYTES = 30 * 1024 ** 3;

export type OrphanReason = 'git-forgot' | 'no-git';
export type OrphanFolder = {
  /** The project the .worktrees folder is in. */
  project: string;
  path: string;
  /** Its path under the project's .worktrees. */
  name: string;
  reason: OrphanReason;
  sizeBytes: number;
  /** The newest change in it (caches and .git aside), or null when none could be read. */
  lastChangedAt: string | null;
};
export type OrphanListing = {
  folders: OrphanFolder[];
  count: number;
  totalBytes: number;
  /** The projects whose worktrees git could not list: none of their folders is offered. Why is in the log. */
  unreadProjects: string[];
};
export type KeptReason = 'in-use' | 'unknown-use' | 'failed';
export type RemovalReport = {
  removed: number;
  freedBytes: number;
  kept: Array<{ path: string; project: string; reason: KeptReason; detail?: string }>;
};
export type RemovalProgress = { done: number; total: number; freedBytes: number; current: string };
type ProcessCwd = { pid: number; command: string; cwd: string };

/** git, through safe-git: no program of the repository's runs (the Audit's Hole 3 on 2.0.4). */
function gitIn(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return safeGit(cwd, args, { maxBuffer: 32 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: { code?: unknown; stdout?: string; stderr?: string; message?: string }) => ({ code: typeof err.code === 'number' ? err.code : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr || err.message || '') }),
  );
}

function run(file: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr || (err ? err.message : '')),
      });
    });
  });
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The worktrees git knows for a project, as real paths; null when git cannot say. */
async function knownWorktrees(project: string): Promise<string[] | null> {
  const r = await gitIn(project, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) {
    console.warn(`[orphan-folders] git cannot list the worktrees of ${project} (${r.code}): ${r.stderr.trim().slice(0, 300)}; none of its folders is offered`);
    return null;
  }
  return r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => real(l.slice('worktree '.length)));
}

function isRealDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

type GitMark = 'none' | 'repository' | 'live-worktree' | 'forgotten' | 'unreadable';

/** What a folder's own `.git` says it is. */
function gitMark(dir: string): GitMark {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGit);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unreadable';
  }
  if (stat.isDirectory()) return 'repository';
  if (!stat.isFile()) return 'unreadable';
  let text: string;
  try { text = fs.readFileSync(dotGit, 'utf8'); } catch { return 'unreadable'; }
  const gitdir = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
  if (!gitdir) return 'unreadable';
  try {
    fs.statSync(path.resolve(dir, gitdir));
    return 'live-worktree';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'forgotten' : 'unreadable';
  }
}

/** Folders a `.git` below is looked for in: rebuildable caches aside. */
const NOT_SEARCHED = new Set(['node_modules', '.next', '.git']);
const SEARCH_LIMIT = 50_000;

/** Whether a package in `nodeModules`, scoped or not, is a repository: 'unknown' when it cannot be read. */
function packageRepository(nodeModules: string): 'none' | 'some' | 'unknown' {
  const has = (p: string) => fs.existsSync(path.join(p, '.git'));
  let packages: fs.Dirent[];
  try { packages = fs.readdirSync(nodeModules, { withFileTypes: true }); } catch { return 'unknown'; }
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue;
    const p = path.join(nodeModules, pkg.name);
    if (!pkg.name.startsWith('@')) { if (has(p)) return 'some'; continue; }
    let scoped: fs.Dirent[];
    try { scoped = fs.readdirSync(p, { withFileTypes: true }); } catch { return 'unknown'; }
    if (scoped.some(s => s.isDirectory() && has(path.join(p, s.name)))) return 'some';
  }
  return 'none';
}

/**
 * Whether any folder below `dir` (not `dir` itself) has a `.git`, at any
 * depth, links not followed: 'unknown' when a folder cannot be read or there
 * is more than SEARCH_LIMIT entries to look through.
 */
function gitBelow(dir: string, limit = SEARCH_LIMIT): 'none' | 'some' | 'unknown' {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return 'unknown'; }
    for (const entry of entries) {
      if (++seen > limit) return 'unknown';
      if (current !== dir && entry.name === '.git') return 'some';
      if (entry.isDirectory() && entry.name === 'node_modules') {
        // Not searched through, but a package checked out as a repository
        // (node_modules/<name>/.git, node_modules/@<scope>/<name>/.git) is
        // looked for (the Audit's recheck of #334).
        const found = packageRepository(path.join(current, entry.name));
        if (found !== 'none') return found;
        continue;
      }
      if (entry.isDirectory() && !NOT_SEARCHED.has(entry.name)) stack.push(path.join(current, entry.name));
    }
  }
  return 'none';
}

/** Why a folder is an orphan, or null when it is not one (or cannot be told). */
function orphanReason(dir: string): OrphanReason | null {
  const mark = gitMark(dir);
  if (mark !== 'none' && mark !== 'forgotten') return null;
  if (gitBelow(dir) !== 'none') return null;
  return mark === 'forgotten' ? 'git-forgot' : 'no-git';
}

/** Size on disk, in bytes, as du counts it. Windows has no du: there the folder is added up in Node (platform/disk-usage.ts). */
async function sizeOf(p: string): Promise<number> {
  if (process.platform === 'win32') return diskUsage(p);
  const r = await run('du', ['-sk', p]);
  const kb = Number(r.stdout.split(/\s/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** The newest mtime of the files in `dir`, caches and .git aside, a bounded walk. */
function lastChangeOf(dir: string): string | null {
  const skip = new Set(['node_modules', '.next', '.git']);
  let newest = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < 20_000) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen++;
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) stack.push(p); continue; }
      if (!entry.isFile()) continue;
      try { newest = Math.max(newest, fs.lstatSync(p).mtimeMs); } catch { /* gone */ }
    }
  }
  if (!newest) {
    try { newest = fs.lstatSync(dir).mtimeMs; } catch { return null; }
  }
  return new Date(newest).toISOString();
}

/**
 * The orphans under one project's .worktrees: each folder that is not a
 * worktree git knows nor an agent's, walked into when it holds one (a branch
 * name with a slash nests its worktree), never through a link.
 */
async function orphansOf(project: string, owned: Set<string>, searchLimit = SEARCH_LIMIT): Promise<Array<Omit<OrphanFolder, 'sizeBytes' | 'lastChangedAt'>> | null> {
  const base = path.join(project, '.worktrees');
  if (!isRealDir(base)) return [];
  const known = await knownWorktrees(project);
  if (!known) return null;
  const live = [...known, ...owned].map(real);
  const holdsLive = (dir: string) => live.some(w => inside(w, real(dir)) && w !== real(dir));
  const found: Array<Omit<OrphanFolder, 'sizeBytes' | 'lastChangedAt'>> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(dir, entry.name);
      const r = real(p);
      if (live.includes(r)) continue;
      if (holdsLive(p)) { walk(p); continue; }
      const mark = gitMark(p);
      // A repository, a live worktree of any repository, or a .git that
      // cannot be read: never offered.
      if (mark !== 'none' && mark !== 'forgotten') continue;
      const below = gitBelow(p, searchLimit);
      if (below === 'unknown') continue;
      // Something with a .git below, at any depth: each folder around it is
      // looked at for itself.
      if (below === 'some') { walk(p); continue; }
      found.push({ project, path: p, name: path.relative(base, p), reason: mark === 'forgotten' ? 'git-forgot' : 'no-git' });
    }
  };
  walk(base);
  return found;
}

/** `searchLimit`: how many entries below a folder are looked through for a `.git` (SEARCH_LIMIT); a test crosses a small one. */
export async function listOrphanFolders(opts: { projects: string[]; owned: string[]; searchLimit?: number }): Promise<OrphanListing> {
  const owned = new Set(opts.owned.map(real));
  const folders: OrphanFolder[] = [];
  const unreadProjects: string[] = [];
  for (const project of [...new Set(opts.projects)]) {
    const orphans = await orphansOf(project, owned, opts.searchLimit);
    if (!orphans) { unreadProjects.push(project); continue; }
    for (const orphan of orphans) {
      folders.push({ ...orphan, sizeBytes: await sizeOf(orphan.path), lastChangedAt: lastChangeOf(orphan.path) });
    }
  }
  folders.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { folders, count: folders.length, totalBytes: folders.reduce((sum, f) => sum + f.sizeBytes, 0), unreadProjects };
}

/**
 * The working directories /proc shows. Null when it cannot be read, or when
 * this process's own is not among them (hidepid, a /proc that is not this
 * system's): then nothing is removed, as when lsof fails on macOS.
 */
export function procCwds(root = '/proc', self = process.pid): ProcessCwd[] | null {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return null; }
  const found: ProcessCwd[] = [];
  for (const pid of names.filter(n => /^\d+$/.test(n))) {
    try {
      found.push({ pid: Number(pid), command: fs.readFileSync(path.join(root, pid, 'comm'), 'utf8').trim(), cwd: fs.readlinkSync(path.join(root, pid, 'cwd')) });
    } catch { /* gone, or not ours to read */ }
  }
  return found.some(p => p.pid === self) ? found : null;
}

/**
 * Every process's working directory: /proc on Linux, lsof elsewhere. Null when
 * neither answers, and then nothing is removed. As scripts/worktree.mjs reads it.
 */
export async function processCwds(): Promise<ProcessCwd[] | null> {
  if (process.platform === 'linux') return procCwds();
  const found: ProcessCwd[] = [];
  const r = await run('lsof', ['-w', '-a', '-d', 'cwd', '-F', 'pcn']);
  if (r.code !== 0 && !r.stdout) return null;
  let current: ProcessCwd | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) current = { pid: Number(line.slice(1)), command: '', cwd: '' };
    else if (current && line.startsWith('c')) current.command = line.slice(1);
    else if (current && line.startsWith('n')) { current.cwd = line.slice(1); found.push(current); }
  }
  return found;
}

let removing = false;

/**
 * Why a removal failed, for the window: the error's code and the path within
 * the folder, never Node's message, which carries the absolute path and so
 * the home folder (the Audit's gate of #336).
 */
function failureOf(err: unknown, folder: string): string {
  const { code, path: where } = (err ?? {}) as NodeJS.ErrnoException;
  if (!code) return 'it could not be removed';
  const within = where ? path.relative(folder, where) : '';
  return within && !within.startsWith('..') && !path.isAbsolute(within) ? `${code} on ${within}` : code;
}

/**
 * Removes every folder no agent owns, as it stands now: the list is read
 * again, and each folder is checked once more just before it goes, its .git
 * and what is below it, and the processes read again (a removal can last
 * minutes). One at a time; `onProgress` after each. A folder a process works
 * in is kept, and so is every one when the processes cannot be read.
 */
export async function removeOrphanFolders(opts: {
  projects: string[];
  owned: string[];
  /** The folders the window showed and the person confirmed (OrphanFolder.path): nothing else is removed. */
  paths: string[];
  processCwds?: () => Promise<ProcessCwd[] | null>;
  onProgress?: (progress: RemovalProgress) => void;
}): Promise<RemovalReport> {
  if (removing) throw new Error('a removal is already under way');
  removing = true;
  try {
    // Only what was shown and confirmed, and of that only what is an orphan
    // now: a folder that became one while Settings stayed open was never
    // shown (the Audit's gate of #336).
    const asked = [...new Set(opts.paths)];
    const report: RemovalReport = { removed: 0, freedBytes: 0, kept: [] };
    if (!asked.length) return report;
    const listing = await listOrphanFolders(opts);
    const now = new Map(listing.folders.map(f => [f.path, f]));
    let done = 0;
    for (const askedPath of asked) {
      const folder = now.get(askedPath);
      if (!folder) {
        const project = opts.projects.find(p => inside(askedPath, path.join(p, '.worktrees'))) ?? '';
        report.kept.push({ path: askedPath, project, reason: 'failed', detail: 'it is not a folder no agent owns now' });
        done++;
        opts.onProgress?.({ done, total: asked.length, freedBytes: report.freedBytes, current: askedPath });
        continue;
      }
      const cwds = await (opts.processCwds ?? processCwds)();
      const keep = (reason: KeptReason, detail?: string) => report.kept.push({ path: folder.path, project: folder.project, reason, ...(detail ? { detail } : {}) });
      if (!cwds) {
        keep('unknown-use');
      } else {
        const user = cwds.find(p => inside(real(p.cwd), real(folder.path)));
        if (user) {
          keep('in-use', `${user.command} (${user.pid})`);
        } else if (!isRealDir(folder.path) || !inside(real(folder.path), real(path.join(folder.project, '.worktrees')))) {
          keep('failed', 'it is no longer a folder of the project\'s .worktrees');
        } else if (orphanReason(folder.path) === null) {
          keep('failed', 'it holds a git repository or a live worktree now, or could not be read');
        } else {
          try {
            fs.rmSync(folder.path, { recursive: true, force: true });
            report.removed++;
            report.freedBytes += folder.sizeBytes;
          } catch (err) {
            keep('failed', failureOf(err, folder.path));
          }
        }
      }
      done++;
      opts.onProgress?.({ done, total: asked.length, freedBytes: report.freedBytes, current: folder.path });
    }
    return report;
  } finally {
    removing = false;
  }
}

/** The free and total space of the disk `at` is on, and the floor Tars warns below. Null when it cannot be read. */
export function diskSpace(at: string = os.homedir()): { freeBytes: number; totalBytes: number; floorBytes: number } | null {
  try {
    const s = fs.statfsSync(at);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, floorBytes: DISK_FLOOR_BYTES };
  } catch {
    return null;
  }
}
