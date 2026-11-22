import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Where the program asked for the wheel, the wheel goes to the program, on the three terminals that keep the user's
 * scroll (src/lib/terminal.ts keepUserScroll, #629): the Dashboard's, the Agents page's terminal dialog and the tray
 * panel's. The Audit's I-1 on #629: keepUserScroll only acts where xterm scrolls its own viewport (`ours()`), and a
 * mutant that drops that guard survives the wheel witnesses, so this case says what the wheel does where it is not
 * xterm's to scroll with.
 *
 * Each surface shows one agent on a stand-in that prints 300 numbered lines (a history to scroll), reads its input
 * raw and records it, and switches mode when the spec writes the mode's name into a file:
 * 1. `mouse`: the normal buffer, the program asks for mouse reports (DECSET 1000 and 1006, SGR). One wheel up over the
 *    terminal reaches the program as an SGR wheel-up report, and the history does not move;
 * 2. `mouse-alt`: the alternate screen, the same request. The wheel reaches the program as the same report;
 * 3. `alt`: the alternate screen, the request withdrawn. The wheel types nothing (no arrow keys, no report: the app's
 *    rule since the wheel typed arrows into a prompt's history) and moves nothing.
 *
 * The artefact: per surface and mode, what the program received and the viewport before and after, in values.json,
 * and a screenshot per mode.
 */

const LEAD = 'w-0';
const WORKER = 'w-1';
const MODES = [
  { mode: 'mouse', reaches: true },
  { mode: 'mouse-alt', reaches: true },
  { mode: 'alt', reaches: false },
];

type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

function seed(home: string, board: boolean): void {
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'projects', 'tars');
  for (const d of [dir, project]) fs.mkdirSync(d, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'mode-cli.cjs'), [
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    "const fs = require('fs');",
    "const path = require('path');",
    `const home = ${JSON.stringify(home)};`,
    'const id = process.env.CLAUDE_AGENT_ID;',
    "const rec = path.join(home, 'input-' + id + '.log');",
    'if (process.stdin.isTTY) process.stdin.setRawMode(true);',
    "process.stdin.on('data', (d) => fs.appendFileSync(rec, d.toString('latin1')));",
    "for (let i = 1; i <= 300; i++) process.stdout.write('line ' + i + ' of ' + id + '\\r\\n');",
    'const MODES = {',
    "  mouse: '\\x1b[?1000h\\x1b[?1006h',",
    "  'mouse-alt': '\\x1b[?1049h\\x1b[H\\x1b[2J\\x1b[?1000h\\x1b[?1006h',",
    "  alt: '\\x1b[?1000l\\x1b[?1006l',",
    '};',
    "let mode = '';",
    'setInterval(() => {',
    "  let want = '';",
    "  try { want = fs.readFileSync(path.join(home, 'mode.txt'), 'utf8').trim(); } catch {}",
    "  if (want && want !== mode && MODES[want] !== undefined) { mode = want; process.stdout.write(MODES[want] + 'mode ' + want + ' on\\r\\n'); }",
    '}, 100);',
    '',
  ].join('\n'));
  const names = board ? ['Lead', 'Frontend Engineer'] : ['Frontend Engineer'];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(names.map((name, i) => ({
    id: board ? `w-${i}` : WORKER, name, character: i === 0 && board ? 'wizard' : 'robot', provider: 'claude', status: 'idle',
    role: i === 0 && board ? 'orchestrator' : 'worker', projectPath: project, cliPath: cli,
    skills: [], createdAt: '2026-11-22T08:00:00.000Z', lastActivity: '2026-11-22T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', autoStartAgentsOnLaunch: board }));
}

const SURFACES = [
  {
    name: "the Dashboard's terminal",
    tag: 'dashboard',
    port: 31592,
    agent: LEAD,
    board: true,
    scope: `[data-agent-panel="${LEAD}"]`,
    open: async (page: Page) => {
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-board-layout="orchestrator"]')).toBeVisible({ timeout: 90_000 });
    },
  },
  {
    name: "the Agents page's terminal dialog",
    tag: 'dialog',
    port: 31593,
    agent: WORKER,
    board: false,
    scope: '',
    open: async (page: Page) => {
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Frontend Engineer', { exact: true }).first().click();
    },
  },
  {
    name: "the tray panel's terminal",
    tag: 'tray',
    port: 31594,
    agent: WORKER,
    board: false,
    scope: '',
    open: async (page: Page) => {
      await page.goto(`${DEV_URL}/tray-panel`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Frontend Engineer/ }).first().click();
    },
  },
];

const shown = (text: string) => text.replace(/\x1b/g, '\\e');

for (const s of SURFACES) {
  test(`${s.name}: the wheel reaches a program that asked for it, in the normal buffer and the alternate screen, and types nothing once it no longer asks`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-wheel-program-'));
    seed(home, s.board);
    const rec = path.join(home, `input-${s.agent}.log`);
    const received = () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'latin1') : '');
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(s.port), DOROTHY_E2E: '1' },
    });
    const seen: Record<string, unknown> = { surface: s.name };
    const term = (sel: string) => page.locator(`${s.scope} ${sel}`.trim()).first();
    let page: Page;
    try {
      page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      if (!s.board) {
        await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
        await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), s.agent);
      }
      await s.open(page);
      await expect(term('.xterm-rows'), 'the history is written').toContainText(`line 300 of ${s.agent}`, { timeout: 60_000 });
      const viewport = () => term('.xterm-viewport').evaluate((el) => Math.round(el.scrollTop));
      const results: Array<Record<string, unknown>> = [];
      seen.modes = results;

      for (const m of MODES) {
        fs.writeFileSync(path.join(home, 'mode.txt'), m.mode);
        await expect(term('.xterm-rows'), `the program is in mode ${m.mode}`).toContainText(`mode ${m.mode} on`, { timeout: 15_000 });
        await page.waitForTimeout(400);
        const box = (await term('.xterm-screen').boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const from = received().length;
        const before = await viewport();
        await page.mouse.wheel(0, -400);
        if (m.reaches) {
          await expect.poll(() => received().slice(from), { timeout: 5_000, message: `${m.mode}: the wheel reached the program as an SGR wheel-up report` })
            .toMatch(/\x1b\[<64;\d+;\d+M/);
        } else {
          await page.waitForTimeout(1_500);
        }
        await page.waitForTimeout(500);
        const got = received().slice(from);
        const after = await viewport();
        results.push({ mode: m.mode, received: shown(got), before, after });
        recordValues(seen);
        await stepShot(page, `${s.tag}-${m.mode}`);
        expect(after, `${m.mode}: the wheel moved no viewport (${before}, then ${after})`).toBe(before);
        if (!m.reaches) {
          expect(shown(got), `${m.mode}: the wheel typed nothing, no arrow and no report`).toBe('');
        }
      }
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
