import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { projectFolders } from './project-index';
import { memoryProjectDirName, knownProjectsByFolder, claudeProjectDirNames } from '../platform/claude-project-dir';
import { unlinkRetryingSync } from '../platform/rename-replacing';
import { spellingsOf } from '../utils/resume-session';
import { guardMemoryFile, readRegularFile, type MemoryGuard } from './memory-guard';

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  size: number;
  lastModified: string;
  isEntrypoint: boolean; // true for MEMORY.md
}

export interface ProjectMemory {
  id: string;          // encoded dir name
  projectName: string; // last segment of decoded path
  projectPath: string; // decoded full path
  memoryDir: string;   // absolute path to memory/ dir
  files: MemoryFile[];
  totalSize: number;
  lastModified: string;
  hasMemory: boolean;
  provider: string;    // 'claude' | 'codex' | 'gemini'
  /**
   * The memory folder an older Tars made for this project under a name Claude
   * never reads (before 1.9.6 on macOS and Linux, a path with `_`, a space,
   * `~`...). Its files were copied into this row's folder once, when that had
   * no MEMORY.md, and are kept where they were.
   */
  olderCopy?: string;
  /**
   * What Claude Code loads of this row's MEMORY.md, and what it does not (services/memory-guard.ts, 2.0.6): on a
   * Claude row whose folder holds one; `unread` when it could not be read.
   */
  guard?: MemoryGuard;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** All provider memory directories to scan */
const PROVIDER_MEMORY_DIRS: { provider: string; dir: string }[] = [
  { provider: 'claude', dir: CLAUDE_PROJECTS_DIR },
  // Codex and Gemini may store project memory in similar structures.
  // These are checked only if they exist: no error if missing.
  { provider: 'codex', dir: path.join(os.homedir(), '.codex', 'projects') },
  { provider: 'gemini', dir: path.join(os.homedir(), '.gemini', 'projects') },
  { provider: 'grok', dir: path.join(os.homedir(), '.grok', 'projects') },
];

/**
 * Validate that a file path is within any provider's projects directory.
 * Uses path.resolve + startsWith to prevent traversal bypasses.
 */
function isWithinProjectsDir(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return PROVIDER_MEMORY_DIRS.some(({ dir }) =>
    resolved.startsWith(dir + path.sep) || resolved === dir
  );
}

function getProjectName(decodedPath: string): string {
  return path.basename(decodedPath) || decodedPath;
}

function memoryFile(filePath: string, stat: fs.Stats, content: string): MemoryFile {
  const name = path.basename(filePath);
  return {
    name,
    path: filePath,
    content,
    size: stat.size,
    lastModified: stat.mtime.toISOString(),
    isEntrypoint: name === 'MEMORY.md',
  };
}

function readMemoryFile(filePath: string): MemoryFile {
  const stat = fs.statSync(filePath);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    content = '';
  }
  return memoryFile(filePath, stat, content);
}

/**
 * The same, for the listing of every project, the safe way (memory-guard.ts readRegularFile; the Audit's R2 on #558):
 * a FIFO named notes.md kept the page loading for ever and held one of libuv's threads. What is not a regular file
 * is not listed, nor one past 1 MiB (the Audit's M1 on #565: listed with an empty content, the page's editor showed
 * it empty and a save replaced the whole file); a MEMORY.md that large is still said too large by its row's guard.
 */
async function readMemoryFileAsync(filePath: string): Promise<MemoryFile | null> {
  const read = await readRegularFile(filePath);
  return read.kind === 'text' ? memoryFile(filePath, read.stat, read.text) : null;
}

/** The folder a project's memory is created in when Claude has none for it yet (platform/claude-project-dir.ts). */
function encodeProjectPath(projectPath: string): string {
  return memoryProjectDirName(projectPath);
}

/**
 * @param extraProjectPaths Tars's own projects (agent folders, projects
 * page). They belong in Brain even when Claude Code never opened them:
 * otherwise a freshly added project is invisible here.
 */
export async function listProjectMemories(extraProjectPaths: string[] = []): Promise<ProjectMemory[]> {
  const results: ProjectMemory[] = [];
  const seenPaths = new Set<string>();
  // On Windows, a folder a known project's own name points at is that project
  // (platform/claude-project-dir.ts); elsewhere none, each folder is decoded.
  const knownByFolder = knownProjectsByFolder(extraProjectPaths);
  /** The rows read from the CLIs' folders, by the path each folder stands for. */
  const byPath = new Map<string, ProjectMemory>();

  for (const { provider, dir: projectsDir } of PROVIDER_MEMORY_DIRS) {
    // Read without blocking, each folder's path decoded once (project-index.ts).
    for (const folder of await projectFolders(projectsDir)) {
      const memoryDir = path.join(folder.dir, 'memory');
      const decodedPath = knownByFolder.get(folder.name) ?? folder.projectPath;

      const project = await readProjectRow(provider, folder.name, memoryDir, decodedPath);
      seenPaths.add(project.projectPath);
      if (!byPath.has(project.projectPath)) byPath.set(project.projectPath, project);
      results.push(project);
    }
  }

  // Tars-known projects with no memory yet: surfaced as empty entries so
  // the user can create their MEMORY.md from the UI. Compared by both
  // spellings, as Tars saved it and its real path: Claude Code files a
  // session under the real one, so a project saved through a link (/tmp on
  // macOS, a symlinked checkout) was listed twice, and its memory folder,
  // named from the saved spelling, was one Claude Code never reads.
  // A row found under the real spelling is shown under the path Tars saved,
  // its memory still Claude Code's: the window counts a project's agents by
  // that path and the hooks file observations under it (QA's gate of #346).
  const claimed = new Set<ProjectMemory>();
  for (const projectPath of extraProjectPaths) {
    if (!projectPath) continue;
    const spellings = spellingsOf(projectPath);
    const exact = byPath.get(projectPath);
    if (exact) { claimed.add(exact); continue; }
    const other = spellings.slice(1).map(spelling => byPath.get(spelling)).find(row => row && !claimed.has(row));
    if (other) {
      claimed.add(other);
      other.projectPath = projectPath;
      other.projectName = getProjectName(projectPath);
      for (const spelling of spellings) seenPaths.add(spelling);
      continue;
    }
    if (spellings.some(spelling => seenPaths.has(spelling))) continue;
    for (const spelling of spellings) seenPaths.add(spelling);
    const real = spellings[spellings.length - 1];
    results.push({
      id: `tars:${projectPath}`,
      projectName: getProjectName(projectPath),
      projectPath,
      memoryDir: path.join(CLAUDE_PROJECTS_DIR, encodeProjectPath(real), 'memory'),
      files: [],
      totalSize: 0,
      lastModified: '',
      hasMemory: false,
      provider: 'claude',
    });
  }

  for (const projectPath of extraProjectPaths) {
    if (projectPath) await keepClaudesRow(projectPath, results);
  }

  // Sort: projects with memory first, then by lastModified desc
  return results.sort((a, b) => {
    if (a.hasMemory && !b.hasMemory) return -1;
    if (!a.hasMemory && b.hasMemory) return 1;
    return b.lastModified.localeCompare(a.lastModified);
  });
}

/** A row of the listing, as a folder holds it. */
async function readProjectRow(provider: string, folderName: string, memoryDir: string, projectPath: string): Promise<ProjectMemory> {
  const project: ProjectMemory = {
    id: `${provider}:${folderName}`,
    projectName: getProjectName(projectPath),
    projectPath,
    memoryDir,
    files: [],
    totalSize: 0,
    lastModified: '',
    hasMemory: false,
    provider,
  };
  if (await fs.promises.access(memoryDir).then(() => true, () => false)) {
    try {
      const mdFiles = (await fs.promises.readdir(memoryDir))
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => {
          // MEMORY.md always first
          if (a === 'MEMORY.md') return -1;
          if (b === 'MEMORY.md') return 1;
          return a.localeCompare(b);
        });
      const files = (await Promise.all(mdFiles.map(f => readMemoryFileAsync(path.join(memoryDir, f))))).filter((f): f is MemoryFile => f !== null);
      project.files = files;
      project.totalSize = files.reduce((sum, f) => sum + f.size, 0);
      project.lastModified = files.reduce((latest, f) => (f.lastModified > latest ? f.lastModified : latest), '');
      project.hasMemory = files.length > 0;
    } catch {
      // Skip unreadable directories
    }
    const entrypoint = path.join(memoryDir, 'MEMORY.md');
    // Read as the guard reads it: a regular file only, its link not followed, at most 1 MiB (memory-guard.ts).
    if (provider === 'claude' && await fs.promises.lstat(entrypoint).then(() => true, () => false)) {
      project.guard = await guardMemoryFile(entrypoint);
    }
  }
  return project;
}

/**
 * One row for a Tars project whose memory an older Tars made under a folder
 * Claude never reads (the gate of #375, M1): before 1.9.6, macOS and Linux
 * named `/Users/me/my_proj` `-Users-me-my_proj`, where Claude's is
 * `-Users-me-my-proj`. The project was listed twice, the old memory in one row
 * and an empty one where Claude reads.
 *
 * Once, when Claude's folder holds no MEMORY.md, its memory files (every .md
 * of the old memory folder) are copied in, none over a file Claude's folder
 * holds, the old ones kept. Then the old row goes and
 * Claude's stays, naming the old folder (`olderCopy`). A copy that fails
 * leaves Claude's row as it is, the old folder still named on it.
 */
async function keepClaudesRow(projectPath: string, results: ProjectMemory[]): Promise<void> {
  const spellings = spellingsOf(projectPath);
  const claudes = new Set(spellings.map(spelling => memoryProjectDirName(spelling)));
  const legacy = new Set(spellings.flatMap(spelling => claudeProjectDirNames(spelling)).filter(name => !claudes.has(name)));
  const folderOf = (row: ProjectMemory) => row.id.slice('claude:'.length);
  const old = results.filter(row => row.provider === 'claude' && row.id.startsWith('claude:') && legacy.has(folderOf(row)));
  const older = old.find(row => row.files.some(f => f.isEntrypoint)) ?? old.find(row => row.hasMemory);
  if (!older) return;
  const target = results.find(row => row.provider === 'claude' && row.id.startsWith('claude:') && claudes.has(folderOf(row)));
  const name = target ? folderOf(target) : memoryProjectDirName(spellings[spellings.length - 1]);
  const memoryDir = path.join(CLAUDE_PROJECTS_DIR, name, 'memory');
  if (!fs.existsSync(path.join(memoryDir, 'MEMORY.md'))) {
    try {
      await fs.promises.mkdir(memoryDir, { recursive: true });
      for (const file of older.files) {
        await fs.promises.copyFile(file.path, path.join(memoryDir, file.name), fs.constants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
      }
    } catch (err) {
      console.warn(`[memory] could not copy ${older.memoryDir} into ${memoryDir}:`, (err as Error).message);
    }
  }
  const row = await readProjectRow('claude', name, memoryDir, projectPath);
  row.olderCopy = older.memoryDir;
  for (const gone of [...old, ...(target ? [target] : [])]) results.splice(results.indexOf(gone), 1);
  // A row the listing made for the project while it had no folder of Claude's.
  const empty = results.findIndex(r => r.id === `tars:${projectPath}`);
  if (empty !== -1) results.splice(empty, 1);
  results.push(row);
}

/**
 * One memory file for the window (memory:read-file), read as the listing reads it (memory-guard.ts readRegularFile;
 * the Audit's L2 on #565): read synchronously on the main thread, a FIFO hung Tars, and a link handed its target to
 * the window. What is not a regular file, or is past 1 MiB, is not read, and the answer says so.
 */
export async function readMemoryFileContent(filePath: string): Promise<{ content: string; error?: string }> {
  if (!isWithinProjectsDir(filePath)) {
    return { content: '', error: 'Access denied: path outside Claude projects directory' };
  }
  const read = await readRegularFile(filePath);
  return read.kind === 'text' ? { content: read.text } : { content: '', error: 'Not a regular file, or past 1 MB: Tars does not read it.' };
}

export function writeMemoryFileContent(filePath: string, content: string): { success: boolean; error?: string } {
  try {
    if (!isWithinProjectsDir(filePath)) {
      return { success: false, error: 'Access denied: path outside Claude projects directory' };
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to write file' };
  }
}

export function createMemoryFile(memoryDir: string, fileName: string, content: string = ''): { success: boolean; file?: MemoryFile; error?: string } {
  try {
    if (!isWithinProjectsDir(memoryDir)) {
      return { success: false, error: 'Access denied' };
    }
    // Reject path traversal and a subdirectory in fileName (`\` separates too, on Windows)
    if (fileName.includes('/') || fileName.includes(path.sep) || fileName.includes('..')) {
      return { success: false, error: 'Invalid file name' };
    }
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    const filePath = path.join(memoryDir, fileName.endsWith('.md') ? fileName : `${fileName}.md`);
    if (fs.existsSync(filePath)) {
      return { success: false, error: 'File already exists' };
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, file: readMemoryFile(filePath) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create file' };
  }
}

export function deleteMemoryFile(filePath: string): { success: boolean; error?: string } {
  try {
    if (!isWithinProjectsDir(filePath)) {
      return { success: false, error: 'Access denied' };
    }
    if (path.basename(filePath) === 'MEMORY.md') {
      return { success: false, error: 'Cannot delete the main MEMORY.md entrypoint' };
    }
    unlinkRetryingSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to delete file' };
  }
}
