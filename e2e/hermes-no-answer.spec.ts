import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Hermes gateway that gives no answer is a refusal with its reason on the
 * pages that call it, and a page keeps what did answer. In the real app, in a
 * sandbox whose saved gateway is a loopback port nothing listens on (seedSandbox:
 * 127.0.0.1:9, as a stopped gateway or a dropped tunnel leaves it):
 * 1. Schedules says "Tars could not reach Hermes at http://127.0.0.1:9:
 *    connect ECONNREFUSED 127.0.0.1:9", never Electron's "Error invoking remote
 *    method 'hermes:crons:list'" (the Frontend's finding, 27/11).
 * 2. Brain, Backends keeps its six sources, Hermes among them, unreachable, and
 *    says the same sentence on the Hermes memory row and under the gateway's
 *    MCP servers and its memory provider: one of the page's three calls
 *    rejecting took every source off it, both cards said "No response from the
 *    gateway", and the row the transport's raw words.
 * Red on main 58f2863b4's main process; the surfaces' baselines of both pages
 * (crons, brain-backends) photographed both defects.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];
const SENTENCE = 'Tars could not reach Hermes at http://127.0.0.1:9: connect ECONNREFUSED 127.0.0.1:9';
const SOURCES = ['Project memory', 'Session observations', 'Obsidian', 'Hermes memory', 'gbrain', 'Honcho'];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-hermes-no-answer-'));
  seedSandbox(home);
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31389), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close();
  await removeHome(home);
});

test('schedules: a gateway that gives no answer is named, with the reason, never in Electron\'s words', async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/crons`, { waitUntil: 'domcontentloaded' });

  // The sentence, inside whatever line the page puts it in: #658 draws it after
  // the action ("Could not read the schedules: ..."), so the whole line is the
  // page's, and only this part is this PR's (the Audit's L1 on #660).
  await expect(page.getByText(SENTENCE)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Error invoking remote method/)).toHaveCount(0);
  await stepShot(page, '01-schedules-says-why');
  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ schedules: { shown: SENTENCE, electronWords: 0 }, pageErrors: errors });
});

test('brain, backends: the sources stay, and the Hermes row and the gateway\'s two cards say why it gave no answer', async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/memory`, { waitUntil: 'domcontentloaded' });
  const backends = page.getByRole('radio', { name: 'Backends' });
  await backends.click();
  await expect(backends).toHaveAttribute('aria-checked', 'true');

  for (const label of SOURCES) await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(SENTENCE, { exact: true })).toHaveCount(3);
  await expect(page.getByText('No response from the gateway', { exact: true })).toHaveCount(0);
  await expect(page.getByText('connect ECONNREFUSED 127.0.0.1:9', { exact: true })).toHaveCount(0);
  await stepShot(page, '02-backends-keep-their-sources');
  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ backends: { sources: SOURCES, sentenceShown: 3, rawWords: 0, noResponse: 0 }, pageErrors: errors });
});
