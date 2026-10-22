import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The keep awake row of Settings, General, Preferences (2.0.5, on #511's setting and its keepAwake:state). Frames:
 * `Keep awake (2.0.5) · Settings, General, Preferences` and `· states`.
 *
 * In the shell as it was and in the new interface: the row offers while working, always and never, while working
 * chosen when nothing was saved; always, picked, is saved in app-settings.json, main keeps the computer awake at once
 * (keepAwake.state() says active) and the row says so; with two agents running, while working keeps it awake and the
 * row counts them; never, picked, is saved, main lets it sleep and the row says so; and when the system refuses the
 * blocker (Electron's powerSaveBlocker made to throw, as #511's spec does), the row says so.
 * Red on #511's head (a890415e): the row is not there.
 *
 * The artefact: what the row said and main answered after each pick, in values.json, and a screenshot of each.
 */

type Api = { electronAPI: { keepAwake: { state(): Promise<{ mode: string; active: boolean; since?: string; working: number; refused?: true }> } } };

for (const newInterface of [false, true]) {
  test(`the keep awake row saves while working, always or never and says what main does now${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(150_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-keep-awake-row-'));
    seedSandbox(home);
    const settingsFile = path.join(home, '.tars', 'app-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', autoStartAgentsOnLaunch: false, newInterface }, null, 2));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31546 : 31545), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/settings?section=general`, { waitUntil: 'domcontentloaded' });
      const group = page.getByRole('radiogroup', { name: 'Keep this computer awake' });
      const radio = (name: string) => group.getByRole('radio', { name, exact: true });
      const line = page.locator('[data-keep-awake-line]');
      const state = () => page.evaluate(() => (window as unknown as Api).electronAPI.keepAwake.state());
      const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).keepAwake;

      // Nothing saved: while working is chosen, and with no agent working the computer sleeps as usual.
      await expect(group).toBeVisible({ timeout: 60_000 });
      await expect(radio('while working')).toHaveAttribute('aria-checked', 'true');
      await expect(line).toHaveText('sleeps as usual · no agent is working');
      seen.default = { line: await line.innerText(), state: await state() };
      await stepShot(page, `${tag}-01-while-working`);

      // Always: saved, and main keeps it awake at once.
      await radio('always').click();
      await expect.poll(saved).toBe('always');
      await expect.poll(async () => (await state()).active).toBe(true);
      await expect(radio('always')).toHaveAttribute('aria-checked', 'true');
      await expect(line).toHaveText('awake while Tars is open', { timeout: 15_000 });
      seen.always = { line: await line.innerText(), state: await state(), saved: saved() };
      await stepShot(page, `${tag}-02-always`);

      // Two agents running, while working: awake, and the row counts them.
      const dist = path.resolve('electron', 'dist');
      const running = await app.evaluate((_e, { dist }) => {
        const { agents } = process.mainModule!.require(`${dist}/core/agent-manager.js`);
        const ids = [...agents.keys()].slice(0, 2);
        for (const id of ids) agents.get(id).status = 'running';
        return ids;
      }, { dist });
      seen.running = running;
      await radio('while working').click();
      await expect.poll(saved).toBe('while-working');
      await expect.poll(async () => (await state()).active).toBe(true);
      await expect(line).toHaveText('awake now · 2 agents working', { timeout: 15_000 });
      seen.working = { line: await line.innerText(), state: await state() };
      await stepShot(page, `${tag}-02b-working`);

      // Never: saved, and main lets it sleep.
      await radio('never').click();
      await expect.poll(saved).toBe('never');
      await expect.poll(async () => (await state()).active).toBe(false);
      await expect(line).toHaveText('sleeps as usual, even during a turn', { timeout: 15_000 });
      seen.never = { line: await line.innerText(), state: await state(), saved: saved() };
      await stepShot(page, `${tag}-03-never`);

      // Refused by the system: always is kept, and the row says the computer may sleep.
      await app.evaluate(({ powerSaveBlocker }) => {
        powerSaveBlocker.start = (() => { throw new Error('refused by the e2e'); }) as typeof powerSaveBlocker.start;
      });
      await radio('always').click();
      await expect.poll(async () => (await state()).refused).toBe(true);
      await expect(line).toHaveText('cannot keep this computer awake here: the system refused', { timeout: 15_000 });
      seen.refused = { line: await line.innerText(), state: await state(), saved: saved() };
      await stepShot(page, `${tag}-04-refused`);
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
