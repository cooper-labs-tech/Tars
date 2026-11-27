import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Claude's data is one store for the window (#233), kept from page to page.
 * A skill installed since the last read must show in Settings > Skills &
 * Plugins when the page is opened again past a poll: the store's comparison,
 * which spares an idle poll a render, used to ignore the skills, so the list
 * kept the old count for as long as the window lived.
 *
 * The app is moved through by the sidebar only: a page load builds the
 * store again from nothing and hides what it keeps. On #233's head before the
 * fix (7be275fa) the count stays at 1: the negative witness.
 */
test('claude data store: a skill added since the last read shows when Settings is opened again', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-skill-'));
  const dataDir = path.join(home, '.tars');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/settings`, DOROTHY_API_PORT: apiPort(31484), DOROTHY_E2E: '1' } });
  try {
    const page = await app.firstWindow();
    const count = () => page.locator('[data-settings-row]', { hasText: 'Installed skills' });
    // Client-side navigation only, as a person moves through the app: a page
    // load would build the store again from nothing and hide what it keeps.
    const toSkills = async () => {
      const nav = page.getByTestId('settings-nav');
      await nav.getByRole('button', { name: 'Extensions' }).click({ timeout: 90_000 });
      await nav.getByRole('button', { name: 'Skills & Plugins' }).click();
      await expect(count()).toBeVisible({ timeout: 30_000 });
    };
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await toSkills();
    await expect(count()).toContainText('1', { timeout: 20_000 });
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'beta'), { recursive: true });
    // Away by the main menu, the Settings route unmounted, then back to Settings as More's card: client-side all the
    // way (until 2.1.0, the classic sidebar's Agents and Settings links).
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await sidebar.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Kanban', exact: true }).click();
    await page.waitForURL(/\/kanban/);
    await page.waitForTimeout(11_000);
    await sidebar.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    await toSkills();
    await page.waitForTimeout(3_000);
    const text = await count().innerText();
    recordValues({ countRow: text });
    await stepShot(page, 'skills-after');
    expect(text).toContain('2');
  } finally {
    await app.close();
    await removeHome(home);
  }
});
