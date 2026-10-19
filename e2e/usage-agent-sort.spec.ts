import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Usage page by agent, sorted by a column's header (JeanBrasse, 18/10, for
 * 2.0.4): a click on Agent, Project or Provider sorts the rows A to Z, and on
 * Tasks, Time, Tokens or Cost highest first (his decision of 18/10: words read
 * A to Z first); a second click turns the order round; a third gives the
 * default order back, the dearest first. The header shows which column and
 * which way, as a box (`Usage · cost per agent`, its header states, and the
 * light copy), says it to a screen reader with aria-sort, and takes Enter and
 * Space as it takes a click. In the classic shell at /usage, and with the new
 * interface on, in the card More opens.
 *
 * Six agents, each column giving them an order of its own: a project, a
 * provider or a count two agents share keeps them in the default order,
 * whichever way the column goes; an agent with no tokens or nothing counted
 * goes last both ways.
 *
 *   agent  project  provider         tasks  time    tokens  cost
 *   Ada    tars     Claude · Main    3      50 min  1.2M    $1.50
 *   Bo     site     Claude · Second  1      2 h 00  2.0M    $3.00
 *   Cy     atlas    Codex            2      25 min  -       not counted
 *   Di     tars     Claude           4      8 min   400.0k  $0.40
 *   Eve    mercury  Claude · Main    1      5 min   2.5M    $2.50
 *   Fox    site     Codex            1      40 min  -       not counted
 *
 * The artefact: values.json with the rows read after every click, in both
 * shells, and a screenshot of each header state, the light one last.
 */

const H = 3_600_000;
const M = 60_000;
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

const DEFAULT = ['Bo', 'Eve', 'Ada', 'Di', 'Cy', 'Fox'];
/** Each column, the order its first click gives and the way it goes, then the order its second gives. */
const COLUMNS: Array<{ header: string; cell: string; first: string[]; firstSort: 'ascending' | 'descending'; second: string[] }> = [
  { header: 'Agent', cell: 'agent', first: ['Ada', 'Bo', 'Cy', 'Di', 'Eve', 'Fox'], firstSort: 'ascending', second: ['Fox', 'Eve', 'Di', 'Cy', 'Bo', 'Ada'] },
  { header: 'Project', cell: 'project', first: ['Cy', 'Eve', 'Bo', 'Fox', 'Ada', 'Di'], firstSort: 'ascending', second: ['Ada', 'Di', 'Bo', 'Fox', 'Eve', 'Cy'] },
  { header: 'Provider', cell: 'provider', first: ['Di', 'Eve', 'Ada', 'Bo', 'Cy', 'Fox'], firstSort: 'ascending', second: ['Cy', 'Fox', 'Bo', 'Eve', 'Ada', 'Di'] },
  { header: 'Tasks', cell: 'tasks', first: ['Di', 'Ada', 'Cy', 'Bo', 'Eve', 'Fox'], firstSort: 'descending', second: ['Bo', 'Eve', 'Fox', 'Cy', 'Ada', 'Di'] },
  { header: 'Time', cell: 'time', first: ['Bo', 'Ada', 'Fox', 'Cy', 'Di', 'Eve'], firstSort: 'descending', second: ['Eve', 'Di', 'Cy', 'Fox', 'Ada', 'Bo'] },
  { header: 'Tokens', cell: 'tokens', first: ['Eve', 'Bo', 'Ada', 'Di', 'Cy', 'Fox'], firstSort: 'descending', second: ['Di', 'Ada', 'Bo', 'Eve', 'Cy', 'Fox'] },
  { header: 'Cost', cell: 'cost', first: ['Bo', 'Eve', 'Ada', 'Di', 'Cy', 'Fox'], firstSort: 'descending', second: ['Di', 'Ada', 'Eve', 'Bo', 'Cy', 'Fox'] },
];
const col = (header: string) => COLUMNS.find(c => c.header === header)!;
const other = (sort: 'ascending' | 'descending') => (sort === 'ascending' ? 'descending' : 'ascending');
/** What each agent's row says, column by column, as the table above writes it. */
const ROWS: Record<string, Record<string, string>> = {
  Ada: { project: 'tars', provider: 'Claude · Main', tasks: '3', time: '50 min', tokens: '1.2M', cost: '$1.50' },
  Bo: { project: 'site', provider: 'Claude · Second', tasks: '1', time: '2 h 00', tokens: '2.0M', cost: '$3.00' },
  Cy: { project: 'atlas', provider: 'Codex', tasks: '2', time: '25 min', tokens: '-', cost: 'not counted' },
  Di: { project: 'tars', provider: 'Claude', tasks: '4', time: '8 min', tokens: '400.0k', cost: '$0.40' },
  Eve: { project: 'mercury', provider: 'Claude · Main', tasks: '1', time: '5 min', tokens: '2.5M', cost: '$2.50' },
  Fox: { project: 'site', provider: 'Codex', tasks: '1', time: '40 min', tokens: '-', cost: 'not counted' },
};

/** A home holding the six agents, their tasks, and the transcripts the counted ones wrote. */
function seed(home: string, newInterface: boolean): void {
  const dir = path.join(home, '.dorothy');
  const project = (name: string) => path.join(home, 'projects', name);
  for (const folder of [dir, ...['tars', 'site', 'atlas', 'mercury'].map(project)]) fs.mkdirSync(folder, { recursive: true });
  const agent = (id: string, name: string, where: string, provider = 'claude') => ({
    id, name, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project(where), skills: [],
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('ada', 'Ada', 'tars'), agent('bo', 'Bo', 'site'), agent('cy', 'Cy', 'atlas', 'codex'),
    agent('di', 'Di', 'tars'), agent('eve', 'Eve', 'mercury'), agent('fox', 'Fox', 'site', 'codex'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(['tars', 'site', 'atlas', 'mercury'].map(project)));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
  fs.writeFileSync(path.join(dir, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  fs.writeFileSync(path.join(dir, 'model-catalog.meta.json'), JSON.stringify({ fetchedAt: Date.now() }));
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), JSON.stringify({
    enabled: true, fiveHourThreshold: 90, weeklyThreshold: 95,
    accounts: [{ id: 'default', label: 'Main', enabled: true }, { id: 'acct-0b0b0b', label: 'Second', enabled: true }],
  }), { mode: 0o600 });

  // The ledger and the transcripts, as usage-by-agent.spec.ts writes them:
  // claude-opus-5 at $1 a million tokens in and $2 out, Codex writing none.
  const now = Date.now();
  const lines: string[] = [];
  let reply = 0;
  const task = (t: { id: string; agentId: string; where: string; startedAt: number; minutes: number; provider?: string; accountId?: string; replies?: Array<[number, number]> }) => {
    const endedAt = t.startedAt + t.minutes * M;
    const session = t.replies ? `sess-${t.id}` : null;
    lines.push(JSON.stringify({ t: 'task', task: {
      id: t.id, agentId: t.agentId, projectPath: project(t.where), worktreePath: null,
      provider: t.provider ?? 'claude', model: t.provider === 'codex' ? 'gpt-5.3-codex' : 'claude-opus-5', accountId: t.accountId ?? null,
      source: 'terminal', requesterAgentId: null, parentTaskId: null,
      text: `the work of ${t.id}`, startedAt: t.startedAt, endedAt, lastAt: endedAt, outcome: 'completed',
      turns: t.replies?.length || 1, sessionIds: session ? [session] : [],
    } }));
    if (!session) return;
    const file = path.join(home, '.claude', 'projects', project(t.where).replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (t.replies ?? []).map(([input, output], i) => {
      reply += 1;
      return JSON.stringify({
        type: 'assistant', requestId: `req_${reply}`, timestamp: new Date(t.startedAt + (i + 1) * 30_000).toISOString(),
        message: { id: `msg_${reply}`, model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: output } },
      });
    }).join('\n') + '\n');
  };
  task({ id: 'ada-1', agentId: 'ada', where: 'tars', startedAt: now - 5 * H, minutes: 20, accountId: 'default', replies: [[400_000, 100_000]] });
  task({ id: 'ada-2', agentId: 'ada', where: 'tars', startedAt: now - 4 * H, minutes: 20, accountId: 'default', replies: [[300_000, 100_000]] });
  task({ id: 'ada-3', agentId: 'ada', where: 'tars', startedAt: now - 3 * H, minutes: 10, accountId: 'default', replies: [[200_000, 100_000]] });
  task({ id: 'bo-1', agentId: 'bo', where: 'site', startedAt: now - 7 * H, minutes: 120, accountId: 'acct-0b0b0b', replies: [[1_000_000, 1_000_000]] });
  task({ id: 'cy-1', agentId: 'cy', where: 'atlas', startedAt: now - 2 * H, minutes: 10, provider: 'codex' });
  task({ id: 'cy-2', agentId: 'cy', where: 'atlas', startedAt: now - 1 * H, minutes: 15, provider: 'codex' });
  for (let i = 1; i <= 4; i++) task({ id: `di-${i}`, agentId: 'di', where: 'tars', startedAt: now - 6 * H + i * 10 * M, minutes: 2, replies: [[100_000, 0]] });
  task({ id: 'eve-1', agentId: 'eve', where: 'mercury', startedAt: now - 90 * M, minutes: 5, accountId: 'default', replies: [[2_500_000, 0]] });
  task({ id: 'fox-1', agentId: 'fox', where: 'site', startedAt: now - 150 * M, minutes: 40, provider: 'codex' });
  fs.writeFileSync(path.join(dir, 'task-ledger.jsonl'), lines.join('\n') + '\n');
}

for (const newInterface of [false, true]) {
  test(`usage by agent: each header sorts its words A to Z or its figures highest first, then the other way, then gives the default order back${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-usage-sort-'));
    seed(home, newInterface);
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31418 : 31417), DOROTHY_E2E: '1' },
    });
    const errors: string[] = [];
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });

      // The page, where each shell shows it: the classic one at its route, the
      // new one in the card More opens.
      const open = async (p: Page): Promise<Locator> => {
        if (!newInterface) {
          await p.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
          await expect(p.getByRole('navigation', { name: 'Main menu' })).toHaveCount(0, { timeout: 90_000 });
          await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
          return p.locator('[data-tasks-panel]');
        }
        await p.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = p.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await p.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Usage' }).click();
        return p.getByRole('dialog', { name: 'Usage' }).locator('[data-tasks-panel]');
      };
      const panel = await open(page);
      await expect(panel).toBeVisible({ timeout: 90_000 });
      await panel.getByRole('radio', { name: /^By agent/ }).click();
      // The table pages five rows at a time since 2.0.4 (`Usage · pages`): ten a page holds the six, and the sort is
      // read over every row. Remembered, so the light copy below opens on ten too.
      const rowsChoice = panel.getByRole('button', { name: 'Agents rows per page' });
      if (await rowsChoice.count()) {
        await rowsChoice.click();
        await page.getByRole('option', { name: '10 rows' }).click();
      }
      const rows = panel.locator('[data-agent-row]');
      await expect(rows).toHaveCount(6, { timeout: 60_000 });

      const read = async () => rows.evaluateAll(els => els.map(el => {
        const value = (name: string) => (el.querySelector(`[data-cell="${name}"] [data-value]`)?.textContent ?? '').trim();
        return { agent: value('agent'), project: value('project'), provider: value('provider'), tasks: value('tasks'), time: value('time'), tokens: value('tokens'), cost: value('cost') };
      }));
      const order = async () => (await read()).map(r => r.agent);
      // The rows once they hold the order wanted, or as they still are after
      // five seconds: soft checks follow, so a run on a build that does not
      // sort reads every click rather than stopping at the first.
      const settle = async (want: string[]) => {
        const until = Date.now() + 5_000;
        let now = await order();
        while (now.join() !== want.join() && Date.now() < until) {
          await page.waitForTimeout(100);
          now = await order();
        }
        return read();
      };
      const header = (name: string) => panel.getByRole('columnheader', { name, exact: true });
      // What a click lands on: the header's button, or on a build with none,
      // the header itself, so that build is read sorting nothing rather than
      // waiting for a button.
      const label = async (name: string) => ((await header(name).getByRole('button').count()) > 0 ? header(name).getByRole('button') : header(name));
      const sorts = async () => Object.fromEntries(await Promise.all(COLUMNS.map(async c => [c.header, await header(c.header).getAttribute('aria-sort')])));
      const shot = async (name: string) => {
        await panel.scrollIntoViewIfNeeded();
        await stepShot(page, `${tag}${name}`);
      };

      // The default order, every value as the seed writes it.
      const first = await read();
      seen.defaultRows = first;
      expect(first.map(r => r.agent)).toEqual(DEFAULT);
      for (const r of first) expect({ ...r, agent: undefined }, r.agent).toEqual({ ...ROWS[r.agent], agent: undefined });
      // Every column sorts, the agent's own name too.
      for (const c of COLUMNS) await expect.soft(header(c.header), c.header).toHaveAttribute('aria-sort', 'none');
      await shot('01-default-order');

      // Three clicks on each header, each read in order.
      const clicks: Record<string, unknown> = {};
      for (const c of COLUMNS) {
        const turns: Array<{ click: number; ariaSort: string | null; agents: string[]; values: string[] }> = [];
        const valueOf = (a: string) => (c.cell === 'agent' ? a : ROWS[a][c.cell]);
        for (const [click, want, direction] of [[1, c.first, c.firstSort], [2, c.second, other(c.firstSort)], [3, DEFAULT, 'none']] as const) {
          await (await label(c.header)).click();
          const now = await settle([...want]);
          const ariaSort = await header(c.header).getAttribute('aria-sort');
          turns.push({ click, ariaSort, agents: now.map(r => r.agent), values: now.map(r => (r as Record<string, string>)[c.cell]) });
          expect.soft(ariaSort, `${c.header}, click ${click}: aria-sort`).toBe(direction);
          expect.soft(now.map(r => r.agent), `${c.header}, click ${click}: the order`).toEqual(want);
          expect.soft(now.map(r => (r as Record<string, string>)[c.cell]), `${c.header}, click ${click}: the values`).toEqual(want.map(valueOf));
          // One column sorted at a time, and none once the default order is back.
          const others = Object.entries(await sorts()).filter(([name]) => name !== c.header).map(([, v]) => v);
          expect.soft(others, `${c.header}, click ${click}: the other headers`).toEqual(others.map(() => 'none'));
          if (click < 3 && (c.header === 'Tokens' || c.header === 'Project' || c.header === 'Agent')) await shot(`02-${c.cell}-${direction}`);
        }
        clicks[c.header] = turns;
      }
      seen.clicks = clicks;

      // Another header starts at its own first order, wherever the first one was.
      await (await label('Tokens')).click();
      await (await label('Tokens')).click();
      await (await label('Cost')).click();
      const another = await settle(col('Cost').first);
      seen.anotherHeader = { agents: another.map(r => r.agent), sorts: await sorts() };
      expect.soft(await header('Cost').getAttribute('aria-sort'), 'Cost after Tokens').toBe('descending');
      expect.soft(await header('Tokens').getAttribute('aria-sort'), 'Tokens after Cost').toBe('none');
      expect.soft(another.map(r => r.agent)).toEqual(col('Cost').first);
      await (await label('Project')).click();
      const words = await settle(col('Project').first);
      seen.wordsAfterFigures = { agents: words.map(r => r.agent), sorts: await sorts() };
      expect.soft(await header('Project').getAttribute('aria-sort'), 'Project after Cost').toBe('ascending');
      expect.soft(words.map(r => r.agent), 'Project after Cost: A to Z').toEqual(col('Project').first);
      await (await label('Project')).click();
      await (await label('Project')).click();
      expect.soft((await settle(DEFAULT)).map(r => r.agent), 'Project, back to the default order').toEqual(DEFAULT);

      // The keyboard: Enter, then Space, then Enter, on Time.
      const keys: Array<{ key: string; ariaSort: string | null; agents: string[] }> = [];
      for (const [key, want, direction] of [['Enter', col('Time').first, 'descending'], ['Space', col('Time').second, 'ascending'], ['Enter', DEFAULT, 'none']] as const) {
        await (await label('Time')).focus();
        await page.keyboard.press(key);
        const now = await settle([...want]);
        const ariaSort = await header('Time').getAttribute('aria-sort');
        keys.push({ key, ariaSort, agents: now.map(r => r.agent) });
        expect.soft(ariaSort, `Time, ${key}: aria-sort`).toBe(direction);
        expect.soft(now.map(r => r.agent), `Time, ${key}: the order`).toEqual(want);
        if (direction === 'descending') await shot('03-time-descending-keyboard');
      }
      seen.keyboard = keys;

      // Light, as its copy of the frame draws the header: Provider, A to Z.
      await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
      const lightPanel = await open(page);
      await expect(lightPanel).toBeVisible({ timeout: 90_000 });
      await expect(lightPanel.locator('[data-agent-row]')).toHaveCount(6, { timeout: 60_000 });
      const provider = lightPanel.getByRole('columnheader', { name: 'Provider', exact: true });
      const providerTarget = (await provider.getByRole('button').count()) > 0 ? provider.getByRole('button') : provider;
      await providerTarget.click();
      await expect.soft(provider).toHaveAttribute('aria-sort', 'ascending');
      await lightPanel.scrollIntoViewIfNeeded();
      await stepShot(page, `${tag}04-provider-a-to-z-light`);
      await page.evaluate(() => localStorage.setItem('tars-theme', 'dark'));

      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      // Kept red or green: what each click read is the artefact.
      recordValues({ seen, pageErrors: errors });
      await app.close().catch(() => { /* gone */ });
      await removeHome(home);
    }
  });
}
