import { test, expect, _electron as electron } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * One Tars per profile, on every platform (the maintainer's parity rule of 2026-10-16, the Audit's G1). On macOS and
 * Linux a second launch used to run beside the first: its own terminals, and on quit its fleet saved over agents.json,
 * losing what the first changed. Now it hands over: the first comes forward, and the second ends at once, having
 * written nothing.
 *
 * In the real app: a Tars runs on a sandbox home, its window minimized. A second Electron on the same home and the same
 * profile (what launchSandboxed gives one home: `--user-data-dir=<home>/electron-profile`) is started as a second
 * launch is, outside Playwright. It must exit with 0 within seconds, the first's window must be shown again, the first
 * must still run, and agents.json must be byte for byte as the first left it.
 * The artefact: values.json with the second's exit code and time, and the first's window before and after.
 */

const electronBinary = (): string => {
  // The electron package's main export is the path of its binary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as unknown as string;
};

test('a second launch on the same profile hands over to the first and exits, writing nothing', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-one-tars-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  for (const d of [dataDir, project]) fs.mkdirSync(d, { recursive: true });
  const agentsFile = path.join(dataDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify([{
    id: 'a1', name: 'Worker One', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], createdAt: '2026-10-16T08:00:00.000Z', lastActivity: '2026-10-16T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const env = { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_E2E: '1' };
  const values: Record<string, unknown> = {};

  const first = await launchSandboxed(electron, home, { env: { ...env, DOROTHY_API_PORT: apiPort(31428) } });
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const page = await first.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect.poll(() => first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), { timeout: 10_000 }).toBe(true);
    // What the first wrote, as the second starts.
    await new Promise((r) => setTimeout(r, 2_000));
    const agentsBefore = fs.readFileSync(agentsFile, 'utf8');

    // A second launch: the same app, home and profile, as the OS or a shell starts it (not through Playwright, which
    // waits for a window a second launch never opens). Another port, so that a second that ran would not fail on it.
    const started = Date.now();
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|DOROTHY|ANTHROPIC)|^CLAUDECODE$/.test(name)));
    second = spawn(electronBinary(), ['.', `--user-data-dir=${path.join(home, 'electron-profile')}`], {
      cwd: process.cwd(),
      env: { ...inherited, ...env, DOROTHY_API_PORT: apiPort(31429), HOME: home, CFFIXED_USER_HOME: home },
      stdio: 'ignore',
    });
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      second!.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    values.secondExit = { code: exit, afterMs: Date.now() - started };
    expect(exit, 'the second launch exits, with 0').toBe(0);
    second = undefined;

    await expect.poll(() => first.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { minimized: win.isMinimized(), visible: win.isVisible() };
    }), { timeout: 10_000, message: 'the first comes forward' }).toEqual({ minimized: false, visible: true });
    values.firstAfter = 'shown';
    expect(first.process().exitCode, 'the first still runs').toBeNull();
    expect(fs.readFileSync(agentsFile, 'utf8'), 'agents.json as the first left it').toBe(agentsBefore);
  } finally {
    recordValues(values);
    second?.kill();
    await first.close();
    await removeHome(home);
  }
});

/**
 * And on macOS with the window closed (the Audit's Low on #429): Tars keeps running there with no window, and makes it
 * again only on the Dock's 'activate'. A second launch (open -n, another copy) now hands over and exits, so the first
 * must make its window again too, or the user who launched Tars sees nothing at all.
 */
test('macOS, the window closed: a second launch makes the first one\'s window again', async () => {
  test.skip(process.platform !== 'darwin', 'Tars quits with its last window everywhere else');
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-one-tars-closed-'));
  const dataDir = path.join(home, '.dorothy');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const env = { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_E2E: '1' };
  const values: Record<string, unknown> = {};
  const first = await launchSandboxed(electron, home, { env: { ...env, DOROTHY_API_PORT: apiPort(31428) } });
  let second: ReturnType<typeof spawn> | undefined;
  const shownWindows = () => first.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length);
  try {
    await first.firstWindow();
    await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(shownWindows, { timeout: 10_000, message: 'the window is closed' }).toBe(0);
    expect(first.process().exitCode, 'Tars still runs with no window').toBeNull();
    values.windowsAfterClose = await shownWindows();

    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|DOROTHY|ANTHROPIC)|^CLAUDECODE$/.test(name)));
    second = spawn(electronBinary(), ['.', `--user-data-dir=${path.join(home, 'electron-profile')}`], {
      cwd: process.cwd(),
      env: { ...inherited, ...env, DOROTHY_API_PORT: apiPort(31429), HOME: home, CFFIXED_USER_HOME: home },
      stdio: 'ignore',
    });
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      second!.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    values.secondExit = exit;
    expect(exit, 'the second launch exits, with 0').toBe(0);
    second = undefined;
    await expect.poll(shownWindows, { timeout: 20_000, message: 'the first shows a window again' }).toBe(1);
    values.windowsAfterSecondLaunch = await shownWindows();
  } finally {
    recordValues(values);
    second?.kill();
    await first.close();
    await removeHome(home);
  }
});
