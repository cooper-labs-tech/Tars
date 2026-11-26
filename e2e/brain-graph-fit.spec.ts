import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Brain's agent graph with a fleet like the maintainer's (JeanBrasse, 18/10,
 * for 2.0.4: about fifty agents, and even at 25 % the circle was too large to
 * see or to move around in). Fifty agents in seven projects, 997 memory files
 * (two projects hold 410 and 278 of them, as on the maintainer's Mac), a
 * CLAUDE.md per project, ten skills and seven MCP servers. Before 2.0.4 each
 * memory file was a box: 1,078 boxes, a ring 65,000 px wide, the zoom stopped
 * at 25 %. Then 13 % fitted. Now a project's memory files are its one box
 * (JeanBrasse, 18/10): 81 boxes, fitted near 36 % at 1440x900, and a click on
 * a project opens the list of its files, each of which opens.
 *
 * In the card More opens (and in the classic shell at /memory until 2.1.0):
 * - at open, every box is inside the canvas, the canvas is whole in the window
 *   (and in the card), and the zoom is no more than 100 %;
 * - after the window is resized, every box is inside the canvas again;
 * - zoomed in, the fit control brings every box back inside;
 * - at 100 %, dragging the canvas moves the graph with the pointer, and
 *   scrolled to its start, the graph's left and top edges can be reached;
 * - one agent clicked, its smaller graph fits too, and clicked again, the
 *   whole graph is back, fitted;
 * - a project clicked, the panel lists its memory files; one clicked, the
 *   panel shows it; files goes back to the list.
 * Frames: `Brain · Agents`, and `Brain · Agents · fifty agents, fitted`.
 *
 * The artefact: values.json with what each step measured (the zoom, the
 * canvas, the graph's bounds, the boxes outside), and a screenshot per step.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
/** Each project, its agents and its memory files, as the maintainer's seven. */
const PROJECTS: Array<[string, number, number]> = [
  ['atlas', 11, 15], ['borealis', 7, 278], ['cobalt', 7, 9], ['dune', 7, 17], ['ember', 6, 410], ['fjord', 6, 0], ['glacier', 6, 268],
];
const SKILLS = ['react-practices', 'web-guidelines', 'frontend-design', 'postgres-practices', 'security-audit', 'optimize', 'polish', 'harden', 'critique', 'audit'];
const SERVERS = 7;
const AGENTS = PROJECTS.reduce((n, [, agents]) => n + agents, 0);
const FILES = PROJECTS.reduce((n, [, , files]) => n + files, 0);
/** Projects, agents, one CLAUDE.md per project, skills, servers: a project's memory files are its own box. */
const NODES = PROJECTS.length + AGENTS + PROJECTS.length + SKILLS.length + SERVERS;
const title = (name: string) => name[0].toUpperCase() + name.slice(1);
const agentName = (project: string, i: number) => `${title(project)} ${String(i + 1).padStart(2, '0')}`;

function seed(home: string): void {
  const dir = path.join(home, '.tars');
  for (const folder of [dir, path.join(home, '.claude')]) fs.mkdirSync(folder, { recursive: true });
  const agents: unknown[] = [];
  let n = 0;
  for (const [name, count, files] of PROJECTS) {
    const project = path.join(home, 'projects', name);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), `# ${name}\n\nHow this project is worked on.\n`);
    for (let i = 0; i < count; i++, n++) {
      agents.push({
        id: `agent-${name}-${i}`, name: agentName(name, i), character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
        projectPath: project, skills: [SKILLS[n % 10], SKILLS[(n + 3) % 10], ...(n % 4 === 0 ? [SKILLS[(n + 7) % 10]] : [])],
        createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
      });
    }
    if (files === 0) continue;
    const memory = path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'MEMORY.md'), `# ${name}\n\n- the index of what the agents of ${name} remember\n`);
    for (let f = 1; f < files; f++) fs.writeFileSync(path.join(memory, `note-${String(f).padStart(3, '0')}.md`), `A note of ${name}, number ${f}.\n`);
  }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(PROJECTS.map(([name]) => path.join(home, 'projects', name))));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const servers = Object.fromEntries(Array.from({ length: SERVERS }, (_, i) => [`server-${i + 1}`, { command: 'node', args: [`server-${i + 1}.js`] }]));
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

/** What the canvas holds, measured in the page: the canvas is the scrolling element around the graph's boxes. */
type Measure = {
  zoom: string | null;
  nodes: number;
  outside: number;
  examples: string[];
  canvas: { left: number; top: number; width: number; height: number; scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number };
  graph: { left: number; top: number; right: number; bottom: number };
  canvasCut: string[];
};

async function measure(page: Page, firstAgent: string, frame: Locator | null): Promise<Measure> {
  const frameBox = frame ? await frame.evaluate(el => {
    // The card's own scrolling body: what of the page the card shows.
    const body = [...el.querySelectorAll('div')].find(d => /(auto|scroll)/.test(getComputedStyle(d).overflowY) && d.scrollHeight >= d.clientHeight) ?? el;
    const r = body.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.left + body.clientWidth, bottom: r.top + body.clientHeight };
  }) : null;
  return page.evaluate(({ firstAgent, frameBox }) => {
    // Found once from the first agent's box, then kept by a mark: with one
    // agent picked, that box is gone from the graph and the canvas is not.
    let canvas = document.querySelector<HTMLElement>('[data-e2e-canvas="1"]');
    if (!canvas) {
      // The canvas by its name, once it holds the first agent's box: at fit it
      // does not scroll, so it is no longer the first scrolling ancestor.
      const first = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').startsWith(firstAgent));
      canvas = first?.closest<HTMLElement>('[aria-label="Agent graph"]') ?? null;
      canvas?.setAttribute('data-e2e-canvas', '1');
    }
    const zoom = document.querySelector('button[title="Back to 100%"]')?.textContent?.trim() ?? null;
    if (!canvas) {
      return { zoom, nodes: 0, outside: 0, examples: ['no canvas'], canvas: { left: 0, top: 0, width: 0, height: 0, scrollLeft: 0, scrollTop: 0, scrollWidth: 0, scrollHeight: 0 }, graph: { left: 0, top: 0, right: 0, bottom: 0 }, canvasCut: [] };
    }
    const c = canvas.getBoundingClientRect();
    const box = { left: c.left + canvas.clientLeft, top: c.top + canvas.clientTop, width: canvas.clientWidth, height: canvas.clientHeight };
    const nodes = [...canvas.querySelectorAll('button')];
    let outside = 0;
    const examples: string[] = [];
    const graph = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      graph.left = Math.min(graph.left, r.left); graph.top = Math.min(graph.top, r.top);
      graph.right = Math.max(graph.right, r.right); graph.bottom = Math.max(graph.bottom, r.bottom);
      const inside = r.left >= box.left - 0.5 && r.top >= box.top - 0.5 && r.right <= box.left + box.width + 0.5 && r.bottom <= box.top + box.height + 0.5;
      if (!inside) {
        outside += 1;
        if (examples.length < 4) examples.push(`${(node.textContent ?? '').slice(0, 30)} at ${Math.round(r.left)},${Math.round(r.top)}`);
      }
    }
    // The canvas whole: in the window, and in the card when there is one.
    const canvasCut: string[] = [];
    const limits = [{ name: 'window', left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, ...(frameBox ? [{ name: 'card', ...frameBox }] : [])];
    for (const l of limits) {
      if (box.left < l.left - 0.5 || box.top < l.top - 0.5 || box.left + box.width > l.right + 0.5 || box.top + box.height > l.bottom + 0.5) {
        canvasCut.push(`${l.name}: canvas ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)} past ${Math.round(l.right)}x${Math.round(l.bottom)}`);
      }
    }
    return {
      zoom, nodes: nodes.length, outside, examples,
      canvas: { ...box, scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop, scrollWidth: canvas.scrollWidth, scrollHeight: canvas.scrollHeight },
      graph, canvasCut,
    };
  }, { firstAgent, frameBox });
}

test(`brain: fifty agents and a thousand files fit the canvas at open, after a resize and from fit, and the graph pans`, async () => {
  test.setTimeout(420_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-brain-fit-'));
  seed(home);
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31420), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = { nodesSeeded: NODES, agents: AGENTS, memoryFiles: FILES };
  const tag = 'new-';
  const first = agentName(PROJECTS[0][0], 0);
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });

    // Brain, in the card More opens, on its Agents tab.
    let frame: Locator | null = null;
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    await sidebar.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Brain' }).click();
    frame = page.getByRole('dialog', { name: 'Brain' });
    await frame.getByRole('radio', { name: 'Agents' }).click();
    const scope = frame ?? page;
    const read = () => measure(page, first, frame);
    // Every box in, or the last reading after the wait: soft checks follow,
    // so a build that does not fit is measured at every step.
    const settle = async (label: string, wait = 10_000) => {
      const until = Date.now() + wait;
      let m = await read();
      while ((m.outside > 0 || m.nodes === 0) && Date.now() < until) {
        await page.waitForTimeout(200);
        m = await read();
      }
      seen[label] = m;
      return m;
    };

    // The whole graph, laid out: every box of it, once nothing covers it.
    await expect.poll(async () => (await read()).nodes, { timeout: 120_000 }).toBeGreaterThanOrEqual(NODES);
    await expect(scope.getByText('Switching agent', { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // 1. At open.
    const atOpen = await settle('atOpen');
    await stepShot(page, `${tag}01-at-open`);
    expect.soft(atOpen.nodes, 'every box drawn').toBe(NODES);
    expect.soft(atOpen.outside, `boxes outside the canvas at open: ${atOpen.examples.join('; ')}`).toBe(0);
    expect.soft(atOpen.canvasCut, 'the canvas whole at open').toEqual([]);
    expect.soft(parseInt(atOpen.zoom ?? '0', 10), 'no more than 100 %').toBeLessThanOrEqual(100);
    // Near 26 % in the card's canvas (36 % in the classic shell's larger one, until 2.1.0).
    expect.soft(parseInt(atOpen.zoom ?? '0', 10), 'fitted near a third, not at 13 %').toBeGreaterThanOrEqual(24);

    // 2. After a resize, smaller then back.
    await page.setViewportSize({ width: 1180, height: 760 });
    const smaller = await settle('afterResizeSmaller');
    await stepShot(page, `${tag}02-after-resize`);
    expect.soft(smaller.outside, `boxes outside after the resize: ${smaller.examples.join('; ')}`).toBe(0);
    expect.soft(smaller.canvasCut, 'the canvas whole after the resize').toEqual([]);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Back to its size, the graph is fitted to it again, not left at the
    // smaller window's zoom: every box was inside before the fit too.
    const until = Date.now() + 10_000;
    let back = await read();
    while ((back.outside > 0 || back.zoom !== atOpen.zoom) && Date.now() < until) {
      await page.waitForTimeout(200);
      back = await read();
    }
    seen.afterResizeBack = back;
    expect.soft(back.outside, 'boxes outside after the window is back').toBe(0);
    expect.soft(back.zoom, 'the zoom of the window\'s size again').toBe(atOpen.zoom);

    // 3. Zoomed in, then fit.
    for (let i = 0; i < 5; i++) await scope.getByRole('button', { name: 'Zoom in' }).click({ timeout: 20_000 });
    const zoomed = await read();
    seen.zoomedIn = zoomed;
    expect.soft(zoomed.outside, 'zooming in leaves boxes outside').toBeGreaterThan(0);
    await scope.getByRole('button', { name: 'fit', exact: true }).click();
    const fitted = await settle('afterFit', 5_000);
    await stepShot(page, `${tag}03-after-fit`);
    expect.soft(fitted.outside, `boxes outside after fit: ${fitted.examples.join('; ')}`).toBe(0);

    // 4. At 100 %: the graph's start can be scrolled to, and a drag pans it.
    await scope.locator('button[title="Back to 100%"]').click();
    await expect.poll(async () => (await read()).zoom).toBe('100%');
    const canvas = page.locator('[data-e2e-canvas="1"]');
    await expect(canvas, 'the canvas, marked by the first reading').toHaveCount(1);
    await canvas.evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    await page.waitForTimeout(300);
    const start = await read();
    seen.scrolledToStart = start;
    expect.soft(start.graph.left, 'the graph\'s left edge can be scrolled to').toBeGreaterThanOrEqual(start.canvas.left - 0.5);
    expect.soft(start.graph.top, 'the graph\'s top edge can be scrolled to').toBeGreaterThanOrEqual(start.canvas.top - 0.5);
    await canvas.evaluate(el => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
    await page.waitForTimeout(300);
    const before = await read();
    // A point of the canvas with no box under it, where a drag starts.
    const spot = await page.evaluate(({ c }) => {
      for (let y = c.top + 30; y < c.top + c.height - 30; y += 17) {
        for (let x = c.left + 30; x < c.left + c.width - 30; x += 23) {
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest('button') && hit.closest('[data-e2e-canvas="1"]')) return { x, y };
        }
      }
      return null;
    }, { c: before.canvas });
    expect(spot, 'a point of the canvas with no box under it').not.toBeNull();
    await page.mouse.move(spot!.x, spot!.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(spot!.x - 24 * i, spot!.y - 15 * i);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await read();
    seen.drag = { from: spot, by: { x: -240, y: -150 }, before: before.canvas, after: after.canvas };
    await stepShot(page, `${tag}04-after-drag`);
    expect.soft(after.canvas.scrollLeft - before.canvas.scrollLeft, 'a drag left scrolls the graph with the pointer').toBeCloseTo(240, -1);
    expect.soft(after.canvas.scrollTop - before.canvas.scrollTop, 'a drag up scrolls the graph with the pointer').toBeCloseTo(150, -1);

    // 5. One agent, then all of them again.
    await scope.getByRole('button', { name: 'fit', exact: true }).click();
    await settle('beforeOneAgent', 5_000);
    const ember = agentName('ember', 0);
    await page.locator('[data-e2e-canvas="1"] button', { hasText: ember }).click({ timeout: 20_000 });
    await expect(scope.getByText('Switching agent', { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await read()).nodes, { timeout: 30_000 }).toBeLessThan(atOpen.nodes);
    const one = await settle('oneAgent');
    await stepShot(page, `${tag}05-one-agent`);
    expect.soft(one.nodes, 'the boxes of one agent: its project, itself, the CLAUDE.md files and its tools').toBeLessThan(40);
    expect.soft(one.outside, `boxes outside with one agent: ${one.examples.join('; ')}`).toBe(0);
    await page.locator('[data-e2e-canvas="1"] button', { hasText: ember }).click({ timeout: 20_000 });
    await expect(scope.getByText('Switching agent', { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await read()).nodes, { timeout: 30_000 }).toBe(atOpen.nodes);
    const all = await settle('allAgentsAgain');
    expect.soft(all.outside, 'boxes outside with every agent back').toBe(0);

    // 6. A project's memory files: its box opens their list, a file opens, files goes back.
    const box = page.locator('[data-e2e-canvas="1"] button', { hasText: /^ember\s*410 memory files$/ });
    await box.click({ timeout: 20_000 });
    const list = page.getByRole('list', { name: 'Memory files of ember' });
    await expect.soft(list.getByRole('button'), 'the project\'s 410 files listed').toHaveCount(410, { timeout: 10_000 });
    seen.projectFiles = { listed: await list.getByRole('button').count() };
    await stepShot(page, `${tag}06-project-memory-files`);
    if (await list.count()) {
      await list.getByRole('button', { name: /^note-007\.md/ }).click();
      await expect.soft(page.getByText('A note of ember, number 7.'), 'the file opened in the panel').toBeVisible({ timeout: 10_000 });
      await stepShot(page, `${tag}07-a-memory-file`);
      await page.getByRole('button', { name: 'files', exact: true }).click();
      await expect.soft(list.getByRole('button'), 'back to the list').toHaveCount(410, { timeout: 10_000 });
      await page.getByRole('button', { name: 'close', exact: true }).click();
      await expect.soft(list, 'the panel closed').toHaveCount(0);
    }

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    // Kept red or green: what each step measured is the artefact.
    recordValues({ seen, pageErrors: errors });
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
