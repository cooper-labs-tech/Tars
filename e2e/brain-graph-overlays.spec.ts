import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Brain's agent graph at fit, clear of what the canvas draws over it (the QA's
 * L1 and L2 at the gate of #454, 18/10). A small fleet, the most common one:
 * one project, three agents, its CLAUDE.md and two MCP servers. On #454 its
 * boxes sat in the canvas's corners at fit, one under the zoom controls (top
 * right) and one under the legend (bottom left), with the new interface at
 * 1440x900 and in the classic shell at 1180x760. In the new shell, the only
 * one since 2.1.0, at both sizes: no box under either.
 *
 * Then the canvas's scrollbars are made to take room, 17 px, as on Windows and
 * Linux (macOS draws them over the content, so a spec never meets them
 * otherwise), the graph is zoomed in and fitted again: no scrollbar is left
 * and the graph is back at its margin. On #454, in the classic shell, fit kept
 * both scrollbars and moved the graph 17 px up and left.
 *
 * The artefact: values.json (every box, the overlays and the canvas at each
 * size, and the canvas after the fit), and a screenshot per step.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const CANVAS = '[aria-label="Agent graph"]';
const SCROLLBARS_THAT_TAKE_ROOM = `${CANVAS} { scrollbar-width: auto !important; scrollbar-color: auto !important; }
${CANVAS}::-webkit-scrollbar { width: 17px; height: 17px; }
${CANVAS}::-webkit-scrollbar-thumb { background: #888; }
${CANVAS}::-webkit-scrollbar-track { background: #333; }`;
/** One project, three agents, its CLAUDE.md, two servers. */
const BOXES = 7;

function seed(home: string): void {
  const dir = path.join(home, '.tars');
  const project = path.join(home, 'projects', 'atlas');
  for (const folder of [dir, path.join(home, '.claude'), project]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# atlas\n');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([1, 2, 3].map(i => ({
    id: `agent-atlas-${i}`, name: `Atlas 0${i}`, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({
    mcpServers: { 'server-1': { command: 'node', args: ['s1.js'] }, 'server-2': { command: 'node', args: ['s2.js'] } },
  }, null, 2));
}

/** The canvas, its boxes and the two overlays, and which boxes sit under which. */
const measure = (page: Page) => page.evaluate((sel) => {
  const el = document.querySelector<HTMLElement>(sel)!;
  const rect = (r: DOMRect) => ({ l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) });
  const controls = document.querySelector('button[aria-label="Zoom out"]')?.parentElement?.getBoundingClientRect();
  const legend = [...document.querySelectorAll('p')].find(p => p.textContent?.startsWith('agents share this project'))?.parentElement?.getBoundingClientRect();
  const boxes = [...el.querySelectorAll('button')].map(b => ({ label: (b.textContent ?? '').slice(0, 30), ...rect(b.getBoundingClientRect()) }));
  const under = (o: DOMRect | undefined) => (!o ? [] : boxes.filter(x => x.l < o.right && x.r > o.left && x.t < o.bottom && x.b > o.top).map(x => x.label));
  const canvas = el.getBoundingClientRect();
  return {
    zoom: document.querySelector('button[title="Back to 100%"]')?.textContent?.trim() ?? null,
    canvas: { ...rect(canvas), offsetWidth: el.offsetWidth, offsetHeight: el.offsetHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop },
    controls: controls ? rect(controls) : null,
    legend: legend ? rect(legend) : null,
    boxes,
    margin: { left: Math.min(...boxes.map(x => x.l)) - Math.round(canvas.left), top: Math.min(...boxes.map(x => x.t)) - Math.round(canvas.top) },
    underControls: under(controls),
    underLegend: under(legend),
  };
}, CANVAS);

test(`brain: a small graph at fit keeps every box clear of the zoom controls and the legend, and fit leaves no scrollbar`, async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-brain-overlays-'));
  seed(home);
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31427), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = { boxes: BOXES };
  const tag = 'new-';
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });

    // Brain, in the card More opens, on its Agents tab.
    let scope: Page | Locator = page;
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    await sidebar.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Brain' }).click();
    scope = page.getByRole('dialog', { name: 'Brain' });
    await scope.getByRole('radio', { name: 'Agents' }).click();
    await expect(page.locator(`${CANVAS} button`)).toHaveCount(BOXES, { timeout: 60_000 });
    await expect(scope.getByText('Switching agent', { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // 1. At fit, at the default window and at 1180x760: no box under the controls or the legend.
    for (const [width, height] of [[1440, 900], [1180, 760]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(1_000);
      const m = await measure(page);
      seen[`fit ${width}x${height}`] = m;
      await stepShot(page, `${tag}01-fit-${width}x${height}`);
      expect.soft(m.controls, 'the zoom controls are drawn').not.toBeNull();
      expect.soft(m.legend, 'the legend is drawn').not.toBeNull();
      expect.soft(m.underControls, `boxes under the zoom controls at ${width}x${height}`).toEqual([]);
      expect.soft(m.underLegend, `boxes under the legend at ${width}x${height}`).toEqual([]);
    }

    // 2. Scrollbars that take room: zoomed in, they show; fit takes them away and puts the graph back at its margin.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(1_000);
    await page.addStyleTag({ content: SCROLLBARS_THAT_TAKE_ROOM });
    for (let i = 0; i < 3; i++) await scope.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(800);
    const zoomed = await measure(page);
    seen.zoomedIn = zoomed;
    expect(zoomed.canvas.clientWidth, 'zoomed in, the scrollbars take their room').toBeLessThan(zoomed.canvas.offsetWidth);
    await scope.getByRole('button', { name: 'fit', exact: true }).click();
    await page.waitForTimeout(800);
    const fitted = await measure(page);
    seen.fitAgain = fitted;
    await stepShot(page, `${tag}02-fit-again-with-scrollbars-that-take-room`);
    expect.soft(fitted.canvas.clientWidth, 'no vertical scrollbar left at fit').toBe(fitted.canvas.offsetWidth);
    expect.soft(fitted.canvas.clientHeight, 'no horizontal scrollbar left at fit').toBe(fitted.canvas.offsetHeight);
    expect.soft([fitted.canvas.scrollLeft, fitted.canvas.scrollTop], 'nothing scrolled at fit').toEqual([0, 0]);
    expect.soft(fitted.margin.left, 'the graph back at its left margin').toBeGreaterThanOrEqual(24);
    expect.soft(fitted.margin.top, 'the graph back at its top margin').toBeGreaterThanOrEqual(24);
    expect.soft(fitted.underControls, 'boxes under the zoom controls after fit').toEqual([]);
    expect.soft(fitted.underLegend, 'boxes under the legend after fit').toEqual([]);

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    // Kept red or green: what each step measured is the artefact.
    recordValues({ seen, pageErrors: errors });
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
