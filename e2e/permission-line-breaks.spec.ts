import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A permission question's line breaks, in the window (2.0.5, the Audit's M1 on PR 544; frame `Permission asked of
 * Tars`, its line breaks row): "echo safe" then "rm -rf important" are two commands, and the window must never read
 * them as one harmless echo.
 *
 * One agent on a stand-in of claude with the state mod, in bypass: it asks Tars about a Bash of two lines (POST
 * /api/hooks/permission, again while Tars answers `pending`), and writes the answer to a file.
 *
 * How it can fail, written before the window's change:
 * 1. the panel's line reads the break as a space ("echo safe rm -rf important");
 * 2. the panel's line or its title does not mark the break;
 * 3. the agent window shows the two commands on one line;
 * 4. an uncaught error in the page.
 * Once with the classic shell and once with the new interface: on the Dashboard's panel, and in the agent window.
 * Red on PR 538's head with the frames and the spec (the window flattening the break into a space).
 * The artefact: values.json (the line and the window's block as read), screenshots.
 */

const COMMAND = 'echo safe\nrm -rf important';

function worker(home: string): string {
  return writeNodeCli(path.join(home, 'cli-w.cjs'), [
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const dir = ${JSON.stringify(home)};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'clean the build folder' });",
    "  let answer;",
    `  do answer = await post('/api/hooks/permission', { tool: 'Bash', tool_use_id: 'toolu_two_lines', input: { command: ${JSON.stringify(COMMAND)} },`,
    "    reason: 'This call requires approval', via: 'mod' });",
    "  while (answer.decision === 'pending');",
    "  fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(answer));",
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

for (const newInterface of [false, true]) {
  test(`a permission question's line breaks are shown, never read as a space${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-permission-breaks-'));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'w', name: 'Harbor Cleaner', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'bypass',
      projectPath: project, skills: [], cliPath: worker(home), createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31576 : 31575), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.electronAPI);
      await page.evaluate(() => window.electronAPI!.agent!.start({ id: 'w', prompt: '' } as never));

      // 1, 2. The panel's line: the break marked, never a space.
      const ask = page.locator('[data-permission-ask="w"]').first();
      await expect(ask).toBeVisible({ timeout: 60_000 });
      const subject = (await ask.locator('[data-subject]').innerText()).trim();
      const title = await ask.getAttribute('title');
      seen.panel = { subject, title };
      expect(subject).toContain('⏎');
      expect(subject).not.toContain('echo safe rm');
      expect(title).toContain('echo safe ⏎ rm -rf important');
      await stepShot(page, `${tag}1-panel`);

      // 3. The agent window: each command on its own line.
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-agent-card="w"]').getByRole('button', { name: 'open', exact: true }).click({ timeout: 60_000 });
      const block = page.getByRole('dialog').locator('[data-permission-ask="w"]');
      await expect(block).toBeVisible();
      const lines = await block.locator('[data-subject-line]').allInnerTexts();
      seen.windowLines = lines;
      expect(lines.map((l) => l.trim())).toEqual(['echo safe', 'rm -rf important']);
      expect(await block.innerText()).not.toContain('echo safe rm');
      await stepShot(page, `${tag}2-window`);

      // 4.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
