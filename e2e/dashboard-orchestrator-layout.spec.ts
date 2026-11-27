import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Dashboard's orchestrator layout (t-c4ac3055, the maintainer's idea of 18/10). Frames `Dashboard · orchestrator
 * layout · 2 agents` to `· notes` in design/tars-redesign.pen. At
 * 1440 by 900, five projects: tars (its orchestrator and three agents), duo (two), six (six), seven (seven) and harbor
 * (two agents, no orchestrator). Their agents run a CLI of the sandbox that prints its terminal's size at each resize.
 * Asserted:
 * 1. tars opens in the orchestrator layout, the switch in the header on Orchestrator: the orchestrator's card the left
 *    two thirds of the board and its whole height, as two columns and two rows of the 3x2 grid; the three others one
 *    under the other in the column on the right, each the box of a card of that grid; the column scrolls;
 * 2. the keys go to the orchestrator: typed, they reach its CLI and no other; a click on another card takes them there;
 * 3. six: the column's cards have the box a card of the equal grid has, and their CLI the same columns and rows,
 *    read in the orchestrator layout then after Equal grid; the orchestrator's CLI is wider in the orchestrator layout;
 * 4. the choice is kept per project: six stays on the grid, seven opens in the orchestrator layout, six is still on
 *    the grid once the window has loaded again; Orchestrator gives the layout back;
 * 5. seven: six cards in the column, two in sight, the last reached by the wheel over the column;
 * 6. duo: its one other card takes the board's whole height;
 * 7. harbor, no orchestrator: no switch, and the grid of today;
 * 8. a card's fullscreen fills the window, and its exit gives the layout back;
 * 9. at the narrowest window, 1200 by 800, the same layout, the column's cards still the box of the grid's;
 * 10. a scrollbar that takes room (forced, as Windows and Linux draw one) is taken from the orchestrator, never from the
 *     column's cards, even when it comes without the board being drawn again;
 * 11. a card out of sight resized, then its board left at once, leaves no page error behind.
 * Red on the code before it (main, 12bc5dcc): no switch, and every board the equal grid.
 * The artefact: values.json with every box, size and focus read, per shell, and a screenshot of each step.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const PROJECTS: Record<string, string[]> = {
  tars: ['Orchestrator', 'Frontend Engineer', 'Backend Engineer', 'QA'],
  duo: ['Duo Lead', 'Duo Worker'],
  six: ['Six Lead', 'Six One', 'Six Two', 'Six Three', 'Six Four', 'Six Five'],
  seven: ['Seven Lead', 'Seven One', 'Seven Two', 'Seven Three', 'Seven Four', 'Seven Five', 'Seven Six'],
  harbor: ['Harbor Billing', 'Harbor Docs'],
};
const ids = (project: string) => PROJECTS[project].map((_, i) => `${project}-${i}`);

type Box = { x: number; y: number; width: number; height: number };

/** A home holding the five projects, their agents on the sandbox's CLI, nothing started at launch. */
function seed(home: string): void {
  const dir = path.join(home, '.tars');
  const project = (name: string) => path.join(home, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(PROJECTS)) fs.mkdirSync(project(name), { recursive: true });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, 'sized-cli.cjs');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const size = () => '[size ' + process.stdout.columns + 'x' + process.stdout.rows + ']';",
    "process.stdout.write('a CLI of the E2E sandbox ' + size() + '\\r\\n> ');",
    "process.stdout.on('resize', () => process.stdout.write('\\r\\n' + size() + '\\r\\n> '));",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  const agents = Object.entries(PROJECTS).flatMap(([name, list]) => list.map((agentName, i) => ({
    id: `${name}-${i}`, name: agentName, character: i === 0 ? 'wizard' : 'robot', provider: 'claude', status: 'idle',
    role: i === 0 && name !== 'harbor' ? 'orchestrator' : 'worker', projectPath: project(name), cliPath: cli,
    skills: [], createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  })));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(Object.keys(PROJECTS).map(project)));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
}

test(`dashboard orchestrator layout: the orchestrator two thirds, the column, the keys, the switch kept per project`, async () => {
  test.setTimeout(420_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orch-layout-'));
  seed(home);
  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31509), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  const tag = 'new-';
  try {
    const page: Page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    const shot = (name: string) => stepShot(page, `${tag}${name}`);

    const openDashboard = async () => {
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 60_000 });
      await expect(page.locator('[data-agent-panel]').first()).toBeVisible({ timeout: 90_000 });
    };
    const tab = (name: string) => page.getByRole('button', { name, exact: true });
    const panel = (id: string) => page.locator(`[data-agent-panel="${id}"]`);
    /** A project's board on screen: its tab clicked only when it is not shown, since a click on the tab shown turns it off. */
    const showProject = async (name: string) => {
      if (!(await panel(`${name}-0`).isVisible())) await tab(name).click();
      await expect(panel(`${name}-0`)).toBeVisible({ timeout: 30_000 });
    };
    const board = () => page.locator('[data-board-layout]');
    const sw = () => page.getByRole('radiogroup', { name: 'Board layout' });
    const box = async (id: string): Promise<Box | null> => panel(id).boundingBox();
    const near = (a: number, b: number, d = 1.5) => Math.abs(a - b) <= d;
    /** The 3x2 grid's card in this board, as TerminalGrid sizes it: margin 8, no padding, the row floored at 80. */
    const gridCell = async () => {
      const b = (await board().boundingBox())!;
      return { board: b, w: (b.width - 16) / 3, h: Math.max(80, (b.height - 24) / 2) };
    };
    const scrollbarOf = () => page.locator('[data-board-column]').evaluate((el) => (el as HTMLElement).offsetWidth - (el as HTMLElement).clientWidth);
    /**
     * The last size the agent's CLI printed: what its terminal told the PTY after the fit addon sized it. Read from the
     * main process's copy of the terminal (agent:get), not the panel's: xterm draws nothing for a terminal out of
     * sight, such as a card below the column's fold, though its fit and its PTY's size go on.
     */
    const sizeOf = async (id: string) => {
      const text = await page.evaluate(async (i) => {
        const api = (window as unknown as { electronAPI: { agent: { get: (id: string) => Promise<{ output?: string[] } | null> } } }).electronAPI;
        return ((await api.agent.get(i))?.output ?? []).join('');
      }, id);
      const all = [...text.matchAll(/\[size (\d+)x(\d+)\]/g)];
      const last = all[all.length - 1];
      return last ? { cols: Number(last[1]), rows: Number(last[2]) } : null;
    };
    /** Sizes once they hold still for 600 ms, the fit being debounced. */
    const settledSizes = async (list: string[]) => {
      let before = '';
      for (let i = 0; i < 40; i++) {
        const now = JSON.stringify(await Promise.all(list.map(sizeOf)));
        if (now === before && !now.includes('null')) return JSON.parse(now) as Array<{ cols: number; rows: number }>;
        before = now;
        await page.waitForTimeout(600);
      }
      return JSON.parse(before) as Array<{ cols: number; rows: number } | null>;
    };
    const start = (list: string[]) => page.evaluate(async (l) => {
      const api = (window as unknown as { electronAPI: { agent: { start: (p: { id: string; prompt: string }) => Promise<unknown> } } }).electronAPI;
      for (const id of l) await api.agent.start({ id, prompt: '' });
    }, list);
    const focusedPanel = () => page.evaluate(() => document.activeElement?.closest('[data-agent-panel]')?.getAttribute('data-agent-panel') ?? null);
    const layoutOf = async () => board().getAttribute('data-board-layout');

    await openDashboard();

    // 1. tars, in the orchestrator layout by itself.
    await expect(sw(), 'the switch in the header').toBeVisible({ timeout: 30_000 });
    await expect(sw().getByRole('radio', { name: 'Orchestrator' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(layoutOf).toBe('orchestrator');
    await start(ids('tars'));
    const tarsSizes = await settledSizes(ids('tars'));
    const cell = await gridCell();
    const sb = await scrollbarOf();
    const tarsBoxes = await Promise.all(ids('tars').map(box));
    seen.tars = { board: cell.board, cell: { w: cell.w, h: cell.h }, scrollbar: sb, boxes: tarsBoxes, sizes: tarsSizes };
    const [orch, ...others] = tarsBoxes as Box[];
    expect.soft(near(orch.x, cell.board.x), 'the orchestrator on the left').toBe(true);
    expect.soft(near(orch.width, cell.board.width - 8 - cell.w - sb), 'the orchestrator two columns and the gap').toBe(true);
    expect.soft(near(orch.height, 2 * cell.h + 8), 'the orchestrator two rows and the gap').toBe(true);
    others.forEach((b, i) => {
      expect.soft(near(b.width, cell.w), `card ${i + 1} a grid column wide`).toBe(true);
      expect.soft(near(b.height, cell.h), `card ${i + 1} a grid row high`).toBe(true);
      expect.soft(near(b.x, cell.board.x + cell.board.width - cell.w - sb), `card ${i + 1} in the third column`).toBe(true);
      if (i > 0) expect.soft(near(b.y, others[i - 1].y + cell.h + 8), `card ${i + 1} under the one before`).toBe(true);
    });
    const tarsColumn = await page.locator('[data-board-column]').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    seen.tarsColumn = tarsColumn;
    expect.soft(tarsColumn.scroll > tarsColumn.client, 'the column scrolls').toBe(true);
    await shot('01-tars-orchestrator-layout');

    // 2. The keys go to the orchestrator, and a click takes them elsewhere.
    await expect.poll(focusedPanel, { timeout: 15_000 }).toBe('tars-0');
    await page.keyboard.type('orchkeys1');
    await expect(panel('tars-0').locator('.xterm-rows')).toContainText('orchkeys1', { timeout: 15_000 });
    for (const id of ids('tars').slice(1)) await expect.soft(panel(id).locator('.xterm-rows')).not.toContainText('orchkeys1');
    await panel('tars-1').locator('.xterm-screen').click();
    await expect.poll(focusedPanel).toBe('tars-1');
    await page.keyboard.type('frontkeys2');
    await expect(panel('tars-1').locator('.xterm-rows')).toContainText('frontkeys2', { timeout: 15_000 });
    await expect.soft(panel('tars-0').locator('.xterm-rows')).not.toContainText('frontkeys2');
    seen.keys = { first: 'tars-0', afterClick: 'tars-1' };
    await shot('02-tars-keys');

    // 3. six: the column's cards are the equal grid's, their CLI too.
    await showProject('six');
    await expect.poll(layoutOf).toBe('orchestrator');
    await expect.poll(focusedPanel, { timeout: 15_000 }).toBe('six-0');
    await start(ids('six'));
    const orchSizes = await settledSizes(ids('six'));
    const orchCell = await gridCell();
    const orchBoxes = await Promise.all(ids('six').map(box));
    await shot('03-six-orchestrator-layout');
    await sw().getByRole('radio', { name: 'Equal grid' }).click();
    await expect.poll(layoutOf).toBe('grid');
    await expect(sw().getByRole('radio', { name: 'Equal grid' })).toHaveAttribute('aria-checked', 'true');
    const gridSizes = await settledSizes(ids('six'));
    const gridBoxes = await Promise.all(ids('six').map(box));
    seen.six = { cell: orchCell, orchestrator: { boxes: orchBoxes, sizes: orchSizes }, grid: { boxes: gridBoxes, sizes: gridSizes } };
    for (let i = 1; i < 6; i++) {
      const o = orchBoxes[i]!, g = gridBoxes[i]!;
      expect.soft(near(o.width, g.width) && near(o.height, g.height), `six card ${i}: the column's box is the grid's`).toBe(true);
      expect.soft(orchSizes[i], `six card ${i}: its CLI keeps its columns and rows`).toEqual(gridSizes[i]);
    }
    expect.soft((orchSizes[0]?.cols ?? 0) > (gridSizes[0]?.cols ?? 0), "the orchestrator's CLI wider in the orchestrator layout").toBe(true);
    await shot('04-six-equal-grid');

    // 4. The choice is kept per project, and across a reload.
    await showProject('seven');
    await expect.poll(layoutOf).toBe('orchestrator');
    await showProject('six');
    await expect.poll(layoutOf).toBe('grid');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-agent-panel]').first()).toBeVisible({ timeout: 90_000 });
    await showProject('six');
    await expect.poll(layoutOf).toBe('grid');
    await expect(sw().getByRole('radio', { name: 'Equal grid' })).toHaveAttribute('aria-checked', 'true');
    await sw().getByRole('radio', { name: 'Orchestrator' }).click();
    await expect.poll(layoutOf).toBe('orchestrator');
    seen.kept = { six: 'grid after a reload', seven: 'orchestrator', back: 'orchestrator' };

    // 5. seven: six cards in the column, the last reached by the wheel.
    await showProject('seven');
    await expect.poll(layoutOf).toBe('orchestrator');
    const column = page.locator('[data-board-column]');
    const colBox = (await column.boundingBox())!;
    const lastBefore = (await box('seven-6'))!;
    expect.soft(lastBefore.y > colBox.y + colBox.height, 'the last card below the column at first').toBe(true);
    const head = await panel('seven-1').boundingBox();
    await page.mouse.move(head!.x + 40, head!.y + 12);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
    await expect.poll(async () => {
      const b = await box('seven-6');
      return !!b && b.y >= colBox.y - 1 && b.y + b.height <= colBox.y + colBox.height + 1;
    }, { timeout: 10_000 }).toBe(true);
    seen.seven = { column: colBox, lastBefore, lastAfter: await box('seven-6'), cards: (await Promise.all(ids('seven').map(box))).length };
    await shot('05-seven-column-scrolled');

    // 6. duo: one other card, the whole height.
    await showProject('duo');
    await expect.poll(layoutOf).toBe('orchestrator');
    const duo = await Promise.all(ids('duo').map(box));
    seen.duo = duo;
    expect.soft(near(duo[1]!.height, duo[0]!.height), 'the one card as high as the orchestrator').toBe(true);
    await shot('06-duo');

    // 7. harbor: no orchestrator, no switch, the grid.
    await showProject('harbor');
    await expect.poll(layoutOf).toBe('grid');
    await expect(sw()).toHaveCount(0);
    seen.harbor = await Promise.all(ids('harbor').map(box));
    await shot('07-harbor-no-orchestrator');

    // 8. Fullscreen fills the window and gives the layout back.
    await showProject('tars');
    await expect.poll(layoutOf).toBe('orchestrator');
    await panel('tars-2').getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect.poll(async () => (await box('tars-2'))?.width ?? 0).toBeGreaterThan(1400);
    await shot('08-fullscreen');
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect.poll(layoutOf).toBe('orchestrator');
    await expect.poll(async () => near((await box('tars-2'))?.width ?? 0, (await gridCell()).w)).toBe(true);

    // 9. The narrowest window.
    await page.setViewportSize({ width: 1200, height: 800 });
    await showProject('six');
    await expect.poll(layoutOf).toBe('orchestrator');
    await page.waitForTimeout(800);
    const small = await gridCell();
    const smallSb = await scrollbarOf();
    const smallBoxes = await Promise.all(ids('six').map(box));
    seen.narrowest = { cell: small, scrollbar: smallSb, boxes: smallBoxes, sizes: await settledSizes(ids('six')) };
    expect.soft(near(smallBoxes[0]!.width, small.board.width - 8 - small.w - smallSb), 'narrowest: the orchestrator two columns').toBe(true);
    for (let i = 1; i < 6; i++) expect.soft(near(smallBoxes[i]!.width, small.w), `narrowest: card ${i} a grid column wide`).toBe(true);
    await shot('09-narrowest-window');

    // 10. A scrollbar that takes room, as Windows and Linux draw one (macOS overlays its own, so it is forced here as
    // #454's spec forces them): the column's cards keep the grid's width, the orchestrator gives up the room.
    await page.addStyleTag({ content: '[data-board-column] { scrollbar-width: auto !important; scrollbar-color: auto !important; } [data-board-column]::-webkit-scrollbar { width: 17px; }' });
    await expect.poll(scrollbarOf, { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
    await page.waitForTimeout(800);
    const forced = await gridCell();
    const forcedSb = await scrollbarOf();
    const forcedBoxes = await Promise.all(ids('six').map(box));
    seen.scrollbarTakingRoom = { cell: forced, scrollbar: forcedSb, boxes: forcedBoxes, sizes: await settledSizes(ids('six')) };
    expect.soft(near(forcedBoxes[0]!.width, forced.board.width - 8 - forced.w - forcedSb), 'the scrollbar taken from the orchestrator').toBe(true);
    for (let i = 1; i < 6; i++) expect.soft(near(forcedBoxes[i]!.width, forced.w), `with a scrollbar: card ${i} still a grid column wide`).toBe(true);
    await shot('10-scrollbar-taking-room');

    // 11. A card out of sight resized, then its board left at once. xterm defers the resize of a terminal out of sight
    // (a card below the column's fold) to an idle task its dispose does not cancel, and run after the dispose that
    // task read a renderer that was gone: `Cannot read properties of undefined (reading 'handleResize')`, seen at
    // step 9 of the run of 19/10 01:48, a resize then another board. Three rounds of it.
    for (let round = 0; round < 3; round++) {
      await showProject('seven');
      await expect.poll(layoutOf).toBe('orchestrator');
      await page.setViewportSize({ width: round % 2 ? 1440 : 1300, height: 900 });
      await page.waitForTimeout(150);
      await showProject('duo');
    }
    await page.waitForTimeout(1500);
    seen.outOfSightResize = errors.filter((e) => /handleResize/.test(e));
    expect.soft(seen.outOfSightResize, 'no resize left behind for a terminal already gone').toEqual([]);

    seen.pageErrors = errors;
    expect.soft(errors, 'no page error').toEqual([]);
  } finally {
    recordValues({ layout: seen });
    await app.close();
    await removeHome(home);
  }
});
