import { ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { PROJECT_FILES_DIR_NAME } from '../utils/project-files';
import {
  listProjectFolders, listProjectFiles, listProjectPlace, readProjectFile, writeProjectFile, locateProjectFile, SUBFOLDERS, isHeavy,
} from '../services/vault-project-files';

/**
 * The Vault's channels for each project's folder (services/vault-project-files.ts):
 * each takes a folder's key, a place (a list of folder names, or today's
 * subfolder, `sub`) and a name, never a path, and each failure comes back as
 * `{ error, code }`, which the window shows where it happened.
 * `vault:project-files:changed` says which folder moved (`place`, and `sub`
 * when it is in reports/ or tools/), so the tree, the list and an open file
 * follow what the agents write.
 */

/** The place a channel names: `place` when the window sends one, else today's `sub`. */
const placeOf = (p: { place?: unknown; sub?: unknown }) => (p.place !== undefined ? p.place : p.sub);

/** The projects Tars knows: its list and its agents', to name each folder. */
function knownProjects(): string[] {
  let listed: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf-8'));
    if (Array.isArray(parsed)) listed = parsed.filter((p): p is string => typeof p === 'string');
  } catch { /* none */ }
  return [...new Set([...listed, ...[...agents.values()].map((a) => a.projectPath).filter((p): p is string => !!p)])];
}

let watcher: fs.FSWatcher | null = null;
const pending = new Map<string, NodeJS.Timeout>();

/**
 * Watched once a window has asked for the folders: a write, a removal or a
 * rename in any folder of a project's folder, said by the folder it happened
 * in. What happens in a heavy or a hidden folder, or to a hidden file (a
 * save's temporary file), is not shown anywhere, so it is not said.
 */
function watchProjectFiles(): void {
  if (watcher) return;
  const root = path.join(DATA_DIR, PROJECT_FILES_DIR_NAME);
  try {
    fs.mkdirSync(root, { recursive: true });
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const [key, ...rest] = filename.toString().split(/[\\/]/);
      if (!key || rest.length === 0 || rest.some((s) => s.startsWith('.') || isHeavy(s))) return;
      const place = rest.slice(0, -1);
      const sub = (SUBFOLDERS as readonly string[]).includes(rest[0]) ? rest[0] : undefined;
      const id = JSON.stringify([key, place]);
      clearTimeout(pending.get(id));
      pending.set(id, setTimeout(() => {
        pending.delete(id);
        broadcastToAllWindows('vault:project-files:changed', { key, place, ...(sub ? { sub } : {}) });
      }, 150));
    });
    watcher.on('error', (err) => {
      console.warn('[vault] the project folders are no longer watched:', err.message);
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    console.warn('[vault] the project folders cannot be watched:', (err as Error).message);
  }
}

export function registerVaultProjectFilesHandlers(): void {
  ipcMain.handle('vault:project-folders', async () => {
    watchProjectFiles();
    return { folders: listProjectFolders(knownProjects()) };
  });
  ipcMain.handle('vault:project-files', async (_e, p: { key?: unknown; sub?: unknown } = {}) => listProjectFiles(p.key, p.sub));
  ipcMain.handle('vault:project-place', async (_e, p: { key?: unknown; place?: unknown; offset?: unknown; limit?: unknown } = {}) =>
    listProjectPlace(p.key, p.place, { offset: p.offset, limit: p.limit }));
  ipcMain.handle('vault:project-file:read', async (_e, p: { key?: unknown; place?: unknown; sub?: unknown; name?: unknown } = {}) =>
    readProjectFile(p.key, placeOf(p), p.name));
  ipcMain.handle('vault:project-file:write', async (_e, p: { key?: unknown; place?: unknown; sub?: unknown; name?: unknown; text?: unknown; mtimeSeen?: unknown } = {}) =>
    writeProjectFile(p.key, placeOf(p), p.name, p.text, p.mtimeSeen === undefined ? null : p.mtimeSeen));
  // "show folder" opens the folder; "show in folder" shows the file in it.
  ipcMain.handle('vault:project-file:show', async (_e, p: { key?: unknown; place?: unknown; sub?: unknown; name?: unknown } = {}) => {
    const at = locateProjectFile(p.key, placeOf(p), p.name);
    if ('error' in at) return at;
    if (at.isFile) shell.showItemInFolder(at.path);
    else {
      const failed = await shell.openPath(at.path);
      if (failed) return { error: failed, code: 'open_failed' };
    }
    return { success: true };
  });
}
