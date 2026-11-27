import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Downloading an update that fails is a refusal with its reason, never a throw
 * through IPC (app:downloadUpdate answers what downloadUpdate() answers).
 *
 * The window calls it without awaiting it (ClientLayout, Settings, System): a
 * rejection there is unhandled, an error on the page's console, and the update
 * banner stays on "Downloading" with nothing to say why.
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. A download that fails on the network (no connection, GitHub refusing the
 *    asset) rejects instead of answering { success: false, error }.
 * 2. A download asked for before any check, which the updater refuses with no
 *    request at all, rejects the same way.
 * 3. The refusal quotes the updater's whole message: electron-updater's
 *    HttpError carries the request and the response's headers on the lines
 *    after its first.
 * 4. A download that succeeds stops answering success.
 * 5. A download that fails writing to the disk quotes the updater's cache by
 *    its absolute path, the owner's home in it (the Audit's I-2 on #658,
 *    for every message of the class): the home is said `~`.
 */

const download = vi.hoisted(() => ({ next: (): Promise<unknown> => Promise.resolve(['/tmp/Tars.zip']) }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    downloadUpdate: () => download.next(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    currentVersion: { version: '2.0.6' },
  },
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '2.0.6', isPackaged: false, getPath: () => '/tmp' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

let downloadUpdate: () => Promise<unknown>;
beforeEach(async () => {
  ({ downloadUpdate } = await import('../../../electron/services/update-checker'));
});

describe('an update download that fails', () => {
  it('1. a network failure is a refusal with its reason', async () => {
    download.next = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));

    await expect(downloadUpdate()).resolves.toEqual({ success: false, error: 'Tars could not download the update: net::ERR_INTERNET_DISCONNECTED' });
  });

  it('2. a download asked for before any check is a refusal too', async () => {
    download.next = () => Promise.reject(new Error('Please check update first'));

    await expect(downloadUpdate()).resolves.toEqual({ success: false, error: 'Tars could not download the update: Please check update first' });
  });

  it('3. only the first line of the updater\'s message', async () => {
    download.next = () => Promise.reject(Object.assign(new Error(
      '404 Not Found\n"method: GET url: https://github.com/cooper-labs-tech/Tars/releases/download/v2.0.7/Tars-2.0.7-arm64-mac.zip"\n\nHeaders: {\n  "set-cookie": "_gh_sess=abc"\n}',
    ), { statusCode: 404 }));

    await expect(downloadUpdate()).resolves.toEqual({ success: false, error: 'Tars could not download the update: 404 Not Found' });
  });

  it('5. the owner\'s home is said ~', async () => {
    const cache = path.join(os.homedir(), 'Library', 'Caches', 'tars-updater', 'pending', 'Tars-2.0.7-arm64-mac.zip');
    download.next = () => Promise.reject(new Error(`ENOSPC: no space left on device, write '${cache}'`));

    const answer = await downloadUpdate() as { success: boolean; error: string };

    expect(answer.success).toBe(false);
    expect(answer.error).toBe(`Tars could not download the update: ENOSPC: no space left on device, write '${path.join('~', 'Library', 'Caches', 'tars-updater', 'pending', 'Tars-2.0.7-arm64-mac.zip')}'`);
    expect(answer.error).not.toContain(os.homedir());
  });
});

describe('an update download that succeeds', () => {
  it('4. answers success', async () => {
    download.next = () => Promise.resolve(['/tmp/Tars-2.0.7-arm64-mac.zip']);

    await expect(downloadUpdate()).resolves.toEqual({ success: true });
  });
});
