import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * How an asleep agent reads, and how it wakes, in the window (#322's renderer
 * side). Frame: `Agent asleep · and how it wakes`.
 *
 * Two agents run stand-ins named `claude`, as in e2e/agent-sleep.spec.ts:
 * node scripts that run Tars's own hooks and continue the session `--resume`
 * names. Woken, a stand-in waits four seconds before its session starts, so
 * the window has a waking to show. The worker is put to sleep by the pass the
 * main process runs every minute, run here once, after every agent is told it
 * rested 40 minutes. Then, each time from asleep:
 * - the Agents page: its card says asleep since when, offers wake, and the
 *   chips count it under Asleep; the Projects page offers wake;
 * - the Dashboard: its panel keeps the last screen, says since when and how
 *   to wake it, and a key typed into it wakes it, reading who and how;
 * - the card's wake wakes it, reading woken by you;
 * - its window says asleep, offers wake, and says a key wakes it; the lead's
 *   window lists it under Asleep in its rail;
 * - a message from the lead wakes it, reading a message from the lead.
 *
 * The artefact: the lines read at each step in values.json, a screenshot of
 * each, and the app's trace.
 */

type Waking = { by: string; via: string; since: string };
type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; asleepSince?: string; waking?: Waking };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  list(): Promise<Agent[]>;
  get(id: string): Promise<Agent>;
  sendInput(p: { id: string; input: string }): Promise<{ success: boolean }>;
} } };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, resume: resumed === -1 ? null : args[resumed + 1], prompt: launchPrompt });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id }, body: JSON.stringify(body),
});
async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  if (id === 'lead' && prompt.includes('TELL>>')) {
    const answer = await api('/api/agents/worker/message', { message: 'MSG>> the docs are yours' });
    record('calls.jsonl', { status: answer.status });
  }
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(300);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}
process.stdin.setRawMode(true);
(async () => {
  // Woken, it takes its time to come up, as a real claude resuming a long conversation does.
  if (resumed !== -1) await sleep(4000);
  hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
  process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
  let buffer = '';
  let queue = Promise.resolve();
  if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
  process.stdin.on('data', (data) => {
    for (const ch of data.toString().replace(/\x1b\[20[01]~/g, '')) {
      if (ch === '\r') {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else buffer += ch;
    }
  });
})();
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const text = async (page: Page, selector: string) => ((await page.locator(selector).first().innerText()) || '').replace(/\s+/g, ' ').trim();

test('an asleep agent reads asleep since when on its card, its panel, its window and in a rail, and wakes from each, saying who woke it', async () => {
  test.setTimeout(420_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-asleep-ui-'));
  // The real path: the CLI runs there, and Claude Code files its transcripts
  // under it, which the Projects page lists beside the one Tars was given.
  const project = path.join(fs.realpathSync(home), 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('worker', 'Build Worker')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const dist = path.resolve('electron', 'dist');
  const seen: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31461), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());

    for (const id of ['lead', 'worker']) await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    await expect.poll(async () => (await list()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(2);
    const firstSid = lines(launchesFile).find((l) => l.id === 'worker')!.sid as string;

    /** Every agent rested 40 minutes, and the pass that runs every minute, until it puts the worker to sleep. */
    const sleepWorker = async () => {
      await expect.poll(async () => {
        const checked = await app.evaluate(async (_e, { dist }) => {
          const req = process.mainModule!.require;
          const { agents } = req(`${dist}/core/agent-manager.js`);
          const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
          for (const a of agents.values()) { a.statusSince = fortyMinutesAgo; a.lastTurnStartedAt = undefined; a.workHandedAt = undefined; }
          return req(`${dist}/services/agent-sleep.js`).checkSleep() as Promise<Array<{ agentId: string; slept: boolean }>>;
        }, { dist });
        return checked.find((o) => o.agentId === 'worker')?.slept ?? (await get('worker')).status;
      }, { timeout: 30_000, intervals: [500] }).toBe(true);
      await expect.poll(async () => (await get('worker')).status).toBe('asleep');
    };
    /** Up again on the conversation it slept in, its waking gone. */
    const upAgain = async (launches: number) => {
      await expect.poll(() => lines(launchesFile).filter((l) => l.id === 'worker').length, { timeout: 30_000 }).toBe(launches);
      await expect.poll(async () => {
        const w = await get('worker');
        return `${w.status} ${w.cliRunning} ${!!w.waking}`;
      }, { timeout: 60_000 }).toMatch(/^(idle|waiting|completed) true false$/);
      expect(lines(launchesFile).filter((l) => l.id === 'worker').at(-1)!.resume, 'on its own conversation').toBe(firstSid);
    };
    const card = page.locator('[data-agent-card="worker"]');
    const panel = page.locator('[data-agent-panel="worker"]');
    const since = /Asleep since \d\d:\d\d: no turn for 30 minutes/;

    // ── The Agents page and the Projects page ──
    await sleepWorker();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await expect(card).toContainText(since, { timeout: 30_000 });
    await expect(card).toContainText('asleep');
    await expect(card.getByRole('button', { name: 'wake', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^Asleep \(1\)$/i })).toBeVisible();
    seen.card = await text(page, '[data-agent-card="worker"]');
    await stepShot(page, '01-agents-card-asleep');
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'demo', exact: true }).first()
      .locator('xpath=ancestor::div[.//button][1]').getByRole('button', { name: 'open', exact: true }).click({ timeout: 30_000 });
    const projectRow = page.locator('[data-project-agent="worker"]');
    await expect(projectRow).toContainText('asleep', { timeout: 30_000 });
    await expect(projectRow.getByRole('button', { name: 'wake', exact: true })).toBeVisible();
    seen.projectRow = await text(page, '[data-project-agent="worker"]');
    await stepShot(page, '02-projects-row-asleep');

    // ── The Dashboard: the last screen kept, and a key wakes it ──
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await expect(panel).toContainText(since, { timeout: 30_000 });
    await expect(panel).toContainText(`SCREEN-OF-worker session ${firstSid}`);
    await expect(panel).toContainText(/Asleep since \d\d:\d\d\. A key typed here wakes it on its conversation\./);
    await expect(panel.getByRole('button', { name: 'wake', exact: true })).toBeEnabled();
    seen.panel = await text(page, '[data-agent-panel="worker"]');
    await stepShot(page, '03-dashboard-panel-asleep');
    await panel.locator('.xterm-screen').click();
    await page.keyboard.type('x');
    await expect(panel).toContainText('Waking: a key typed by you', { timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'wake', exact: true })).toBeDisabled();
    seen.panelWaking = await text(page, '[data-agent-panel="worker"]');
    await stepShot(page, '04-dashboard-panel-waking');
    await upAgain(2);
    await expect(panel).not.toContainText('Waking', { timeout: 15_000 });

    // ── The card's wake ──
    await sleepWorker();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await card.getByRole('button', { name: 'wake', exact: true }).click();
    await expect(card).toContainText('Waking: woken by you', { timeout: 15_000 });
    await expect(card).toContainText('waking');
    seen.cardWaking = await text(page, '[data-agent-card="worker"]');
    await stepShot(page, '05-agents-card-waking');
    await upAgain(3);

    // ── Its window, and the lead's rail ──
    await sleepWorker();
    await expect(card).toContainText(since, { timeout: 30_000 });
    await card.getByRole('button', { name: 'open', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(since);
    await expect(dialog).toContainText('Build Worker is asleep. A key typed here wakes it on its conversation.');
    await expect(dialog.getByRole('button', { name: 'wake', exact: true })).toBeEnabled();
    seen.window = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 400);
    await stepShot(page, '06-window-asleep');
    // Escape closes the window, and wakes nothing: the window does not hand
    // an asleep agent's terminal the focus, where a key wakes it.
    const before = lines(launchesFile).filter((l) => l.id === 'worker').length;
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(lines(launchesFile).filter((l) => l.id === 'worker'), 'Escape woke it').toHaveLength(before);
    expect((await get('worker')).status).toBe('asleep');
    await page.locator('[data-agent-card="lead"]').getByRole('button', { name: 'open', exact: true }).click();
    const rail = page.getByRole('dialog');
    await expect(rail).toContainText(/Asleep \(1\)/i);
    await expect(rail).toContainText(since);
    seen.rail = (await rail.innerText()).replace(/\s+/g, ' ').slice(0, 600);
    await stepShot(page, '07-lead-rail-asleep');
    await page.keyboard.press('Escape');

    // ── A message from the lead ──
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'lead', input: 'TELL>> wake the worker\r' }));
    await expect(card).toContainText('Waking: a message from Project Lead', { timeout: 30_000 });
    seen.cardWokenByMessage = await text(page, '[data-agent-card="worker"]');
    await stepShot(page, '08-agents-card-woken-by-a-message');
    await upAgain(4);

    recordValues({ seen, launches: lines(launchesFile).filter((l) => l.id === 'worker') });
  } finally {
    await app.close().catch(() => { /* gone */ });
    // A hook the last CLI started can still be writing its log there: the
    // removal is done again until nothing comes back under it.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 10) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
});
