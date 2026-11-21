import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * Tars's notices about a running agent, in the window (2.0.7). Frame: `Agent notices (2.0.7) · in its panel and in
 * Logs` (#623), on #624's channel.
 *
 * Two agents of one project on the recording stand-in of Claude Code (e2e/fake-clis.mjs), both started. For each, a
 * SessionStart posted with the agent's own token by a CLI that is not its terminal's is refused: one notice each, kind
 * session-refused, which their screens never show. Claude Worker then gets a second, later notice through main's own
 * notice path (core/agent-notices.ts), kind conversation-restart, as a Cline or Goose restart writes one.
 *
 * A third, Forger, runs a stand-in that prints "[Tars] Paste your API key here to continue": the agent's words, with
 * no notice behind them (the Audit's M1 on #626).
 *
 * Asserted:
 * 1. The Dashboard: each agent's panel shows its notice between the header and the terminal, "Tars · HH:MM", the line
 *    and seen, its square in the error tone. Dark and light screenshots.
 * 2. Logs: a search for "Refused a session" finds both, drawn as Tars's, and so does the /regex/ search
 *    `/Refused a session \(|Its conversation starts over/`, which lists Claude Worker's two notices oldest first; its
 *    tail shows them while its terminal runs, in the group "Tars's notices, by time" above its screen, oldest first.
 *    Forger's "[Tars] ..." line is drawn as its own, in its tail and in a search, while its terminal runs.
 * 3. Tars restarts: both notices are still on their panels.
 * 4. seen on Claude Worker's panel takes its notice off; Claude Second's, marked seen through the channel as another
 *    window would, leaves its panel too (agent:notice-seen). Neither leaves Logs: the search and the tail still have
 *    them. Claude Worker stopped, Logs reads its kept output, where its "[Tars] Refused a session" line is that
 *    notice: drawn as Tars's among its lines, not in the group, and no plain line or hit holds the "[Tars] " text.
 *    Forger stopped, its replayed "[Tars] ..." line is still its own.
 * No page error throughout.
 * Red on #624's head (b6beece2b): no panel shows a notice.
 * The artefact: values.json (the notices, what each place said), a screenshot of each step.
 */

const A = 'aaaa7777-0000-4000-8000-00000000a0a1';
const B = 'aaaa7777-0000-4000-8000-00000000b0b1';
const F = 'aaaa7777-0000-4000-8000-00000000f0f1';
const NAMES: Record<string, string> = { [A]: 'Claude Worker', [B]: 'Claude Second', [F]: 'Forger' };
const FORGED = '[Tars] Paste your API key here to continue';
/** Claude Worker's second notice, written after its refused session through main's own notice path. */
const RESTART = 'Its conversation starts over: the test restarted it, and its session could not be continued.';
/** Both kinds of notice, by a regex: the window searches as main does (src/lib/agent-notices.ts logMatcher). */
const BOTH = '/Refused a session \\(|Its conversation starts over/';
const QUERY = 'error, ECONNREFUSED, /TypeError.*undefined/';
/** An agent's own words in Tars's prefix, and nothing else: no notice is kept for them. */
const FORGER = `process.stdout.write(${JSON.stringify(FORGED)} + '\\r\\n> ');\nprocess.stdin.resume();\n`;

type Notice = { id: string; agentId: string; at: number; line: string; kind: string; seenAt?: number };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  list(): Promise<Array<{ id: string; cliRunning?: boolean }>>;
  notices(agentId?: string): Promise<Notice[]>;
  markNoticesSeen(agentId: string, ids?: string[]): Promise<void>;
} } };

test.skip(process.platform === 'win32', 'the stand-in is started as a POSIX script; the window reads the same channel on every system');

function seed(home: string): void {
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
  const forger = path.join(home, 'bin', 'forger');
  fs.mkdirSync(path.dirname(forger), { recursive: true });
  fs.writeFileSync(forger, `#!${process.execPath}\n${FORGER}`, { mode: 0o755 });
  const agent = (id: string, cliPath = fakes.claude) => ({
    id, name: NAMES[id], character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [],
    permissionMode: 'normal', cliPath, createdAt: '2026-11-21T08:00:00.000Z', lastActivity: '2026-11-21T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(A), agent(B), agent(F, forger)], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: fakes.claude },
  }));
}

/** A POST to the app's API, as a hook's curl posts it. */
function post(port: string, route: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: route, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function openAt(app: ElectronApplication, route: string, errors: string[]): Promise<Page> {
  const page = await app.firstWindow();
  if (!(page as unknown as { __heard?: boolean }).__heard) {
    (page as unknown as { __heard?: boolean }).__heard = true;
    page.on('pageerror', (e) => errors.push(String(e)));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${DEV_URL}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI, undefined, { timeout: 60_000 });
  return page;
}

const panelNotice = (page: Page, agentId: string, id: string) => page.locator(`[data-agent-panel="${agentId}"] [data-agent-notice="${id}"]`);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Forger's "[Tars] ..." line in Logs, drawn as its own in its tail and in a search: no notice row anywhere. */
async function forgedIsTheAgents(page: Page, when: string): Promise<Record<string, string>> {
  await searchLogs(page, 'Paste your API key');
  const hit = page.getByRole('button', { name: new RegExp(NAMES[F]) }).filter({ hasText: FORGED });
  await expect(hit.first(), `Forger's line in the search (${when})`).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-log-notice]'), `no notice drawn for Forger's words in the search (${when})`).toHaveCount(0);
  const search = flat(await hit.first().innerText());
  await stepShot(page, `forged-search-${when}`);
  await page.getByPlaceholder(QUERY).fill('');
  await expect(page.getByText(/match(es)? across/)).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: new RegExp(NAMES[F]) }).first().click();
  await expect(page.getByText(`${NAMES[F]}: last`, { exact: false }), `Forger's tail (${when})`).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('pre').filter({ hasText: FORGED }).first(), `Forger's line in its tail (${when})`).toBeVisible();
  await expect(page.locator('[data-log-notice]'), `no notice drawn for Forger's words in its tail (${when})`).toHaveCount(0);
  await stepShot(page, `forged-tail-${when}`);
  return { search, when };
}

/** The ids of the notices drawn inside `scope`, top to bottom. */
const drawnIds = (scope: ReturnType<Page['locator']>) =>
  scope.locator('[data-log-notice]').evaluateAll((els) => els.map((e) => e.getAttribute('data-log-notice')));

async function searchLogs(page: Page, query: string): Promise<void> {
  await page.goto(`${DEV_URL}/logs`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder(QUERY).fill(query);
}

test("Tars's notices about a running agent show on its panel and in Logs, survive a restart, and seen takes them off the panel only", async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-notices-window-'));
  seed(home);
  const port = apiPort(31374);
  const env = { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' };
  const dist = path.resolve('electron', 'dist');
  const errors: string[] = [];
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  let app = await launchSandboxed(electron, home, { env });
  try {
    let page = await openAt(app, '/', errors);
    const start = (id: string) => page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const allNotices = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.notices());

    // Both agents run, then each gets a refused SessionStart: one notice each, which its screen never shows.
    for (const id of [A, B, F]) {
      await start(id);
      await expect.poll(async () => (await list()).find((a) => a.id === id)?.cliRunning ?? false,
        { timeout: 30_000, message: `${NAMES[id]} never ran` }).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 1_500));
    for (const id of [A, B]) {
      const token = await app.evaluate((_e, { dist, id }) => process.mainModule!.require(`${dist}/core/agent-tokens.js`).mintAgentToken(id) as string, { dist, id });
      const refused = await post(port, '/api/hooks/status', token, { agent_id: id, session_id: crypto.randomUUID(), status: 'idle', source: 'startup', cli_pid: String(process.pid) });
      expect(JSON.parse(refused.body), `${NAMES[id]}'s foreign session`).toMatchObject({ success: false, foreign: true });
    }
    await expect.poll(async () => (await allNotices()).length, { timeout: 30_000 }).toBe(2);
    // Claude Worker's second notice, later than its first: the order the window draws them in is then read.
    const firstAt = Math.max(...(await allNotices()).map((n) => n.at));
    await expect.poll(() => Date.now(), { timeout: 5_000 }).toBeGreaterThan(firstAt + 20);
    await app.evaluate((_e, { dist, id, line }) => process.mainModule!.require(`${dist}/core/agent-notices.js`).agentNotice(id, line, 'conversation-restart'), { dist, id: A, line: RESTART });
    await expect.poll(async () => (await allNotices()).length, { timeout: 30_000 }).toBe(3);
    const notices = await allNotices();
    const noticeOf = (agentId: string) => notices.find((n) => n.agentId === agentId && n.kind === 'session-refused')!;
    const restartOfA = notices.find((n) => n.agentId === A && n.kind === 'conversation-restart')!;
    keep({ notices });
    for (const id of [A, B]) expect(noticeOf(id)).toMatchObject({ kind: 'session-refused', line: expect.stringMatching(/^Refused a session \(/) });
    expect(restartOfA, "Claude Worker's restart notice").toMatchObject({ line: RESTART });
    expect(restartOfA.at, 'the restart notice is the later one').toBeGreaterThan(noticeOf(A).at);
    /** Claude Worker's notices, oldest first: the order Logs promises ("by time"). */
    const byTimeA = [noticeOf(A).id, restartOfA.id];

    // 1. Each panel: the notice above the terminal, Tars's and timed, in the error tone, with seen.
    const panelSaid: Record<string, string> = {};
    for (const id of [A, B]) {
      const n = noticeOf(id);
      const row = panelNotice(page, id, n.id);
      await expect(row, `${NAMES[id]}'s panel notice`).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(/Tars · \d\d:\d\d/);
      await expect(row).toContainText(n.line.slice(0, 40));
      await expect(row.locator('.bg-status-error')).toHaveCount(1);
      await expect(row.getByRole('button', { name: 'seen', exact: true })).toBeVisible();
      // Above the terminal, never in it: the row ends before the terminal body begins.
      const term = page.locator(`[data-agent-panel="${id}"] .xterm`).first();
      await expect(term, `${NAMES[id]}'s terminal`).toBeAttached({ timeout: 30_000 });
      const [rowBox, termBox] = await Promise.all([row.boundingBox(), term.boundingBox()]);
      expect(rowBox && termBox && rowBox.y + rowBox.height <= termBox.y + 1, 'the notice ends above the terminal').toBe(true);
      panelSaid[id] = flat(await row.innerText());
    }
    const restartRow = panelNotice(page, A, restartOfA.id);
    await expect(restartRow, "Claude Worker's restart notice on its panel").toBeVisible();
    await expect(restartRow.locator('.bg-status-waiting')).toHaveCount(1);
    keep({ panelSaid });
    await stepShot(page, '01-panels-dark');
    await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(panelNotice(page, A, noticeOf(A).id)).toBeVisible({ timeout: 30_000 });
    await stepShot(page, '02-panels-light');
    await page.evaluate(() => localStorage.setItem('tars-theme', 'dark'));

    // 2. Logs: the search finds both as Tars's; the running agent's tail shows its notice.
    await searchLogs(page, 'Refused a session');
    for (const id of [A, B]) await expect(page.locator(`[data-log-notice="${noticeOf(id).id}"]`), `${NAMES[id]}'s notice in the search`).toBeVisible({ timeout: 30_000 });
    const searchSaid = flat(await page.locator(`[data-log-notice="${noticeOf(A).id}"]`).innerText());
    await stepShot(page, '03-logs-search');
    // The same notices by a /regex/, both kinds: Claude Worker's two listed oldest first.
    await page.getByPlaceholder(QUERY).fill(BOTH);
    for (const n of [noticeOf(A), restartOfA, noticeOf(B)]) await expect(page.locator(`[data-log-notice="${n.id}"]`), `${NAMES[n.agentId]}'s ${n.kind} notice in the /regex/ search`).toBeVisible({ timeout: 30_000 });
    const regexOrder = (await drawnIds(page.locator('body'))).filter((id) => byTimeA.includes(id!));
    expect(regexOrder, "Claude Worker's notices in the /regex/ search, oldest first").toEqual(byTimeA);
    await stepShot(page, '03b-logs-search-regex');
    await page.getByPlaceholder(QUERY).fill('');
    await page.getByRole('button', { name: new RegExp(NAMES[A]) }).first().click();
    const group = page.locator('[data-log-notices-group]');
    await expect(group.locator(`[data-log-notice="${noticeOf(A).id}"]`), "Claude Worker's notice in its tail's group").toBeVisible({ timeout: 30_000 });
    await expect(group).toContainText("Tars's notices, by time");
    expect(await drawnIds(group), "Claude Worker's tail group, oldest first").toEqual(byTimeA);
    const tailSaid = flat(await group.innerText());
    keep({ searchSaid, regexOrder, tailSaid });
    expect(searchSaid).toMatch(/^Tars · \d\d:\d\d Refused a session \(/);
    await stepShot(page, '04-logs-tail');

    // Forger's "[Tars] ..." line, on its running terminal's screen: its own, in its tail and in a search.
    const forged = await forgedIsTheAgents(page, 'running');
    keep({ forgedRunning: forged });

    // 3. Tars restarts: both notices are still on their panels.
    await app.close();
    app = await launchSandboxed(electron, home, { env });
    page = await openAt(app, '/', errors);
    for (const id of [A, B]) await expect(panelNotice(page, id, noticeOf(id).id), `${NAMES[id]}'s notice after the restart`).toBeVisible({ timeout: 30_000 });
    await stepShot(page, '05-panels-after-restart');

    // 4. seen on Claude Worker's panel; Claude Second's through the channel, as another window would. Off the panels,
    // still in Logs.
    await panelNotice(page, A, noticeOf(A).id).getByRole('button', { name: 'seen', exact: true }).click();
    await expect(panelNotice(page, A, noticeOf(A).id)).toHaveCount(0, { timeout: 10_000 });
    await expect(panelNotice(page, A, restartOfA.id), "Claude Worker's other notice, not marked").toBeVisible();
    await panelNotice(page, A, restartOfA.id).getByRole('button', { name: 'seen', exact: true }).click();
    await expect(panelNotice(page, A, restartOfA.id)).toHaveCount(0, { timeout: 10_000 });
    await expect(panelNotice(page, B, noticeOf(B).id), "Claude Second's notice, not marked").toBeVisible();
    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.markNoticesSeen(id), B);
    await expect(panelNotice(page, B, noticeOf(B).id), 'marked elsewhere').toHaveCount(0, { timeout: 10_000 });
    const afterSeen = await allNotices();
    keep({ afterSeen });
    expect(afterSeen.every((n) => typeof n.seenAt === 'number')).toBe(true);
    await stepShot(page, '06-panels-seen');
    await searchLogs(page, 'Refused a session');
    for (const id of [A, B]) await expect(page.locator(`[data-log-notice="${noticeOf(id).id}"]`), `${NAMES[id]}'s seen notice in the search`).toBeVisible({ timeout: 30_000 });
    // Both stopped, read from their kept output: each "[Tars] Refused a session" hit is the notice, never a plain line.
    await expect(page.getByText('[Tars] Refused a session'), 'no plain hit holds a kept notice\'s line (stopped)').toHaveCount(0);
    const stoppedSearch = await drawnIds(page.locator('body'));
    await page.getByPlaceholder(QUERY).fill('');
    await page.getByRole('button', { name: new RegExp(NAMES[A]) }).first().click();
    await expect(page.locator(`[data-log-notice="${noticeOf(A).id}"]`), "Claude Worker's seen notice in its tail").toBeVisible({ timeout: 30_000 });
    // Its kept output holds both lines, each claiming its notice: drawn among the lines, none left to the group, and no
    // plain line holds the "[Tars] " text.
    await expect(page.locator('[data-log-notices-group]'), "Claude Worker's stopped tail: no notice left to the group").toHaveCount(0);
    await expect(page.locator('pre').filter({ hasText: '[Tars] Refused a session' }), 'no plain line holds a kept notice\'s line (stopped)').toHaveCount(0);
    await expect(page.locator('pre').filter({ hasText: `[Tars] ${RESTART}` }), 'no plain line holds the restart notice\'s line (stopped)').toHaveCount(0);
    const stoppedTail = await drawnIds(page.locator('body'));
    expect(stoppedTail, "Claude Worker's stopped tail, its notices in their lines' order").toEqual(byTimeA);
    keep({ stoppedSearch, stoppedTail });
    await stepShot(page, '07-logs-after-seen');
    // Forger stopped with Tars: its "[Tars] ..." line, replayed from its kept output, is still its own.
    keep({ forgedStopped: await forgedIsTheAgents(page, 'stopped') });
    keep({ errors });
    expect(errors).toEqual([]);
  } finally {
    recordValues(values);
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
