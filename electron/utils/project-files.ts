import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { pathKey } from '../platform/path-compare';

/**
 * The folder Tars keeps for each project: ~/.dorothy/project-files/<key>, with
 * tools/, notes/ and reports/, where the project's agents keep the scripts,
 * notes and reports worth keeping. They kept them in temporary folders, which
 * a session's end or a cleanup empties, or under ~/Documents, which iCloud
 * evicts (a read of an evicted file then blocks). Outside the repository, so
 * nothing there is committed by mistake; never deleted by Tars.
 *
 * The key is the project folder's name, readable, then ten hex digits of the
 * SHA-256 of the place as the platform compares paths (platform/path-compare's
 * pathKey: on Windows, case and separators do not count). Two spellings of one
 * project share a folder, two projects of one name do not.
 */

export const PROJECT_FILES_DIR_NAME = 'project-files';
export const PROJECT_FILES_SUBDIRS = ['tools', 'notes', 'reports'] as const;

/** Names Windows keeps for devices, whatever follows them. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/**
 * A file name every system takes: lower case letters, digits and dashes, 40 at
 * most. An accented letter keeps its letter: NFKD writes it as the letter and a
 * combining mark, and the mark goes (`Été` is `ete`, not `e-te`).
 */
function slugOf(name: string): string {
  const slug = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
  if (!slug) return 'project';
  return WINDOWS_DEVICE.test(slug) ? `project-${slug}` : slug;
}

/** The key of a project's folder, or null for a path that is not absolute. */
export function projectFilesKey(projectPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!projectPath || !p.isAbsolute(projectPath)) return null;
  const place = p.normalize(projectPath);
  const hash = crypto.createHash('sha256').update(pathKey(place, platform), 'utf8').digest('hex').slice(0, 10);
  return `${slugOf(p.basename(place))}-${hash}`;
}

/** Where a project's folder is, made or not; null for a path that is not absolute. */
export function projectFilesDir(projectPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const key = projectFilesKey(projectPath, platform);
  return key ? path.join(DATA_DIR, PROJECT_FILES_DIR_NAME, key) : null;
}

/** A project's folder, or why it has none, as an agent's identity says it. */
export type ProjectFolder = { dir: string; why?: undefined } | { dir: null; why: string };

/**
 * A project's folder, made if it is not there: what is in it is left as it is.
 * None when the path is not absolute or the folder cannot be made (a full disk,
 * a folder Tars may not write), and why, which an agent's identity then says
 * rather than naming a folder that is not there or blaming the project's path.
 */
export function ensureProjectFiles(projectPath: string): ProjectFolder {
  const dir = projectFilesDir(projectPath);
  if (!dir) return { dir: null, why: 'its path is not absolute' };
  try {
    for (const sub of PROJECT_FILES_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    return { dir };
  } catch (err) {
    console.warn(`[project-files] ${dir} could not be made:`, (err as Error).message);
    return { dir: null, why: `${dir} could not be made: ${(err as Error).message}` };
  }
}
