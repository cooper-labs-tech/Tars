import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings, Telegram once Tars's own bot is gone (2.0.5, the owner's decision of 01/10: Telegram goes through Hermes
 * only; frames `Settings · Telegram · Telegram through Hermes` and its light copy). On the Database Engineer's removal of
 * the bot (feat/telegram-through-hermes): no `telegram` channel in the window, and `telegramBotRetired` set once at the
 * first 2.0.5 launch that found the bot's settings.
 *
 * How it can fail, written before the section:
 * 1. the section still offers something of the bot: a field to type a token or a chat id, a switch, a test, a send;
 * 2. it does not say Telegram goes through Hermes;
 * 3. its one action does not open Settings, Hermes;
 * 4. Tars found the old bot's token and the section does not say to revoke it with BotFather (/revoke); or it says so
 *    when no token was found;
 * 5. the window still has a `telegram` channel;
 * 6. an uncaught error in the page.
 * Once with the classic shell and an old token found, once with the new interface and none found.
 * Red on main (dc623b594): the section is the bot's, with its token field and its test.
 *
 * The artefact: the section's text and its controls, in values.json, and a screenshot of each step.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

for (const newInterface of [false, true]) {
  const hadToken = !newInterface;
  test(`settings, telegram: telegram goes through hermes, one action to hermes, nothing of the old bot${hadToken ? ', and its token to revoke' : ''}${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-telegram-hermes-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface,
      telegramBotRetired: { at: '2026-10-28T09:00:00.000Z', hadToken },
    }));
    const seen: Record<string, unknown> = { newInterface, hadToken };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31568 : 31567), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/settings?section=telegram`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
      const section = page.locator('[data-settings-section="telegram"]');
      await expect(section).toBeVisible({ timeout: 90_000 });

      // 2. What it says.
      await expect(section).toContainText('Telegram goes through Hermes');
      seen.text = (await section.innerText()).replace(/\s+/g, ' ');

      // 1. Nothing of the bot: no field, no switch, no test, one action.
      const controls = {
        textboxes: await section.getByRole('textbox').count(),
        switches: await section.getByRole('switch').count(),
        checkboxes: await section.getByRole('checkbox').count(),
        buttons: await section.getByRole('button').allInnerTexts(),
      };
      seen.controls = controls;
      expect(controls.textboxes).toBe(0);
      expect(controls.switches).toBe(0);
      expect(controls.checkboxes).toBe(0);
      expect(controls.buttons.map((b) => b.trim().toLowerCase())).toEqual(['open hermes']);

      // 4. The old bot's token, to revoke, only when one was found.
      if (hadToken) {
        await expect(section).toContainText('/revoke');
        await expect(section).toContainText('@BotFather');
      } else {
        await expect(section).not.toContainText('/revoke');
      }
      await stepShot(page, `${tag}1-telegram`);

      // 5. No telegram channel in the window.
      const channel = await page.evaluate(() => typeof (window.electronAPI as unknown as Record<string, unknown>).telegram);
      seen.telegramChannel = channel;
      expect(channel).toBe('undefined');

      // 3. Its one action opens Settings, Hermes.
      await section.getByRole('button', { name: 'open hermes' }).click();
      await expect(page.locator('[data-settings-section="hermes"]')).toBeVisible({ timeout: 30_000 });
      await stepShot(page, `${tag}2-hermes`);

      // 6.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
