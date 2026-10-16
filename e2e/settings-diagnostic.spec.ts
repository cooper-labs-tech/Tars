import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Send a diagnostic, in Settings > Preferences (Noah's go on monitoring,
 * 15/10). Frames: `Settings · Preferences` and its copies, and `Settings ·
 * Preferences · diagnostic` with its light copy. In the real app, on a home
 * where nothing starts, with main's `diagnostic:send` answered by a stand-in
 * the spec puts in its place (the Backend's contract: { sent: true, samples,
 * from, to } or { sent: false, reason }):
 * - Send error reports says what it covers now, the abrupt-end note included;
 * - the Diagnostic row's button is off while the switch is off, and nothing
 *   is asked of main;
 * - the switch on, the button sends: off, saying sending…, until main
 *   answers, then one line, how many samples from when to when in local
 *   time;
 * - a refusal shows main's sentence as it gives it; a call that fails reads
 *   Nothing was sent; the switch off again turns the button off;
 * - light, as the frame's copy draws it.
 *
 * The artefact: a screenshot per step, the last one in light, and values.json
 * with what main was asked and what each step showed.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

type Answer = { sent: true; samples: number; from: string; to: string } | { sent: false; reason: string } | { throws: string };

test('settings send a diagnostic: off with the switch, then how many samples went, or main\'s own sentence', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-diagnostic-'));
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', errorReportsEnabled: false }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31434), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });

    // Main's answer, put in place of its own, and what it was asked.
    const answerWith = (answer: Answer, delayMs = 0) => app.evaluate(({ ipcMain }, { answer, delayMs }) => {
      const g = globalThis as unknown as { diagnosticCalls?: number };
      g.diagnosticCalls ??= 0;
      ipcMain.removeHandler('diagnostic:send');
      ipcMain.handle('diagnostic:send', async () => {
        g.diagnosticCalls = (g.diagnosticCalls ?? 0) + 1;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        if ('throws' in answer) throw new Error(answer.throws);
        return answer;
      });
    }, { answer, delayMs });
    const calls = () => app.evaluate(() => (globalThis as unknown as { diagnosticCalls?: number }).diagnosticCalls ?? 0);
    await answerWith({ sent: false, reason: 'never asked' });

    const open = async () => {
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 60_000 });
    };
    await open();
    const row = (label: string) => page.locator('[data-settings-row]').filter({ has: page.locator('[data-settings-label]', { hasText: new RegExp(`^${label}$`) }) });
    const reports = row('Send error reports');
    const diagnostic = row('Diagnostic');
    const toggle = page.getByRole('switch', { name: 'Send error reports' });
    const button = diagnostic.getByRole('button');
    const line = diagnostic.locator('[data-diagnostic-line]');
    await expect(diagnostic).toBeVisible({ timeout: 60_000 });

    // What the switch covers now.
    await expect(reports).toContainText('When Tars ended abruptly, the next launch says so: how long it ran, the crash type macOS gives, and its last health numbers.');
    await expect(diagnostic).toContainText('Sends the last 24 hours of health numbers now, at most once a day, while Send error reports is on.');
    await expect(diagnostic).toContainText('No file path, no name, no content.');

    // The switch off: the button off, and main asked nothing.
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(button).toHaveText('send a diagnostic');
    await expect(button).toBeDisabled();
    await expect(line).toHaveCount(0);
    await stepShot(page, '01-switch-off');

    // The switch on: the button sends, off and saying so until main answers.
    const year = new Date().getFullYear();
    const from = new Date(year, 9, 14, 9, 5).toISOString();
    const to = new Date(year, 9, 15, 9, 0).toISOString();
    await answerWith({ sent: true, samples: 288, from, to }, 2000);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toHaveText('sending…');
    await expect(button).toBeDisabled();
    await stepShot(page, '02-sending');
    await expect(line).toHaveText('Sent 288 samples from 14 Oct 09:05 to 15 Oct 09:00.', { timeout: 15_000 });
    await expect(button).toHaveText('send a diagnostic');
    await expect(button).toBeEnabled();
    expect(await calls()).toBe(1);
    seen.sent = await line.textContent();
    await stepShot(page, '03-sent');

    // A refusal: main's sentence, as it gives it.
    await answerWith({ sent: false, reason: 'A diagnostic was already sent in the last 24 hours.' });
    await button.click();
    await expect(line).toHaveText('A diagnostic was already sent in the last 24 hours.');
    seen.refused = await line.textContent();
    await stepShot(page, '04-refused');

    // A call that fails: nothing was sent, and the button comes back.
    await answerWith({ throws: 'the bridge broke' });
    await button.click();
    await expect(line).toHaveText('Nothing was sent.');
    await expect(button).toBeEnabled();
    seen.failed = await line.textContent();
    expect(await calls()).toBe(3);

    // The switch off again: the button off.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    expect(await calls()).toBe(3);

    // Light, as the frame's copy draws it.
    await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
    await open();
    await expect(diagnostic).toBeVisible({ timeout: 60_000 });
    await stepShot(page, '05-light');

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    // Kept red or green: what each step read is the artefact.
    recordValues({ seen, pageErrors: errors });
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
