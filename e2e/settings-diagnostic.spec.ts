import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Send a diagnostic, in Settings > Preferences (the maintainer's go on
 * monitoring, 15/10). Frames: `Settings · Preferences` and its copies, and
 * `Settings · Preferences · diagnostic` with its light copy. In the real app,
 * on a home where nothing starts, main sampling its health every second
 * (DOROTHY_HEALTH_EVERY_MS, under DOROTHY_E2E) and its reports pointed at a
 * stand-in for Sentry the spec runs (DOROTHY_ERROR_REPORTS_DSN):
 * - Send error reports says what it covers now, the abrupt-end note included;
 * - the Diagnostic row's button is off while the switch is off, and nothing
 *   is asked of main;
 * - the switch on, the button sends the samples main keeps, through main's own
 *   diagnostic:send: the line says how many went, from when to when in local
 *   time, and the stand-in received one diagnostic report holding that many
 *   samples and nothing of the sandbox's home; sent again within the day, the
 *   line is main's own refusal;
 * - then main's answer put in a stand-in's place (the Backend's contract:
 *   { sent: true, samples, from, to } or { sent: false, reason }): the button
 *   off, saying sending…, until main answers, then the line; a refusal as
 *   main words it; a call that fails reads Nothing was sent; the switch off
 *   again turns the button off;
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

  // A stand-in for Sentry: every envelope it is sent, decoded, answered 200.
  const envelopes: string[] = [];
  const sentry = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      envelopes.push((req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body) : body).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>(resolve => sentry.listen(0, '127.0.0.1', resolve));
  const sentryPort = (sentry.address() as AddressInfo).port;

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31434), DOROTHY_E2E: '1',
      DOROTHY_HEALTH_EVERY_MS: '1000', DOROTHY_ERROR_REPORTS_DSN: `http://e2e@127.0.0.1:${sentryPort}/1`,
    },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });

    // What main is asked: its own handler, counted.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { diagnosticCalls?: number };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const own = handlers.get('diagnostic:send');
      if (!own) throw new Error('main has no diagnostic:send');
      g.diagnosticCalls = 0;
      ipcMain.removeHandler('diagnostic:send');
      ipcMain.handle('diagnostic:send', (...args: unknown[]) => { g.diagnosticCalls = (g.diagnosticCalls ?? 0) + 1; return own(...args); });
    });
    // Main's answer, put in place of its own.
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

    expect(await calls()).toBe(0);

    // The switch on: the button sends the samples main keeps, through its own
    // diagnostic:send, to the stand-in for Sentry.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(button).toBeEnabled();
    const samplesFile = path.join(dir, 'health-samples.jsonl');
    const kept = () => (fs.existsSync(samplesFile) ? fs.readFileSync(samplesFile, 'utf8').split('\n').filter(Boolean).length : 0);
    await expect.poll(kept, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await button.click();
    await expect(line).toHaveText(/^Sent \d+ samples? from \d{1,2} [A-Z][a-z]{2}( \d{4})? \d\d:\d\d to \d{1,2} [A-Z][a-z]{2}( \d{4})? \d\d:\d\d\.$/, { timeout: 30_000 });
    const sentLine = (await line.textContent()) ?? '';
    const count = Number(/^Sent (\d+)/.exec(sentLine)?.[1]);
    const diagnosticsSent = () => envelopes.flatMap(e => e.split('\n')).flatMap(l => {
      try { const o = JSON.parse(l); return o?.tags?.kind === 'diagnostic' ? [o] : []; } catch { return []; }
    });
    const diagnostics = diagnosticsSent();
    seen.realSend = { line: sentLine, kept: kept(), envelopes: envelopes.length, samplesSent: diagnostics[0]?.contexts?.tars?.samples?.length };
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].contexts.tars.samples).toHaveLength(count);
    expect(envelopes.join('\n')).not.toContain(home);
    expect(await calls()).toBe(1);
    await stepShot(page, '02-sent-for-real');

    // Again within the day: main's own refusal, and nothing more reached the stand-in.
    await button.click();
    await expect(line).toHaveText('A diagnostic was already sent in the last 24 hours.', { timeout: 30_000 });
    expect(diagnosticsSent()).toHaveLength(1);
    seen.realRefusal = await line.textContent();
    expect(await calls()).toBe(2);

    // Main's answer in a stand-in's place: off and saying so until main answers.
    const year = new Date().getFullYear();
    const from = new Date(year, 9, 14, 9, 5).toISOString();
    const to = new Date(year, 9, 15, 9, 0).toISOString();
    await answerWith({ sent: true, samples: 288, from, to }, 2000);
    await button.click();
    await expect(button).toHaveText('sending…');
    await expect(button).toBeDisabled();
    await expect(line).toHaveCount(0);
    await stepShot(page, '03-sending');
    await expect(line).toHaveText('Sent 288 samples from 14 Oct 09:05 to 15 Oct 09:00.', { timeout: 15_000 });
    await expect(button).toHaveText('send a diagnostic');
    await expect(button).toBeEnabled();
    expect(await calls()).toBe(3);
    seen.sent = await line.textContent();
    await stepShot(page, '04-sent');

    // A refusal: main's sentence, as it gives it.
    await answerWith({ sent: false, reason: 'A diagnostic was already sent in the last 24 hours.' });
    await button.click();
    await expect(line).toHaveText('A diagnostic was already sent in the last 24 hours.');
    seen.refused = await line.textContent();
    await stepShot(page, '05-refused');

    // A call that fails: nothing was sent, and the button comes back.
    await answerWith({ throws: 'the bridge broke' });
    await button.click();
    await expect(line).toHaveText('Nothing was sent.');
    await expect(button).toBeEnabled();
    seen.failed = await line.textContent();
    expect(await calls()).toBe(5);

    // The switch off again: the button off.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    expect(await calls()).toBe(5);

    // Light, as the frame's copy draws it.
    await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
    await open();
    await expect(diagnostic).toBeVisible({ timeout: 60_000 });
    await stepShot(page, '06-light');

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    // Kept red or green: what each step read is the artefact.
    recordValues({ seen, envelopes, pageErrors: errors });
    await app.close().catch(() => { /* gone */ });
    await new Promise<void>(resolve => sentry.close(() => resolve()));
    await removeHome(home);
  }
});
