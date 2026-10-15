import { test, expect, _electron as electron, type CDPSession, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, removeHome, seedSandbox, splashGone, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The wheel over a Dashboard panel reaches a full-screen CLI as wheel reports.
 *
 * Claude Code with `"tui": "fullscreen"` draws its conversation on the
 * alternate screen, where xterm has no history to scroll, and scrolls it itself
 * on SGR wheel reports it asks for (`?1000h ?1002h ?1003h ?1006h`).
 * `suppressMouseTracking` keeps the mouse from xterm and records that request;
 * `passWheelToProgram` then sends the wheel, and only the wheel, as one report
 * per line of travel at the cell under the pointer. A program that asks for
 * nothing still gets nothing, as e2e/terminal-wheel.spec.ts holds for the
 * Projects shell.
 *
 * Two agents whose CLI is a recorder start on the board: every byte a panel
 * sends lands in that agent's file. One asks for the mouse the way Claude Code
 * does, the other asks for nothing. The test takes the guard away at the end,
 * and the same wheel then types arrows: the reports before were the guard's.
 */


/** Raw mode, no echo, every byte appended to `log`; the alternate screen, and the mouse request if asked. */
function recorder(log: string, askForMouse: boolean): string {
  return `const fs = require('fs');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H');
${askForMouse ? "process.stdout.write('\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h');" : ''}
process.stdout.write('${askForMouse ? 'reader of the wheel, mouse asked for' : 'reader of the wheel, nothing asked for'}\\r\\n');
process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(log)}, chunk));
`;
}

/** One notch of a mouse wheel, as Chromium reports it. */
const NOTCH = 100;

/**
 * A trackpad swipe: the finger speeding up and slowing down, then the inertia
 * macOS keeps sending after it lifts, in fractions of a pixel.
 */
const SWIPE = [1.5, 4, 9, 15, 19, 17, 13, 10, 7.5, 5.5, 4, 3, 2.2, 1.6, 1.1, 0.8, 0.5, 0.3, 0.2, 0.1];

const WHEEL_REPORTS = /^(?:\x1b\[<(64|65);(\d+);(\d+)M)+$/;

/** Every report in a chunk, as [button, col, row]. */
function parseReports(bytes: string): Array<[number, number, number]> {
  return [...bytes.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

test('a panel sends the wheel a full-screen CLI asked for as wheel reports, and nothing to one that did not ask', async () => {
  test.setTimeout(150_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-wheel-reports-'));
  seedSandbox(home);
  const project = path.join(home, 'projects', 'tars');
  const logs = { asked: path.join(home, 'asked.bin'), plain: path.join(home, 'plain.bin') };
  const agents = [
    { id: 'wheel-asked', name: 'Reader that asked', log: logs.asked, askForMouse: true },
    { id: 'wheel-plain', name: 'Reader that did not', log: logs.plain, askForMouse: false },
  ];
  const cliPaths = new Map<string, string>();
  for (const agent of agents) {
    fs.writeFileSync(agent.log, '');
    cliPaths.set(agent.id, writeNodeCli(path.join(home, `${agent.id}.cjs`), recorder(agent.log, agent.askForMouse)));
  }
  // Only the two readers, idle and without a terminal, so the board's auto
  // start runs them, and them alone, through the agent's own CLI path.
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify(agents.map(agent => ({
    id: agent.id, name: agent.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cliPaths.get(agent.id),
    createdAt: '2026-09-16T08:00:00.000Z', lastActivity: '2026-09-16T08:00:00.000Z',
  })), null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31489), DOROTHY_E2E: '1' },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    // Hydrated first: until React holds the page, nothing the checks below wait
    // for can render, and on a runner slow to hydrate their bounds ran out on an
    // empty page on a slow runner. splashGone waits as long as the
    // spec allows for that, then holds the splash to its own cap.
    await splashGone(page);

    const asked = await screenOf(page, 'Reader that asked');
    const plain = await screenOf(page, 'Reader that did not');
    await expect(asked.locator('.xterm-rows')).toContainText('reader of the wheel, mouse asked for', { timeout: 30_000 });
    await expect(plain.locator('.xterm-rows')).toContainText('reader of the wheel, nothing asked for', { timeout: 30_000 });

    // What the page itself receives, so the count below is measured against the
    // wheel xterm saw and not against what Playwright was asked to send.
    await page.evaluate(() => {
      const seen: Array<{ deltaY: number; deltaMode: number }> = [];
      (window as unknown as { qaWheel: typeof seen }).qaWheel = seen;
      window.addEventListener('wheel', e => { seen.push({ deltaY: e.deltaY, deltaMode: e.deltaMode }); }, { capture: true, passive: true });
    });
    const travelSince = async (from: number) => page.evaluate(start => {
      const seen = (window as unknown as { qaWheel: Array<{ deltaY: number; deltaMode: number }> }).qaWheel.slice(start);
      return { count: seen.length, pixels: seen.reduce((sum, e) => sum + e.deltaY, 0), modes: [...new Set(seen.map(e => e.deltaMode))] };
    }, from);
    const wheelEvents = () => page.evaluate(() => (window as unknown as { qaWheel: unknown[] }).qaWheel.length);

    const sent = async (log: string, phase: string, gesture: () => Promise<void>) => {
      const before = fs.statSync(log).size;
      await gesture();
      // Long enough for a byte to cross IPC and the pty: the arrows at the end
      // of this test arrive well inside it.
      await page.waitForTimeout(800);
      const bytes = fs.readFileSync(log).subarray(before).toString('latin1');
      console.log(`WHEEL REPORTS ${phase}: ${Buffer.byteLength(bytes, 'latin1')} bytes ${JSON.stringify(bytes.slice(0, 40))}`);
      return bytes;
    };
    const pointAt = async (screen: Locator, x: number, y: number) => {
      const box = (await screen.boundingBox())!;
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
    };
    const notches = (direction: 1 | -1) => async () => {
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, direction * NOTCH);
        await page.waitForTimeout(40);
      }
    };
    const swipe = (direction: 1 | -1) => async () => {
      for (const delta of SWIPE) {
        await page.mouse.wheel(0, direction * delta);
        await page.waitForTimeout(16);
      }
    };
    const rowHeight = async (screen: Locator) => {
      const box = (await screen.boundingBox())!;
      const rows = await screen.locator('.xterm-rows').evaluate(el => el.childElementCount);
      return box.height / rows;
    };

    // The panel whose CLI asked: wheel reports only, one per row of travel,
    // at the cell under the pointer.
    await pointAt(asked, 0.25, 0.25);
    const height = await rowHeight(asked);
    const cases: Array<[string, 1 | -1, () => Promise<void>, number]> = [
      ['three notches up', -1, notches(-1), 64],
      ['three notches down', 1, notches(1), 65],
      ['trackpad swipe up with inertia', -1, swipe(-1), 64],
      ['trackpad swipe down with inertia', 1, swipe(1), 65],
    ];
    let first: [number, number] | undefined;
    // Down reports less up reports, against rows of travel: over the whole run
    // they differ by less than the one remainder still carried.
    let net = 0;
    let rows = 0;
    for (const [phase, direction, gesture, button] of cases) {
      const mark = await wheelEvents();
      const bytes = await sent(logs.asked, phase, gesture);
      const travel = await travelSince(mark);

      expect(travel.modes, `${phase}: the wheel Chromium delivered is in pixels`).toEqual([0]);
      expect(bytes, `${phase}: wheel reports and nothing else`).toMatch(WHEEL_REPORTS);
      const parsed = parseReports(bytes);
      expect(new Set(parsed.map(([b]) => b)), phase).toEqual(new Set([button]));
      // One per whole row of travel. A gesture starts with the remainder the one
      // before left and ends with its own, each less than a row.
      expect(Math.abs(parsed.length - Math.abs(travel.pixels) / height), `${phase}: ${parsed.length} reports for ${travel.pixels}px at ${height}px a row`).toBeLessThan(2);
      net += direction * parsed.length;
      rows += travel.pixels / height;
      expect(Math.sign(travel.pixels), phase).toBe(direction);
      expect(new Set(parsed.map(([, col, row]) => `${col};${row}`)).size, `${phase}: one cell, the one under the pointer`).toBe(1);
      first ??= [parsed[0][1], parsed[0][2]];
    }

    await pointAt(asked, 0.75, 0.75);
    const lowerMark = await wheelEvents();
    const lower = parseReports(await sent(logs.asked, 'three notches up, pointer lower right', notches(-1)));
    expect(lower.length).toBeGreaterThan(0);
    net -= lower.length;
    rows += (await travelSince(lowerMark)).pixels / height;
    expect(Math.abs(net - rows), `${net} rows reported for ${rows} rows of travel`).toBeLessThan(1);
    expect(lower[0][1], 'the column follows the pointer').toBeGreaterThan(first![0]);
    expect(lower[0][2], 'the row follows the pointer').toBeGreaterThan(first![1]);

    // The rest of the mouse stays here: a click reports nothing, which is also
    // what says xterm is not tracking the mouse and the reports above were not
    // its own. The keys still reach the CLI.
    expect(await sent(logs.asked, 'a click', async () => { await asked.click(); })).toBe('');
    expect(await sent(logs.asked, 'ArrowUp', async () => { await page.keyboard.press('ArrowUp'); })).toBe('\x1b[A');

    // The panel whose CLI asked for nothing: the wheel sends nothing at all.
    await pointAt(plain, 0.5, 0.5);
    expect(await sent(logs.plain, 'nothing asked, three notches up', notches(-1))).toBe('');
    expect(await sent(logs.plain, 'nothing asked, three notches down', notches(1))).toBe('');
    expect(await sent(logs.plain, 'nothing asked, trackpad swipe up', swipe(-1))).toBe('');

    // The control: the guard taken away from the panel that asked. xterm turns
    // the same wheel into arrow keys, so the reports were the guard's, and the
    // arrows #100 stopped would be back.
    const cdp = await page.context().newCDPSession(page);
    const index = await indexOf(page, 'Reader that asked');
    expect(await wheelGuards(cdp, index), 'the capture listener passWheelToProgram adds').toBe(1);
    expect(await wheelGuards(cdp, index, { remove: true })).toBe(1);
    expect(await wheelGuards(cdp, index)).toBe(0);
    await pointAt(asked, 0.5, 0.5);
    expect(await sent(logs.asked, 'control, three notches up', notches(-1))).toMatch(/^(\x1b\[A)+$/);
  } finally {
    await app.close();
    await removeHome(home);
  }
});

/**
 * Which `.xterm` on the page is the panel of this agent: the first ancestor
 * holding a panel header (its actions menu, one per panel) names it. It
 * looked for the live/history switch, which #273 took out of the header.
 */
async function indexOf(page: Page, agentName: string): Promise<number> {
  return page.locator('.xterm').evaluateAll((terminals, name) => terminals.findIndex(terminal => {
    let panel = terminal.parentElement;
    while (panel && !panel.querySelector('button[aria-label="Panel actions"]')) panel = panel.parentElement;
    return !!panel && (panel.textContent ?? '').includes(name);
  }), agentName);
}

async function screenOf(page: Page, agentName: string): Promise<Locator> {
  await expect.poll(() => indexOf(page, agentName), { timeout: 30_000, message: `the panel of ${agentName}` }).toBeGreaterThanOrEqual(0);
  return page.locator('.xterm').nth(await indexOf(page, agentName)).locator('.xterm-screen');
}

/**
 * How many capture-phase wheel listeners one terminal element holds, read by the
 * DevTools command line API, which hands back the listener functions
 * themselves, so they can be taken away when asked.
 */
async function wheelGuards(cdp: CDPSession, index: number, { remove = false } = {}): Promise<number> {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.querySelectorAll('.xterm')[${index}];
      const guards = (getEventListeners(element).wheel || []).filter(listener => listener.useCapture);
      if (${remove}) for (const guard of guards) element.removeEventListener('wheel', guard.listener, true);
      return guards.length;
    })()`,
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`reading the wheel listeners failed: ${exceptionDetails.text}`);
  return result.value as number;
}
