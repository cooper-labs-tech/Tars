import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Telegram through Hermes switch in Settings, Hermes, in the real app, on
 * #285's relay. Frames: `Settings · Connection`, and `Settings · Connection ·
 * Telegram through Hermes` with its light copy.
 *
 * Since 2.0.5 Tars has no Telegram bot of its own (PR 545): the relay is the
 * one way to Telegram. The sandbox holds a Hermes connection to a port nothing
 * listens on.
 * - Off: the row says what turning it on does, and nothing of a bot.
 * - A click on the switch asks first, with turn on and cancel, and the
 *   settings file is untouched; cancel keeps it so.
 * - Turn on: the file says the relay is on, the switch is on, and the row says
 *   the state main reports (relayStatus) in its word.
 * - A reload keeps it. Settings, Telegram says Telegram goes through Hermes,
 *   with nothing to type, test or switch (frame `Settings · Telegram ·
 *   Telegram through Hermes`); its button opens Settings, Hermes.
 * - Turning it off saves at once, and Settings, Telegram still says Telegram
 *   goes through Hermes: no bot comes back.
 *
 * The artefact: a screenshot per step, and values.json with the settings file
 * and the bot's (stand-in) token as Tars keeps it, at each step, and the
 * states read.
 */

const LABEL = 'Telegram through Hermes';
const WARNING = 'Turning it on makes Hermes the only voice on your Telegram';
const THROUGH = 'Telegram goes through Hermes';
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const WORDS: Record<string, string> = {
  ready: 'ready', unreachable: 'unreachable', 'not-configured': 'not configured',
  'plugin-missing': 'plugin missing', unauthorized: 'unauthorized', 'no-connection': 'no connection',
};
type Api = { electronAPI: { hermes: { relayStatus(): Promise<{ enabled: boolean; state: string; waiting: number }> } } };

test('Telegram through Hermes asks before it turns on, says how the relay stands, and Settings, Telegram says Telegram goes through it', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-relay-switch-'));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const priv = path.join(home, '.tars-private');
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(priv, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }), { mode: 0o600 });
  const settingsFile = path.join(dir, 'app-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', hermesRelayEnabled: false,
  }));
  const file = () => JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { hermesRelayEnabled?: boolean };

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31469), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    const openSection = async (p: Page) => {
      await p.goto(`${DEV_URL}/settings?section=hermes`, { waitUntil: 'domcontentloaded' });
      await expect(p.getByRole('switch', { name: LABEL })).toBeVisible({ timeout: 60_000 });
      await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    };
    await openSection(page);
    const toggle = page.getByRole('switch', { name: LABEL });
    const row = page.getByText(LABEL, { exact: true }).locator('xpath=../..');
    const rows = page.locator('[data-settings-row]');
    const rowOf = (label: string) => rows.filter({ has: page.locator('[data-settings-label]', { hasText: new RegExp(`^${label}$`) }) });

    // Off: the row says what it does, and nothing of a bot.
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(row).toContainText('Hermes becomes the only voice on your Telegram');
    await expect(row).not.toContainText(/bot/i);
    seen.off = file();
    await stepShot(page, '01-off');

    // A click asks first, and saves nothing.
    await toggle.click();
    const notice = page.getByText(new RegExp(`^${WARNING}`));
    await expect(notice).toBeVisible();
    await expect(page.getByRole('button', { name: 'turn on', exact: true })).toBeVisible();
    expect(file()).toMatchObject({ hermesRelayEnabled: false });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await stepShot(page, '02-asks-first');

    await page.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(file()).toMatchObject({ hermesRelayEnabled: false });

    // Turn on: the relay on, the state main reports.
    await toggle.click();
    await page.getByRole('button', { name: 'turn on', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(() => file().hermesRelayEnabled, { timeout: 15_000 }).toBe(true);
    seen.on = file();
    expect(file()).toMatchObject({ hermesRelayEnabled: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const relay = () => page.evaluate(() => (window as unknown as Api).electronAPI.hermes.relayStatus());
    await expect.poll(async () => (await relay()).state, { timeout: 30_000 }).not.toBe('off');
    const state = (await relay()).state;
    seen.state = state;
    await expect(row).toContainText(WORDS[state], { timeout: 15_000 });
    await stepShot(page, '03-on');

    // A reload keeps it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openSection(page);
    await expect(page.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(LABEL, { exact: true }).locator('xpath=../..')).toContainText(WORDS[(await relay()).state]);

    // Settings, Telegram: Telegram goes through Hermes, nothing to type, test or switch.
    await page.goto(`${DEV_URL}/settings?section=telegram`, { waitUntil: 'domcontentloaded' });
    await expect(rowOf(THROUGH)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    await expect(rows.locator('input')).toHaveCount(0);
    await expect(rows.getByRole('switch')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Test', exact: true })).toHaveCount(0);
    seen.telegramOn = { labels: await rows.locator('[data-settings-label]').allTextContents(), file: file() };
    expect(file()).toMatchObject({ hermesRelayEnabled: true });
    await stepShot(page, '03b-telegram-replaced');
    await page.getByRole('button', { name: 'open hermes', exact: true }).click();
    await expect(page.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');

    // Off saves at once, without asking.
    await page.getByRole('switch', { name: LABEL }).click();
    await expect(page.getByText(new RegExp(`^${WARNING}`))).toHaveCount(0);
    await expect.poll(() => file().hermesRelayEnabled, { timeout: 15_000 }).toBe(false);
    seen.offAgain = file();
    await stepShot(page, '04-off-again');

    // Settings, Telegram still says Telegram goes through Hermes: no bot comes back.
    await page.goto(`${DEV_URL}/settings?section=telegram`, { waitUntil: 'domcontentloaded' });
    await expect(rowOf(THROUGH)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    await expect(rows.locator('input')).toHaveCount(0);
    await expect(rowOf('Bot token')).toHaveCount(0);
    seen.telegramOffAgain = { labels: await rows.locator('[data-settings-label]').allTextContents() };
    await stepShot(page, '05-telegram-back');

    recordValues({ seen, pageErrors: errors });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
