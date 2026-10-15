import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, seedSandbox, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings > CLI Paths > Additional PATH keeps each folder the user types,
 * through Save and a reload.
 *
 * The row is one PATH string. It was split and joined on `:`, which is inside
 * every Windows drive: `C:\tools` was saved as `C` and `\tools`, and read back
 * joined with `:` again, so the field looked right after a reload while the
 * agents got two folders that do not exist. The saved list is what this reads,
 * as well as the field. On darwin/linux the separator is `:`, as it was.
 */

const onWindows = process.platform === 'win32';
const TYPED = onWindows ? 'C:\\tools;D:\\a b (x)' : '/opt/tools:/usr/a b (x)';
const EXPECTED = onWindows ? ['C:\\tools', 'D:\\a b (x)'] : ['/opt/tools', '/usr/a b (x)'];

async function openCliPaths(page: import('@playwright/test').Page) {
  await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const nav = page.getByTestId('settings-nav');
  await nav.getByText('AI & Providers', { exact: true }).click();
  await page.waitForTimeout(400);
  await nav.getByText('CLI Paths', { exact: true }).click();
  await page.waitForTimeout(1200);
  return page.getByPlaceholder('/path/to/directory');
}

test('the extra PATH list keeps a drive path through save and reload', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-cli-paths-'));
  seedSandbox(home);
  const settingsFile = path.join(home, '.dorothy', 'app-settings.json');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31486), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');

    const field = await openCliPaths(page);
    await field.fill(TYPED);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(1500);
    await stepShot(page, 'saved');

    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).cliPaths?.additionalPaths;

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await (await openCliPaths(page)).inputValue();
    await stepShot(page, 'reloaded');

    recordValues({ platform: process.platform, typed: TYPED, saved, reloaded, command: 'E2E_PORT_OFFSET=20 npx playwright test e2e/cli-paths-extra-path.spec.ts' });
    console.log('CLI-PATHS saved   :', JSON.stringify(saved));
    console.log('CLI-PATHS reloaded:', JSON.stringify(reloaded));

    expect(saved).toEqual(EXPECTED);
    expect(reloaded).toBe(TYPED);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
