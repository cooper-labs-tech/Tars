import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The cost of each task, in the Usage page of the real app, on #305's
 * usage.tasks (PLAN-1.9.3.md, item 2). Frames: `Usage · cost per task`, and
 * its light copy.
 *
 * The sandbox holds a ledger of tasks (~/.dorothy/task-ledger.jsonl), the
 * transcripts their sessions wrote, and a catalogue pricing claude-opus-5 at
 * $1 a million tokens in and $2 out, marked fresh so no fetch replaces it,
 * and two Claude accounts on, Main and Second, which the lead and the worker
 * ran on.
 * Seeded rather than run: the chain that writes them is #305's own spec
 * (task-cost.spec.ts). This one reads what the page makes of them, through the
 * real IPC and the real pricing.
 * - 14 days: the 21 tasks of the window, newest first, twenty at a time. The
 *   lead's own cost, and its total with the worker's and the Codex helper's,
 *   partial since the helper's CLI wrote no transcript: "not counted", never
 *   $0.00. A deleted agent's task. Who handed each over; a stopped and an
 *   errored one. The averages per agent and per model over them.
 * - A project picked, then an agent: the rows and the averages follow.
 * - 24 hours: today's three. 12 weeks: two older tasks too, one of them half
 *   a minute before the 14 days start, which usage.tasks hands over (the page
 *   asks a minute early) and the page leaves out of its 14 days.
 * - Past twenty: the rest on demand.
 *
 * The artefact: a screenshot per step, the last one in light, and values.json
 * with the rows and averages read at each step and the report usage.tasks gave.
 */

const H = 3_600_000;
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

type Row = { text: string; source: string; agent: string; provider: string; model: string; started: string; ended: string; time: string; turns: string; tokens: string; own: string; total: string };
type Average = { name: string; tasks: string; counted: string; cost: string; time: string };
type Api = { electronAPI: { usage: { tasks(q?: { sinceDays?: number }): Promise<unknown> } } };

test('the usage page lists each task with its own cost and its total, the averages per agent and per model, filtered by project, agent and period', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-task-cost-view-'));
  const dir = path.join(home, '.dorothy');
  const tars = path.join(home, 'projects', 'tars');
  const site = path.join(home, 'projects', 'site');
  for (const folder of [dir, tars, site]) fs.mkdirSync(folder, { recursive: true });

  // The writer's name and its task's text carry a U+202E and a line break,
  // as a name or a prompt can: the page reads them flattened, "Site Writer"
  // and "update the landing copy" (the Audit's Low at this PR's gate).
  const agent = (id: string, name: string, project: string, provider = 'claude') => ({
    id, name, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [],
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', tars), agent('worker', 'Build Worker', tars),
    agent('codex', 'Codex Helper', tars, 'codex'), agent('writer', 'Site\u202EWriter', site),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([tars, site]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  fs.writeFileSync(path.join(dir, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  fs.writeFileSync(path.join(dir, 'model-catalog.meta.json'), JSON.stringify({ fetchedAt: Date.now() }));
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), JSON.stringify({
    enabled: true, fiveHourThreshold: 90, weeklyThreshold: 95,
    accounts: [{ id: 'default', label: 'Main', enabled: true }, { id: 'acct-0b0b0b', label: 'Second', enabled: true }],
  }), { mode: 0o600 });

  // The ledger and the transcripts, around now.
  const now = Date.now();
  const lines: string[] = [];
  const transcripts = new Map<string, string[]>();
  let reply = 0;
  const task = (t: {
    id: string; agentId: string; project: string; source: string; text: string; startedAt: number; minutes: number;
    outcome?: string; requesterAgentId?: string; parentTaskId?: string; provider?: string; model?: string; accountId?: string;
    session?: string; replies?: Array<[number, number]>;
  }) => {
    const endedAt = t.startedAt + t.minutes * 60_000;
    lines.push(JSON.stringify({ t: 'task', task: {
      id: t.id, agentId: t.agentId, projectPath: t.project, worktreePath: null,
      provider: t.provider ?? 'claude', model: t.model ?? 'claude-opus-5', accountId: t.accountId ?? null,
      source: t.source, requesterAgentId: t.requesterAgentId ?? null, parentTaskId: t.parentTaskId ?? null,
      text: t.text, startedAt: t.startedAt, endedAt, lastAt: endedAt, outcome: t.outcome ?? 'completed',
      turns: t.replies?.length || 1, sessionIds: t.session ? [t.session] : [],
    } }));
    if (!t.session) return;
    const file = path.join(home, '.claude', 'projects', t.project.replace(/[^a-zA-Z0-9]/g, '-'), `${t.session}.jsonl`);
    const list = transcripts.get(file) ?? [];
    (t.replies ?? []).forEach(([input, output], i) => {
      reply += 1;
      list.push(JSON.stringify({
        type: 'assistant', requestId: `req_${reply}`, timestamp: new Date(t.startedAt + (i + 1) * 60_000).toISOString(),
        message: { id: `msg_${reply}`, model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: output } },
      }));
    });
    transcripts.set(file, list);
  };
  task({ id: 'task-lead', agentId: 'lead', project: tars, source: 'terminal', text: 'fix the build on main', startedAt: now - 3 * H, minutes: 30, accountId: 'default', session: 'sess-lead', replies: [[1_000_000, 500_000]] });
  task({ id: 'task-worker', agentId: 'worker', project: tars, source: 'agent', requesterAgentId: 'lead', parentTaskId: 'task-lead', text: 'review the build', startedAt: now - 3 * H + 5 * 60_000, minutes: 15, accountId: 'acct-0b0b0b', session: 'sess-worker', replies: [[3_000_000, 0]] });
  task({ id: 'task-codex', agentId: 'codex', project: tars, source: 'agent', requesterAgentId: 'lead', parentTaskId: 'task-lead', text: 'translate the strings', startedAt: now - 3 * H + 10 * 60_000, minutes: 15, provider: 'codex', model: 'gpt-5.3-codex' });
  task({ id: 'task-writer', agentId: 'writer', project: site, source: 'telegram', outcome: 'stopped', text: 'update the\u202E landing\ncopy', startedAt: now - 26 * H, minutes: 30, session: 'sess-writer', replies: [[250_000, 0]] });
  task({ id: 'task-hermes', agentId: 'lead', project: tars, source: 'hermes', outcome: 'error', text: 'the nightly test run', startedAt: now - 72 * H, minutes: 43, session: 'sess-hermes', replies: [[500_000, 250_000]] });
  task({ id: 'task-ghost', agentId: 'ghost', project: tars, source: 'terminal', text: 'an old task of a deleted agent', startedAt: now - 120 * H, minutes: 10, session: 'sess-ghost', replies: [[100_000, 0]] });
  for (let i = 1; i <= 15; i++) {
    task({ id: `task-chore-${i}`, agentId: 'worker', project: tars, source: 'tars', text: `chore ${i}`, startedAt: now - 144 * H + i * 10 * 60_000, minutes: 5, session: 'sess-chores', replies: [[20_000, 0]] });
  }
  task({ id: 'task-old', agentId: 'lead', project: tars, source: 'terminal', text: 'the old migration', startedAt: now - 40 * 24 * H, minutes: 60, session: 'sess-old', replies: [[1_000_000, 0]] });
  // Half a minute before the 14 days start, at local midnight 13 days back:
  // usage.tasks is asked a minute early and hands it over, and the page cuts it.
  const today = new Date(now);
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 13).getTime();
  task({ id: 'task-edge', agentId: 'lead', project: tars, source: 'terminal', text: 'just before the window', startedAt: windowStart - 30_000, minutes: 5, session: 'sess-edge', replies: [[10_000, 0]] });
  fs.writeFileSync(path.join(dir, 'task-ledger.jsonl'), lines.join('\n') + '\n');
  for (const [file, list] of transcripts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, list.join('\n') + '\n');
  }

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31467), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = page.locator('[data-tasks-panel]');
    const open = async (p: Page) => {
      await p.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await expect(p.locator('[data-tasks-panel]')).toBeVisible({ timeout: 90_000 });
      await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    };
    const rows = (): Promise<Row[]> => panel.locator('[data-task-row]').evaluateAll(els => els.map(el => {
      const cell = (name: string) => (el.querySelector(`[data-cell="${name}"]`)?.textContent ?? '').trim();
      return {
        text: cell('text'), source: cell('source'), agent: cell('agent'), provider: cell('provider'), model: cell('model'),
        started: cell('started'), ended: cell('ended'), time: cell('time'), turns: cell('turns'), tokens: cell('tokens'),
        own: cell('own'), total: cell('total'),
      };
    }));
    const averages = (which: string): Promise<Average[]> => page.locator(`[data-task-averages="${which}"] [data-average-row]`).evaluateAll(els => els.map(el => {
      const cell = (name: string) => (el.querySelector(`[data-cell="${name}"]`)?.textContent ?? '').trim();
      return { name: cell('name'), tasks: cell('tasks'), counted: cell('counted'), cost: cell('cost'), time: cell('time') };
    }));
    const pick = async (label: string, option: string) => {
      await panel.getByRole('button', { name: label }).click();
      await page.getByRole('option', { name: new RegExp(`^${option}`) }).click();
    };
    const shot = async (name: string) => {
      await panel.scrollIntoViewIfNeeded();
      await stepShot(page, name);
    };

    await open(page);
    seen.report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 14 }));

    // 14 days: twenty of the 21, newest first.
    await expect(panel.locator('[data-task-row]')).toHaveCount(20, { timeout: 30_000 });
    await expect(panel).toContainText('21 tasks · 1 not counted');
    const first = await rows();
    seen.fourteenDays = first;
    expect(first.slice(0, 3).map(r => r.text)).toEqual(['translate the strings', 'review the build', 'fix the build on main']);
    expect(first[0]).toMatchObject({ source: 'from Project Lead', agent: 'Codex Helper', provider: 'Codex', model: 'gpt-5.3-codex', time: '15 min', tokens: '-', own: 'not counted', total: 'not counted' });
    // Several Claude accounts are off on a Windows build whatever the registry
    // says: there a task names no account.
    const claudeOn = (account: string) => (process.platform === 'win32' ? 'Claude' : `Claude · ${account}`);
    expect(first[1]).toMatchObject({ source: 'from Project Lead', agent: 'Build Worker', provider: claudeOn('Second'), model: 'Opus 5', time: '15 min', turns: '1', tokens: '3.0M', own: '$3.00', total: '$3.00' });
    expect(first[2]).toMatchObject({ source: 'typed', agent: 'Project Lead', provider: claudeOn('Main'), time: '30 min', tokens: '1.5M', own: '$2.00', total: '$5.00partial' });
    expect(first[3]).toMatchObject({ text: 'update the landing copy', source: 'from Telegram · stopped', agent: 'Site Writer', provider: 'Claude', own: '$0.25' });
    expect(first[4]).toMatchObject({ text: 'the nightly test run', source: 'from Hermes · error', own: '$1.00', time: '43 min' });
    expect(first[5]).toMatchObject({ text: 'an old task of a deleted agent', agent: 'deleted agent', own: '$0.10' });
    expect(first[6]).toMatchObject({ text: 'chore 15', source: 'from Tars', own: '$0.02' });
    for (const row of first) expect(row.started).toMatch(/\d\d:\d\d$|\d{4}$/);
    seen.byAgent = await averages('agent');
    seen.byModel = await averages('model');
    expect(seen.byAgent).toEqual([
      { name: 'Build Worker', tasks: '16', counted: '16', cost: '$0.21', time: '5 min' },
      { name: 'Project Lead', tasks: '2', counted: '2', cost: '$1.50', time: '36 min' },
      { name: 'Site Writer', tasks: '1', counted: '1', cost: '$0.25', time: '30 min' },
      { name: 'deleted agent', tasks: '1', counted: '1', cost: '$0.10', time: '10 min' },
      { name: 'Codex Helper', tasks: '1', counted: '0', cost: 'not counted', time: '15 min' },
    ]);
    expect(seen.byModel).toEqual([
      { name: 'Opus 5', tasks: '20', counted: '20', cost: '$0.33', time: '10 min' },
      { name: 'gpt-5.3-codex', tasks: '1', counted: '0', cost: 'not counted', time: '15 min' },
    ]);
    await shot('01-fourteen-days');
    await page.locator('[data-task-averages="agent"]').scrollIntoViewIfNeeded();
    await stepShot(page, '01b-averages');

    // The rest on demand.
    await expect(panel).toContainText('20 of 21');
    await panel.getByRole('button', { name: 'show 1 more' }).click();
    await expect(panel.locator('[data-task-row]')).toHaveCount(21);
    await expect(panel.getByRole('button', { name: /^show \d+ more$/ })).toHaveCount(0);
    expect((await rows())[20].text).toBe('chore 1');

    // A project, then an agent: the rows and the averages follow.
    await pick('Show the tasks of one project', 'site');
    await expect(panel.locator('[data-task-row]')).toHaveCount(1);
    seen.siteProject = await rows();
    expect((seen.siteProject as Row[])[0].text).toBe('update the landing copy');
    expect(await averages('agent')).toEqual([{ name: 'Site Writer', tasks: '1', counted: '1', cost: '$0.25', time: '30 min' }]);
    await shot('02-one-project');
    await pick('Show the tasks of one project', 'All projects');
    await pick('Show the tasks of one agent', 'Project Lead');
    await expect(panel.locator('[data-task-row]')).toHaveCount(2);
    seen.leadAgent = await rows();
    expect((seen.leadAgent as Row[]).map(r => r.text)).toEqual(['fix the build on main', 'the nightly test run']);
    expect(await averages('model')).toEqual([{ name: 'Opus 5', tasks: '2', counted: '2', cost: '$1.50', time: '36 min' }]);
    await shot('03-one-agent');
    await pick('Show the tasks of one agent', 'All agents');

    // The page's timeframe: 24 hours, then 12 weeks.
    await page.getByRole('radio', { name: '24 hours' }).click();
    await expect(panel.locator('[data-task-row]')).toHaveCount(3, { timeout: 30_000 });
    await expect(panel).toContainText('TASKS · 24 HOURS');
    seen.day = await rows();
    await shot('04-twenty-four-hours');
    await page.getByRole('radio', { name: '12 weeks' }).click();
    await expect(panel).toContainText('23 tasks', { timeout: 30_000 });
    await panel.getByRole('button', { name: 'show 3 more' }).click();
    await expect(panel.locator('[data-task-row]')).toHaveCount(23);
    seen.twelveWeeks = await rows();
    expect((seen.twelveWeeks as Row[]).slice(21).map(r => r.text)).toEqual(['just before the window', 'the old migration']);

    // Light, as its copy of the frame draws it.
    await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
    await open(page);
    await expect(panel.locator('[data-task-row]')).toHaveCount(20, { timeout: 30_000 });
    await shot('05-light');

    recordValues({ seen, pageErrors: errors });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
