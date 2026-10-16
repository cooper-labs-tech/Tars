import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox, splashGone, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Dashboard panel mounted after a long turn starts in the modes the CLI set
 * at start: the wheel still reaches the CLI as wheel reports, and a paste of
 * several lines still arrives as one paste.
 *
 * Claude Code in fullscreen asks for the alternate screen, the mouse and
 * bracketed paste once, at start, and a turn with no input only repaints: 649
 * chunks and not one mode over 270 seconds, measured on 2.1.273. A panel
 * mounted after such a turn used to be written from agent.output, which kept
 * 600 chunks and trimmed to 400: the start was gone and every mode with it, so
 * 478f6ec put the modes back in front of the kept chunks. Since #127 a panel is
 * handed the terminal's own screen from its mirror instead, one chunk that
 * starts with RIS and carries the modes the terminal is in: the start of the
 * turn is on screen again, and the modes come with the screen. This holds what
 * a remounted panel does with it, and the agent window of the Agents page,
 * which is handed the same.
 *
 * The CLI is a recorder that asks the way Claude Code does, at start only, then
 * repaints more chunks than the old trim kept and never asks again. Every byte
 * a panel sends lands in its file. Handed a screen without its modes, the
 * remounted panel and the agent window send nothing for the wheel and the
 * paste arrives unwrapped, while the live panel before them did both.
 */

const AGENT = { id: 'replay-long-turn', name: 'Reader of a long turn' };

/** More repaints than the 600 chunks agent.output kept before #127, each written on its own. */
const REPAINTS = 1000;

/**
 * Raw mode, no echo, every byte received appended to `log` and every resize to
 * `resizes`. At start what Claude Code 2.1.273 writes in fullscreen, in its two
 * writes, then a long turn of repaints that set no mode.
 */
function recorder(log: string, resizes: string): string {
  return `const fs = require('fs');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(log)}, chunk));
process.stdout.on('resize', () => fs.appendFileSync(${JSON.stringify(resizes)}, process.stdout.columns + 'x' + process.stdout.rows + '\\n'));
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h\\x1b[?25l\\x1b[2J\\x1b[Hstart of a long turn');
setTimeout(() => {
  process.stdout.write('\\x1b[?2004h\\x1b[?2031h\\x1b[?1004h');
  let repaint = 0;
  const next = () => {
    if (repaint === ${REPAINTS}) return process.stdout.write('\\x1b[3;1H\\x1b[2Kturn over');
    process.stdout.write('\\x1b[2;1H\\x1b[2KCogitating ' + repaint++);
    setTimeout(next, 4);
  };
  setTimeout(next, 50);
}, 50);
`;
}

/** One notch of a mouse wheel, as Chromium reports it. */
const NOTCH = 100;

const WHEEL_REPORTS = /^(?:\x1b\[<(64|65);(\d+);(\d+)M)+$/;

/** Three lines as the clipboard holds them, and as xterm sends them: each line break becomes a carriage return. */
const PASTED = 'first line\nsecond line\nthird line';
const TYPED = 'first line\rsecond line\rthird line';

type AgentApi = { electronAPI: { agent: { get(id: string): Promise<{ output?: string[] } | null> } } };

test('a panel remounted after a long turn, and the agent window, still send the wheel as reports and a paste as one paste', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-replay-modes-'));
  seedSandbox(home);
  const project = path.join(home, 'projects', 'tars');
  const log = path.join(home, 'received.bin');
  const resizes = path.join(home, 'resizes.txt');
  fs.writeFileSync(log, '');
  fs.writeFileSync(resizes, '');
  const cli = writeNodeCli(path.join(home, `${AGENT.id}.cjs`), recorder(log, resizes));
  // The reader alone, idle and without a terminal, so the board's auto start
  // runs it through the agent's own CLI path.
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-09-17T08:00:00.000Z', lastActivity: '2026-09-17T08:00:00.000Z',
  }], null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31494), DOROTHY_E2E: '1' },
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

    const sent = async (phase: string, gesture: () => Promise<void>) => {
      const before = fs.statSync(log).size;
      await gesture();
      // Until the bytes have crossed IPC and the pty, and then nothing more for
      // 400 ms: a fixed 800 ms read an empty paste on CI's windows-latest, whose
      // wheel before it had landed. Bounded: 15 s with none
      // is what the assertion then reports.
      const size = () => fs.statSync(log).size;
      const until = Date.now() + 15_000;
      while (size() === before && Date.now() < until) await page.waitForTimeout(50);
      for (let last = -1; size() !== last && Date.now() < until;) {
        last = size();
        await page.waitForTimeout(400);
      }
      const bytes = fs.readFileSync(log).subarray(before).toString('latin1');
      console.log(`REPLAY ${phase}: ${Buffer.byteLength(bytes, 'latin1')} bytes ${JSON.stringify(bytes.slice(0, 60))}`);
      return bytes;
    };
    const threeNotchesUp = async () => {
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -NOTCH);
        await page.waitForTimeout(40);
      }
    };

    // The live panel read the request as the recorder wrote it.
    const live = await screenOf(page, AGENT.name);
    await expect(live.locator('.xterm-rows')).toContainText('start of a long turn', { timeout: 30_000 });
    await expect(live.locator('.xterm-rows')).toContainText('turn over', { timeout: 60_000 });

    // What a panel mounted now is handed: the terminal's screen from its
    // mirror, one chunk opening with RIS, not the chunks the turn wrote.
    const handed = await page.evaluate(id => (window as unknown as AgentApi).electronAPI.agent.get(id).then(agent => agent?.output ?? []), AGENT.id);
    console.log(`REPLAY handed ${handed.length} chunk(s), first ${JSON.stringify(handed[0]?.slice(0, 80))}`);
    expect(handed, 'one chunk: the screen').toHaveLength(1);
    expect(handed[0].startsWith('\x1bc'), 'the screen opens with RIS').toBe(true);
    expect(handed[0], 'the screen holds the end of the turn').toContain('turn over');
    recordValues({ handedChunks: handed.length, handedBytes: handed[0].length });

    // The control: before any remount, the panel that saw the start passes the
    // wheel on and wraps a paste.
    await pointAt(page, live);
    const liveWheel = await sent('live panel, three notches up', threeNotchesUp);
    expect(liveWheel, 'the live panel, which read the request').toMatch(WHEEL_REPORTS);
    expect(await sent('live panel, a paste of three lines', () => paste(live, PASTED))).toBe(`\x1b[200~${TYPED}\x1b[201~`);

    // Change page and come back: a new terminal, written by the replay alone.
    await live.evaluate(screen => screen.closest('.xterm')!.setAttribute('data-qa-mounted-before', ''));
    const resizedBefore = fs.readFileSync(resizes, 'utf8').length;
    const sidebar = page.locator('aside');
    await sidebar.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.xterm')).toHaveCount(0, { timeout: 15_000 });
    await sidebar.getByRole('link', { name: 'Dashboard', exact: true }).click();
    const remounted = await screenOf(page, AGENT.name);
    await expect(remounted.locator('.xterm-rows')).toContainText('turn over', { timeout: 30_000 });
    expect(await page.locator('.xterm[data-qa-mounted-before]').count(), 'the panel on screen is a new terminal').toBe(0);
    await expect(remounted.locator('.xterm-rows'), 'the new terminal shows the whole screen, the start of the turn included').toContainText('start of a long turn');
    // A resize would make Claude Code ask for the mouse again, and the recorder
    // never does: said here so a run that resized is read for what it is.
    console.log(`REPLAY resizes while remounting: ${JSON.stringify(fs.readFileSync(resizes, 'utf8').slice(resizedBefore))}`);

    await pointAt(page, remounted);
    const wheel = await sent('remounted panel, three notches up', threeNotchesUp);
    expect.soft(wheel, 'the wheel over the remounted panel').toMatch(WHEEL_REPORTS);
    expect.soft(new Set([...wheel.matchAll(/\x1b\[<(\d+);/g)].map(m => m[1])), 'up, and only up').toEqual(new Set(['64']));
    const pasted = await sent('remounted panel, a paste of three lines', () => paste(remounted, PASTED));
    expect.soft(pasted, 'a paste into the remounted panel').toBe(`\x1b[200~${TYPED}\x1b[201~`);

    // The other window that replays the same output: the agent's own, opened
    // from its card on the Agents page. The Kanban page is the Hermes board and
    // opens no agent terminal.
    await sidebar.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page.locator('.xterm')).toHaveCount(0, { timeout: 15_000 });
    await page.getByText(AGENT.name, { exact: true }).first().click();
    await expect(page.locator('.xterm')).toHaveCount(1, { timeout: 15_000 });
    const agentWindow = page.locator('.xterm .xterm-screen');
    await expect(page.locator('.xterm .xterm-rows')).toContainText('turn over', { timeout: 30_000 });
    await pointAt(page, agentWindow);
    const windowWheel = await sent('agent window, three notches up', threeNotchesUp);
    expect.soft(windowWheel, 'the wheel over the agent window').toMatch(WHEEL_REPORTS);
    const windowPaste = await sent('agent window, a paste of three lines', () => paste(agentWindow, PASTED));
    expect.soft(windowPaste, 'a paste into the agent window').toBe(`\x1b[200~${TYPED}\x1b[201~`);
  } finally {
    await app.close();
    await removeHome(home);
  }
});

async function pointAt(page: Page, screen: Locator): Promise<void> {
  const box = (await screen.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * A paste as the Edit menu delivers it: a paste event on the terminal's
 * textarea, which xterm reads and wraps when the program asked for bracketed
 * paste. Built here rather than read from the clipboard, which belongs to the
 * machine running the test.
 */
async function paste(screen: Locator, text: string): Promise<void> {
  await screen.evaluate((element, pasted) => {
    const textarea = element.closest('.xterm')!.querySelector('textarea.xterm-helper-textarea')!;
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

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
