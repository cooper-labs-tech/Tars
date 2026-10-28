import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The preview of 2.0.0, offered to everyone (PLAN-2.0.0, step 7): on an
 * install that never chose it, Settings, Preferences shows "New interface",
 * last and off, and turning it on brings the new shell at once. Frames:
 * `Settings · Preferences` (the row off) and `Settings · Preferences · new
 * interface on`, each with its light copy.
 *
 * The real app, a sandbox whose app-settings.json has no newInterface, as a
 * 1.9 install's has none. How it can fail, each checked below:
 * 1. the row is not there for someone who never turned the preview on, as
 *    until 2.0.0;
 * 2. it is there but on, or reads on while today's interface is shown;
 * 3. it is not the last row of Preferences, as the frame draws it;
 * 4. today's interface is not the one shown before the switch is touched;
 * 5. turned on, the new shell does not come at once, the row does not read
 *    on, or the choice is not saved.
 *
 * The artefact: a screenshot per state and values.json with what each read.
 */

/** The launch splash, over the page on every document load until its checks answer (4 s at most). */
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

test('an install that never chose it: Settings, Preferences offers New interface, last and off; turned on, the new shell at once, and saved', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-preview-'));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  // A 1.9 install's settings: nothing about the new interface.
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31446), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'app-settings.json'), 'utf8')).newInterface;
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });

    // 1 to 4: the row, last and off, under today's interface.
    const rows = page.locator('[data-settings-row]');
    await expect(rows.filter({ hasText: 'Start agents when Tars opens' })).toBeVisible({ timeout: 90_000 });
    const row = rows.filter({ hasText: 'New interface' });
    await expect(row).toHaveCount(1);
    await expect(rows.last()).toContainText('New interface');
    const toggle = row.getByRole('switch', { name: 'New interface' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Agents', exact: true })).toBeVisible();
    seen.rows = (await rows.locator('[data-settings-label]').allInnerTexts()).map(s => s.trim());
    seen.hint = (await row.locator('[data-settings-hint]').innerText()).replace(/\s+/g, ' ').trim();
    seen.switchBefore = await toggle.getAttribute('aria-checked');
    seen.savedBefore = saved() ?? null;
    await stepShot(page, '01-row-off');

    // 5: turned on, the new shell at once, the row on, and the choice saved.
    await toggle.click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Tars, all projects', exact: true })).toBeVisible();
    await expect(page.locator('[data-settings-row]', { hasText: 'New interface' }).getByRole('switch', { name: 'New interface' }))
      .toHaveAttribute('aria-checked', 'true');
    await expect.poll(saved, { timeout: 15_000 }).toBe(true);
    seen.savedOn = saved();
    await stepShot(page, '02-turned-on');

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await removeHome(home);
  }
});
