import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { scanVault, readVaultFile, isWithinVault } from '../services/obsidian-service';
import { vaultRefusal, windowMayReadInVault, windowMayWriteInVault } from '../utils/window-file-access';
import type { AppSettings } from '../types';

interface ObsidianHandlerDeps {
  getAppSettings: () => AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  saveAppSettings: (settings: AppSettings) => void;
}

/** A vault the rule refuses, and why: kept in the settings, used by nothing, said in the answers. */
type RefusedVault = { vaultPath: string; reason: string };

/**
 * Register IPC handlers for Obsidian vault browsing (multi-vault).
 *
 * They follow the window's file rules (utils/window-file-access.ts, 2.0.7). A vault is judged (vaultRefusal) when
 * added and at every use, since obsidianVaultPaths lives in ~/.tars/app-settings.json, which every agent can write; a
 * read never gets a secret nor follows a link out of the vault, and a write is a markdown note in it, no dotfile, no
 * dot folder.
 */
export function registerObsidianHandlers(deps: ObsidianHandlerDeps): void {
  const { getAppSettings, setAppSettings, saveAppSettings } = deps;

  /** The registered vaults the rule allows, and those it refuses with why. */
  const vaultsOf = (): { usable: string[]; refused: RefusedVault[] } => {
    const usable: string[] = [];
    const refused: RefusedVault[] = [];
    for (const vp of getAppSettings().obsidianVaultPaths || []) {
      const reason = vaultRefusal(vp);
      if (reason) refused.push({ vaultPath: String(vp), reason });
      else usable.push(vp);
    }
    return { usable, refused };
  };

  // Scan all registered vaults: returns per-vault file list + folder tree
  ipcMain.handle('obsidian:scan', async () => {
    const { usable, refused } = vaultsOf();

    const vaults: Array<{
      vaultPath: string;
      name: string;
      files: ReturnType<typeof scanVault>['files'];
      tree: ReturnType<typeof scanVault>['tree'];
    }> = [];

    for (const vp of usable) {
      if (!fs.existsSync(vp)) continue;
      const { files, tree } = scanVault(vp, (file) => windowMayReadInVault(file, vp));
      vaults.push({
        vaultPath: vp,
        name: path.basename(vp),
        files,
        tree,
      });
    }

    return { vaults, refused };
  });

  // Read a single file: a vault the rule allows, a file of it the window may read
  ipcMain.handle('obsidian:readFile', async (_event, filePath: string, vaultPath: string) => {
    const settings = getAppSettings();
    const vaultPaths = settings.obsidianVaultPaths || [];

    if (!vaultPaths.includes(vaultPath)) {
      return { error: 'Vault path not registered' };
    }
    const refused = vaultRefusal(vaultPath);
    if (refused) return { error: refused };
    if (typeof filePath !== 'string' || !windowMayReadInVault(filePath, vaultPath)) {
      return { error: 'Access denied: a secret, or outside the vault where it really lies' };
    }

    return readVaultFile(filePath, vaultPath);
  });

  // Get vault configuration status
  ipcMain.handle('obsidian:getVaultInfo', async () => {
    const { usable, refused } = vaultsOf();
    return {
      configured: usable.length > 0,
      vaultPaths: usable,
      refused,
    };
  });

  // Detect if a project folder is an Obsidian vault
  ipcMain.handle('obsidian:detectVault', async (_event, projectPath: string) => {
    try {
      const obsidianDir = path.join(projectPath, '.obsidian');
      if (fs.existsSync(obsidianDir) && fs.statSync(obsidianDir).isDirectory()) {
        return { detected: true, vaultPath: projectPath };
      }
      return { detected: false, vaultPath: null };
    } catch {
      return { detected: false, vaultPath: null };
    }
  });

  // Add a vault path to registered list: a folder that exists, and one the rule allows
  ipcMain.handle('obsidian:addVault', async (_event, vaultPath: string) => {
    try {
      const refused = vaultRefusal(vaultPath);
      if (refused) return { success: false, error: refused };
      if (!fs.statSync(vaultPath).isDirectory()) return { success: false, error: 'A vault is a folder.' };
      const settings = getAppSettings();
      const vaultPaths = settings.obsidianVaultPaths || [];

      if (vaultPaths.includes(vaultPath)) {
        return { success: true }; // Already registered
      }

      const updated = { ...settings, obsidianVaultPaths: [...vaultPaths, vaultPath] };
      setAppSettings(updated);
      saveAppSettings(updated);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Write content to a file: a vault the rule allows, a markdown note of it
  ipcMain.handle('obsidian:writeFile', async (_event, filePath: string, content: string, vaultPath: string) => {
    const settings = getAppSettings();
    const registeredPaths = settings.obsidianVaultPaths || [];

    if (!registeredPaths.includes(vaultPath)) {
      return { error: 'Vault path not registered' };
    }
    const refused = vaultRefusal(vaultPath);
    if (refused) return { error: refused };

    // Confinement used to be a bare `fullPath.startsWith(path.resolve(vaultPath))`,
    // a string prefix test with no separator: with a vault of `/Users/demo/Notes`,
    // a filePath of `/Users/demo/Notes-backup/x.md` or `/Users/demo/Notes.private/secrets.md`
    // resolved to a string that starts with the vault path and was accepted, so the
    // handler wrote outside the vault the user actually registered. isWithinVault()
    // appends path.sep (and allows the vault dir itself), which is what the read side
    // already goes through via readVaultFile. Read and write now share one check,
    // and windowMayWriteInVault judges where the write really lands.
    if (typeof filePath !== 'string') return { error: 'File path is outside vault' };
    const fullPath = path.resolve(filePath);
    if (!isWithinVault(fullPath, vaultPath)) {
      return { error: 'File path is outside vault' };
    }
    if (!windowMayWriteInVault(fullPath, vaultPath)) {
      return { error: 'Only a markdown note of the vault is written from here: no dotfile, no dot folder, no link out of it' };
    }

    try {
      fs.writeFileSync(fullPath, String(content), 'utf-8');
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to write file' };
    }
  });

  // Remove a vault path from registered list
  ipcMain.handle('obsidian:removeVault', async (_event, vaultPath: string) => {
    try {
      const settings = getAppSettings();
      const vaultPaths = settings.obsidianVaultPaths || [];

      const updated = { ...settings, obsidianVaultPaths: vaultPaths.filter(p => p !== vaultPath) };
      setAppSettings(updated);
      saveAppSettings(updated);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
