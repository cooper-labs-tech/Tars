import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * "Reveal in Finder" on the Projects page shows a folder Tars knows in its folder, and nothing else (shell:reveal,
 * 2.0.7). A project's path comes from ~/.tars/projects.json, which every agent can write.
 *
 * The real app on a sandbox HOME whose projects.json holds two entries: a real project folder, and a small script
 * standing in for a file that is not a folder. If anything ever runs the stand-in, it writes a marker in the sandbox.
 * From the page, each project is opened and its "Reveal in Finder" pressed.
 *
 * What main asks the system to do is recorded instead of done: shell.openPath and shell.showItemInFolder are replaced
 * in the main process by recorders, so the run opens no window on the machine it runs on.
 * Asserted:
 * - shell.openPath is never called, with any path;
 * - the stand-in is neither shown nor opened, and its marker is never written;
 * - the real project is shown in its folder (shell.showItemInFolder), once.
 * Red on train/2.0.7 b5f207bcf: the button hands each path to shell.openPath, the stand-in's included.
 *
 * The artefact: values.json (the calls recorded, the marker's absence), projects-*.png, and with E2E_TRACE=on the
 * app's trace. Reproduce: `E2E_PORT_OFFSET=40 npx playwright test e2e/show-folder-reveals.spec.ts`.
 */

type Call = { fn: 'openPath' | 'showItemInFolder'; path: string };

test('Reveal in Finder shows a known project folder in its folder, and never opens a path', async () => {
  test.setTimeout(240_000);
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-reveal-'));
  const home = process.platform === 'win32' ? fs.realpathSync(made) : made;
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'work', 'harbor');
  const marker = path.join(home, 'stand-in-ran');
  const standIn = path.join(home, 'work', 'stand-in.sh');
  for (const d of [dir, project]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(standIn, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, standIn]));
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31374), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  try {
    // The recorders, before the window can press anything.
    await app.evaluate(({ shell }) => {
      const calls: Array<{ fn: string; path: string }> = [];
      (globalThis as unknown as { __revealCalls: typeof calls }).__revealCalls = calls;
      shell.openPath = async (p: string) => { calls.push({ fn: 'openPath', path: p }); return ''; };
      shell.showItemInFolder = (p: string) => { calls.push({ fn: 'showItemInFolder', path: p }); };
    });
    const calls = () => app.evaluate(() => [...(globalThis as unknown as { __revealCalls: Call[] }).__revealCalls]);

    const page = await app.firstWindow();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    const main = page.locator('main');

    const reveal = async (name: string) => {
      const title = main.getByText(name, { exact: true }).first();
      await expect(title, `the project ${name} is not listed`).toBeVisible({ timeout: 90_000 });
      const card = title.locator('xpath=ancestor::div[.//button[normalize-space()="open"]][1]');
      await card.getByRole('button', { name: 'open', exact: true }).click();
      const before = (await calls()).length;
      await main.getByRole('button', { name: 'Reveal in Finder' }).click();
      // The handler answers in a few milliseconds; what it asked for, if anything, is recorded by then.
      await expect.poll(async () => (await calls()).length, { timeout: 5_000 }).toBeGreaterThan(before).catch(() => undefined);
      await stepShot(page, `projects-${name}`);
      // The project's panel closed again, so its scrim leaves the next card to be pressed.
      await main.getByRole('button', { name: 'close', exact: true }).click();
      await expect(main.getByRole('button', { name: 'Reveal in Finder' })).toHaveCount(0);
    };
    await reveal(path.basename(standIn));
    await reveal('harbor');

    const recorded = await calls();
    const values = { platform: process.platform, project, standIn, recorded, markerWritten: fs.existsSync(marker), pageErrors };
    recordValues(values);
    expect(recorded.filter((c) => c.fn === 'openPath'), 'a path was opened rather than shown').toEqual([]);
    expect(recorded.filter((c) => c.path === standIn), 'the stand-in was shown or opened').toEqual([]);
    expect(values.markerWritten, 'the stand-in ran').toBe(false);
    expect(recorded.filter((c) => c.fn === 'showItemInFolder' && c.path === project), 'the project was not shown in its folder').toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
