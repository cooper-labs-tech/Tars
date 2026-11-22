import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The scroll lock under load on the two other terminals that stream an agent's live output: the Agents page's terminal
 * dialog (AgentWorld/useAgentDialogTerminal) and the tray panel's (TrayPanel/useTrayTerminal). The Audit's L1 on #629:
 * both kept the fault orchestrator-board-wheel-under-load.spec.ts shows on the Dashboard.
 *
 * The renderer's CPU is throttled (CDP Emulation.setCPUThrottlingRate, E2E_CPU_RATE, 12 unless given). One agent on a
 * stand-in that prints 300 numbered lines, then one every 200 ms, started from the window. Per surface, the terminal is
 * opened, and E2E_WHEEL_ROUNDS times (5 unless given):
 * 0. it is taken down to its last line and follows its output again;
 * 1. the wheel goes up 400 over it, and its viewport is seen above where it stood;
 * 2. 1 s later it is still above where the wheel started;
 * 3. 3 s of output later, it has not moved down by more than two rows.
 * Red on 8128be013 (#629 before L1); green on its head.
 *
 * The artefact: each round's viewports and the row height in values.json, a screenshot after each round.
 */

const RATE = Number(process.env.E2E_CPU_RATE ?? 12);
const ROUNDS = Number(process.env.E2E_WHEEL_ROUNDS ?? 5);
const AGENT = 'w-1';

type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

function seed(home: string): void {
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'projects', 'tars');
  for (const d of [dir, project]) fs.mkdirSync(d, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'busy-cli.cjs'), [
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    'let n = 0;',
    "const line = () => process.stdout.write('line ' + (++n) + ' of ' + process.env.CLAUDE_AGENT_ID + '\\r\\n');",
    'for (let i = 0; i < 300; i++) line();',
    'setInterval(line, 200);',
    'process.stdin.resume();',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'Frontend Engineer', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, cliPath: cli, skills: [], createdAt: '2026-11-22T08:00:00.000Z', lastActivity: '2026-11-22T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', autoStartAgentsOnLaunch: false }));
}

const viewportOf = (page: Page) => page.locator('.xterm-viewport').first().evaluate((el) => Math.round(el.scrollTop));
const fromBottom = (page: Page) => page.locator('.xterm-viewport').first().evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));

const SURFACES = [
  {
    name: "the Agents page's terminal dialog",
    port: 31589,
    open: async (page: Page) => {
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Frontend Engineer', { exact: true }).first().click();
    },
  },
  {
    name: "the tray panel's terminal",
    port: 31590,
    open: async (page: Page) => {
      await page.goto(`${DEV_URL}/tray-panel`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Frontend Engineer/ }).first().click();
    },
  },
];

for (const s of SURFACES) {
  test(`${s.name}, followed and scrolled up by the wheel, stays there while the output goes on, the renderer slowed ${RATE} times`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-wheel-surfaces-'));
    seed(home);
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(s.port), DOROTHY_E2E: '1' },
    });
    const seen: Record<string, unknown> = { surface: s.name, rate: RATE, rounds: ROUNDS };
    const tag = s.port === 31589 ? 'dialog' : 'tray';
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), AGENT);
      await s.open(page);
      await expect(page.locator('.xterm-screen').first(), 'the terminal').toBeVisible({ timeout: 60_000 });
      await expect.poll(() => viewportOf(page), { timeout: 60_000, message: 'the terminal has history' }).toBeGreaterThan(200);
      const rowHeight = await page.locator('.xterm-rows > div').first().evaluate((el) => el.getBoundingClientRect().height);
      seen.rowHeight = rowHeight;

      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
      const box = (await page.locator('.xterm-screen').first().boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

      const rounds: Array<Record<string, number>> = [];
      seen.rounds = rounds;
      for (let round = 1; round <= ROUNDS; round++) {
        await page.locator('.xterm-viewport').first().evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await expect.poll(() => fromBottom(page), { timeout: 15_000, message: `round ${round}: back at its last line` }).toBeLessThanOrEqual(rowHeight);
        await page.waitForTimeout(1_000);
        // Taken to its last line, it follows its output again: 1 s of lines later it is still at the end.
        expect.soft(await fromBottom(page), `round ${round}: back at its last line, it follows its output again`).toBeLessThanOrEqual(rowHeight);
        const before = await viewportOf(page);
        await page.mouse.wheel(0, -400);
        await expect.poll(() => viewportOf(page), { timeout: 10_000, message: `round ${round}: the wheel moved the terminal up` }).toBeLessThan(before);
        await page.waitForTimeout(1_000);
        const left = await viewportOf(page);
        await page.waitForTimeout(3_000);
        const held = await viewportOf(page);
        rounds.push({ round, before, left, held, movedDown: held - left });
        recordValues(seen);
        await stepShot(page, `${tag}-round-${round}`);
        expect.soft(left, `round ${round}: 1 s after the wheel, still above where it started (${before})`).toBeLessThan(before);
        expect.soft(held - left, `round ${round}: stays where the wheel left it (${left}, then ${held} 3 s later; started at ${before})`).toBeLessThanOrEqual(2 * rowHeight);
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
