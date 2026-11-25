import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A call main throws on is said in main's own sentence, never Electron's wrapping (QA's Low on #599 at 5752bea8a).
 *
 * A handler that throws reaches the window as "Error invoking remote method '<channel>': Error: <sentence>". The upload,
 * storage and session views showed main's sentence (reasonOf); the endpoints, the closed models switch, the pairs and a
 * project's switch showed the whole wrapping, the channel's name included.
 *
 * The real app on a sandbox HOME, an endpoint added through the window's own call. Main's handler for each channel is
 * made to throw one sentence (as QA's 5d does), and the line the window shows is read:
 * 1. Settings, Inference endpoints, removing the endpoint: [data-endpoint-remove-refused];
 * 2. Settings, Inference endpoints, Never record closed models: its error line;
 * 3. Traces, Who may be traced, the list read: its alert.
 * Each holds the sentence, and neither "Error invoking remote method" nor "Error:".
 * Red on 5752bea8a's window: the three lines showed the wrapping.
 * The artefact: values.json (each line as shown) and thrown-<n>.png.
 */

const SENTENCE = 'the settings file is held by another process';
const WRAPPING = /Error invoking remote method|Error:/;

type Api = { electronAPI: { endpoints: {
  save(e: { name: string; baseUrl: string; allowTraces: boolean; allowPlainHttp?: boolean }): Promise<{ ok: boolean; error?: string }>;
} } };

test('a call main throws on is said in main\'s own sentence, in the endpoints, the closed models switch and the pairs', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-thrown-reason-'));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31951), DOROTHY_E2E: '1' },
  });
  /** Main's handler for `channel` throws the sentence from now on. */
  const throwOn = (channel: string) => app.evaluate(({ ipcMain }, { ch, words }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    handlers.set(ch, async () => { throw new Error(words); });
  }, { ch: channel, words: SENTENCE });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const saved = await page.evaluate(() => (window as unknown as Api).electronAPI.endpoints.save({ name: 'Bench', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: false, allowPlainHttp: true }));
    keep({ saved });
    const shot = (n: number) => page.screenshot({ path: test.info().outputPath(`thrown-${n}.png`) });

    // 1. Removing the endpoint.
    await page.goto(`${DEV_URL}/settings?section=inference-endpoints`, { waitUntil: 'domcontentloaded' });
    const row = page.locator('[data-endpoint="Bench"]');
    await row.getByRole('button', { name: 'remove', exact: true }).first().click();
    await throwOn('endpoints:remove');
    await row.getByRole('button', { name: 'remove', exact: true }).last().click();
    const removeLine = page.locator('[data-endpoint-remove-refused]');
    await expect.soft(removeLine, 'the removal refused').toBeVisible({ timeout: 10_000 });
    const removeShown = (await removeLine.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    await shot(1);

    // 2. Never record closed models.
    await throwOn('traces:setSettings');
    await page.getByRole('switch', { name: 'Never record closed models' }).click();
    const closedLine = page.locator('[data-closed-models] .text-status-error');
    await expect.soft(closedLine, 'the closed models switch refused').toBeVisible({ timeout: 10_000 });
    const closedShown = (await closedLine.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    await shot(2);

    // 3. The pairs, read.
    await throwOn('traces:pairs');
    await page.goto(`${DEV_URL}/traces?view=pairs`, { waitUntil: 'domcontentloaded' });
    const pairsLine = page.getByRole('alert').filter({ hasText: 'could not read the list' });
    await expect.soft(pairsLine, 'the list not read').toBeVisible({ timeout: 10_000 });
    const pairsShown = (await pairsLine.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    await shot(3);

    keep({ removeShown, closedShown, pairsShown });
    for (const [what, shown] of [['the removal', removeShown], ['the closed models switch', closedShown], ['the pairs', pairsShown]] as const) {
      expect.soft(shown ?? '', `${what}: main's sentence`).toContain(SENTENCE);
      expect.soft(shown ?? '', `${what}: no wrapping`).not.toMatch(WRAPPING);
    }
  } finally {
    await app.close();
    await removeHome(home);
  }
});
