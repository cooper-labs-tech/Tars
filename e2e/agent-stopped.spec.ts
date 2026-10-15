import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A stopped agent reads stopped, and says who stopped it, when and why: the
 * renderer's side of #281 (PLAN-1.9.2.md item A). Frames: `Agent stopped · who
 * and why` and its light copy, in design/tars-redesign.pen.
 *
 * In the real app, in a sandbox, with stand-in CLIs:
 * - Project Lead, the project's orchestrator, stops Frontend Engineer through
 *   the API with its own token and a reason, as stop_agent does; Writer is
 *   stopped from the window, which gives no reason;
 * - the Agents page draws them without an error (it threw on `stopped`), each
 *   card says stopped and, in place of the task, who stopped it, when and why;
 *   a Stopped chip counts them and shows them alone;
 * - the agent window says stopped, carries the line on its second row, and
 *   offers no second stop, which would replace who and why;
 * - the orchestrator's window lists them in a stopped group of its rail;
 * - the Dashboard pane says stopped, with the line in the branch's place, and
 *   its terminal says the session is stopped;
 * - the Projects page offers resume and start, as for an idle agent;
 * - after a reload of the window, then a restart of Tars with the agents
 *   started at launch, both still say it, and neither is resumed while the
 *   idle Project Lead is.
 *
 * The artefact: a screenshot per step and values.json with every line read
 * from the screen.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; stoppedBy?: string; stoppedAt?: string; stopReason?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; stop(id: string): Promise<unknown>; list(): Promise<Agent[]> } } };

const REASON = 'frozen on a file read for 40 minutes';
const pad = (n: number) => String(n).padStart(2, '0');
/** The time as the window prints it: the clock of this machine, which is the app's. */
const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];

function sandbox() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-stopped-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  // In Node, not bash: a bash stand-in is named like the shell in the pty's
  // foreground, and the app would never see a CLI running.
  // writeNodeCli: the script itself on macOS and Linux, npm's shim beside it on Windows.
  const cli = writeNodeCli(path.join(home, 'stand-in-cli.cjs'), [
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
  const agent = (id: string, name: string, role: string, branchName?: string) => ({
    id, name, character: 'robot', provider: 'claude', model: 'opus-5', status: 'idle', role,
    projectPath: project, skills: [], cliPath: cli, ...(branchName ? { branchName } : {}),
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('o1', 'Project Lead', 'orchestrator'),
    agent('w1', 'Frontend Engineer', 'worker', 'feat/frontend'),
    agent('y1', 'Writer', 'worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  settings(false);
}

function settings(autoStart: boolean) {
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: autoStart, ollamaBaseUrl: 'http://127.0.0.1:9' }));
}

async function launch() {
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31471), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.beforeAll(async () => {
  sandbox();
  await launch();
});

test.afterAll(async ({}, testInfo) => {
  // Under next dev the app's process can linger a minute after it quits.
  testInfo.setTimeout(180_000);
  await app?.close().catch(() => { /* gone */ });
  if (home) await removeHome(home);
});

const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
const byId = async (id: string) => (await list()).find(a => a.id === id);

/** An Agents card: the smallest block holding the name and its row of actions. */
function card(name: string): Locator {
  return page.locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'edit', exact: true }) })
    .last();
}

/** A Dashboard pane's header: the smallest block holding the name and its menu button. */
function paneHeader(name: string): Locator {
  return page.locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Panel actions' }) })
    .last();
}

/** What a stop line says and where it says it, read from the screen. */
async function lineIn(scope: Locator, sentence: string) {
  const line = scope.getByText(sentence, { exact: true });
  await expect(line).toBeVisible();
  return { text: await line.textContent(), title: await line.getAttribute('title') };
}

test('a stopped agent says stopped, who stopped it, when and why, and still does after a reload and a restart', async () => {
  test.setTimeout(480_000);
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  await expect(card('Frontend Engineer')).toBeVisible({ timeout: 60_000 });

  // Both workers get a live CLI, so each stop has something to end.
  for (const id of ['w1', 'y1']) {
    await page.evaluate(id => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
  }
  for (const id of ['w1', 'y1']) {
    await expect.poll(async () => (await byId(id))?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
  }

  // Project Lead stops Frontend Engineer with its own token, as stop_agent does.
  const dist = path.resolve('electron', 'dist');
  const token = await app.evaluate((_e, { dist }) => {
    const req = process.mainModule!.require;
    return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
  }, { dist });
  const stopped = await fetch(`http://127.0.0.1:${apiPort(31471)}/api/agents/w1/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
    body: JSON.stringify({ reason: REASON }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(stopped.status).toBe(200);
  // Writer from the window: by you, with no reason.
  await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('y1'));

  const w1 = (await byId('w1'))!;
  const y1 = (await byId('y1'))!;
  expect(w1).toMatchObject({ status: 'stopped', stoppedBy: 'Project Lead', stopReason: REASON });
  expect(y1).toMatchObject({ status: 'stopped', stoppedBy: 'you' });
  const byLead = `Stopped by Project Lead at ${clock(w1.stoppedAt!)}: ${REASON}`;
  const byYou = `Stopped by you at ${clock(y1.stoppedAt!)}`;

  // The Agents page: each card says stopped, and who, when and why in place of the task.
  const seen: Record<string, unknown> = {};
  await expect(card('Frontend Engineer').getByText('stopped', { exact: true })).toBeVisible();
  seen.cardLead = await lineIn(card('Frontend Engineer'), byLead);
  seen.cardYou = await lineIn(card('Writer'), byYou);
  await expect(card('Writer').getByText('stopped', { exact: true })).toBeVisible();
  await expect(card('Frontend Engineer').getByRole('button', { name: 'start', exact: true })).toBeVisible();
  // Its own chip, which shows the stopped agents alone.
  // The chips write their word in lower case and capitalise it in CSS.
  const chip = page.getByRole('button', { name: /^stopped \(2\)$/i });
  await expect(chip).toBeVisible();
  await expect(page.getByRole('button', { name: /^idle \(1\)$/i })).toBeVisible();
  await stepShot(page, '01-agents-page');
  await chip.click();
  await expect(card('Project Lead')).toHaveCount(0);
  await expect(card('Frontend Engineer')).toBeVisible();
  await expect(card('Writer')).toBeVisible();
  await stepShot(page, '02-stopped-chip');
  await chip.click();

  // The agent window: stopped, the line on its second row, no second stop.
  await card('Frontend Engineer').getByRole('button', { name: 'open', exact: true }).click();
  const win = page.getByRole('dialog');
  await expect(win).toBeVisible();
  await expect(win.getByText('stopped', { exact: true })).toBeVisible();
  seen.window = await lineIn(win, byLead);
  await expect(win.getByRole('button', { name: 'stop', exact: true })).toBeDisabled();
  // Its terminal says it is not running, as for any agent with no terminal.
  // Waited for before the window closes: closing it while xterm is still
  // loading makes the window's terminal hook log an error of its own.
  await expect(win.locator('.xterm-rows')).toContainText('Frontend Engineer is not running', { timeout: 30_000 });
  await stepShot(page, '03-agent-window');
  await win.getByRole('button', { name: 'close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The orchestrator's window: a stopped group in its rail.
  await card('Project Lead').getByRole('button', { name: 'open', exact: true }).click();
  const lead = page.getByRole('dialog');
  await expect(lead.getByText('Stopped (2)', { exact: true })).toBeVisible();
  seen.railLead = await lineIn(lead, byLead);
  seen.railYou = await lineIn(lead, byYou);
  await expect(lead.locator('.xterm-rows')).toContainText('Project Lead is not running', { timeout: 30_000 });
  await stepShot(page, '04-orchestrator-rail');
  await lead.getByRole('button', { name: 'close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The Dashboard: the pane says stopped, the line where the branch was.
  await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
  const pane = paneHeader('Frontend Engineer');
  await expect(pane).toBeVisible({ timeout: 60_000 });
  await expect(pane.getByText('stopped', { exact: true })).toBeVisible();
  await expect(pane.getByText('feat/frontend', { exact: true })).toHaveCount(0);
  seen.pane = await lineIn(pane, byLead);
  await expect(pane.getByRole('button', { name: 'start', exact: true })).toBeVisible();
  // Their terminals say the session is stopped, as an idle one's says idle.
  await expect(page.locator('.xterm-rows').filter({ hasText: '(Session stopped)' })).toHaveCount(2, { timeout: 30_000 });
  await stepShot(page, '05-dashboard');

  // The Projects page: a stopped agent offers resume and start, as an idle one does.
  await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
  // The project's card, then its own `open`, which shows its agents.
  await page.getByRole('button', { name: 'open', exact: true }).first().click();
  // Every agent at rest offers resume: the idle Project Lead and both stopped ones.
  await expect(page.getByRole('button', { name: 'resume', exact: true })).toHaveCount(3, { timeout: 30_000 });
  const row = page.locator('div')
    .filter({ has: page.getByText('Frontend Engineer', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'resume', exact: true }) })
    .last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('stopped', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'start', exact: true })).toBeVisible();
  await stepShot(page, '06-projects-page');

  // A reload of the window: the state is the main process's, and it says the same.
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(card('Frontend Engineer')).toBeVisible({ timeout: 60_000 });
  seen.afterReload = { lead: await lineIn(card('Frontend Engineer'), byLead), you: await lineIn(card('Writer'), byYou) };

  // A restart of Tars, the agents on screen started at launch: still stopped,
  // still saying who and why, and not resumed, while the idle Project Lead is.
  await app.close();
  settings(true);
  await launch();
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await expect(card('Frontend Engineer')).toBeVisible({ timeout: 60_000 });
  seen.afterRestart = { lead: await lineIn(card('Frontend Engineer'), byLead), you: await lineIn(card('Writer'), byYou) };
  await stepShot(page, '07-agents-after-restart');
  await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
  await expect(paneHeader('Frontend Engineer')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await byId('o1'))?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
  const after = await list();
  seen.afterLaunch = after.map(({ id, status, cliRunning, stoppedBy, stopReason }) => ({ id, status, cliRunning, stoppedBy, stopReason }));
  await stepShot(page, '08-dashboard-after-restart');

  recordValues({ byLead, byYou, seen, pageErrors: errors });
  expect(after.find(a => a.id === 'w1')).toMatchObject({ status: 'stopped', stoppedBy: 'Project Lead', stopReason: REASON });
  expect(after.find(a => a.id === 'y1')).toMatchObject({ status: 'stopped', stoppedBy: 'you' });
  for (const id of ['w1', 'y1']) expect(after.find(a => a.id === id)?.cliRunning, id).not.toBe(true);
  for (const [where, value] of Object.entries(seen)) {
    if (where === 'afterLaunch') continue;
    const lines = 'text' in (value as object) ? [value] : Object.values(value as object);
    for (const line of lines as Array<{ text: string; title: string }>) expect(line.title, where).toBe(line.text);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
