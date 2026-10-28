import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The checkpoint line in an agent's Dashboard terminal header, and nowhere on its card (JeanBrasse, 22/10), on
 * #513's checkpoint (POST /api/agents/:id/checkpoint with the agent's own token, carried by the agents tick).
 * Frame: `Checkpoint (2.0.5) · the line in the Dashboard terminal header`.
 *
 * In the shell as it was and in the new interface: a worker writes a line; its panel's header shows it under its
 * row with "now", whole in its title, and the lead's panel, with none written, has no such line. A second, 120
 * characters long, replaces it and is cut to the panel, its title whole. The Agents page card shows neither.
 * Red on #513's head (c01b773d): no line in the header.
 *
 * The artefact: what each header and card showed, in values.json, and a screenshot of each step.
 */

const FIRST = 'tests pass on macOS, the Windows run is next';
const LONG = `matrix 70 of 72 green, the two reds are gemini behind gemini and amp with no hooks, both known and filed, ok ${'x'.repeat(8)}`.slice(0, 120);

for (const newInterface of [false, true]) {
  test(`an agent's checkpoint shows in its dashboard terminal header, not on its card${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(150_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-checkpoint-header-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
      createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('w', 'Writer', 'worker')]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(newInterface ? 31548 : 31547);
    const dist = path.resolve('electron', 'dist');
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      const token = await app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/core/agent-tokens.js`).mintRunToken('w').token as string, { dist });
      const write = async (line: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/agents/w/checkpoint`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'w' }, body: JSON.stringify({ line }),
        });
        expect(res.status, await res.clone().text()).toBe(200);
      };
      const panel = (id: string) => page.locator(`[data-agent-panel="${id}"]`);
      const ckpt = panel('w').locator('[data-checkpoint]');
      await expect(panel('w')).toBeVisible({ timeout: 90_000 });
      await expect(ckpt).toHaveCount(0);

      // A first line: under the header's row, with now, whole in its title; none on the lead's panel.
      await write(FIRST);
      await expect(ckpt).toContainText(FIRST, { timeout: 15_000 });
      await expect(ckpt).toContainText('now');
      await expect(ckpt.locator(`[title="${FIRST}"]`)).toHaveCount(1);
      await expect(panel('lead').locator('[data-checkpoint]')).toHaveCount(0);
      seen.first = await ckpt.innerText();
      await stepShot(page, `${tag}-01-checkpoint`);

      // A 120-character line replaces it, cut to the panel, whole in its title.
      await write(LONG);
      const text = ckpt.locator(`[title="${LONG}"]`);
      await expect(text).toHaveCount(1, { timeout: 15_000 });
      seen.long = await text.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect((seen.long as { scrollWidth: number }).scrollWidth, 'cut to the panel').toBeGreaterThan((seen.long as { clientWidth: number }).clientWidth);
      await stepShot(page, `${tag}-02-long`);

      // The Agents page card shows no checkpoint.
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      const card = page.locator('[data-agent-card="w"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).not.toContainText('matrix 70 of 72');
      await expect(card).not.toContainText(FIRST);
      seen.card = (await card.innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${tag}-03-card`);
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
