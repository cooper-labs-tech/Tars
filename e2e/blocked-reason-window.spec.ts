import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent blocked on its CLI's word, with its reason and message, in the window (#510's OSC 7501 record on
 * agents:tick). Frame: `Blocked (2.0.5) · an agent blocked, its reason`.
 *
 * Three grok agents (a CLI with no hooks, so its reports are what Tars reads), each on a stand-in faithful to #510's:
 * it probes OSC 7501, and once answered reports itself blocked, one on a permission, one on a question, one on a
 * sign-in, each with its message, and stays so. In the shell as it was and in the new interface:
 * 1. Each Dashboard panel says it under its header: the message (a question as "Asks: ..."), and open, or answer for
 *    the question; its header's status word reads waiting · permission, waiting · question, blocked · sign in.
 * 2. answer brings the question's terminal forward (the panel full screen), and its exit puts it back.
 * 3. The Agents page cards say the same word and the message in place of the task.
 * Red on #510's head (5ba29eec): the window shows no reason.
 *
 * The artefact: what each panel and card said, in values.json, and a screenshot of each place.
 */

const BLOCKS = [
  { id: 'x-perm', name: 'Perm Agent', kind: 'permission', msg: 'Wants to run npm publish --access public', line: 'Wants to run npm publish --access public', word: 'waiting · permission', action: 'open' },
  { id: 'x-question', name: 'Question Agent', kind: 'question', msg: 'Which database, staging or prod?', line: 'Asks: Which database, staging or prod?', word: 'waiting · question', action: 'answer' },
  { id: 'x-auth', name: 'Auth Agent', kind: 'auth', msg: 'Signed out: run /login', line: 'Signed out: run /login', word: 'blocked · sign in', action: 'open' },
];

const standIn = (kind: string, msg: string) => `#!${process.execPath}
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
process.stdin.setRawMode && process.stdin.setRawMode(true);
let got = '';
process.stdin.on('data', (d) => { got += d.toString('latin1'); });
process.stdout.write('stand-in ready\\r\\n');
process.stdout.write('\\x1b]7501;?\\x1b\\\\\\x1b[c');
const report = () => process.stdout.write('\\x1b]7501;state=blocked:kind=${kind}:app=stand-in:msg=' + b64(${JSON.stringify(msg)}) + '\\x1b\\\\');
const wait = setInterval(() => { if (got.includes('\\x1b]7501;?:')) { clearInterval(wait); report(); } }, 200);
setInterval(() => {}, 1 << 30);
`;

for (const newInterface of [false, true]) {
  test(`an agent blocked on its cli's word says why on its panel and its card, and its terminal comes forward${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-blocked-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const agents = BLOCKS.map((b) => {
      const cli = path.join(bin, `grok-${b.kind}`);
      fs.writeFileSync(cli, standIn(b.kind, b.msg), { mode: 0o755 });
      return { id: b.id, name: b.name, character: 'robot', provider: 'grok', status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'bypass', cliPath: cli, createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z' };
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, grokEnabled: true }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31552 : 31551), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      for (const b of BLOCKS) {
        await page.evaluate((id) => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id, prompt: 'go' }), b.id);
      }

      // 1. Each panel: the message under its header, its action, and its status word.
      for (const b of BLOCKS) {
        const panel = page.locator(`[data-agent-panel="${b.id}"]`);
        const line = panel.locator(`[data-blocked="${b.kind}"]`);
        await expect(line, `${b.id}'s blocked line`).toContainText(b.line, { timeout: 60_000 });
        await expect(line.getByRole('button', { name: b.action, exact: true })).toBeVisible();
        await expect(panel.getByText(b.word, { exact: true })).toBeVisible();
        seen[`panel-${b.id}`] = (await line.innerText()).replace(/\s+/g, ' ');
      }
      await stepShot(page, `${tag}-01-panels`);

      // 2. answer brings the question's terminal forward; its exit puts it back.
      const question = page.locator('[data-agent-panel="x-question"]');
      await question.locator('[data-blocked="question"]').getByRole('button', { name: 'answer', exact: true }).click();
      await expect.poll(() => question.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
      await stepShot(page, `${tag}-02-answer-fullscreen`);
      await question.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await expect.poll(() => question.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed');

      // 3. The cards: the same word, and the message in place of the task.
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      for (const b of BLOCKS) {
        const card = page.locator(`[data-agent-card="${b.id}"]`);
        await expect(card.locator('[data-blocked-line]'), `${b.id}'s card`).toHaveText(b.line, { timeout: 30_000 });
        await expect(card.getByText(b.word, { exact: true })).toBeVisible();
        seen[`card-${b.id}`] = (await card.innerText()).replace(/\s+/g, ' ');
      }
      await stepShot(page, `${tag}-03-cards`);
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
