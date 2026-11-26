import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The new shell, the only one since 2.1.0 (plan 2.0.0, then the owner's
 * decision of 26/11). Frames: `Shell · chats · empty`, `Shell · chats · More
 * open` and `Shell · chats · Settings card` in tars-redesign.pen, and `Chat ·
 * chats · Tars, all projects` in chat-redesign-a.pen.
 *
 * The real app, a sandbox whose app-settings.json says nothing of the shell.
 * The person opens the chats page: the sidebar is the main menu (Chat,
 * Projects, Dashboard, Kanban, Schedules) with Chat current, New chat
 * disabled, "Tars, all projects" first, and "No chats yet" where the chats
 * will be, none of them made up; the pages of More are not in it. More opens
 * its ten pages, Resources between Usage and Brain since 2.0.5 (#539, frame
 * `Shell · chats · More open`). Settings opens as a card above the app, the chats page
 * still under it, at Preferences, whose Appearance row offers Dark and Light,
 * and no New interface switch is left; Escape closes it and the page has not
 * moved. Usage opens the same way and its cross closes it. "Tars, all
 * projects" opens today's room, /chat, and is the current entry, Chat no
 * longer. In light, the chats page as its light frame draws it.
 *
 * The artefact: a screenshot per state and values.json with what each read.
 */

/** The launch splash, over the page on every document load until its checks answer (4 s at most). */
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const MAIN = ['Chat', 'Projects', 'Dashboard', 'Kanban', 'Schedules'];
const MORE = ['Agents', 'Review', 'Logs', 'Vault', 'Extensions', 'Usage', 'Resources', 'Brain', 'Settings', "What's New"];

test('the shell of the frames: the main menu, Tars first, no made-up chats, More and its pages as cards, Settings at Preferences with its Appearance row', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-new-shell-'));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31455), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });

    // The sidebar of the frames, with nothing made up where the chats go.
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    const menu = sidebar.getByRole('navigation', { name: 'Main menu' });
    await expect(menu).toBeVisible({ timeout: 90_000 });
    seen.menu = (await menu.getByRole('link').allInnerTexts()).map(s => s.trim());
    expect(seen.menu).toEqual(MAIN);
    const chat = menu.getByRole('link', { name: 'Chat', exact: true });
    await expect(chat).toHaveAttribute('aria-current', 'page');
    const tars = sidebar.getByRole('link', { name: 'Tars, all projects', exact: true });
    await expect(tars).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'New chat' })).toBeDisabled();
    await expect(sidebar.getByText('No chats yet')).toBeVisible();
    for (const name of ['Agents', 'Usage', 'Settings']) {
      await expect(sidebar.getByRole('link', { name, exact: true }), `${name} is in More, not in the sidebar`).toHaveCount(0);
    }
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'No chats yet' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Open Tars, all projects' })).toBeVisible();
    seen.chatsEmpty = (await main.innerText()).replace(/\s+/g, ' ').trim();
    await stepShot(page, '01-chats-empty');

    // More and its ten pages.
    const moreButton = sidebar.getByRole('button', { name: 'More' });
    await moreButton.click();
    const more = page.getByRole('menu', { name: 'More' });
    await expect(more).toBeVisible();
    seen.more = (await more.getByRole('menuitem').allInnerTexts()).map(s => s.trim());
    expect(seen.more).toEqual(MORE);
    await stepShot(page, '02-more-open');

    // Settings, as a card above the app: the page under it does not move.
    await more.getByRole('menuitem', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await expect(more).toHaveCount(0);
    await expect(page).toHaveURL(/\/chats\/?$/);
    await expect(settings.getByText('Opening the page')).toHaveCount(0, { timeout: 60_000 });
    // At Preferences: the theme's row, Appearance, Dark and Light, and no New interface switch any more.
    const appearance = settings.locator('[data-settings-row]', { hasText: 'Appearance' });
    await expect(appearance.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio')).toHaveText(['Dark', 'Light']);
    await expect(settings.locator('[data-settings-row]', { hasText: 'New interface' })).toHaveCount(0);
    seen.appearance = (await appearance.innerText()).replace(/\s+/g, ' ').trim();
    await expect(main.getByRole('heading', { name: 'No chats yet' })).toBeVisible();
    await stepShot(page, '03-settings-card');
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(page).toHaveURL(/\/chats\/?$/);

    // Usage, the same way, closed with its cross.
    await moreButton.click();
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Usage' }).click();
    const usage = page.getByRole('dialog', { name: 'Usage' });
    await expect(usage).toBeVisible();
    await expect(page).toHaveURL(/\/chats\/?$/);
    await expect(usage.getByText('Opening the page')).toHaveCount(0, { timeout: 60_000 });
    await stepShot(page, '04-usage-card');
    await usage.getByRole('button', { name: 'Close' }).click();
    await expect(usage).toHaveCount(0);

    // Tars, all projects: today's room, unchanged, and the current entry.
    await tars.click();
    await expect(page).toHaveURL(/\/chat\/?$/);
    await expect(tars).toHaveAttribute('aria-current', 'page');
    await expect(chat).not.toHaveAttribute('aria-current', 'page');
    // Chat stays boxed beside it, its section (hongt, chat-redesign-a.pen): the current item of the menu, not its page.
    await expect(chat).toHaveAttribute('aria-current', 'true');
    expect(await chat.evaluate(el => el.className.includes('bg-accent-dim'))).toBe(true);
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    await stepShot(page, '05-tars-all-projects');

    // In light, as the light frame draws the chats page.
    await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('main').getByRole('heading', { name: 'No chats yet' })).toBeVisible({ timeout: 60_000 });
    await stepShot(page, '06-chats-empty-light');
    await page.evaluate(() => localStorage.setItem('tars-theme', 'dark'));

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
