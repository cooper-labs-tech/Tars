import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Budget & limits with several Claude accounts, in the real app, on #277's
 * counters. Frames: `Usage · limits per account` and its light copy.
 *
 * The sandbox has the accounts option on with three accounts, one turned off,
 * a counter file per account as the status line writes them, and account 1's
 * rate-limits.json. Team B's 5 h window reset 30 seconds ago.
 * - On: each account in use gets its 5 h and weekly rows under "Claude · its
 *   name", in Settings' order; Team B's 5 h row says reset over an empty bar;
 *   the turned-off account and the plain "Claude" rows are nowhere.
 * - Off: Claude's two rows are account 1's again, from rate-limits.json.
 *
 * The artefact: a screenshot of each, and values.json with every row read.
 */

const ROWS = 'Budget & limits';
/** The launch splash, over the page on every document load until its checks answer (4 s at most). */
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

/** Every row of the panel: its label, its detail, and how wide its bar is drawn. */
async function budgetRows(page: Page) {
  const panel = page.getByText(ROWS, { exact: true }).locator('xpath=../..');
  return panel.locator(':scope > div.space-y-2 > div').evaluateAll(els => els.map(el => {
    const spans = [...el.querySelectorAll('span')].map(s => s.textContent ?? '');
    const bar = el.querySelector('div.h-full') as HTMLElement | null;
    return { label: spans[0], detail: spans[spans.length - 1], bar: bar ? bar.style.width : null };
  }));
}

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test('Budget & limits shows each Claude account\'s windows, and Claude\'s own with the option off', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-limits-per-account-'));
  const dir = path.join(home, '.dorothy');
  const priv = path.join(home, '.tars-private');
  fs.mkdirSync(path.join(dir, 'rate-limits.d'), { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const registry = (enabled: boolean) => fs.writeFileSync(path.join(priv, 'claude-accounts.json'), JSON.stringify({
    enabled, fiveHourThreshold: 90, weeklyThreshold: 95,
    accounts: [
      { id: 'default', label: 'Personal', enabled: true },
      { id: 'acct-0b0b0b', label: 'Team B', enabled: true },
      { id: 'acct-0c0c0c', label: 'Paused', enabled: false },
    ],
  }), { mode: 0o600 });
  registry(true);
  const now = Math.floor(Date.now() / 1000);
  const counters = (id: string, five: [number, number], week: [number, number]) => fs.writeFileSync(
    path.join(dir, 'rate-limits.d', `${id}.json`),
    JSON.stringify({ updatedAt: now - 60, rate_limits: {
      five_hour: { used_percentage: five[0], resets_at: five[1] },
      seven_day: { used_percentage: week[0], resets_at: week[1] },
    } }),
  );
  counters('default', [62, now + 1800], [31, now + 3 * 86_400]);
  counters('acct-0b0b0b', [12, now - 30], [8, now + 5 * 86_400]);
  counters('acct-0c0c0c', [50, now + 1800], [50, now + 86_400]);
  // Account 1's, as its status line writes it: what the page shows with the option off.
  fs.writeFileSync(path.join(dir, 'rate-limits.json'), JSON.stringify({
    five_hour: { used_percentage: 44, resets_at: now + 3600 },
    seven_day: { used_percentage: 22, resets_at: now + 2 * 86_400 },
  }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31470), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(ROWS, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Claude · Personal', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    const on = await budgetRows(page);
    const claudeOn = on.filter(r => r.label.startsWith('Claude'));
    expect(claudeOn.map(r => [r.label, r.detail.replace(/resets in .*/, 'resets')])).toEqual([
      ['Claude · Personal', '5h window · 62% used · resets'],
      ['Claude · Personal', '7d window · 31% used · resets'],
      ['Claude · Team B', '5h window · reset'],
      ['Claude · Team B', '7d window · 8% used · resets'],
    ]);
    expect(claudeOn[2].bar).toBe('0%');
    expect(on.some(r => r.label.includes('Paused'))).toBe(false);
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    await stepShot(page, '01-accounts-on');

    // The option off: Claude's two rows are account 1's, as before.
    registry(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(ROWS, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Claude · Personal', { exact: true })).toHaveCount(0, { timeout: 30_000 });
    const off = await budgetRows(page);
    const claudeOff = off.filter(r => r.label.startsWith('Claude'));
    expect(claudeOff.map(r => [r.label, r.detail.replace(/resets in .*/, 'resets')])).toEqual([
      ['Claude', '5h window · 44% used · resets'],
      ['Claude', '7d window · 22% used · resets'],
    ]);
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    await stepShot(page, '02-accounts-off');

    recordValues({ on, off, pageErrors: errors });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
