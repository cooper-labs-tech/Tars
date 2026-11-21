import '../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';

/**
 * The renderer has no way to ask for the API's shared token.
 *
 * `window.electronAPI.api.getToken()` handed any page the bearer token that
 * opens every authenticated route, the agent routes included, and nothing in
 * src/, landing/ or e2e/ ever called it. A channel with no caller is only a way
 * in, so the preload entry, its handler and its declaration are gone together.
 *
 * Both halves are read from the real code: what the preload exposes, and what
 * registerIpcHandlers registers.
 */

const exposed: Record<string, unknown> = {};
const handlers = new Set<string>();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  app: {
    getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string) => { handlers.add(channel); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));

// The main process's module graph, loaded with the file as orphan-folders-ipc and agent-remove-saves-work load it.
// Imported inside the case, it was the case: 7.5 s of its 5 at a load of 70 and 10.4 s at 130 (QA's runs of
// 2.0.1), where registering the handlers and checking them take milliseconds.
import { registerIpcHandlers } from '../../electron/handlers/ipc-handlers';

describe('the shared API token', () => {
  it('is not exposed to the renderer by the preload', async () => {
    await import('../../electron/preload');

    const api = exposed.electronAPI as Record<string, unknown> | undefined;
    expect(api, 'the preload exposed nothing, so this proves nothing').toBeTruthy();
    expect(api).not.toHaveProperty('api');
  });

  it('has no handler for the renderer to call', () => {
    registerIpcHandlers(new Proxy({} as Record<string, unknown>, {
      get(target, key: string) {
        if (!(key in target)) target[key] = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : vi.fn();
        return target[key];
      },
    }) as never);

    expect(handlers.has('agent:start'), 'no handler was registered, so this proves nothing').toBe(true);
    expect(handlers.has('api:getToken')).toBe(false);
  });
});
