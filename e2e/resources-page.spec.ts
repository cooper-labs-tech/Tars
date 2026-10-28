import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Resources page (2.0.5, lots 2 and 3 of the resources plan; frames `Resources (2.0.5) · heavy runs`, `· agents
 * and projects`, `· disk`, their narrowest windows and states, design PR 535): its place, its header, its three views,
 * and what each view says before its backend is there.
 *
 * How it can fail, written before the page:
 * 1. no Resources entry, or one out of place: it sits between Usage and Brain, in the classic sidebar and in the new
 *    interface's More;
 * 2. the page does not open, or opens on a view other than Heavy runs;
 * 3. the views do not switch, or ?view= does not open the one it names;
 * 4. the free disk card says a figure the machine did not give: it must be system.disk's free space;
 * 5. a figure Tars cannot read yet (memory, swap, load before the slot's backend, PR 537, or its first reading) shows
 *    a number instead of saying it is not read;
 * 6. a view whose backend is missing shows an empty list as if there were nothing, instead of saying it cannot read
 *    it; or a view whose backend is there says it cannot;
 * 7. at the narrowest window (1200 by 800) the page scrolls sideways;
 * 8. an uncaught error in the page.
 * Red on PR 537's head with PR 535 merged in (2ad8632ea): no Resources entry, no /resources.
 *
 * The artefact: what each view showed, in values.json, and a screenshot of each.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const VIEWS = ['Heavy runs', 'Agents and projects', 'Disk'] as const;

for (const newInterface of [false, true]) {
  test(`the resources page: its entry between usage and brain, its three views, the free disk, what it cannot read yet${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-resources-page-'));
    const dir = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31558 : 31557), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });

      // 1. The entry, between Usage and Brain; 2. the page opens on Heavy runs.
      const open = async (p: Page): Promise<Locator> => {
        if (!newInterface) {
          await p.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
          // The classic sidebar's nav has no name: the one that links to Usage.
          const nav = p.getByRole('navigation').filter({ has: p.getByRole('link', { name: /^Usage/ }) }).first();
          await expect(nav).toBeVisible({ timeout: 90_000 });
          await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
          const labels = (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
          seen.entries = labels;
          const at = labels.indexOf('Resources');
          expect(at).toBeGreaterThan(0);
          expect(labels[at - 1]).toBe('Usage');
          expect(labels[at + 1]).toBe('Brain');
          await nav.getByRole('link', { name: /^Resources/ }).click();
          await expect(p).toHaveURL(/\/resources/);
          return p.locator('main');
        }
        await p.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = p.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        const more = p.getByRole('menu', { name: 'More' });
        const labels = (await more.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
        seen.entries = labels;
        const at = labels.indexOf('Resources');
        expect(at).toBeGreaterThan(0);
        expect(labels[at - 1]).toBe('Usage');
        expect(labels[at + 1]).toBe('Brain');
        await more.getByRole('menuitem', { name: 'Resources' }).click();
        return p.getByRole('dialog', { name: 'Resources' });
      };
      const where = await open(page);
      const views = where.getByRole('radiogroup', { name: 'Resources view' });
      await expect(views).toBeVisible({ timeout: 90_000 });
      for (const v of VIEWS) await expect(views.getByRole('radio', { name: v })).toBeVisible();
      await expect(views.getByRole('radio', { name: 'Heavy runs' })).toBeChecked();

      // 4. The free disk is the machine's own; 5. what is not read says so.
      const disk = await page.evaluate(() => window.electronAPI!.system.disk());
      const card = (caption: string) => where.locator(`[data-resource-card="${caption}"]`);
      await expect(card('FREE DISK').locator('[data-value]')).toHaveText(/GB$/, { timeout: 30_000 });
      const shownFree = await card('FREE DISK').locator('[data-value]').innerText();
      seen.diskFree = { shown: shownFree, freeBytes: disk?.freeBytes ?? null };
      expect(disk).not.toBeNull();
      expect(Math.abs(Number.parseFloat(shownFree) - disk!.freeBytes / 1024 ** 3)).toBeLessThan(0.2);
      const hasSlot = await page.evaluate(() => Boolean((window.electronAPI as unknown as { heavySlot?: unknown }).heavySlot));
      seen.backends = { heavySlot: hasSlot };
      for (const caption of ['FREE MEMORY', 'SWAP', 'LOAD']) {
        const value = (await card(caption).locator('[data-value]').innerText()).trim();
        seen.cards = { ...(seen.cards as Record<string, string> | undefined), [caption]: value };
        if (!hasSlot) expect(value).toBe('not read');
        else expect(value).toMatch(/^(not read|\d+(\.\d)? (MB|GB)|\d+\.\d)$/);
      }
      // 6. The slot, as its backend gives it, or said unreadable.
      const slot = where.getByRole('region', { name: 'The slot' });
      if (!hasSlot) await expect(slot.getByRole('alert')).toContainText('cannot read the heavy-run slot');
      else await expect(slot.getByRole('alert')).toHaveCount(0);
      await stepShot(page, `${tag}1-heavy-runs`);

      // 3. The other views, and what each says without its backend.
      const backends: Record<string, string> = { 'Agents and projects': 'resources', Disk: 'diskJanitor' };
      for (const v of ['Agents and projects', 'Disk'] as const) {
        await views.getByRole('radio', { name: v }).click();
        await expect(views.getByRole('radio', { name: v })).toBeChecked();
        const region = where.getByRole('region', { name: v });
        await expect(region).toBeVisible({ timeout: 30_000 });
        const has = await page.evaluate((k) => Boolean((window.electronAPI as unknown as Record<string, unknown>)[k]), backends[v]);
        (seen.backends as Record<string, boolean>)[backends[v]] = has;
        if (!has) await expect(region.getByRole('alert')).toContainText('cannot read');
        else await expect(region.getByRole('alert')).toHaveCount(0);
        await stepShot(page, `${tag}2-${v.toLowerCase().replace(/ /g, '-')}`);
      }

      // 3. ?view= opens the view it names (the classic shell, where the page has a route).
      if (!newInterface) {
        await page.goto(`${DEV_URL}/resources?view=disk`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('radiogroup', { name: 'Resources view' }).getByRole('radio', { name: 'Disk' })).toBeChecked({ timeout: 90_000 });
      }

      // 7. The narrowest window does not scroll sideways.
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      seen.sidewaysAt1200 = overflow;
      expect(overflow).toBeLessThanOrEqual(0);
      await stepShot(page, `${tag}3-narrowest`);

      // 8. No uncaught error.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
