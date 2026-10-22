import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Dashboard board of more than nine agents (JeanBrasse, 22/10: the tenth could not be seen). It keeps three
 * columns and a 3x3 cell's size, grows by rows, and scrolls. Frame: `Dashboard (2.0.5) · twelve agents, three
 * columns, scrolled`.
 *
 * Twelve agents on one project, each on a stand-in CLI that prints a line naming its agent and writes what it is
 * typed to a file of its own. In the shell as it was and in the new interface, at the window's opening size: all
 * twelve panels exist, each the size of the first; the board scrolls; the wheel over a panel header brings the
 * tenth to the twelfth into its view; each of them shows its CLI's line, and a click in its terminal and a word typed
 * reach its own CLI. Red on main (dc623b59): nine panels.
 *
 * The artefact: the panel boxes, the board's scroll and what each CLI received, in values.json, and screenshots.
 */

const N = 12;
const ids = Array.from({ length: N }, (_, i) => `a${i + 1}`);

function standIn(home: string): string {
  return writeNodeCli(path.join(home, 'stand-in.cjs'), [
    "const fs = require('fs'); const path = require('path');",
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    `const out = path.join(${JSON.stringify(home)}, 'typed-' + process.env.CLAUDE_AGENT_ID + '.txt');`,
    "process.stdout.write('READY-' + process.env.CLAUDE_AGENT_ID + '\\r\\n> ');",
    "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
    "process.stdin.on('data', (d) => { fs.appendFileSync(out, d.toString()); process.stdout.write(d.toString()); });",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

for (const newInterface of [false, true]) {
  test(`a board of twelve agents keeps three columns, scrolls to the tenth to twelfth, and each takes input${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-board-scroll-'));
    seedSandbox(home);
    const project = path.join(home, 'projects', 'tars');
    const cli = standIn(home);
    const dir = path.join(home, '.tars');
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(ids.map((id, i) => ({
      id, name: `Agent ${i + 1}`, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
      projectPath: project, skills: [], cliPath: cli,
      createdAt: '2026-10-22T08:00:00.000Z', lastActivity: `2026-10-22T08:${String(59 - i).padStart(2, '0')}:00.000Z`,
    })), null, 2));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }, null, 2));
    const typedOf = (id: string) => { const f = path.join(home, `typed-${id}.txt`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31550 : 31549), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      seen.window = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

      // All twelve panels, each the size of the first.
      const panels = page.locator('[data-agent-panel]');
      await expect(panels).toHaveCount(N, { timeout: 90_000 });
      const boxes = await panels.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-agent-panel'), w: Math.round(r.width), h: Math.round(r.height) }; }));
      seen.boxes = boxes;
      for (const b of boxes) {
        expect(Math.abs(b.w - boxes[0].w), `${b.id} as wide as the first`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.h - boxes[0].h), `${b.id} as tall as the first`).toBeLessThanOrEqual(1);
      }

      // The board scrolls, and the wheel over a panel header brings the last row into view.
      const board = page.locator('[data-board-layout="grid"]');
      const scroll = () => board.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
      const before = await scroll();
      seen.before = before;
      expect(before.height, 'the board is taller than its view').toBeGreaterThan(before.client);
      await stepShot(page, `${tag}-01-top`);
      const header = page.locator('[data-agent-panel="a1"] [aria-label="Panel actions"]');
      const hb = (await header.boundingBox())!;
      await page.mouse.move(hb.x - 40, hb.y + hb.height / 2);
      await page.mouse.wheel(0, before.height);
      await expect.poll(async () => (await scroll()).top, { timeout: 10_000 }).toBeGreaterThan(0);
      seen.after = await scroll();
      await stepShot(page, `${tag}-02-scrolled`);

      // The tenth to the twelfth: in the board's view, showing their CLI, and taking typed input.
      const view = (await board.boundingBox())!;
      // The panels are ordered by the board; the last row holds the three past nine.
      const order = boxes.map((b) => b.id!);
      for (const id of order.slice(9)) {
        const panel = page.locator(`[data-agent-panel="${id}"]`);
        const box = (await panel.boundingBox())!;
        seen[`box-${id}`] = box;
        expect(box.y, `${id} below the board's top`).toBeGreaterThanOrEqual(view.y - 1);
        expect(box.y + box.height, `${id} above the board's bottom`).toBeLessThanOrEqual(view.y + view.height + 1);
        await expect(panel.locator('.xterm-rows'), `${id} renders its CLI`).toContainText(`READY-${id}`, { timeout: 60_000 });
        await panel.locator('.xterm-screen').click();
        await page.keyboard.type(`hello-${id}`);
        await expect.poll(() => typedOf(id), { timeout: 15_000 }).toContain(`hello-${id}`);
        seen[`typed-${id}`] = typedOf(id);
      }
      expect(await scroll(), 'typing did not scroll the board back').toMatchObject({ top: (seen.after as { top: number }).top });
      await stepShot(page, `${tag}-03-typed`);
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
