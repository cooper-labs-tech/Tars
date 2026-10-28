import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A permission question about a file tool, its content withheld from Tars (2.0.5, PR 538's `permissionAsk.withheld`;
 * frame `Permission asked of Tars`, its withheld row): the window shows the path alone, says the content is withheld,
 * and offers deny and ask in terminal, never allow nor show all.
 *
 * One agent on a stand-in of claude with the state mod, in bypass (since PR 538's ff0e3f2d, a withheld question comes
 * from a bypass agent only): it asks Tars about a Write into its project by the path alone (POST /api/hooks/permission
 * with `withheld: true`, again while Tars answers `pending`), and writes the answer to a file.
 *
 * How it can fail, written before the window's change:
 * 1. the panel offers allow, or show all, which leads to allow;
 * 2. the panel does not show the path, or does not say the content is withheld;
 * 3. deny or ask in terminal is missing;
 * 4. deny does not refuse it: the agent does not read deny;
 * 5. in the agent window, allow is offered, or ask in terminal does not hand it to Claude Code's own dialog, or its
 *    title does not say that dialog has no delay;
 * 6. an uncaught error in the page.
 * Once with the classic shell and once with the new interface: on the Dashboard's panel (1 to 4), and in the agent
 * window from the Agents page (5).
 * Red on PR 538's head with the frames (the commit before the spec): allow and show all are offered.
 * The artefact: values.json (the panel's line and buttons, the answer), screenshots.
 */

const FILE = 'src/app/settings/page.tsx';

function worker(home: string, project: string): string {
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
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'give the settings page its new title' });",
    "  let answer;",
    `  do answer = await post('/api/hooks/permission', { tool: 'Write', tool_use_id: 'toolu_write', input: { file_path: path.join(${JSON.stringify(project)}, ${JSON.stringify(FILE)}) },`,
    "    reason: 'This call requires approval', via: 'mod', withheld: true });",
    "  while (answer.decision === 'pending');",
    "  fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(answer));",
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

for (const newInterface of [false, true]) for (const where of ['panel', 'window'] as const) {
  test(`a withheld file question shows its path alone and offers deny and ask in terminal, never allow, in the ${where}${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-permission-withheld-'));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(path.join(project, 'src', 'app', 'settings'), { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'w', name: 'Harbor Writer', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'bypass',
      projectPath: project, skills: [], cliPath: worker(home, project), createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface, where };
    const tag = `${newInterface ? 'new-' : ''}${where}-`;
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort((newInterface ? 31570 : 31569) + (where === 'window' ? 2 : 0)), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.electronAPI);
      await page.evaluate(() => window.electronAPI!.agent!.start({ id: 'w', prompt: '' } as never));

      // 2. The path alone, said withheld: on the Dashboard's panel, or in the agent window opened from its card.
      if (where === 'window') {
        await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-agent-card="w"]').getByRole('button', { name: 'open', exact: true }).click({ timeout: 60_000 });
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      const ask = (where === 'window' ? page.getByRole('dialog') : page).locator('[data-permission-ask="w"]').first();
      await expect(ask).toBeVisible({ timeout: 60_000 });
      const subject = ask.locator('[data-subject]');
      await expect(subject).toContainText('page.tsx');
      await expect(ask).toContainText('content withheld');
      const buttons = (await ask.getByRole('button').allInnerTexts()).map((b) => b.trim().toLowerCase());
      seen.line = (await ask.innerText()).replace(/\s+/g, ' ');
      seen.buttons = buttons;
      await stepShot(page, `${tag}1-withheld`);

      // 1, 3. Never allow nor show all; deny and ask in terminal.
      expect(buttons).not.toContain('allow');
      expect(buttons).not.toContain('show all');
      expect(buttons).toContain('deny');
      expect(buttons).toContain('ask in terminal');

      const terminal = ask.getByRole('button', { name: 'ask in terminal' });
      await expect(terminal).toHaveAttribute('title', "Claude Code's own dialog, which has no delay: answer it there");
      const answered = async () => {
        await expect.poll(() => fs.existsSync(path.join(home, 'answer.json')), { timeout: 30_000 }).toBe(true);
        return JSON.parse(fs.readFileSync(path.join(home, 'answer.json'), 'utf8')) as { decision: string };
      };
      if (where === 'panel') {
        // 4. deny refuses it.
        await ask.getByRole('button', { name: 'deny' }).click();
        await ask.getByRole('button', { name: 'deny' }).click();
        const answer = await answered();
        seen.answer = answer;
        expect(answer.decision).toBe('deny');
      } else {
        // 5. ask in terminal hands it to Claude Code's own dialog.
        await terminal.click();
        const answer = await answered();
        seen.answer = answer;
        expect(answer.decision).toBe('ask');
        await stepShot(page, `${tag}2-asked-in-terminal`);
      }

      // 6.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
