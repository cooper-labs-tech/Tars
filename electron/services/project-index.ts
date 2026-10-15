import * as fs from 'fs';
import * as path from 'path';
import { decodeProjectPath } from '../utils/decode-project-path';

/**
 * The project folders a CLI keeps (`~/.claude/projects` and the like), with the
 * path each one stands for, read without blocking the main process.
 *
 * Decoding a folder name back to its path is what costs: Claude Code writes
 * both `/` and `.` as `-`, so decodeProjectPath tries the separators against
 * the disk, segment by segment. On JeanBrasse's 27 folders that was 101 ms of
 * existsSync, and fs:list-projects (Dashboard, Agents, Projects, Brain),
 * memory:list-projects, fs:read-project-files and the project scan of
 * claude:getData each paid it again on every call: 104 to 397 ms per call,
 * measured by the Audit on 2026-09-23.
 *
 * A folder's path is decoded once and kept. It is decoded again only when the
 * path it gave no longer exists, at most every REDECODE_MS: a folder whose
 * directory appears after it was first read (the decoder falls back to the
 * raw tokens for a path missing on disk) then gets its real path, and one
 * whose project was deleted costs a decode twice a minute, not every call.
 */

const decoded = new Map<string, { path: string; at: number }>();
export const REDECODE_MS = 30_000;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

/** The path a project folder's name stands for, decoded once and kept. */
export async function decodedProjectPath(dirName: string, now = Date.now()): Promise<string> {
  const kept = decoded.get(dirName);
  if (kept && (now - kept.at < REDECODE_MS || await exists(kept.path))) return kept.path;
  const fresh = decodeProjectPath(dirName);
  decoded.set(dirName, { path: fresh, at: now });
  return fresh;
}

/** How many folders' paths are checked on disk at once. */
const AT_ONCE = 8;

/**
 * The paths many folder names stand for, in their order, a few at a time.
 *
 * One after another, each folder's check on disk (past REDECODE_MS) waited for
 * a turn of the main loop of its own: on 24 folders, 7 ms on an idle loop and
 * 200 ms on a loop busy in 8 ms slices, the transcript scan's breathing, which
 * claude:getData and fs:list-projects then took. Eight at a time, 8 ms. A bound
 * rather than all at once, for a machine with hundreds of folders.
 */
export async function decodedProjectPaths(names: string[]): Promise<string[]> {
  const paths = new Array<string>(names.length);
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      paths[i] = await decodedProjectPath(names[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, names.length) }, worker));
  return paths;
}

export interface ProjectFolder {
  /** The folder's own name, the encoded path. */
  name: string;
  /** The folder itself, under `root`. */
  dir: string;
  /** The project path it stands for. */
  projectPath: string;
}

/** Every folder under `root` with the project path it stands for. None when `root` is missing. */
export async function projectFolders(root: string): Promise<ProjectFolder[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders: Array<{ name: string; dir: string }> = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    // A link to a folder counts, as the statSync these callers used did.
    const isDir = entry.isDirectory()
      || (entry.isSymbolicLink() && await fs.promises.stat(dir).then(s => s.isDirectory(), () => false));
    if (!isDir) continue;
    folders.push({ name: entry.name, dir });
  }
  const paths = await decodedProjectPaths(folders.map(f => f.name));
  return folders.map((folder, i) => ({ ...folder, projectPath: paths[i] }));
}

/** Test seam. */
export function resetProjectIndex(): void {
  decoded.clear();
}
