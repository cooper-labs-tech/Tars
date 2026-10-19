import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Usage's three tables, five rows a card (the maintainer's request of 18/10, for 2.0.4; frames `Usage · pages · five
 * rows a card`, `· states`, `· narrowest window`, `· notes`). In the classic shell at /usage, and with the new
 * interface on, in the card More opens.
 *
 * Twelve agents, one task each, Agent k's at k times $0.10, on six models, two agents each. Asserted:
 * 1. By agent, five rows, the dearest first (Agent 12 to Agent 08), "1 to 5 of 12", pages 1 to 3, page 1 shown and
 *    previous off;
 * 2. next page: Agent 07 to Agent 03, "6 to 10 of 12"; page 3: Agent 02 and Agent 01, "11 to 12 of 12", next off;
 * 3. a sort (Agent, A to Z) orders every row and starts at page 1: Agent 01 to Agent 05;
 * 4. ten rows a page: Agent 01 to Agent 10, "1 to 10 of 12", pages 1 and 2;
 * 5. the averages page on their own: per agent five rows of twelve, per model five of six, and per model page 2 is
 *    "6 of 6";
 * 6. the choice is remembered per card: the page opened again, the agents table shows ten rows, the averages five;
 * 7. By task lists the twelve tasks as before, with no pager; By agent again pages at ten from page 1;
 * and the pager's arrows are drawn whole (12 px), not squeezed into a small button's padding (red on 421c9534).
 * Red on 94ed3211 (the code before the pager): every row shows and there is no pager.
 * The artefact: values.json with the rows and pagers read at each step, in both shells, and their screenshots.
 */

const H = 3_600_000;
const M = 60_000;
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4'];
const AGENTS = Array.from({ length: 12 }, (_, i) => ({ id: `a${String(i + 1).padStart(2, '0')}`, name: `Agent ${String(i + 1).padStart(2, '0')}`, k: i + 1 }));
const names = (from: number, to: number) => AGENTS.filter((a) => (from <= to ? a.k >= from && a.k <= to : a.k <= from && a.k >= to))
  .sort((a, b) => (from <= to ? a.k - b.k : b.k - a.k)).map((a) => a.name);

/** A home holding the twelve agents, their tasks, and the transcript each task wrote. */
function seed(home: string, newInterface: boolean): void {
  const dir = path.join(home, '.dorothy');
  const project = (name: string) => path.join(home, 'projects', name);
  for (const folder of [dir, project('tars'), project('site')]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(AGENTS.map((a) => ({
    id: a.id, name: a.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project(a.k % 2 ? 'tars' : 'site'),
    skills: [], createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project('tars'), project('site')]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
  // Each model at $1 a million tokens in, so a task's cost is its tokens in.
  fs.writeFileSync(path.join(dir, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: Object.fromEntries(MODELS.map((id) => [id, { id, name: id, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } }])) },
  }));
  fs.writeFileSync(path.join(dir, 'model-catalog.meta.json'), JSON.stringify({ fetchedAt: Date.now() }));

  const now = Date.now();
  const lines: string[] = [];
  for (const a of AGENTS) {
    const where = a.k % 2 ? 'tars' : 'site';
    const model = MODELS[(a.k - 1) % MODELS.length];
    const startedAt = now - 6 * H + a.k * 10 * M;
    const endedAt = startedAt + 5 * M;
    const session = `sess-${a.id}`;
    lines.push(JSON.stringify({ t: 'task', task: {
      id: `${a.id}-1`, agentId: a.id, projectPath: project(where), worktreePath: null, provider: 'claude', model, accountId: null,
      source: 'terminal', requesterAgentId: null, parentTaskId: null, text: `the work of ${a.name}`, startedAt, endedAt, lastAt: endedAt,
      outcome: 'completed', turns: 1, sessionIds: [session],
    } }));
    const file = path.join(home, '.claude', 'projects', project(where).replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      type: 'assistant', requestId: `req_${a.id}`, timestamp: new Date(startedAt + 30_000).toISOString(),
      message: { id: `msg_${a.id}`, model, usage: { input_tokens: a.k * 100_000, output_tokens: 0 } },
    })}\n`);
  }
  fs.writeFileSync(path.join(dir, 'task-ledger.jsonl'), `${lines.join('\n')}\n`);
}

for (const newInterface of [false, true]) {
  test(`usage pages: five rows a card, the pages, a sort across them, the rows choice remembered per card${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-usage-pages-'));
    seed(home, newInterface);
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31507 : 31506), DOROTHY_E2E: '1' },
    });
    const errors: string[] = [];
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });

      // The page, where each shell shows it: the classic one at its route, the new one in the card More opens.
      const open = async (p: Page): Promise<Locator> => {
        if (!newInterface) {
          await p.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
          await expect(p.getByRole('navigation', { name: 'Main menu' })).toHaveCount(0, { timeout: 90_000 });
          await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
          return p.locator('main');
        }
        await p.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = p.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await p.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Usage' }).click();
        return p.getByRole('dialog', { name: 'Usage' });
      };
      let where = await open(page);
      const panel = () => where.locator('[data-tasks-panel]');
      await expect(panel()).toBeVisible({ timeout: 90_000 });
      await expect(panel().locator('[data-task-row]').first()).toBeVisible({ timeout: 60_000 });
      await panel().getByRole('radio', { name: /^By agent/ }).click();

      const agents = () => panel().locator('[data-agent-row] [data-cell="agent"] [data-value]').allTextContents();
      const pager = (name: string) => where.getByRole('navigation', { name: `${name} pages` });
      const read = async (name: string) => {
        const nav = pager(name);
        if ((await nav.count()) === 0) return null;
        const buttons = await nav.getByRole('button', { name: /^Page \d+$/ }).evaluateAll((els) => els.map((el) => ({
          page: el.getAttribute('aria-label'), current: el.getAttribute('aria-current') === 'page' })));
        return { text: (await nav.innerText()).replace(/\s+/g, ' ').trim(), buttons };
      };
      const settle = async (want: string[]) => {
        const until = Date.now() + 5_000;
        let now = (await agents()).map((t) => t.trim());
        while (now.join() !== want.join() && Date.now() < until) {
          await page.waitForTimeout(100);
          now = (await agents()).map((t) => t.trim());
        }
        return now;
      };
      const shot = async (name: string) => stepShot(page, `${tag}${name}`);

      // 1. Five rows, the dearest first, and the pager.
      seen.page1 = { agents: await settle(names(12, 8)), pager: await read('Agents') };
      expect.soft((seen.page1 as { agents: string[] }).agents, 'page 1').toEqual(names(12, 8));
      await expect.soft(pager('Agents'), 'the agents pager').toContainText('1 to 5 of 12');
      await expect.soft(pager('Agents').getByRole('button', { name: 'Page 1' }), 'page 1 shown').toHaveAttribute('aria-current', 'page');
      await expect.soft(pager('Agents').getByRole('button', { name: 'Page 3' }), 'three pages').toBeVisible();
      await expect.soft(pager('Agents').getByRole('button', { name: 'Previous page' }), 'previous off').toBeDisabled();
      // The arrows drawn whole: a padding left on a small button squeezed them into 4 px.
      const arrow = (await pager('Agents').count()) ? await pager('Agents').getByRole('button', { name: 'Next page' }).locator('svg').boundingBox() : null;
      seen.nextArrowWidth = arrow?.width ?? null;
      expect.soft(arrow?.width ?? 0, 'the next arrow is drawn whole').toBeGreaterThanOrEqual(10);
      await shot('01-agents-page-1');

      // 2. The next page, then the last.
      if (await pager('Agents').count()) await pager('Agents').getByRole('button', { name: 'Next page' }).click();
      seen.page2 = { agents: await settle(names(7, 3)), pager: await read('Agents') };
      expect.soft((seen.page2 as { agents: string[] }).agents, 'page 2').toEqual(names(7, 3));
      await expect.soft(pager('Agents'), 'page 2 range').toContainText('6 to 10 of 12');
      if (await pager('Agents').count()) await pager('Agents').getByRole('button', { name: 'Page 3' }).click();
      seen.page3 = { agents: await settle(names(2, 1)), pager: await read('Agents') };
      expect.soft((seen.page3 as { agents: string[] }).agents, 'page 3').toEqual(names(2, 1));
      await expect.soft(pager('Agents'), 'page 3 range').toContainText('11 to 12 of 12');
      await expect.soft(pager('Agents').getByRole('button', { name: 'Next page' }), 'next off').toBeDisabled();
      await shot('02-agents-last-page');

      // 3. A sort orders every row, from page 1.
      await panel().getByRole('columnheader', { name: 'Agent', exact: true }).getByRole('button').click();
      seen.sorted = { agents: await settle(names(1, 5)), pager: await read('Agents') };
      expect.soft((seen.sorted as { agents: string[] }).agents, 'sorted A to Z, page 1').toEqual(names(1, 5));
      await expect.soft(pager('Agents').getByRole('button', { name: 'Page 1' }), 'a sort starts at page 1').toHaveAttribute('aria-current', 'page');

      // 4. Ten rows a page.
      const rowsChoice = (name: string) => where.getByRole('button', { name: `${name} rows per page` });
      if (await rowsChoice('Agents').count()) {
        await rowsChoice('Agents').click();
        await page.getByRole('option', { name: '10 rows' }).click();
      }
      seen.ten = { agents: await settle(names(1, 10)), pager: await read('Agents') };
      expect.soft((seen.ten as { agents: string[] }).agents, 'ten rows').toEqual(names(1, 10));
      await expect.soft(pager('Agents'), 'ten rows range').toContainText('1 to 10 of 12');
      await expect.soft(pager('Agents').getByRole('button', { name: 'Page 3' }), 'two pages at ten').toHaveCount(0);
      await shot('03-agents-ten-rows');

      // 5. The averages, each its own pager.
      const averages = (which: string) => where.locator(`[data-task-averages="${which}"] [data-average-row] [data-cell="name"]`).allTextContents();
      seen.perAgent = { names: await averages('agent'), pager: await read('Average per agent') };
      seen.perModel = { names: await averages('model'), pager: await read('Average per model') };
      expect.soft((seen.perAgent as { names: string[] }).names, 'per agent, five rows').toEqual(names(12, 8));
      await expect.soft(pager('Average per agent'), 'per agent pager').toContainText('1 to 5 of 12');
      expect.soft((seen.perModel as { names: string[] }).names.length, 'per model, five rows').toBe(5);
      await expect.soft(pager('Average per model'), 'per model pager').toContainText('1 to 5 of 6');
      if (await pager('Average per model').count()) await pager('Average per model').getByRole('button', { name: 'Next page' }).click();
      await expect.soft(pager('Average per model'), 'per model page 2').toContainText('6 of 6');
      seen.perModelPage2 = { names: await averages('model') };
      await where.locator('[data-task-averages="agent"]').scrollIntoViewIfNeeded();
      await shot('04-averages');

      // 6. Remembered per card: open the page again.
      where = await open(page);
      await expect(panel()).toBeVisible({ timeout: 90_000 });
      seen.reopened = { agents: await settle(names(12, 3)), agentsPager: await read('Agents'), perAgent: await averages('agent') };
      expect.soft((seen.reopened as { agents: string[] }).agents, 'the agents table remembers ten rows').toEqual(names(12, 3));
      expect.soft((seen.reopened as { perAgent: string[] }).perAgent, 'the averages keep five').toEqual(names(12, 8));

      // 7. By task as before, then By agent again from page 1 at ten.
      await panel().getByRole('radio', { name: /^By task/ }).click();
      await expect.soft(panel().locator('[data-task-row]'), 'by task, the twelve tasks').toHaveCount(12, { timeout: 30_000 });
      await expect.soft(pager('Agents'), 'no agents pager by task').toHaveCount(0);
      await panel().getByRole('radio', { name: /^By agent/ }).click();
      seen.backByAgent = { agents: await settle(names(12, 3)), pager: await read('Agents') };
      expect.soft((seen.backByAgent as { agents: string[] }).agents, 'by agent again, page 1 at ten').toEqual(names(12, 3));
      await shot('05-by-agent-again');

      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      recordValues({ seen, pageErrors: errors });
      await app.close().catch(() => { /* gone */ });
      await removeHome(home);
    }
  });
}
