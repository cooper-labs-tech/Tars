import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Resources · Heavy runs says the machine's terminals (2.0.6, item 1; frames `Resources (2.0.6) · heavy runs,
 * terminals left` and `· terminals left · states`), on #553's FleetResources.terminals.
 *
 * How it can fail, written before the window's change:
 * 1. Heavy runs has no TERMINALS figure beside free memory, swap, free disk and load;
 * 2. its figure is not the machine's count in use that the resources channel gives, or its line does not name the
 *    limit and the terminals Tars holds;
 * 3. under 80 % of the limit a notice about terminals shows anyway;
 * 4. on Windows (no pool, null) it reads anything but "not counted";
 * 5. an uncaught error in the page.
 * Near full, full and a leak cannot be made on a test machine without filling its real pool: their words and tones
 * are the unit's (__tests__/lib/terminals.test.ts), on the same module this figure draws with.
 * Red on #553's head (fab678b90) before the window's change: no TERMINALS figure. Once with the classic shell and once
 * with the new interface. The artefact: values.json (the channel's terminals and the figure as read), screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

for (const newInterface of [false, true]) {
  test(`resources, heavy runs: the machine's terminals, in use of the limit, with the ones Tars holds${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-resources-terminals-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31580 : 31579), DOROTHY_E2E: '1', DOROTHY_HEALTH_EVERY_MS: '500' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      let where;
      if (!newInterface) {
        await page.goto(`${DEV_URL}/resources`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
        where = page.locator('main');
      } else {
        await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Resources' }).click();
        where = page.getByRole('dialog', { name: 'Resources' });
      }
      const view = where.getByRole('region', { name: 'Heavy runs' });

      // 1. The fifth figure.
      const card = view.locator('[data-resource-card="TERMINALS"]');
      await expect(card).toBeVisible({ timeout: 60_000 });

      // 2, 4. The channel's terminals, and the figure drawn from them (re-read until both agree: the count moves).
      type Terminals = { inUse: number; max: number; tars: number | null; open?: number; nearFull: boolean } | null;
      const read = () => page.evaluate(async () =>
        ((await (window.electronAPI as unknown as { resources: { read(): Promise<{ terminals?: Terminals }> } }).resources.read()).terminals ?? null) as Terminals);
      const value = card.locator('[data-value]');
      let terminals: Terminals = null;
      await expect.poll(async () => { terminals = await read(); return (await value.innerText()).trim() === (terminals ? String(terminals.inUse) : 'not counted'); }, { timeout: 30_000 }).toBe(true);
      const text = (await card.innerText()).replace(/\s+/g, ' ');
      seen.terminals = terminals;
      seen.card = text;
      if (process.platform === 'win32') {
        expect(text).toContain('not counted');
        expect(text).toContain('No shared pool on Windows');
      } else {
        expect(terminals).not.toBeNull();
        const t = terminals!;
        expect(text).toContain(`of ${t.max} on this machine`);
        if (t.tars !== null) expect(text).toContain(`Tars holds ${t.tars}`);
        // 3. Under 80 %, no notice of terminals.
        if (!t.nearFull) await expect(view.locator('[data-terminals-notice]')).toHaveCount(0);
      }
      await stepShot(page, `${newInterface ? 'new-' : ''}1-terminals`);

      // 5.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
