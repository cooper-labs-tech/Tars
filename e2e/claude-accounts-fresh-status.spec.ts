import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings > Claude accounts shows the account Claude Code is signed in with now, not the one it answered when the
 * window first listed the accounts (the maintainer's report of 2026-10-15: Settings named one Google address while Claude
 * Code was signed in with another, after a login in a terminal three minutes into the run).
 *
 * The claude binary is a stand-in (Settings > CLI paths): `auth status` answers from a marker in ~/.claude, which a
 * test rewrites as a login outside Tars rewrites the keychain item (macOS), ~/.claude/.credentials.json (Linux) or the
 * Windows store. Made-up addresses only; no real account, no keychain, no network.
 *
 * What the run proves, each step a picture:
 * - the window lists the accounts at load, and Claude Code answers personal@example.com;
 * - the sign-in changes to work@example.com outside Tars; turning the option on shows work@example.com;
 * - it changes again; the window coming back to the front a minute later shows the third answer, without a refresh.
 */

function writeFakeClaude(home: string): { bin: string; log: string } {
  const bin = path.join(home, 'fake-claude.cjs');
  const log = path.join(home, 'fake-claude-calls.log');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "const [cmd, sub] = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');",
    "const marker = path.join(d, '.fake-signed-in');",
    "if (cmd === 'auth' && sub === 'status') {",
    "  if (fs.existsSync(marker)) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: fs.readFileSync(marker, 'utf8'), subscriptionType: 'max', configDirectory: d })); process.exit(0); }",
    "  console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: d })); process.exit(1);",
    "} else { process.exit(2); }",
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, log };
}

const row = (page: Page) => page.locator('[data-account-row="default"]');
const statusRuns = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === 'auth status').length : 0);

test('Settings shows the Claude account Claude Code answers now, after a sign-in changed outside Tars', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-accounts-fresh-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  for (const d of [project, dataDir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const marker = path.join(home, '.claude', '.fake-signed-in');
  fs.writeFileSync(marker, 'personal@example.com');
  const { bin, log } = writeFakeClaude(home);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: bin },
  }));
  const values: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/settings`, DOROTHY_API_PORT: apiPort(31430), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    // The window lists the accounts at load; Claude Code answers once.
    await expect.poll(() => statusRuns(log), { timeout: 30_000, message: 'the first list asked Claude Code' }).toBeGreaterThanOrEqual(1);
    values.runsAtLoad = statusRuns(log);
    await page.getByText('AI & Providers', { exact: true }).click();
    await page.getByText('Claude accounts', { exact: true }).click();
    await stepShot(page, '1-off');

    // Three minutes into the run, a login in a terminal: Claude Code is now signed in with another account.
    fs.writeFileSync(marker, 'work@example.com');
    await page.getByRole('switch', { name: 'Use several Claude subscriptions' }).click();
    await expect(row(page)).toContainText('work@example.com', { timeout: 20_000 });
    await expect(row(page)).not.toContainText('personal@example.com');
    values.afterTurningOn = await row(page).innerText();
    await stepShot(page, '2-on-shows-now');

    // Again, and the window comes back to the front a minute later (from the terminal the login ran in).
    fs.writeFileSync(marker, 'third@example.com');
    await page.waitForTimeout(61_000);
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      electronApp.emit('browser-window-focus', {}, win);
    });
    await expect(row(page)).toContainText('third@example.com', { timeout: 20_000 });
    values.afterFocus = await row(page).innerText();
    values.statusRuns = statusRuns(log);
    await stepShot(page, '3-focus-shows-now');
    expect(errors).toEqual([]);
  } finally {
    recordValues(values);
    await app.close();
    await removeHome(home);
  }
});
