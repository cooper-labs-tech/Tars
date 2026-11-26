import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The last error report beside the Send error reports switch (2.0.4, the window's part of #474). Frames:
 * `Settings · Preferences` (and its light and new interface copies) and `Settings · Preferences · error reports,
 * the last report`, with its light copy.
 *
 * The real app on a sandbox HOME, error reports off, so nothing loads Sentry or leaves; main reads the last report
 * from ~/.tars/error-reports.json each time the window asks (errorReports:last), and the spec writes that file as
 * a report would have left it. Asserted:
 * 1. No file: the row says "No report sent yet", and its description what a report carries since #474.
 * 2. A handled error that Sentry took 3 minutes ago: "Last report: 3 min ago (handled), Sentry answered 200",
 *    read again when Preferences opens again.
 * 3. An uncaught error 12 minutes ago that Sentry never answered: "... (uncaught), no answer from Sentry".
 * 4. The page holds nothing but that line of the file: no install id.
 * Red on 209c6b0f (#474's head, the page before this): no line beside the switch, the old description.
 * The artefact: values.json (the lines read), the screenshots, and with E2E_TRACE=on the app's trace.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const DESCRIPTION = "Sends Sentry the errors Tars meets, where they happened in Tars's code, the version, the system and a random install id, and your agents' tool errors, as a code. An error Tars caught goes without its message.";
const INSTALL_ID = '4b0e7c2a-91d3-4f6e-8a5b-2c7d9e1f3a6b';

function seed(tag: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-error-line-${tag}-`));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', errorReportsEnabled: false,
  }));
  /** The file as main's ReportBudget writes it, with `last` the answer to the last report. */
  const reportsLeft = (last: { minutesAgo: number; kind: string; status: number }) => fs.writeFileSync(
    path.join(dir, 'error-reports.json'),
    JSON.stringify({ installId: INSTALL_ID, sent: [], seen: {}, last: { at: Date.now() - last.minutesAgo * 60_000, kind: last.kind, status: last.status } }),
    { mode: 0o600 },
  );
  return { home, reportsLeft };
}

const reportsRow = (page: Page) => page.locator('[data-settings-row]')
  .filter({ has: page.locator('[data-settings-label]', { hasText: /^Send error reports$/ }) });

/** Preferences opened again, from another section: the page asks main for the last report as it opens. */
async function reopenPreferences(page: Page) {
  const nav = page.getByTestId('settings-nav');
  await nav.getByText('Terminal', { exact: true }).click({ timeout: 10_000 });
  await nav.getByText('Preferences', { exact: true }).click({ timeout: 10_000 });
}

const shell = ' (new interface)';

test(`the last error report is said beside its switch: when, which kind, and what sentry answered${shell}`, async () => {
  test.setTimeout(180_000);
  const s = seed('ni');
  const app = await launchSandboxed(electron, s.home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31558), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-nav')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
    const row = reportsRow(page);

    // 1. Nothing sent yet, and what a report carries.
    await expect(row).toContainText('No report sent yet', { timeout: 30_000 });
    await expect(row).toContainText(DESCRIPTION);
    values.none = await row.innerText();
    await stepShot(page, '01-no-report-yet');

    // 2. A handled error Sentry took, read again as Preferences opens.
    s.reportsLeft({ minutesAgo: 3, kind: 'handled', status: 200 });
    await reopenPreferences(page);
    await expect(row).toContainText('Last report: 3 min ago (handled), Sentry answered 200', { timeout: 15_000 });
    values.taken = await row.innerText();
    await stepShot(page, '02-handled-taken');

    // 3. An uncaught error Sentry never answered.
    s.reportsLeft({ minutesAgo: 12, kind: 'error', status: 0 });
    await reopenPreferences(page);
    await expect(row).toContainText('Last report: 12 min ago (uncaught), no answer from Sentry', { timeout: 15_000 });
    values.unanswered = await row.innerText();
    await stepShot(page, '03-uncaught-unanswered');

    // 4. The line is all the page holds of the file.
    expect(await page.evaluate((id) => document.body.innerText.includes(id), INSTALL_ID), 'the install id is not shown').toBe(false);

    values.pageErrors = errors;
    recordValues(values);
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(s.home);
  }
});
