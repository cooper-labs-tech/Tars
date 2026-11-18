import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, seedSandbox, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A click on a link in a terminal opens it in the default browser, with no
 * warning, and only when it is a web page.
 *
 * Claude Code prints a URL as an OSC 8 hyperlink. xterm's own handling of a
 * click asked "this link could be dangerous" and then called window.open(''),
 * which the main process denies: the user got the warning, then nothing. The
 * click now goes to the main process (app:openExternal), which hands an http
 * or https URL to shell.openExternal and refuses anything else.
 *
 * Driven through the real app, on the Projects page's shell (Terminal.tsx), as
 * terminal-wheel.spec.ts does: the shell's profile hands the terminal to a
 * printer that writes two OSC 8 links, a https one and a file: one, then a
 * URL as plain text, which the web links addon makes a link.
 * shell.openExternal is replaced in the main process by a recorder, so nothing
 * opens on the machine running the test. Playwright dismisses any dialog and
 * records it here: the old build's warning is one.
 */

const WEB = 'https://github.com/cooper-labs-tech/ward/pull/21';
const FILE = 'file:///C:/Windows/System32/calc.exe';
/** Printed as plain text, as a dev server or `git push` prints one: no OSC 8 around it. */
const PLAIN = 'http://localhost:3000/plain';

const osc8 = (url: string, text: string) => `\\x1b]8;;${url}\\x07${text}\\x1b]8;;\\x07`;
const PRINTER = `#!${process.execPath}
process.stdout.write('${osc8(WEB, 'the pull request')}\\r\\n\\r\\n${osc8(FILE, 'a local file')}\\r\\n\\r\\nready at ${PLAIN} now\\r\\n');
process.stdin.resume();
`;

const ZSHRC = `if [[ -o interactive && -t 0 && -n "$TARS_TERMINAL_PRINTER" ]]; then
  exec "$TARS_TERMINAL_PRINTER"
fi
`;
const BASH_PROFILE = `if [[ $- == *i* && -t 0 && -n "$TARS_TERMINAL_PRINTER" ]]; then
  exec "$TARS_TERMINAL_NODE" "$TARS_TERMINAL_PRINTER"
fi
`;

const onWindows = process.platform === 'win32';
const GIT_BASH = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

test('a click on a web link in a terminal, marked or plain, opens it in the browser, with no warning, and a file: link opens nothing', async () => {
  test.setTimeout(120_000);
  test.skip(onWindows && !fs.existsSync(GIT_BASH), `Windows runs the printer through Git for Windows' bash, and there is none at ${GIT_BASH}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-links-'));
  seedSandbox(home);
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    ...(onWindows ? { terminalShell: GIT_BASH } : {}),
  }, null, 2));
  const project = path.join(home, 'projects', 'tars');
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  const printer = path.join(home, 'printer.cjs');
  fs.writeFileSync(printer, PRINTER, { mode: 0o755 });
  fs.writeFileSync(path.join(home, onWindows ? '.bash_profile' : '.zshrc'), onWindows ? BASH_PROFILE : ZSHRC);

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: apiPort(31454),
      DOROTHY_E2E: '1',
      ...(onWindows ? { TARS_TERMINAL_NODE: process.execPath } : { SHELL: '/bin/zsh' }),
      TARS_TERMINAL_PRINTER: printer,
    },
  });

  try {
    // What the main process would hand the system: recorded, never opened.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      shell.openExternal = async (url: string) => { opened.push(url); };
    });
    const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

    const page = await app.firstWindow();
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);

    await page.locator(`p[title="${project.replace(/["\\]/g, '\\$&')}"]`)
      .locator('xpath=ancestor::div[.//button[normalize-space()="open"]][1]')
      .getByRole('button', { name: 'open', exact: true })
      .click({ timeout: 20_000 });
    await page.getByTitle('Open a terminal in this folder').click();

    const rows = page.locator('.xterm-rows');
    await expect(rows).toContainText('the pull request', { timeout: 20_000 });
    await expect(rows).toContainText('a local file');
    await expect(rows).toContainText(PLAIN);

    // Hovered first: xterm finds the link under the pointer on its move, then a click activates it.
    await rows.getByText('the pull request').hover();
    await page.waitForTimeout(300);
    await rows.getByText('the pull request').click();
    await expect.poll(opened, { timeout: 5_000 }).toEqual([WEB]);

    await rows.getByText('a local file').hover();
    await page.waitForTimeout(300);
    await rows.getByText('a local file').click();
    // Long enough for a click to cross IPC: the web link's arrived well inside it.
    await page.waitForTimeout(1_000);
    expect(await opened(), 'a file: link was handed to the system').toEqual([WEB]);

    // The plain URL, clicked on its first characters: the row's text holds more than it.
    const plain = rows.getByText(PLAIN, { exact: false });
    const box = (await plain.boundingBox())!;
    const at = { x: box.x + 90, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(300);
    await page.mouse.click(at.x, at.y);
    await expect.poll(opened, { timeout: 5_000 }).toEqual([WEB, PLAIN]);

    const values = { opened: await opened(), dialogs };
    recordValues(values);
    expect(values.opened, 'only the web pages were handed to the system').toEqual([WEB, PLAIN]);
    expect(values.dialogs, 'a warning was shown').toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
