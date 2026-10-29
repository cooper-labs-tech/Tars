import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent that could not start for lack of a terminal says why, in main's own words (2.0.6, item 1; PR 553 marks it:
 * status 'error' with `error` = the refusal's sentence, or, asleep, it stays asleep with it; frame `Agent cannot start ·
 * no terminal left (2.0.6)`).
 *
 * How it can fail, written before the window's change:
 * 1. the card of an agent whose start was refused does not show the sentence, or reworded, or without it whole in its
 *    title;
 * 2. the card of an asleep agent whose wake was refused shows no reason (PR 553 leaves it asleep, the sentence in
 *    `error`), or only after the page is read again;
 * 3. the Dashboard pane's header line is not the sentence, whole in its title;
 * 4. an uncaught error in the page.
 * Main refuses for real: DOROTHY_E2E_PTY_MAX=1 (PR 567) makes the pool Tars's own terminals out of one, so every start
 * is refused by spawnPty before node-pty is asked, and markNoTerminal marks the agent. The window's own start and wake
 * (agent:start, agent:wake) are asked once the cards show, so the cards must take the reason live. An agent seeded in
 * 'error' cannot stand in for this: main's load turns it idle (core/agent-manager.ts). Once with the classic shell and
 * once with the new interface (the Dashboard pane in the classic shell, whose home it is). Red on #555's tile commit,
 * the seam set: the asleep card has no reason. The artefact: values.json (the answers and the lines as read),
 * screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const HEAD = 'No terminal can be opened on this machine:';

for (const newInterface of [false, true]) {
  test(`an agent that could not start for lack of a terminal says main's sentence on its card and its pane${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-no-terminal-'));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
      id, name, character: 'robot', provider: 'claude', role: 'worker', projectPath: project, skills: [],
      createdAt: '2026-10-29T08:00:00.000Z', lastActivity: '2026-10-29T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('nt-error', 'Harbor Builder', { status: 'idle' }),
      agent('nt-asleep', 'Harbor Reviewer', { status: 'asleep', asleepSince: '2026-10-29T08:30:00.000Z' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const errors: string[] = [];
    const tag = newInterface ? 'new-' : '';

    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31582 : 31581), DOROTHY_E2E: '1',
        DOROTHY_E2E_PTY_MAX: '1',
      },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      let where;
      if (!newInterface) {
        await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
        where = page.locator('main');
      } else {
        await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Agents' }).click();
        where = page.getByRole('dialog', { name: 'Agents' });
      }

      const errorCard = where.locator('[data-agent-card="nt-error"]');
      const asleepCard = where.locator('[data-agent-card="nt-asleep"]');
      await expect(errorCard).toBeVisible({ timeout: 60_000 });
      await expect(asleepCard).toContainText('asleep');

      // The window's own start and wake, refused by main: no terminal under the seam.
      type Answer = { success: boolean; error?: string; code?: string };
      const started = await page.evaluate(() => window.electronAPI!.agent.start({ id: 'nt-error', prompt: '' })) as Answer;
      seen.started = started;
      expect(started).toMatchObject({ success: false, code: 'no_terminal' });
      expect(started.error?.startsWith(HEAD)).toBe(true);
      const said = started.error!;
      const woken = await page.evaluate(() => window.electronAPI!.agent.wake('nt-asleep')) as Answer;
      seen.woken = woken;
      expect(woken.success).toBe(false);
      expect(woken.error?.startsWith(HEAD)).toBe(true);
      const saidAsleep = woken.error!;

      // 1. Its start refused: the sentence on its card, whole in the line's title, without the page read again.
      await expect(errorCard.locator(`[title="${said}"]`)).toHaveCount(1, { timeout: 15_000 });
      // 2. Asleep, its wake refused: still asleep, the sentence under its word.
      await expect(asleepCard).toContainText('asleep');
      await expect(asleepCard.locator(`[title="${saidAsleep}"]`)).toHaveCount(1, { timeout: 15_000 });
      seen.cards = { error: (await errorCard.innerText()).replace(/\s+/g, ' '), asleep: (await asleepCard.innerText()).replace(/\s+/g, ' ') };
      await stepShot(page, `${tag}1-cards`);

      // 3. The Dashboard pane's header line: the sentence, cut to the pane, whole in its title.
      if (!newInterface) {
        await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
        const line = page.locator(`[title="${said}"]`).first();
        await expect(line).toBeVisible({ timeout: 60_000 });
        seen.paneLine = await line.innerText();
        expect(String(seen.paneLine).trim()).toBe(said);
        await stepShot(page, '2-pane');
      }

      // 4.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
