import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The data folder notice (2.0.4, the window's part of #473's app:dataDir; frame `Data folder · notice`, and its
 * light copy). The real app on a sandbox HOME where Tars cannot settle on ~/.tars, Finder stood in for in the main
 * process. Asserted:
 * 1. Two data folders, ~/.tars empty and ~/.dorothy holding the agents and settings: the line across the top of the
 *    main column says main's notice, that Tars uses ~/.dorothy; show folder opens that folder; dismiss hides it.
 * 2. A file standing at ~/.tars: Tars could not move ~/.dorothy there, goes on from it, and says it tries again.
 * Red on 71cf07f2 (#473's head, the window before this): no line at all.
 * The artefact: values.json (the lines read, what Tars would have opened), the screenshots, and with E2E_TRACE=on the
 * app's trace.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

function seed(tag: string, tarsIsAFile: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-data-folder-${tag}-`));
  const old = path.join(home, '.dorothy');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'agents.json'), '[]');
  fs.writeFileSync(path.join(old, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const tars = path.join(home, '.tars');
  if (tarsIsAFile) fs.writeFileSync(tars, 'not a folder');
  else fs.mkdirSync(tars, { recursive: true });
  return { home, old, tars };
}

async function standInForFinder(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __e2eOpened: string[] };
    g.__e2eOpened = [];
    shell.openPath = (async (p: string) => { g.__e2eOpened.push(p); return ''; }) as typeof shell.openPath;
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __e2eOpened: string[] }).__e2eOpened);

const shell = ' (new interface)';

for (const tarsIsAFile of [false, true]) {
  const what = tarsIsAFile ? 'a file at ~/.tars: the move refused, tried again at each start' : 'two data folders: the one tars runs on';
  test(`the data folder notice says ${what}${shell}`, async () => {
    test.setTimeout(180_000);
    const s = seed(`ni-${tarsIsAFile ? 'file' : 'both'}`, tarsIsAFile);
    const app = await launchSandboxed(electron, s.home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31563 + 2 + (tarsIsAFile ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const errors: string[] = [];
    try {
      await standInForFinder(app);
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });

      const notice = page.getByRole('status', { name: 'Data folder' });
      await expect(notice).toContainText('Data folder:', { timeout: 30_000 });
      if (tarsIsAFile) {
        await expect(notice).toContainText(`Tars could not move ${s.old} to ${s.tars}: it goes on from ${s.old}, and tries again at each start.`);
      } else {
        await expect(notice).toContainText(`Two data folders: ${s.tars} and ${s.old}, which are not the same folder. Tars uses ${s.old}, which holds its agents and settings, and has left ${s.tars} as it is.`);
      }
      const said = await notice.innerText();
      await stepShot(page, tarsIsAFile ? '01-move-refused' : '01-two-folders');

      await notice.getByRole('button', { name: 'show folder', exact: true }).click();
      await expect.poll(async () => (await opened(app)).at(-1) ?? '', { timeout: 10_000 }).toBe(s.old);
      await notice.getByRole('button', { name: 'dismiss', exact: true }).click();
      await expect(notice).toHaveCount(0);
      await stepShot(page, '02-dismissed');

      recordValues({ tarsIsAFile, said, opened: await opened(app), pageErrors: errors });
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await app.close().catch(() => { /* gone */ });
      await removeHome(s.home);
    }
  });
}
