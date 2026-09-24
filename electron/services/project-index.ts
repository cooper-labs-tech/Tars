import * as fs from 'fs';
import * as path from 'path';
import { decodeProjectPath } from '../utils/decode-project-path';

/**
 * The project folders a CLI keeps (`~/.claude/projects` and the like), with the
 * path each stands for, read without blocking the main process. Decoding a
 * folder name is what costs (Claude Code writes `/` and `.` as `-`, so the
 * decoder tries separators against the disk): 101 ms on JeanBrasse's 27 folders,
 * paid again by four IPC callers on every call, 104 to 397 ms each (the Audit,
 * 2026-09-23). A path is decoded once and kept, and again only when it no
 * longer exists, at most every REDECODE_MS: a directory that appeared later
 * then gets its real path, and a deleted project costs a decode twice a minute.
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
  const folders: ProjectFolder[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    // A link to a folder counts, as the statSync these callers used did.
    const isDir = entry.isDirectory()
      || (entry.isSymbolicLink() && await fs.promises.stat(dir).then(s => s.isDirectory(), () => false));
    if (!isDir) continue;
    folders.push({ name: entry.name, dir, projectPath: await decodedProjectPath(entry.name) });
  }
  return folders;
}

/** Test seam. */
export function resetProjectIndex(): void {
  decoded.clear();
}
