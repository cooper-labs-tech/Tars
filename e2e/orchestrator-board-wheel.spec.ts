import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * On the Dashboard's orchestrator layout, a sub-agent's terminal takes the wheel only once it has been clicked (the
 * owner, 28/10: scrolling the sub-agents' column stopped over any agent at work, its CLI took the wheel). Until then
 * the wheel over it scrolls the column. The orchestrator's terminal takes the wheel without a click, as before.
 *
 * One project: its orchestrator and four agents, each on a stand-in CLI that prints 300 numbered lines, then a line
 * every 200 ms, so every terminal has history to scroll and the sub-agents are at work. In the shell as it was and
 * with the new interface on, at 1440 by 900:
 * 1. before any click, the wheel over the first sub-agent's terminal scrolls the column, down then up, and no
 *    sub-agent's terminal moves;
 * 2. a click on that terminal, then the wheel over it, scrolls its terminal back, and the column stays;
 * 3. its terminal stays where the wheel left it while its output goes on (xterm's own scroll lock);
 * 4. the wheel over the orchestrator's terminal, never clicked, scrolls it;
 * 5. that click on the orchestrator ends the sub-agent's hold: the wheel over the sub-agent scrolls the column again.
 * Red on main (dc623b59): step 1, the wheel over a sub-agent's terminal scrolls that terminal.
 *
 * The artefact: the column's and every viewport's scroll after each step, in values.json, and a screenshot of each.
 */

const AGENTS = ['Lead', 'Frontend Engineer', 'Backend Engineer', 'QA Engineer', 'Docs Writer'];
const ids = AGENTS.map((_, i) => `w-${i}`);

function seed(home: string, newInterface: boolean): void {
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'projects', 'tars');
  for (const d of [dir, project]) fs.mkdirSync(d, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'busy-cli.cjs'), [
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    "let n = 0;",
    "const line = () => process.stdout.write('line ' + (++n) + ' of ' + process.env.CLAUDE_AGENT_ID + '\\r\\n');",
    "for (let i = 0; i < 300; i++) line();",
    "setInterval(line, 200);",
    "process.stdin.resume();",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(AGENTS.map((name, i) => ({
    id: ids[i], name, character: i === 0 ? 'wizard' : 'robot', provider: 'claude', status: 'idle',
    role: i === 0 ? 'orchestrator' : 'worker', projectPath: project, cliPath: cli,
    skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
}

/** Where a terminal's viewport is scrolled to, from the top of its history. */
const viewportOf = (page: Page, id: string) => page.locator(`[data-agent-panel="${id}"] .xterm-viewport`).evaluate((el) => Math.round(el.scrollTop));
const viewports = async (page: Page) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await viewportOf(page, id)] as const)));
/** The middle of a terminal's screen, where a person's pointer sits to scroll it. */
const middle = async (screen: Locator) => { const b = (await screen.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

for (const newInterface of [false, true]) {
  test(`on the orchestrator layout a sub-agent's terminal takes the wheel only once clicked, the orchestrator's always${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orch-wheel-'));
    seed(home, newInterface);
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31554 : 31553), DOROTHY_E2E: '1' },
    });
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-board-layout="orchestrator"]')).toBeVisible({ timeout: 90_000 });
      const column = page.locator('[data-board-column]');
      const columnTop = () => column.evaluate((el) => Math.round(el.scrollTop));
      const sub = ids[1];
      const subScreen = page.locator(`[data-agent-panel="${sub}"] .xterm-screen`);
      const leadScreen = page.locator(`[data-agent-panel="${ids[0]}"] .xterm-screen`);
      // Every terminal has history: its viewport is scrolled away from the top, to its last line.
      for (const id of ids.slice(0, 2)) {
        await expect.poll(() => viewportOf(page, id), { timeout: 60_000 }).toBeGreaterThan(200);
      }
      expect(await column.evaluate((el) => el.scrollHeight > el.clientHeight), 'the column scrolls').toBe(true);
      await stepShot(page, `${tag}-01-board`);

      // 1. Before any click: the wheel over the first sub-agent's terminal scrolls the column, and no terminal moves.
      const at = await middle(subScreen);
      await page.mouse.move(at.x, at.y);
      const before1 = await viewports(page);
      await page.mouse.wheel(0, 150);
      await expect.poll(columnTop, { timeout: 5_000 }).toBeGreaterThan(0);
      const down = await columnTop();
      await page.mouse.wheel(0, -150);
      await expect.poll(columnTop, { timeout: 5_000 }).toBeLessThan(down);
      await page.waitForTimeout(300);
      const after1 = await viewports(page);
      seen.step1 = { before: before1, after: after1, columnDown: down, columnBack: await columnTop() };
      for (const id of ids.slice(1)) {
        // A sub-agent at work only ever moves down, to its new last line; the wheel up would have moved it up.
        expect(after1[id], `${id}'s terminal did not scroll back`).toBeGreaterThanOrEqual(before1[id]);
      }
      await stepShot(page, `${tag}-02-column-scrolled`);

      // 2. A click on that terminal: now the wheel over it scrolls it, and the column stays.
      const at2 = await middle(subScreen);
      await page.mouse.click(at2.x, at2.y);
      const column2 = await columnTop();
      const sub2 = await viewportOf(page, sub);
      await page.mouse.wheel(0, -400);
      await expect.poll(() => viewportOf(page, sub), { timeout: 5_000 }).toBeLessThan(sub2);
      // xterm snaps its viewport to a whole row once the wheel stops (5 px seen on 28/10): read it settled.
      await page.waitForTimeout(500);
      const sub2after = await viewportOf(page, sub);
      expect(await columnTop(), 'the column stays').toBe(column2);
      seen.step2 = { columnBefore: column2, terminalBefore: sub2, terminalAfter: sub2after };
      await stepShot(page, `${tag}-03-terminal-scrolled`);

      // 3. Its output goes on, and it stays where the wheel left it.
      await page.waitForTimeout(1_500);
      const sub3 = await viewportOf(page, sub);
      seen.step3 = { held: sub3, wheelLeftAt: sub2after };
      expect(sub3, 'scroll lock: the terminal stays where the wheel left it').toBe(sub2after);

      // 4. The orchestrator's terminal, never clicked, takes the wheel.
      const lead = await middle(leadScreen);
      await page.mouse.move(lead.x, lead.y);
      const lead4 = await viewportOf(page, ids[0]);
      await page.mouse.wheel(0, -400);
      await expect.poll(() => viewportOf(page, ids[0]), { timeout: 5_000 }).toBeLessThan(lead4);
      seen.step4 = { before: lead4, after: await viewportOf(page, ids[0]) };

      // 5. A click on the orchestrator ends the sub-agent's hold: the wheel over it scrolls the column again.
      await page.mouse.click(lead.x, lead.y);
      const at5 = await middle(subScreen);
      await page.mouse.move(at5.x, at5.y);
      const sub5 = await viewportOf(page, sub);
      const column5 = await columnTop();
      await page.mouse.wheel(0, 150);
      await expect.poll(columnTop, { timeout: 5_000 }).toBeGreaterThan(column5);
      expect(await viewportOf(page, sub), 'the released terminal did not scroll').toBe(sub5);
      seen.step5 = { columnBefore: column5, columnAfter: await columnTop(), terminal: sub5 };
      await stepShot(page, `${tag}-04-released`);
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
