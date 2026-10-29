import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Resources · disk, on its backend (lot 3, item H, Tars-Backend's janitorScan and janitorApprove, PR 542; frames
 * `Resources (2.0.5) · disk` and `· disk · states`). Red without that backend (PR 539's head).
 *
 * A sandbox where allowed and forbidden items sit side by side: the temporary folder of an agent no longer in the
 * fleet and a stale npx cache entry (allowed); the uv cache, a folder under ~/Documents, one under ~/.tars-private and
 * the temporary folder of an agent of the fleet (never proposed: the agent is in the fleet).
 *
 * How it can fail, written before its backend:
 * 1. the view says it cannot read the janitor although the channel is there, or proposes before a scan;
 * 2. a scan proposes a forbidden item, or misses an allowed one;
 * 3. an item comes without its size, its rule or why;
 * 4. what is never proposed is not said;
 * 5. a scan comes with items ticked; delete goes without asking once, or asked and kept still deletes; an item the
 *    owner did not tick is deleted, or a ticked one is not;
 * 6. a forbidden item is touched;
 * 7. a deletion is not in the log with its bytes;
 * 8. an uncaught error in the page.
 *
 * The artefact: the proposed items, the outcomes and the files left, in values.json; a screenshot of each step.
 * Proven on macOS and Linux (the npx cache path is ~/.npm/_npx there; on Windows it is under %LocalAppData%).
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const DAY = 86_400_000;

function put(file: string, size: number, ageDays = 0): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(file, t, t);
  fs.utimesSync(path.dirname(file), t, t);
}

for (const newInterface of [false, true]) {
  test(`resources, disk: a scan proposes only what the list allows, the owner approves, only what is ticked goes${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-resources-disk-'));
    const dir = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'a-kept-agent', name: 'Kept Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project,
      skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));

    const allowed = {
      goneAgentTmp: path.join(dir, 'tmp', 'deadbeef00'),
      staleNpx: path.join(home, '.npm', '_npx', '0a1b2c3d4e5f'),
    };
    const forbidden = {
      uv: path.join(home, '.cache', 'uv'),
      documents: path.join(home, 'Documents', 'proof', 'test-results'),
      privateDir: path.join(home, '.tars-private', 'keep'),
    };
    // Fresh: a boot's own retention of the temporary folders weighs the oldest first.
    put(path.join(allowed.goneAgentTmp, 't', 'blob.bin'), 2 * 1024 * 1024, 0);
    const fleetTmp = path.join(dir, 'tmp', createHash('sha256').update('a-kept-agent').digest('hex').slice(0, 10));
    put(path.join(fleetTmp, 't', 'blob.bin'), 1024 * 1024, 0);
    put(path.join(allowed.staleNpx, 'node_modules', 'pkg', 'index.js'), 1024 * 1024, 30);
    // The whole entry is stale: its folders too, which npx touches when it writes in them and the rule reads
    // (the QA's F7 of the final verification: only the file and its own folder were aged, so it read as in use).
    for (const d of [path.join(allowed.staleNpx, 'node_modules'), allowed.staleNpx]) {
      const t = (Date.now() - 30 * DAY) / 1000;
      fs.utimesSync(d, t, t);
    }
    put(path.join(forbidden.uv, 'archive', 'blob.bin'), 1024 * 1024, 60);
    put(path.join(forbidden.documents, 'trace.zip'), 1024 * 1024, 60);
    put(path.join(forbidden.privateDir, 'blob.bin'), 1024, 60);
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31562 : 31561), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      let where;
      if (!newInterface) {
        await page.goto(`${DEV_URL}/resources?view=disk`, { waitUntil: 'domcontentloaded' });
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
        await where.getByRole('radiogroup', { name: 'Resources view' }).getByRole('radio', { name: 'Disk' }).click();
      }
      const view = where.getByRole('region', { name: 'Disk' });
      // Exact: a region's name is matched as a substring, and 'Never proposed' holds it.
      const proposed = view.getByRole('region', { name: 'Proposed', exact: true });

      // 1. Read, and nothing proposed before a scan; 4. the never list said.
      await expect(proposed.getByRole('button', { name: 'scan' })).toBeVisible({ timeout: 60_000 });
      await expect(view.getByRole('alert')).toHaveCount(0);
      expect(await proposed.locator('[data-item]').count()).toBe(0);
      const never = await view.getByRole('region', { name: 'Never proposed' }).innerText();
      seen.never = never;
      expect(never).toMatch(/uv cache/i);
      expect(never).toMatch(/Documents/);
      expect(never).toMatch(/uncommitted/i);
      await stepShot(page, `${tag}1-no-scan`);

      // 2, 3. A scan: the allowed proposed, with size, rule and why; nothing forbidden.
      await proposed.getByRole('button', { name: 'scan' }).click();
      // The scan streams its items: the list is read once it has ended (its note and scan again), never at the first
      // item (the QA's F1 on PR 543: one item read, the npx cache still to come).
      await expect(proposed.getByRole('button', { name: 'scan again' })).toBeVisible({ timeout: 120_000 });
      await expect(proposed).toContainText('a scan deletes nothing');
      await expect(proposed).not.toContainText('SCANNING');
      await expect(proposed.locator('[data-item]').first()).toBeVisible();
      const items = await proposed.locator('[data-item]').evaluateAll((els) => els.map((e) => ({ path: e.getAttribute('data-item'), text: (e as HTMLElement).innerText })));
      seen.proposed = items;
      // The backend may name a folder by its real path (/private/var on macOS for a sandbox under /var).
      const same = (a: string | null, p: string) => a === p || a === fs.realpathSync(p);
      const has = (p: string) => items.some((i) => same(i.path, p));
      expect(has(allowed.goneAgentTmp)).toBe(true);
      expect(has(allowed.staleNpx)).toBe(true);
      for (const i of items) {
        expect(i.path).not.toContain(`${path.sep}.cache${path.sep}uv`);
        expect(i.path).not.toContain(`${path.sep}Documents${path.sep}`);
        expect(i.path).not.toContain('.tars-private');
        expect(same(i.path, fleetTmp)).toBe(false);
        expect(i.text).toMatch(/\d+ (MB|GB|B)/);
      }
      expect(await proposed.locator('[data-rule]').count()).toBeGreaterThan(0);
      await stepShot(page, `${tag}2-proposed`);

      // 5. Nothing comes ticked; the owner ticks the gone agent's folder; delete asks once, keep keeps everything.
      expect(await proposed.getByRole('checkbox', { checked: true }).count(), 'a scan comes unticked').toBe(0);
      const tmpItem = proposed.locator('[data-item]').filter({ hasText: path.basename(allowed.goneAgentTmp) });
      await tmpItem.getByRole('checkbox').click();
      await expect(tmpItem.getByRole('checkbox')).toBeChecked();
      seen.tickedBoxes = await proposed.getByRole('checkbox', { checked: true }).count();
      await proposed.getByRole('button', { name: 'delete 1 item', exact: true }).click();
      const confirm = proposed.getByRole('alertdialog', { name: 'Delete the ticked items' });
      await expect(confirm).toContainText('this cannot be undone');
      await confirm.getByRole('button', { name: 'keep', exact: true }).click();
      await expect(confirm).toHaveCount(0);
      expect(fs.existsSync(allowed.goneAgentTmp), 'keep deletes nothing').toBe(true);
      await proposed.getByRole('button', { name: 'delete 1 item', exact: true }).click();
      await stepShot(page, `${tag}2b-delete-asks`);
      await proposed.getByRole('alertdialog', { name: 'Delete the ticked items' }).getByRole('button', { name: 'delete them', exact: true }).click();
      await expect(tmpItem).toContainText(/deleted · .* freed/, { timeout: 120_000 });
      seen.after = {
        goneAgentTmp: fs.existsSync(allowed.goneAgentTmp),
        staleNpx: fs.existsSync(allowed.staleNpx),
        uv: fs.existsSync(forbidden.uv), documents: fs.existsSync(forbidden.documents), privateDir: fs.existsSync(forbidden.privateDir), fleetTmp: fs.existsSync(fleetTmp),
      };
      expect(fs.existsSync(allowed.goneAgentTmp)).toBe(false);
      expect(fs.existsSync(allowed.staleNpx)).toBe(true);
      // 6.
      for (const p of [...Object.values(forbidden), fleetTmp]) expect(fs.existsSync(p)).toBe(true);

      // 7. In the log, with its bytes.
      const log = view.getByRole('region', { name: 'Freed' });
      await expect(log).toContainText(path.basename(allowed.goneAgentTmp), { timeout: 30_000 });
      seen.log = await log.innerText();
      await stepShot(page, `${tag}3-deleted`);

      // 8.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
