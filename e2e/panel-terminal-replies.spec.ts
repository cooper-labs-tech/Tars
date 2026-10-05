import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A mounted Dashboard panel sends its terminal's replies to nobody: the
 * panels' side of the held-message bug of 04/10 (#314). A CLI asked the colour
 * of the background (`ESC ] 11 ; ?`), the panel's xterm answered through
 * onData, and the answer went to the agent's terminal as if typed.
 *
 * The CLI is a recorder in raw mode: at start it asks what Claude Code asks,
 * and more: the colours (OSC 4, 10, 11, 12, ended by BEL and by ST), the
 * insert mode (DECRQM for an ANSI mode), xterm's version (its reply a device
 * string) and the text area's size (a window report, which xterm 5.3 sends only
 * when allowed). Every byte it receives lands in its file. Nobody types until
 * the queries are answered, so the file must stay empty; then two keys typed
 * into the panel must arrive, and they alone, which shows the panel was
 * listening all along.
 *
 * The artefact: what the recorder received, as escaped text, in values.json,
 * and the panel with its queries asked.
 */

const AGENT = { id: 'reply-asker', name: 'Asker of questions' };

const QUERIES = [
  '\\x1b]11;?\\x07', '\\x1b]10;?\\x1b\\\\', '\\x1b]4;1;?\\x07', '\\x1b]12;?\\x1b\\\\',
  '\\x1b[4$p', '\\x1b[?2004$p', '\\x1b[>q', '\\x1b[18t',
];

function recorder(log: string): string {
  return `#!${process.execPath}
const fs = require('fs');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(log)}, chunk));
process.stdout.write('${QUERIES.join('')}');
setTimeout(() => process.stdout.write('queries asked\\r\\n'), 300);
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

const escaped = (bytes: string) => JSON.stringify(bytes);

test('a mounted panel sends its terminal\'s replies to nobody, and the keys typed into it through', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-panel-replies-'));
  seedSandbox(home);
  const project = path.join(home, 'projects', 'tars');
  const log = path.join(home, 'received.bin');
  fs.writeFileSync(log, '');
  const cli = path.join(home, `${AGENT.id}.cjs`);
  fs.writeFileSync(cli, recorder(log), { mode: 0o755 });
  // The asker alone, idle and without a terminal, so the board's auto start
  // runs it through the agent's own CLI path.
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  }], null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31463), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });

    const screen = await screenOf(page, AGENT.name);
    await expect(screen.locator('.xterm-rows')).toContainText('queries asked', { timeout: 60_000 });
    // Long enough for a reply to cross IPC and the pty.
    await page.waitForTimeout(1500);
    const replies = fs.readFileSync(log, 'latin1');
    await stepShot(page, '01-queries-asked');

    // The control: what is typed into the panel arrives, and nothing else.
    const box = (await screen.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('ok');
    await expect.poll(() => fs.readFileSync(log, 'latin1'), { timeout: 15_000 }).toBe(replies + 'ok');

    recordValues({ queries: QUERIES, receivedBeforeTyping: escaped(replies), receivedAfterTyping: escaped(fs.readFileSync(log, 'latin1')) });
    expect(escaped(replies), 'the replies the panel sent as keys').toBe(escaped(''));
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
