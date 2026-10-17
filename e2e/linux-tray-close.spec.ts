import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The menu bar and the close, on the platform the run is on (2.0.4, parity P2). In the real app: on Linux and
 * Windows there is no application menu (Electron's default one showed File / Edit / View on Linux, and bound Ctrl+W,
 * Ctrl+R and Ctrl+Shift+I over the terminals); macOS keeps its own. On Linux, closing the window hides Tars to the tray
 * when the session bus has a StatusNotifierWatcher (a tray is shown), and quits when it has none, as before: the spec
 * asks the bus itself to know which to expect. On the build before this change Linux kept the menu bar and always quit.
 * The artefact: values.json with the platform, the menu, the bus's answer and what the close did.
 */

const busHasWatcher = (): boolean => {
  try {
    return execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'], { encoding: 'utf8', timeout: 5000 }).trim() === '(true,)';
  } catch {
    return false;
  }
};

test('the application menu as each platform has it, and on Linux a close that hides only to a tray that is shown', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-linux-tray-'));
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  // Explained already: the one-time question would hold the close.
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, closeToTrayExplained: true, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = { platform: process.platform };
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31431), DOROTHY_E2E: '1' },
  });
  let closed = false;
  app.on('close', () => { closed = true; });
  try {
    await app.firstWindow();
    const hasMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu() !== null);
    values.applicationMenu = hasMenu;
    expect(hasMenu).toBe(process.platform === 'darwin');

    if (process.platform === 'linux') {
      const watcher = busHasWatcher();
      values.trayShown = watcher;
      // Tars asks the bus in the background at launch: give it the time to answer.
      await new Promise((r) => setTimeout(r, 4_000));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      if (watcher) {
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? null), { timeout: 15_000 }).toBe(false);
        values.closeDid = 'hid';
        expect(closed).toBe(false);
      } else {
        await expect.poll(() => closed, { timeout: 30_000 }).toBe(true);
        values.closeDid = 'quit';
      }
    }
  } finally {
    recordValues(values);
    if (!closed) await app.close();
    await removeHome(home);
  }
});
