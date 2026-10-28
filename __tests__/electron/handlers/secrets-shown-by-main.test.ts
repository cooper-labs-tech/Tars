import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The three secrets the window still saw after #466 (the Audit's L2 on
 * 06a46bcb): the Telegram auth token Settings mints, the Hermes dashboard's
 * token in the Hermes form, and the webhook secret the Hermes page shows to
 * copy. A page with an XSS that reads one gets more than the window's
 * channels: Telegram's token authorizes the attacker's own Telegram to drive
 * agents from outside, Hermes's reconfigures the user's Hermes, the webhook's
 * posts to Tars as Hermes, long after the page is fixed.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  T1. telegram:generateAuthToken answers the token it minted; or mints none,
 *      or does not show the user the one it minted, in a dialog of the main
 *      process, which the page cannot read.
 *  T2. The token is copied for the user by an answer that holds it, or not
 *      copied at all.
 *  T3. hermes:getConnectionInfo answers the webhook secret; or the user has no
 *      way left to copy it into Hermes.
 *  T4. hermes:connection:get or hermes:connection:import hands the page the
 *      dashboard's token; or a save of the form, which holds the mask, writes
 *      the mask over the token, or clears it; or a token typed in is not kept.
 * (T1 and T2 went with Tars's own Telegram bot in 2.0.5.)
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const shown = vi.hoisted(() => [] as Array<{ message?: string; detail?: string }>);
const copied = vi.hoisted(() => [] as string[]);

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: { autoDownload: false, autoInstallOnAppQuit: true, on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.HOME, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '2.0.4', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [], getFocusedWindow: () => null }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(async (...args: unknown[]) => { shown.push(args[args.length - 1] as { message?: string; detail?: string }); return { response: 1 }; }),
  },
  clipboard: { writeText: (text: string) => { copied.push(text); } },
}));

import type { IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import type { AppSettings } from '../../../electron/types';

let settings: AppSettings;
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<Record<string, unknown>>;

beforeAll(async () => {
  const deps = new Proxy({
    agents: new Map(), getClaudeSkills: async () => [],
    getAppSettings: () => settings, setAppSettings: (s: AppSettings) => { settings = s; }, saveAppSettings: vi.fn(),
  } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
  (await import('../../../electron/handlers/ipc-handlers')).registerIpcHandlers(deps);
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
}, 60_000);

beforeEach(() => {
  settings = {} as AppSettings;
  shown.length = 0;
  copied.length = 0;
});

describe('the Hermes webhook secret', () => {
  it('T3. never in the connection info, and copied for the user on its own channel', async () => {
    const { provisionWebhookSecret } = await import('../../../electron/services/hermes-webhook-secret');
    const secret = provisionWebhookSecret();
    const info = await call('hermes:getConnectionInfo');
    expect(JSON.stringify(info)).not.toContain(secret);
    const answer = await call('hermes:webhookSecret:copy');
    expect(copied).toEqual([secret]);
    expect(JSON.stringify(answer)).not.toContain(secret);
  });
});

describe('the Hermes dashboard token', () => {
  it('T4. the form gets a mask, a save of the mask keeps the token, a token typed in replaces it', async () => {
    const { readHermesConnection } = await import('../../../electron/services/hermes-config');
    await call('hermes:connection:save', { mode: 'local', localPort: 9119, authMode: 'token', token: 'dashboard-token-1234' });
    const got = await call('hermes:connection:get');
    expect(JSON.stringify(got)).not.toContain('dashboard-token-1234');
    const form = got.connection as Record<string, unknown>;
    await call('hermes:connection:save', form);
    expect(readHermesConnection().token).toBe('dashboard-token-1234');
    await call('hermes:connection:save', { ...form, token: '' });
    expect(readHermesConnection().token).toBe('dashboard-token-1234');
    await call('hermes:connection:save', { ...form, token: 'dashboard-token-5678' });
    expect(readHermesConnection().token).toBe('dashboard-token-5678');

    // Imported from Hermes Desktop: the answer masks it too.
    const desktop = path.join(process.env.HOME!, 'Library', 'Application Support', 'Hermes');
    if (process.platform === 'darwin') {
      fs.mkdirSync(desktop, { recursive: true });
      fs.writeFileSync(path.join(desktop, 'connection.json'), JSON.stringify({ mode: 'remote', remoteUrl: 'http://127.0.0.1:9119', token: 'desktop-token-9999' }));
      const imported = await call('hermes:connection:import');
      expect(JSON.stringify(imported)).not.toContain('desktop-token-9999');
    }
  });
});
