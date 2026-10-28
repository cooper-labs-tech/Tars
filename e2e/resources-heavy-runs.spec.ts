import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Resources · heavy runs, on its backend (lot 2, item A, Tars-Backend's `heavySlot` channel, PR 537; frames
 * `Resources (2.0.5) · heavy runs` and `· heavy runs · states`). Red without that backend (PR 535's head with the page alone).
 *
 * How it can fail, written before its backend:
 * 1. the view says it cannot read the slot although the channel is there;
 * 2. with nobody holding it and nothing waiting, it does not say so;
 * 3. the machine's memory, swap or load say "not read" on a platform that reads them (macOS and Linux), or the free
 *    disk differs from system.disk's by more than half a gigabyte;
 * 4. the slots and the floors shown are not the settings' (defaults: 1 slot, 15 GB free disk, 20 % free memory);
 * 5. a holder is not shown with its agent, its project and what it runs, or its label shows a secret it was given;
 * 6. a waiter is not shown behind it;
 * 7. give back goes without asking once; asked and kept, it gives back; given back, the holder stays, the waiter is not
 *    granted, or the day's alerts do not say it;
 * 8. an uncaught error in the page.
 * Two agents of two projects, whose CLI is a stand-in that asks for the slot with its own pid as the backend's spec
 * (heavy-run-slot.spec.ts) does: macOS and Linux (the stand-ins post to the API; Windows is the backend's to drive).
 *
 * The artefact: what the view showed, in values.json, and a screenshot.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const SECRET = 'sk-ant-api03-E2Esecretvalue1234567890';

/** A stand-in CLI that asks for the slot with its own pid and a label, and holds it while it lives. */
function asker(home: string, id: string, label: string): string {
  const cli = path.join(home, `cli-${id}.cjs`);
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const crypto = require('crypto'); const session = crypto.randomUUID();",
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "(async () => {",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    `  await post('/api/heavy-slot/ask', { pid: process.pid, label: ${JSON.stringify(label)} });`,
    "})();",
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  return cli;
}

for (const newInterface of [false, true]) {
  test(`resources, heavy runs: the machine read, the slot free, the slots and floors of the settings${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-resources-heavy-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const harbor = path.join(home, 'projects', 'harbor');
    const meridian = path.join(home, 'projects', 'meridian');
    for (const p of [harbor, meridian]) fs.mkdirSync(p, { recursive: true });
    const agent = (id: string, name: string, project: string, cli: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [], cliPath: cli,
      createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('h', 'Harbor Runner', harbor, asker(home, 'h', `curl -H "Authorization: Bearer ${SECRET}" https://ci.example.com && npm run e2e`)),
      agent('m', 'Meridian Builder', meridian, asker(home, 'm', 'next build')),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([harbor, meridian]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31564 : 31563), DOROTHY_E2E: '1', DOROTHY_HEALTH_EVERY_MS: '500' },
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
      const slot = view.getByRole('region', { name: 'The slot' });

      // 1, 2.
      await expect(slot).toContainText('Nobody holds the slot and nothing waits', { timeout: 60_000 });
      await expect(slot.getByRole('alert')).toHaveCount(0);

      // 3. The machine.
      const card = (c: string) => view.locator(`[data-resource-card="${c}"] [data-value]`);
      const values: Record<string, string> = {};
      // The machine is read with the health samples, every 500 ms here: the first reading comes within seconds.
      if (process.platform !== 'win32') await expect(card('FREE MEMORY')).not.toHaveText('not read', { timeout: 30_000 });
      for (const c of ['FREE MEMORY', 'SWAP', 'FREE DISK', 'LOAD']) values[c] = (await card(c).innerText()).trim();
      seen.cards = values;
      if (process.platform !== 'win32') for (const c of ['FREE MEMORY', 'SWAP']) expect(values[c]).not.toBe('not read');
      if (process.platform !== 'win32') expect(values.LOAD).toMatch(/^\d+\.\d$/);
      const disk = await page.evaluate(() => window.electronAPI!.system.disk());
      expect(Math.abs(Number.parseFloat(values['FREE DISK']) - disk!.freeBytes / 1e9)).toBeLessThan(0.5);

      // 4. The settings' slots and floors.
      const floors = view.getByRole('region', { name: 'Slots and floors' });
      const text = (await floors.innerText()).replace(/\s+/g, ' ');
      seen.floors = text;
      expect(text).toContain('Slots for the whole machine 1');
      expect(text).toContain('15 GB free disk');
      expect(text).toContain('20 % free memory');
      await stepShot(page, `${tag}1-heavy-runs`);

      if (process.platform !== 'win32') {
        // 5, 6. Harbor Runner takes the slot, Meridian Builder waits behind it.
        const start = (id: string) => page.evaluate((i) => window.electronAPI!.agent!.start({ id: i, prompt: '' } as never), id);
        await start('h');
        const holder = slot.locator('[data-holder="Harbor Runner"]');
        await expect(holder).toBeVisible({ timeout: 60_000 });
        await start('m');
        await expect(slot.locator('[data-waiter="Meridian Builder"]')).toBeVisible({ timeout: 60_000 });
        const label = await holder.locator('[data-label]').innerText();
        seen.holder = { text: (await holder.innerText()).replace(/\s+/g, ' '), label };
        await expect(holder).toContainText('harbor');
        expect(label).toContain('npm run e2e');
        expect(label).not.toContain(SECRET);
        await stepShot(page, `${tag}2-held-and-waiting`);

        // 7. Give back asks once; keep keeps it; give it back frees it for the waiter, and the alerts say it.
        await holder.getByRole('button', { name: 'give back' }).click();
        await expect(holder).toContainText('Give the slot back?');
        await holder.getByRole('button', { name: 'keep' }).click();
        await expect(holder).not.toContainText('Give the slot back?');
        await expect(holder).toBeVisible();
        await holder.getByRole('button', { name: 'give back' }).click();
        await holder.getByRole('button', { name: 'give it back' }).click();
        await expect(slot.locator('[data-holder="Meridian Builder"]')).toBeVisible({ timeout: 30_000 });
        await expect(slot.locator('[data-holder="Harbor Runner"]')).toHaveCount(0);
        const alerts = view.getByRole('region', { name: 'Alerts' });
        await expect(alerts.locator('[data-alert]').filter({ hasText: /given back/i })).toHaveCount(1, { timeout: 30_000 });
        seen.alerts = await alerts.innerText();
        expect(String(seen.alerts)).not.toContain(SECRET);
        await stepShot(page, `${tag}3-given-back`);
      }

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
