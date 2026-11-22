import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A terminal scrolled up deep in its history stays still once its output has stopped, at every device pixel ratio.
 *
 * The Audit's M1 on #629 (reports/audit-629.md): keepUserScroll (src/lib/terminal.ts) turns the viewport's scrollTop
 * into a row with `.xterm-screen`'s height over the rows. xterm's DOM renderer rounds that height
 * (Math.round(dch * rows / dpr)) while xterm places scrollTop with the unrounded dch / dpr. Where the two differ, the row
 * read is off by ydisp * error / height, and once that reaches half a row, settle scrolls a line on every frame:
 * - at a fractional pixel ratio (1.25) the view creeps down to the end and follows again;
 * - on Retina (2) with an odd device cell height and an odd number of rows, it creeps up.
 * An upward creep still "stays above" where the wheel started, so the wheel witness
 * (orchestrator-board-wheel-under-load.spec.ts) cannot see it.
 *
 * The app runs with --force-device-scale-factor (launchSandboxed's `switches`). The orchestrator's terminal (it takes
 * the wheel without a click) prints 3000 numbered lines and stops. Per case:
 * 1. the geometry is read and the case proves something only where the rounded screen height differs from rows times
 *    the unrounded cell height (`mismatch`); on Retina the window height and the font size are moved until the device
 *    cell height and the rows are both odd;
 * 2. the wheel goes up 400 once, deep in the history;
 * 3. for 2 s, frame by frame, the first row the terminal shows (its line number, which is buffer.viewportY + 1) and the
 *    viewport's scrollTop are read: both hold still;
 * 4. the window is resized while scrolled up (the Audit's I-3): the terminal still shows the same first line, and holds
 *    still for 1 s after.
 * Red on 8128be013 (#629 before the M1 fix); green on the fixed head.
 *
 * The artefact: values.json (the geometry, every frame's first line and scrollTop), a screenshot after each step.
 */

const LINES = 3000;
const AGENTS = ['Lead', 'Frontend Engineer'];
const ids = AGENTS.map((_, i) => `w-${i}`);
const lead = ids[0];

type Frame = { t: number; top: number; first: string };
type Geometry = { dpr: number; cellCss: number; dch: number; rows: number; screen: number; mismatch: number; fontSize: number; height: number };

function seed(home: string, fontSize: number): void {
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'projects', 'tars');
  for (const d of [dir, project]) fs.mkdirSync(d, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'history-cli.cjs'), [
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    `for (let i = 1; i <= ${LINES}; i++) process.stdout.write('line ' + i + ' of ' + process.env.CLAUDE_AGENT_ID + '\\r\\n');`,
    'process.stdin.resume();',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(AGENTS.map((name, i) => ({
    id: ids[i], name, character: i === 0 ? 'wizard' : 'robot', provider: 'claude', status: 'idle',
    role: i === 0 ? 'orchestrator' : 'worker', projectPath: project, cliPath: cli,
    skills: [], createdAt: '2026-11-22T08:00:00.000Z', lastActivity: '2026-11-22T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', terminalFontSize: fontSize }));
}

const panel = (id: string) => `[data-agent-panel="${id}"]`;

/** The terminal's geometry as the DOM renderer laid it out. */
const geometry = (page: Page, fontSize: number, height: number): Promise<Geometry> => page.evaluate(({ sel, fontSize, height }) => {
  const dpr = window.devicePixelRatio;
  const rows = document.querySelectorAll(`${sel} .xterm-rows > div`).length;
  const row = document.querySelector(`${sel} .xterm-rows > div`) as HTMLElement | null;
  const cellCss = row ? row.getBoundingClientRect().height : 0;
  const dch = Math.round(cellCss * dpr);
  const screen = (document.querySelector(`${sel} .xterm-screen`) as HTMLElement).getBoundingClientRect().height;
  return { dpr, cellCss, dch, rows, screen, mismatch: Math.abs(screen - (dch * rows) / dpr), fontSize, height };
}, { sel: panel(lead), fontSize, height });

/** The first line the terminal shows and its viewport's scrollTop, every animation frame for `ms`. */
const frames = (page: Page, ms: number): Promise<Frame[]> => page.evaluate(({ sel, ms }) => new Promise<Frame[]>((resolve) => {
  const viewport = document.querySelector(`${sel} .xterm-viewport`) as HTMLElement;
  const rows = document.querySelector(`${sel} .xterm-rows`) as HTMLElement;
  const out: Frame[] = [];
  const t0 = performance.now();
  const tick = () => {
    out.push({ t: Math.round(performance.now() - t0), top: Math.round(viewport.scrollTop * 100) / 100, first: (rows.firstElementChild?.textContent ?? '').trim() });
    if (performance.now() - t0 < ms) requestAnimationFrame(tick);
    else resolve(out);
  };
  requestAnimationFrame(tick);
}), { sel: panel(lead), ms });

const lineOf = (first: string) => Number(first.match(/^line (\d+)/)?.[1] ?? NaN);

/**
 * The window's content size, set on the window itself. page.setViewportSize would set the page's metrics through CDP with
 * a device scale factor of 1, over --force-device-scale-factor (measured: the ratio read 1 at 1.25 and at 2).
 */
const sizeWindow = (app: ElectronApplication, width: number, height: number) => app.evaluate(({ BrowserWindow }, { width, height }) => {
  const win = BrowserWindow.getAllWindows().filter((w) => w.isVisible()).sort((a, b) => b.getBounds().width - a.getBounds().width)[0];
  win?.setContentSize(width, height);
}, { width, height });

const CASES = [
  { name: 'at a pixel ratio of 1.25', scale: 1.25, oddOnRetina: false, port: 31587 },
  { name: 'on Retina, an odd cell height and an odd number of rows', scale: 2, oddOnRetina: true, port: 31588 },
];

for (const c of CASES) {
  test(`a terminal scrolled up deep in its history stays still once its output stops, ${c.name}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-scroll-dpr-'));
    let fontSize = 11;
    seed(home, fontSize);
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(c.port), DOROTHY_E2E: '1' },
      switches: [`--force-device-scale-factor=${c.scale}`],
    });
    const seen: Record<string, unknown> = { case: c.name, scale: c.scale };
    const tag = c.oddOnRetina ? 'retina-odd' : 'dpr-1.25';
    try {
      const page = await app.firstWindow();
      let height = 900;
      await sizeWindow(app, 1440, height);
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-board-layout="orchestrator"]')).toBeVisible({ timeout: 90_000 });
      const lastLine = page.locator(`${panel(lead)} .xterm-rows`).filter({ hasText: `line ${LINES} of ${lead}` });
      await expect(lastLine, 'the history is written').toBeVisible({ timeout: 60_000 });

      // 1. The geometry. On Retina: the font size and the window height moved until the cell height and rows are odd.
      let g = await geometry(page, fontSize, height);
      if (c.oddOnRetina) {
        const tried: Geometry[] = [g];
        search: for (const size of [11, 12, 13, 10, 14]) {
          if (size !== fontSize) {
            await page.evaluate((s) => (window as unknown as { electronAPI: { appSettings: { get(): Promise<Record<string, unknown>>; save(v: Record<string, unknown>): Promise<unknown> } } })
              .electronAPI.appSettings.get().then((v) => (window as unknown as { electronAPI: { appSettings: { save(v: Record<string, unknown>): Promise<unknown> } } }).electronAPI.appSettings.save({ ...v, terminalFontSize: s })), size);
            fontSize = size;
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(lastLine, 'the history is written again').toBeVisible({ timeout: 60_000 });
          }
          for (const h of [900, 892, 884, 876, 868, 860, 852, 844]) {
            height = h;
            await sizeWindow(app, 1440, height);
            await page.waitForTimeout(400);
            g = await geometry(page, fontSize, height);
            tried.push(g);
            if (g.dch % 2 === 1 && g.rows % 2 === 1) break search;
          }
        }
        seen.tried = tried;
        expect(g.dch % 2 === 1 && g.rows % 2 === 1, `an odd cell height and odd rows at a ratio of 2 (${JSON.stringify(g)})`).toBe(true);
      }
      seen.geometry = g;
      expect(g.dpr, 'the window runs at the ratio asked').toBe(c.scale);
      expect(g.mismatch, `the rounded screen height differs from rows times the cell height: the case proves something (${JSON.stringify(g)})`).toBeGreaterThan(0);
      await stepShot(page, `${tag}-01-history`);

      // 2. The wheel, once, deep in the history.
      const box = (await page.locator(`${panel(lead)} .xterm-screen`).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const before = await frames(page, 50);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(400);

      // 3. Two seconds, frame by frame: the first line and the scrollTop hold still.
      const held = await frames(page, 2_000);
      seen.before = before.at(-1);
      seen.held = held;
      recordValues(seen);
      await stepShot(page, `${tag}-02-held`);
      const firsts = [...new Set(held.map((f) => f.first))];
      expect(lineOf(held[0].first), 'the wheel took the terminal up into its history').toBeLessThan(lineOf(before.at(-1)!.first));
      expect(firsts, `the first line shown held still for 2 s (${held.length} frames; from ${held[0].first} to ${held.at(-1)!.first})`).toHaveLength(1);
      expect([...new Set(held.map((f) => Math.round(f.top)))], 'the scrollTop held still for 2 s').toHaveLength(1);

      // 4. A resize while scrolled up (the Audit's I-3): the same first line, and still after it.
      const shown = held.at(-1)!.first;
      await sizeWindow(app, 1440, height - 40);
      await page.waitForTimeout(600);
      const afterResize = await frames(page, 1_000);
      seen.afterResize = afterResize;
      recordValues(seen);
      await stepShot(page, `${tag}-03-resized`);
      expect(Math.abs(lineOf(afterResize[0].first) - lineOf(shown)), `the resize kept the line shown (${shown}, then ${afterResize[0].first})`).toBeLessThanOrEqual(1);
      expect([...new Set(afterResize.map((f) => f.first))], 'still after the resize').toHaveLength(1);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
