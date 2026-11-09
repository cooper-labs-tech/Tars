import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Ask in terminal leads to the terminal (the owner's report of 10/11: from a chat, "ask in terminal" seemed to do
 * nothing; frame `Permission asked of Tars`, its row `ask in terminal from a chat`).
 *
 * The orchestrator of project harbor runs a stand-in of claude with the state mod: it asks Tars about a call
 * (POST /api/hooks/permission, again while Tars answers `pending`), and when Tars hands the question back (`ask`) it
 * prints Claude Code's own dialog in its terminal, as Claude Code does.
 *
 * How it can fail, written before the window's change:
 * 1. on a chat's page, which shows no terminal, ask in terminal hands the question back and nothing else: no
 *    terminal shows the dialog that now waits;
 * 2. the window that opens is not that orchestrator's, or its terminal does not show the dialog;
 * 3. the question is not handed back (the stand-in does not read `ask`);
 * 4. on the Dashboard's panel, where the terminal is already under the question, a window opens over it;
 * 5. an uncaught error in the page;
 * 6. on a chat's page, ask in terminal clicked on a question Tars no longer holds (answered elsewhere first) opens
 *    the window all the same, over no dialog (the Audit's L1 on PR 578). The question is denied through main and the
 *    button clicked in the same step, before the window hears of it; main takes the deny first and answers the ask
 *    false. The card's late line is not read: the deny clears the question, and the card with it;
 * 7. the window a chat's page opens has no project list: its side panel says "No projects added yet" whatever the
 *    fleet has (QA's L1 on PR 578), where the Agents page's window lists them.
 * The chat's page exists in the new interface only; the Dashboard's panel is the classic shell's.
 * Red on main (58f2863b4) with the frames: on the chat's page no window opens. Case 6 is red on a mutant that opens
 * the window without `taken` (PermissionAskNotice's answer). Case 7 is red at 9c7efa146 (no projects passed); the
 * Dashboard case (4) is red on a mutant whose panel opens the window over itself (QA's L2; the mutant is in the PR's report).
 * The artefact: values.json (the answer, the window's name and its terminal's lines), screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const CHAT = 'c0ffee00-0000-4000-8000-0000000000a1';
const DIALOG = 'Do you want to proceed?';

function standIn(home: string): string {
  return writeNodeCli(path.join(home, 'lead.cjs'), [
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const dir = ${JSON.stringify(home)};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "const pause = ms => new Promise(r => setTimeout(r, ms));",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'look at the dashboard in Chrome' });",
    "  let answer;",
    "  do { answer = await post('/api/hooks/permission', { tool: 'mcp__claude-in-chrome__tabs_context_mcp', tool_use_id: 'toolu_chrome', input: {},",
    "    reason: 'This call requires approval', via: 'mod' }); if (answer.decision === 'pending') await pause(300); }",
    "  while (answer.decision === 'pending');",
    "  fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(answer));",
    // What Claude Code does with `ask`: its own dialog, in the terminal.
    `  if (answer.decision === 'ask') process.stdout.write(' Tool use\\r\\n   claude-in-chrome - tabs_context_mcp (MCP)\\r\\n ${DIALOG}\\r\\n > 1. Yes\\r\\n   2. No\\r\\n');`,
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

for (const { newInterface, late } of [{ newInterface: true, late: false }, { newInterface: false, late: false }, { newInterface: true, late: true }]) {
  const where = newInterface ? 'a chat\'s page (new interface)' : 'the Dashboard\'s panel';
  const name = late
    ? 'ask in terminal on a question Tars no longer holds opens no window, from a chat\'s page (new interface)'
    : `ask in terminal leads to the terminal that shows Claude Code's dialog, from ${where}`;
  test(name, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-ask-terminal-'));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const at = '2026-11-10T08:00:00.000Z';
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'lead', name: 'Harbor Orchestrator', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator',
      orchestratorMode: true, permissionMode: 'bypass', projectPath: project, skills: [], cliPath: standIn(home),
      createdAt: at, lastActivity: at,
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, numbers: { [project]: 1 }, chats: [{
      id: CHAT, projectPath: project, number: 1, title: 'Main', titleSource: 'user', runnerId: 'lead',
      sessionIds: [], pinned: false, snoozedUntil: null, settledAt: null, inbox: true, createdAt: at, updatedAt: at, lastActivityAt: at,
    }] }, null, 2));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface, late };
    const tag = late ? 'new-chat-late-' : newInterface ? 'new-chat-' : 'dashboard-';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(late ? 31597 : newInterface ? 31595 : 31596), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(newInterface ? `${DEV_URL}/chats/?chat=${CHAT}` : `${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
      await page.waitForFunction(() => !!window.electronAPI);
      await page.evaluate(() => window.electronAPI!.agent!.start({ id: 'lead', prompt: '' } as never));

      const ask = (newInterface ? page.getByRole('main') : page).locator('[data-permission-ask="lead"]').first();
      await expect(ask).toBeVisible({ timeout: 60_000 });
      await expect(ask).toContainText('tabs_context_mcp');
      await stepShot(page, `${tag}1-asked`);

      if (late) {
        // 6. Denied through main, then ask in terminal clicked in the same step: Tars no longer holds the question.
        await page.evaluate(() => {
          void window.electronAPI!.agent!.answerPermission('lead', 'deny');
          const button = [...document.querySelectorAll('[data-permission-ask="lead"] button')]
            .find(b => b.textContent?.trim() === 'ask in terminal') as HTMLButtonElement | undefined;
          button?.click();
        });
        await expect.poll(() => fs.existsSync(path.join(home, 'answer.json')), { timeout: 30_000 }).toBe(true);
        seen.answer = JSON.parse(fs.readFileSync(path.join(home, 'answer.json'), 'utf8'));
        expect(seen.answer).toMatchObject({ decision: 'deny' });
        await page.waitForTimeout(1_500);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await stepShot(page, `${tag}2-no-window`);
        seen.errors = errors;
        expect(errors).toEqual([]);
        return;
      }

      // 3. ask in terminal hands it back: the stand-in reads `ask` and shows its dialog.
      await ask.getByRole('button', { name: 'ask in terminal' }).click();
      await expect.poll(() => fs.existsSync(path.join(home, 'answer.json')), { timeout: 30_000 }).toBe(true);
      seen.answer = JSON.parse(fs.readFileSync(path.join(home, 'answer.json'), 'utf8'));
      expect(seen.answer).toMatchObject({ decision: 'ask' });
      await expect(ask).toHaveCount(0, { timeout: 30_000 });

      if (newInterface) {
        // 1, 2. The orchestrator's window opens, its terminal showing the dialog.
        const win = page.getByRole('dialog').filter({ hasText: 'Harbor Orchestrator' });
        await expect(win).toBeVisible({ timeout: 15_000 });
        await expect(win.locator('.xterm-rows')).toContainText(DIALOG, { timeout: 30_000 });
        seen.window = (await win.locator('.xterm-rows').innerText()).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-6);
        // 7. Its side panel lists the fleet's projects, as the Agents page's window does (QA's L1 on PR 578).
        await expect(win).toContainText('projects/harbor', { timeout: 15_000 });
        await expect(win).not.toContainText('No projects added yet');
        await stepShot(page, `${tag}2-window-on-the-dialog`);
      } else {
        // 4. The panel's terminal already shows it: no window opens over it.
        await expect(page.locator('.xterm-rows').filter({ hasText: DIALOG })).toHaveCount(1, { timeout: 30_000 });
        await page.waitForTimeout(1_500);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        seen.window = null;
        await stepShot(page, `${tag}2-dialog-in-the-panel`);
      }

      // 5.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
