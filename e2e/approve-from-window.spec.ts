import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Every permission question approved from the window (2.0.7, approve-everywhere, PR 588's channels; frame `Permission
 * asked of Tars`, its rows `approve a file, shown whole` and `a cut view, and while it is read`; the chat's card in
 * chat-redesign-a.pen).
 *
 * The orchestrator of project harbor runs a stand-in of claude with the state mod's requests: it asks Tars about a
 * Write of a file of 400 lines (8,692 characters: main's view cuts its content), then about a short Bash command, each
 * again while Tars answers `pending`, and writes each answer to a file.
 *
 * How it can fail, written before the window's change:
 * 1. the cut Write is offered allow on what the view shows, or from a panel's line;
 * 2. shown whole, a field is missing, cut, or without its name, or the content without its size above it;
 * 3. allow names no fingerprint, or another than the question's, so main refuses it and the file is never allowed;
 * 4. the short command, shown whole by the view, is not allowed with the view's fingerprint;
 * 5. ask in terminal is still a first answer in the block (not the ghost after deny);
 * 6. an uncaught error in the page;
 * 7. a Write that empties a file (its content empty, left out of main's line) is allowed from a panel's line that
 *    shows its path alone (the Audit's M1 on #589), or the block does not say the content is empty.
 * Once on a chat's page (the new interface, its card) and once on the Dashboard's panel (the classic shell).
 * Red on the frames' commit (ee515fda4, PR 588 and 578 with no window change): allow is offered on the cut view, and
 * sent with no fingerprint.
 * The artefact: values.json (the answers the stand-in read, the block's lines), screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const CHAT = 'c0ffee00-0000-4000-8000-0000000000b2';
const CONTENT = Array.from({ length: 400 }, (_, i) => `export const line${String(i).padStart(3, '0')} = ${i};`).join('\n');

function standIn(home: string): string {
  return writeNodeCli(path.join(home, 'lead.cjs'), [
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const dir = ${JSON.stringify(home)};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "const pause = ms => new Promise(r => setTimeout(r, ms));",
    "const askTars = async (name, call) => { let a;",
    "  do { a = await post('/api/hooks/permission', { ...call, via: 'mod' }); if (a.decision === 'pending') await pause(300); }",
    "  while (a.decision === 'pending');",
    "  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(a)); return a; };",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'write the ledger' });",
    `  await askTars('write', { tool: 'Write', tool_use_id: 'toolu_write', input: { file_path: ${JSON.stringify('/tmp/harbor-ledger.ts')}, content: ${JSON.stringify(CONTENT)} } });`,
    "  await askTars('bash', { tool: 'Bash', tool_use_id: 'toolu_bash', input: { command: 'npm test' } });",
    `  await askTars('empty', { tool: 'Write', tool_use_id: 'toolu_empty', input: { file_path: ${JSON.stringify('/tmp/harbor-main.ts')}, content: '' } });`,
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

for (const newInterface of [true, false]) {
  const where = newInterface ? 'a chat\'s page (new interface)' : 'the Dashboard\'s panel';
  test(`a cut file question is read whole and allowed with its fingerprint, a short one too, from ${where}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-approve-'));
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
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-chat-' : 'dashboard-';
    const errors: string[] = [];
    const read = (name: string) => (fs.existsSync(path.join(home, `${name}.json`)) ? JSON.parse(fs.readFileSync(path.join(home, `${name}.json`), 'utf8')) : null);

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31525 : 31526), DOROTHY_E2E: '1' },
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
      await expect(ask).toContainText('Write');

      // 1. The cut view: no allow on what it shows. A panel opens it whole first.
      if (!newInterface) {
        await expect(ask.getByRole('button', { name: 'allow', exact: true })).toHaveCount(0);
        await expect(ask.getByRole('button', { name: 'show all', exact: true })).toBeVisible();
        await stepShot(page, `${tag}1-cut-line`);
        await ask.getByRole('button', { name: 'show all', exact: true }).click();
      }

      // 2. Whole, field by field, the content's size above it, its last line there.
      const content = ask.locator('[data-ask-field="content"]');
      await expect(content).toContainText(`content · ${CONTENT.length.toLocaleString('en-US')} characters, 400 lines`, { timeout: 30_000 });
      await expect(content).toContainText('export const line399 = 399;');
      await expect(ask.locator('[data-ask-field="file_path"]')).toContainText('/tmp/harbor-ledger.ts');
      const names = await ask.locator('[data-ask-field]').evaluateAll(els => els.map(e => e.getAttribute('data-ask-field')));
      expect(names).toEqual(['file_path', 'content']);
      seen.contentLength = (await content.innerText()).length;
      // 5. ask in terminal, the ghost after deny.
      const labels = (await ask.getByRole('button').allInnerTexts()).map(t => t.trim());
      seen.answers = labels;
      expect(labels).toEqual(['allow', 'deny', 'ask in terminal']);
      await stepShot(page, `${tag}2-whole`);

      // 3. allow, with the whole question's fingerprint: main takes it.
      await ask.getByRole('button', { name: 'allow', exact: true }).click();
      await expect.poll(() => read('write'), { timeout: 30_000 }).not.toBeNull();
      seen.write = read('write');
      expect(seen.write).toMatchObject({ decision: 'allow' });

      // 4. The short command, whole in the view: allowed with its fingerprint.
      await expect(ask).toContainText('npm test', { timeout: 30_000 });
      await stepShot(page, `${tag}3-short`);
      await ask.getByRole('button', { name: 'allow', exact: true }).click();
      await expect.poll(() => read('bash'), { timeout: 30_000 }).not.toBeNull();
      seen.bash = read('bash');
      expect(seen.bash).toMatchObject({ decision: 'allow' });

      // 7. The Write that empties a file: never from the line; the block says the content is empty.
      await expect(ask).toContainText('harbor-main.ts', { timeout: 30_000 });
      if (!newInterface) {
        await expect(ask.getByRole('button', { name: 'allow', exact: true })).toHaveCount(0);
        await stepShot(page, `${tag}4-empty-line`);
        await ask.getByRole('button', { name: 'show all', exact: true }).click();
      }
      await expect(ask.locator('[data-ask-field="content"]')).toContainText('content · empty');
      await stepShot(page, `${tag}5-empty-whole`);
      await ask.getByRole('button', { name: 'allow', exact: true }).click();
      await expect.poll(() => read('empty'), { timeout: 30_000 }).not.toBeNull();
      seen.empty = read('empty');
      expect(seen.empty).toMatchObject({ decision: 'allow' });

      // 6.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
