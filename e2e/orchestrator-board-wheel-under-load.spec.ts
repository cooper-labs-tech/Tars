import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A terminal following its agent's output, scrolled up by the wheel, stays where the wheel left it while the output
 * goes on, also when the window is slow: orchestrator-board-wheel.spec.ts's steps 2 and 3, on a renderer whose CPU is
 * throttled.
 *
 * QA, 22/11 (reports/qa-scroll-lock-under-load.md): step 3 failed four times on 21 and 22/11, under load only, on trees
 * of main and of the stacks alike. The wheel moved the sub-agent's terminal up (step 2 saw it), then within 500 ms it
 * stood lower than where the wheel had started and went on following the output (4455, then 4500, then 4620). At load 3
 * to 6 it passed. Here the renderer's CPU is throttled (CDP Emulation.setCPUThrottlingRate, E2E_CPU_RATE, 12 unless
 * given), so the window is as slow as under that load on any machine. At 6 it held in 10 tests of 10; at 12 the same
 * jump came back at load 3 (4425, then 4515, then 4740).
 *
 * The same project as orchestrator-board-wheel: its orchestrator and four agents, each on a stand-in that prints 300
 * numbered lines, then one every E2E_LINE_MS (200 unless given, as there). In the shell as it was and with the new
 * interface on, at 1440 by 900, the first sub-agent's terminal is clicked (it then takes the wheel), and,
 * E2E_WHEEL_ROUNDS times (5 unless given):
 * 0. it is taken down to its last line, and it follows the output again (where the jump starts: a terminal
 *    already scrolled up has nothing to lose);
 * 1. the wheel goes up 400 over it, and its viewport is seen above where it stood (the wheel moved it);
 * 2. 1 s later (xterm snaps the viewport to a whole row once the wheel stops), it is still above where the wheel
 *    started;
 * 3. 3 s of output later, it has not moved down by more than two rows. Following the output, it moves down by every
 *    line written in between.
 * Red on main (58f2863b4): reports/qa-scroll-lock-under-load.md gives the count.
 *
 * The artefact: each round's viewports and the row height in values.json, a screenshot after each round, the app's trace
 * with E2E_TRACE=on. Re-run: `E2E_TRACE=on npx playwright test e2e/orchestrator-board-wheel-under-load.spec.ts --repeat-each=5`.
 */

const AGENTS = ['Lead', 'Frontend Engineer', 'Backend Engineer', 'QA Engineer', 'Docs Writer'];
const ids = AGENTS.map((_, i) => `w-${i}`);
const RATE = Number(process.env.E2E_CPU_RATE ?? 12);
const ROUNDS = Number(process.env.E2E_WHEEL_ROUNDS ?? 5);
const LINE_MS = Number(process.env.E2E_LINE_MS ?? 200);

function seed(home: string, newInterface: boolean): void {
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'projects', 'tars');
  for (const d of [dir, project]) fs.mkdirSync(d, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'busy-cli.cjs'), [
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    "let n = 0;",
    "const line = () => process.stdout.write('line ' + (++n) + ' of ' + process.env.CLAUDE_AGENT_ID + '\\r\\n');",
    "for (let i = 0; i < 300; i++) line();",
    `setInterval(line, ${LINE_MS});`,
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

/** Where a terminal's viewport is scrolled to, from the top of its history, and how far that is from its last line. */
const viewportOf = (page: Page, id: string) => page.locator(`[data-agent-panel="${id}"] .xterm-viewport`).evaluate((el) => Math.round(el.scrollTop));
const fromBottom = (page: Page, id: string) => page.locator(`[data-agent-panel="${id}"] .xterm-viewport`).evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));

for (const newInterface of [false, true]) {
  test(`a terminal following its output, scrolled up by the wheel, stays there while the output goes on, the renderer slowed ${RATE} times${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orch-wheel-load-'));
    seed(home, newInterface);
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31586 : 31585), DOROTHY_E2E: '1' },
    });
    const seen: Record<string, unknown> = { newInterface, rate: RATE, rounds: ROUNDS, lineMs: LINE_MS };
    const tag = newInterface ? 'new' : 'old';
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-board-layout="orchestrator"]')).toBeVisible({ timeout: 90_000 });
      const sub = ids[1];
      const subScreen = page.locator(`[data-agent-panel="${sub}"] .xterm-screen`);
      await expect.poll(() => viewportOf(page, sub), { timeout: 60_000 }).toBeGreaterThan(200);
      const rowHeight = await page.locator(`[data-agent-panel="${sub}"] .xterm-rows > div`).first().evaluate((el) => el.getBoundingClientRect().height);
      seen.rowHeight = rowHeight;

      // The window as slow as under load, for the rest of the test.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });

      // The sub-agent's terminal takes the wheel once clicked (orchestrator-board-wheel, step 2).
      const box = (await subScreen.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      const rounds: Array<Record<string, number>> = [];
      seen.rounds = rounds;
      for (let round = 1; round <= ROUNDS; round++) {
        // 0. Down to its last line, following the output again: set as dragging the scrollbar to its end sets it. A wheel
        // down this far stays in the window's smooth scroll and swallows the wheel up that follows (measured, 22/11).
        await page.locator(`[data-agent-panel="${sub}"] .xterm-viewport`).evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await expect.poll(() => fromBottom(page, sub), { timeout: 15_000, message: `round ${round}: the terminal is back at its last line` }).toBeLessThanOrEqual(rowHeight);
        await page.waitForTimeout(1_000);
        // Taken to its last line, it follows its output again: 1 s of lines later it is still at the end.
        expect.soft(await fromBottom(page, sub), `round ${round}: back at its last line, it follows its output again`).toBeLessThanOrEqual(rowHeight);
        const before = await viewportOf(page, sub);
        // 1. The wheel moved it up.
        await page.mouse.wheel(0, -400);
        await expect.poll(() => viewportOf(page, sub), { timeout: 10_000, message: `round ${round}: the wheel moved the terminal up` }).toBeLessThan(before);
        // 2. Still above where the wheel started, once the wheel has settled.
        await page.waitForTimeout(1_000);
        const left = await viewportOf(page, sub);
        // 3. Output goes on: it stays, give or take the row snap.
        await page.waitForTimeout(3_000);
        const held = await viewportOf(page, sub);
        rounds.push({ round, before, left, held, movedDown: held - left });
        recordValues(seen);
        await stepShot(page, `${tag}-round-${round}`);
        expect.soft(left, `round ${round}: 1 s after the wheel, the terminal is still above where the wheel started (${before})`).toBeLessThan(before);
        expect.soft(held - left, `round ${round}: the terminal stays where the wheel left it (${left}, then ${held} 3 s later; the wheel started at ${before})`).toBeLessThanOrEqual(2 * rowHeight);
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
