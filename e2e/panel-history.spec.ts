import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Dashboard panel keeps 5,000 lines of history, where it kept 10,000
 * (Noah's choice 9 of 05/10, RD-RAM.md: a full panel weighed 32.6 MB at
 * 10,000 lines, 7.6 MB at 2,000). The transcript keeps everything; what a
 * panel scrolls back through is xterm's scrollback.
 *
 * The CLI writes 7,000 numbered lines in the normal buffer, more than 5,000
 * and fewer than 10,000, then waits. It writes them once the panel shows its
 * first line and a key is typed into it: written before the panel is there,
 * they reach it through the terminal's mirror (core/terminal-mirror.ts), which
 * keeps 2,500, and that is not what this measures. Measured on a Windows
 * runner on 2026-10-08: the writer was done before the Dashboard drew its
 * panel, which held the mirror's 2,500 lines and its 30 rows.
 *
 * The panel's buffer is read from its DOM:
 * the viewport's scroll height over the height of a row is the number of lines
 * xterm holds, the screen's rows included; scrolled to the top, its first row
 * is the oldest line kept. Kept 10,000, the panel held all 7,001 lines and
 * started at line 1.
 *
 * The artefact: the measures in values.json, and the panel at the top of its
 * history.
 */

const AGENT = { id: 'history-writer', name: 'Writer of a long history' };
const WRITTEN = 7000;
const KEPT = 5000;

/** The key that starts the history: in nothing a terminal answers on its own, such as ConPTY's cursor report. */
const GO = 'g';

function writer(): string {
  return `process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('ready for the history\\n');
let written = false;
process.stdin.on('data', data => {
  if (written || !String(data).includes('${GO}')) return;
  written = true;
  let out = '';
  for (let i = 1; i <= ${WRITTEN}; i++) out += 'line ' + i + '\\n';
  process.stdout.write(out + 'history written');
});
`;
}

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

/** How many lines the panel's xterm holds, its rows, and the first row's text once scrolled to the top. */
function measure(screen: Locator) {
  return screen.evaluate(async el => {
    const xterm = el.closest('.xterm') as HTMLElement;
    const viewport = xterm.querySelector('.xterm-viewport') as HTMLElement;
    const rows = Array.from(xterm.querySelectorAll('.xterm-rows > div')) as HTMLElement[];
    const rowHeight = rows[0].getBoundingClientRect().height;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 300));
    return {
      lines: Math.round(viewport.scrollHeight / rowHeight),
      rows: rows.length,
      rowHeight,
      top: (rows[0].textContent ?? '').trim(),
    };
  });
}

test('a Dashboard panel keeps the last 5,000 lines of history, not 10,000', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-panel-history-'));
  seedSandbox(home);
  const project = path.join(home, 'projects', 'tars');
  // writeNodeCli: the script itself on macOS and Linux, npm's shim beside it on Windows.
  const cli = writeNodeCli(path.join(home, `${AGENT.id}.cjs`), writer());
  // The writer alone, idle and without a terminal, so the board's auto start
  // runs it through the agent's own CLI path.
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  }], null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31465), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });

    const screen = await screenOf(page, AGENT.name);
    await expect(screen.locator('.xterm-rows')).toContainText('ready for the history', { timeout: 60_000 });
    await screen.click();
    await page.keyboard.press(GO);
    await expect(screen.locator('.xterm-rows')).toContainText('history written', { timeout: 60_000 });
    const kept = await measure(screen);
    recordValues({ written: WRITTEN + 1, kept });
    await stepShot(page, '01-top-of-the-history');

    // Every line the screen shows, and the 5,000 above it.
    expect(kept.lines, `the panel holds ${kept.lines} lines for ${kept.rows} rows`).toBe(KEPT + kept.rows);
    // The oldest line kept: the 7,001 written, less the 5,000 and the rows.
    expect(kept.top).toBe(`line ${WRITTEN + 1 - KEPT - kept.rows + 1}`);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
