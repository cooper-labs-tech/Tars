import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { childEnv, envValue, isPlainAbsolute, type Env } from '../platform';

/**
 * An agent's new worktree gets its project's dependencies as a clone (JeanBrasse's
 * choice 17, 05/10). Each package of the worktree (the root, and every folder
 * one level down with a package.json: mcp-*, landing) whose node_modules is
 * missing gets the project's own, cloned when it was installed for the same
 * lock. On APFS `cp -c` shares every block: 9.8 s and about 65 MB of real
 * space for a 1.2 GB node_modules (measured 01/10 for scripts/worktree.mjs),
 * where each agent ran its own `npm ci` into its worktree.
 *
 * Clone or nothing: a system that cannot clone (another file system, no
 * reflink) gets no copy of gigabytes, and the agent installs as before. A
 * clone that fails is taken away whole. Windows has no cp -c: there a copy
 * shares blocks only on a Dev Drive (ReFS) from Windows 11 24H2
 * (windowsClone).
 */

export type DepsResult = { cloned: string[]; skipped: Array<{ dir: string; why: string }> };
type Copy = (source: string, target: string) => Promise<void>;

/** `cp`'s arguments for a clone that shares blocks, or null where there is none. */
export function cloneArgs(platform: NodeJS.Platform, source: string, target: string): string[] | null {
  if (platform === 'darwin') return ['-c', '-R', source, target];
  if (platform === 'linux') return ['-R', '--reflink=always', source, target];
  return null;
}

/** The file system of the volume `p` lies on, from `mount`: the longest mount point above it. */
function fileSystemOf(p: string, mounts: string): string | undefined {
  let best: { at: string; type: string } | undefined;
  for (const line of mounts.split('\n')) {
    const m = line.match(/^.+? on (.+) \(([^,)]+)/);
    if (!m) continue;
    const at = m[1];
    const inside = at === '/' || p === at || p.startsWith(at.endsWith('/') ? at : `${at}/`);
    if (inside && (!best || at.length > best.at.length)) best = { at, type: m[2] };
  }
  return best?.type;
}

/**
 * Why `cp -c` would not clone from `source` into `targetDir` on macOS, or
 * null when it will: both ends on one APFS volume. Onto another file system it
 * copies in full and exits 0 (measured on an HFS+ disk image, QA's gate of
 * #325), and across volumes there is nothing to share.
 */
function noCloneOnMac(source: string, targetDir: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('/sbin/mount', [], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(`mount could not be read: ${err.message}`); return; }
      try {
        const from = fs.realpathSync(source);
        const to = fs.realpathSync(targetDir);
        const types = [fileSystemOf(from, String(stdout)), fileSystemOf(to, String(stdout))];
        if (types.some(t => t !== 'apfs')) { resolve(`not APFS (${types.map(t => t ?? 'unknown').join(' to ')}): cp -c would copy in full`); return; }
        if (fs.statSync(from).dev !== fs.statSync(to).dev) { resolve('another volume: there is nothing to share'); return; }
        resolve(null);
      } catch (e) {
        resolve(e instanceof Error ? e.message : String(e));
      }
    });
  });
}

/** What windowsClone reads of the system; a test hands in another Windows. */
export type WindowsCloneFacts = {
  /** os.release(): `10.0.<build>`. */
  release: () => string;
  /** The drive a path is on, `D:\`, from its real path. */
  rootOf: (p: string) => string;
  /** The volume a path is on (its serial number, as fs.stat gives it there). */
  devOf: (p: string) => number;
  /** The drive's file system as Windows names it: NTFS, ReFS. */
  driveFormat: (root: string) => Promise<string | undefined>;
};

/** Windows 11 24H2 and Windows Server 2025: CopyFile clones blocks within a ReFS volume. */
const BLOCK_CLONE_BUILD = 26100;

/** The file system of a drive (`D:\`), read by the Windows PowerShell under %SystemRoot%; undefined when it cannot be. */
export function windowsDriveFormat(root: string): Promise<string | undefined> {
  const configured = envValue(process.env as Env, 'SystemRoot', 'win32');
  const systemRoot = configured && isPlainAbsolute(configured) ? configured : 'C:\\Windows';
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { ...childEnv(file, process.env as Env, 'win32'), TARS_DRIVE: root } as unknown as NodeJS.ProcessEnv;
  return new Promise(resolve => {
    execFile(file, ['-NoProfile', '-NonInteractive', '-Command', '[IO.DriveInfo]::new($env:TARS_DRIVE).DriveFormat'],
      { env, windowsHide: true, timeout: 15_000 },
      (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined));
  });
}

const realWindowsFacts: WindowsCloneFacts = {
  release: () => os.release(),
  rootOf: p => path.win32.parse(p).root,
  devOf: p => fs.statSync(p).dev,
  driveFormat: windowsDriveFormat,
};

/**
 * Why a copy from `source` into `targetDir` would not share blocks on
 * Windows, or null when it will: Windows 11 24H2 or later, both ends on one
 * volume, that volume a drive of its own (one mounted in a folder has a file
 * system its drive's root does not tell), and that file system ReFS, a Dev
 * Drive's. There CopyFile, which fs.cp copies each file with, clones the
 * file's blocks; anywhere else it copies in full.
 */
async function noCloneOnWindows(source: string, targetDir: string, facts: WindowsCloneFacts): Promise<string | null> {
  const release = facts.release();
  if (!(Number(release.split('.')[2]) >= BLOCK_CLONE_BUILD)) {
    return `Windows ${release} copies in full: it shares blocks from Windows 11 24H2 (build ${BLOCK_CLONE_BUILD}), on a Dev Drive`;
  }
  try {
    const from = fs.realpathSync(source);
    const to = fs.realpathSync(targetDir);
    const root = facts.rootOf(from);
    if (!/^[A-Za-z]:\\$/.test(root)) return `not on a drive (${root || from}): its file system cannot be read`;
    if (facts.devOf(from) !== facts.devOf(to)) return 'another volume: there is nothing to share';
    if (facts.devOf(root) !== facts.devOf(from)) return 'a volume mounted in a folder: its drive does not say its file system';
    const format = await facts.driveFormat(root);
    if (format !== 'ReFS') return `not ReFS (${format ?? 'unknown'}): a copy would be in full`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A copy that shares every block, on a Dev Drive (noCloneOnWindows), else none. A link inside is copied as a link, as cp -R does. */
export async function windowsClone(source: string, target: string, facts: WindowsCloneFacts = realWindowsFacts): Promise<void> {
  const why = await noCloneOnWindows(source, path.dirname(target), facts);
  if (why) throw new Error(why);
  await fs.promises.cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
}

const cpClone: Copy = async (source, target) => {
  if (process.platform === 'win32') return windowsClone(source, target);
  const args = cloneArgs(process.platform, source, target);
  if (!args) throw new Error('this system has no clone that shares blocks');
  if (process.platform === 'darwin') {
    const why = await noCloneOnMac(source, path.dirname(target));
    if (why) throw new Error(why);
  }
  await new Promise<void>((resolve, reject) => {
    execFile('cp', args, { maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve();
    });
  });
};

/**
 * Whether the node_modules was installed for this lock: every package it holds
 * at the lock's version (and integrity, when both name one), and nothing the
 * lock needs missing. As scripts/worktree.mjs reads it.
 */
export function installedMatches(nodeModules: string, lockPath: string): boolean {
  let installed: Record<string, { version?: string; integrity?: string }>;
  let lock: Record<string, { version?: string; integrity?: string; optional?: boolean; devOptional?: boolean; peer?: boolean }>;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(nodeModules, '.package-lock.json'), 'utf8')).packages ?? {};
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')).packages ?? {};
  } catch {
    return false;
  }
  for (const [key, got] of Object.entries(installed)) {
    const want = lock[key];
    if (!want || want.version !== got.version) return false;
    if (want.integrity && got.integrity && want.integrity !== got.integrity) return false;
  }
  for (const [key, want] of Object.entries(lock)) {
    if (key === '' || installed[key]) continue;
    if (!want.optional && !want.devOptional && !want.peer) return false;
  }
  return true;
}

/** The worktree's packages: its root, and each folder one level down with a package.json. */
function packagesOf(worktreePath: string): string[] {
  const found = fs.existsSync(path.join(worktreePath, 'package.json')) ? [''] : [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(worktreePath, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (fs.existsSync(path.join(worktreePath, entry.name, 'package.json'))) found.push(entry.name);
  }
  return found;
}

function isRealDirectory(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

/** Clones what it can into the worktree; never throws. */
export async function cloneDependencies(
  projectPath: string,
  worktreePath: string,
  opts: { copy?: Copy } = {},
): Promise<DepsResult> {
  const copy = opts.copy ?? cpClone;
  const result: DepsResult = { cloned: [], skipped: [] };
  for (const dir of packagesOf(worktreePath)) {
    const source = path.join(projectPath, dir, 'node_modules');
    const target = path.join(worktreePath, dir, 'node_modules');
    const lock = path.join(worktreePath, dir, 'package-lock.json');
    // Anything there is the worktree's own, a link included: one that points
    // nowhere reads as absent to existsSync, and the failure branch below
    // then deleted it (the Audit's gate of #325).
    try { fs.lstatSync(target); continue; } catch { /* nothing there */ }
    if (!isRealDirectory(source)) {
      result.skipped.push({ dir, why: 'the project has no node_modules of its own there' });
      continue;
    }
    if (!fs.existsSync(lock)) {
      result.skipped.push({ dir, why: 'no package-lock.json' });
      continue;
    }
    if (!installedMatches(source, lock)) {
      result.skipped.push({ dir, why: "the project's node_modules was installed for another lock" });
      continue;
    }
    try {
      await copy(source, target);
      result.cloned.push(dir);
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      result.skipped.push({ dir, why: `the clone failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return result;
}

/** One line of the main process log for what a new worktree got. */
export async function logDependencies(worktreePath: string, result: DepsResult): Promise<void> {
  const cloned = result.cloned.map(d => d || '.').join(', ') || 'nothing';
  const skipped = result.skipped.map(k => `${k.dir || '.'} (${k.why})`).join(', ');
  console.log(`[worktree] ${worktreePath}: dependencies cloned: ${cloned}${skipped ? `; not cloned: ${skipped}` : ''}`);
}
