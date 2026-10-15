import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { fmtTokens, fmtUsd } from '@/lib/usage-format';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Usage page by agent, in the real app (JeanBrasse, 13/10: "Dans Usage on
 * pourrait check l'usage par agent et pas par tâche aussi ? Je veux avoir le
 * choix de regarder l'un ou l'autre"). Frames: `Usage · cost per agent`, and
 * the switch in `Usage · cost per task`, with their light copies.
 *
 * The sandbox holds what task-cost-view.spec.ts seeds, as usage.tasks reads
 * it: a ledger of tasks, the transcripts their sessions wrote, a catalogue
 * pricing claude-opus-5 at $1 a million tokens in and $2 out, and two Claude
 * accounts, Main and Second. The lead's two tasks ran on one each, the
 * worker's latest on Second and its three chores on none; the Codex helper's
 * CLI wrote no transcript; an agent since deleted has a task; two of the
 * lead's tasks start before the 14 days.
 * - By task first, the switch counting the tasks and the agents listed.
 * - By agent: one row per agent, the dearest first, the uncounted last, each
 *   with its project, the provider and account of its latest task and any
 *   other under it, and its tasks, time, tokens and cost. Each row is the sum
 *   of that agent's rows in the task view, and of the tokens and costs
 *   usage.tasks gave for the window: own costs, so the lead's delegations are
 *   counted once, in the agents that did them.
 * - The window rule (the Audit's Low 1 on #408, its words at #416's gate): a
 *   row holds the tasks begun in the timeframe, each at its own cost, and the
 *   note under the rows says so, and what the charts hold that no row does. The lead's task begun half a minute before the 14 days wrote its reply
 *   inside them: the charts above count it, by turn, and no row does, so the
 *   total cost is the rows' sum and that task's own cost.
 * - The agent picked in the task view steps aside in the agent view and is
 *   kept for the task view; the project picked applies to both.
 * - The view picked is kept: the page opens on it again. 24 hours, then light.
 *
 * The artefact: a screenshot per step, the light one last, and values.json
 * with the rows of both views at each step and the report usage.tasks gave.
 */

const H = 3_600_000;
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

type TaskRow = { text: string; agent: string; own: string };
type AgentRow = { agent: string; project: string; provider: string; also: string; tasks: string; time: string; tokens: string; cost: string; partial: string };
type Entry = { id: string; agentId: string; startedAt: number; costUSD: number | null; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null };
type Report = { tasks: Entry[]; agentNames: Record<string, string> };
type Api = { electronAPI: { usage: { tasks(q?: { sinceDays?: number }): Promise<Report> } } };

test('the usage page shows its tasks by agent, each agent the sum of its own tasks, and opens again on the view picked', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-usage-by-agent-'));
  const dir = path.join(home, '.dorothy');
  const tars = path.join(home, 'projects', 'tars');
  const site = path.join(home, 'projects', 'site');
  for (const folder of [dir, tars, site]) fs.mkdirSync(folder, { recursive: true });

  const agent = (id: string, name: string, project: string, provider = 'claude') => ({
    id, name, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [],
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', tars), agent('worker', 'Build Worker', tars),
    agent('codex', 'Codex Helper', tars, 'codex'), agent('writer', 'Site Writer', site),
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

  // The ledger and the transcripts, around now, as task-cost-view.spec.ts writes them.
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
  task({ id: 'task-writer', agentId: 'writer', project: site, source: 'telegram', outcome: 'stopped', text: 'update the landing copy', startedAt: now - 26 * H, minutes: 30, session: 'sess-writer', replies: [[250_000, 0]] });
  task({ id: 'task-hermes', agentId: 'lead', project: tars, source: 'hermes', outcome: 'error', text: 'the nightly test run', startedAt: now - 72 * H, minutes: 43, accountId: 'acct-0b0b0b', session: 'sess-hermes', replies: [[500_000, 250_000]] });
  task({ id: 'task-ghost', agentId: 'ghost', project: tars, source: 'terminal', text: 'an old task of a deleted agent', startedAt: now - 120 * H, minutes: 10, session: 'sess-ghost', replies: [[100_000, 0]] });
  for (let i = 1; i <= 3; i++) {
    task({ id: `task-chore-${i}`, agentId: 'worker', project: tars, source: 'tars', text: `chore ${i}`, startedAt: now - 144 * H + i * 10 * 60_000, minutes: 5, session: 'sess-chores', replies: [[20_000, 0]] });
  }
  // The lead's, before the 14 days: forty days back, and half a minute before
  // local midnight 13 days back, which usage.tasks hands over and the page cuts.
  task({ id: 'task-old', agentId: 'lead', project: tars, source: 'terminal', text: 'the old migration', startedAt: now - 40 * 24 * H, minutes: 60, session: 'sess-old', replies: [[1_000_000, 0]] });
  const today = new Date(now);
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 13).getTime();
  task({ id: 'task-edge', agentId: 'lead', project: tars, source: 'terminal', text: 'just before the window', startedAt: windowStart - 30_000, minutes: 5, session: 'sess-edge', replies: [[10_000, 0]] });
  fs.writeFileSync(path.join(dir, 'task-ledger.jsonl'), lines.join('\n') + '\n');
  for (const [file, list] of transcripts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, list.join('\n') + '\n');
  }

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31436), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = page.locator('[data-tasks-panel]');
    const byTask = panel.getByRole('radio', { name: /^By task/ });
    const byAgent = panel.getByRole('radio', { name: /^By agent/ });
    const open = async (p: Page) => {
      await p.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await expect(p.locator('[data-tasks-panel]')).toBeVisible({ timeout: 90_000 });
      await expect(p.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    };
    const taskRows = (): Promise<TaskRow[]> => panel.locator('[data-task-row]').evaluateAll(els => els.map(el => {
      const cell = (name: string) => (el.querySelector(`[data-cell="${name}"]`)?.textContent ?? '').trim();
      return { text: cell('text'), agent: cell('agent'), own: cell('own') };
    }));
    const agentRows = (): Promise<AgentRow[]> => panel.locator('[data-agent-row]').evaluateAll(els => els.map(el => {
      const value = (name: string) => (el.querySelector(`[data-cell="${name}"] [data-value]`)?.textContent ?? '').trim();
      const sub = (name: string) => (el.querySelector(`[data-cell="${name}"] [data-sub]`)?.textContent ?? '').trim();
      return {
        agent: value('agent'), project: value('project'), provider: value('provider'), also: sub('provider'),
        tasks: value('tasks'), time: value('time'), tokens: value('tokens'), cost: value('cost'), partial: sub('cost'),
      };
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
    const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 14 }));
    seen.report = report;

    // By task first: the switch counts the tasks listed and the agents they are of.
    await expect(panel.locator('[data-task-row]')).toHaveCount(9, { timeout: 30_000 });
    await expect(byTask).toHaveAttribute('aria-checked', 'true');
    await expect(byTask).toHaveText('By task (9)');
    await expect(byAgent).toHaveText('By agent (5)');
    await expect(panel).toContainText('TASKS · 14 DAYS');
    const tasks = await taskRows();
    seen.byTask = tasks;
    await shot('01-by-task');

    // By agent: one row each, the dearest first, the uncounted last.
    await byAgent.click();
    await expect(byAgent).toHaveAttribute('aria-checked', 'true');
    await expect(panel).toContainText('AGENTS · 14 DAYS');
    await expect(panel.locator('[data-agent-row]')).toHaveCount(5);
    await expect(panel.locator('[data-task-row]')).toHaveCount(0);
    await expect(panel).toContainText('5 agents · 1 task not counted');
    await expect(panel).toContainText('A row adds up the agent\'s tasks begun in this timeframe, each at its own cost from its first turn to its last. The charts above count by turn, and also hold what no row does: a task begun earlier, what came before Tars recorded tasks (1.9.3), and Claude Code sessions Tars did not start.');
    await expect(panel.getByRole('button', { name: 'Show the tasks of one agent' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Show the tasks of one project' })).toBeVisible();
    const agents = await agentRows();
    seen.byAgent = agents;
    expect(agents).toEqual([
      { agent: 'Build Worker', project: 'tars', provider: 'Claude · Second', also: 'also Claude', tasks: '4', time: '30 min', tokens: '3.1M', cost: '$3.06', partial: '' },
      { agent: 'Project Lead', project: 'tars', provider: 'Claude · Main', also: 'also Claude · Second', tasks: '2', time: '1 h 13', tokens: '2.3M', cost: '$3.00', partial: '' },
      { agent: 'Site Writer', project: 'site', provider: 'Claude', also: '', tasks: '1', time: '30 min', tokens: '250.0k', cost: '$0.25', partial: '' },
      { agent: 'deleted agent', project: 'tars', provider: 'Claude', also: '', tasks: '1', time: '10 min', tokens: '100.0k', cost: '$0.10', partial: '' },
      { agent: 'Codex Helper', project: 'tars', provider: 'Codex', also: '', tasks: '1', time: '15 min', tokens: '-', cost: 'not counted', partial: '' },
    ]);

    // Each row is the sum of that agent's tasks: its rows in the task view,
    // and the tokens and own costs usage.tasks gave for the 14 days.
    const money = (text: string) => Number(text.replace(/[$,]/g, ''));
    const inWindow = report.tasks.filter(t => t.startedAt >= windowStart);
    const nameOf = (id: string) => report.agentNames[id] ?? 'deleted agent';
    const sums: Record<string, { tasks: number; cost: number | null; tokens: number | null }> = {};
    for (const t of inWindow) {
      const s = sums[nameOf(t.agentId)] ??= { tasks: 0, cost: null, tokens: null };
      s.tasks += 1;
      if (t.costUSD !== null) s.cost = (s.cost ?? 0) + t.costUSD;
      if (t.tokens) s.tokens = (s.tokens ?? 0) + t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
    }
    seen.sumsFromTheReport = sums;
    expect(Object.keys(sums).sort()).toEqual(agents.map(a => a.agent).sort());
    for (const a of agents) {
      const its = tasks.filter(t => t.agent === a.agent);
      expect(String(its.length), a.agent).toBe(a.tasks);
      const counted = its.filter(t => t.own !== 'not counted');
      expect(a.cost, a.agent).toBe(counted.length ? fmtUsd(counted.reduce((sum, t) => sum + money(t.own), 0)) : 'not counted');
      expect(String(sums[a.agent].tasks), a.agent).toBe(a.tasks);
      expect(a.cost, a.agent).toBe(sums[a.agent].cost === null ? 'not counted' : fmtUsd(sums[a.agent].cost as number));
      expect(a.tokens, a.agent).toBe(sums[a.agent].tokens === null ? '-' : fmtTokens(sums[a.agent].tokens as number));
    }

    // The window rule: the lead's task begun half a minute before the 14 days
    // is in no row, and its reply, written inside them, is in the charts'
    // total, which counts by turn.
    const edge = report.tasks.find(t => t.id === 'task-edge');
    expect(edge?.startedAt).toBeLessThan(windowStart);
    expect(edge?.costUSD).toBeGreaterThan(0);
    const rowsSum = Object.values(sums).reduce((sum, s) => sum + (s.cost ?? 0), 0);
    const totalCost = page.getByText('TOTAL COST', { exact: true }).locator('xpath=..').locator('p').first();
    seen.windowRule = { rowsSum, edgeTask: edge?.costUSD, totalCost: await totalCost.textContent() };
    await expect(totalCost).toHaveText(fmtUsd(rowsSum + (edge?.costUSD ?? 0)));
    await shot('02-by-agent');

    // The agent picked in the task view steps aside in the agent view, and is
    // kept for the task view; the project picked applies to both.
    await byTask.click();
    await pick('Show the tasks of one agent', 'Project Lead');
    await expect(panel.locator('[data-task-row]')).toHaveCount(2);
    await expect(byTask).toHaveText('By task (2)');
    await expect(byAgent).toHaveText('By agent (5)');
    await byAgent.click();
    await expect(panel.locator('[data-agent-row]')).toHaveCount(5);
    await pick('Show the tasks of one project', 'site');
    await expect(panel.locator('[data-agent-row]')).toHaveCount(1);
    await expect(byAgent).toHaveText('By agent (1)');
    seen.siteProject = await agentRows();
    expect(seen.siteProject).toEqual([agents[2]]);
    await shot('03-one-project');
    await pick('Show the tasks of one project', 'All projects');
    await byTask.click();
    await expect(panel.locator('[data-task-row]')).toHaveCount(2);
    expect((await taskRows()).map(r => r.agent)).toEqual(['Project Lead', 'Project Lead']);
    await pick('Show the tasks of one agent', 'All agents');
    await expect(panel.locator('[data-task-row]')).toHaveCount(9);

    // The view picked is kept: the page opens on it again.
    await byAgent.click();
    await expect(panel.locator('[data-agent-row]')).toHaveCount(5);
    await open(page);
    await expect(byAgent).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await expect(panel.locator('[data-agent-row]')).toHaveCount(5, { timeout: 30_000 });
    seen.afterReload = await agentRows();
    expect(seen.afterReload).toEqual(agents);
    await shot('04-kept-after-reload');

    // The page's timeframe applies: 24 hours.
    await page.getByRole('radio', { name: '24 hours' }).click();
    await expect(panel).toContainText('AGENTS · 24 HOURS', { timeout: 30_000 });
    await expect(panel.locator('[data-agent-row]')).toHaveCount(3);
    seen.day = await agentRows();
    expect((seen.day as AgentRow[]).map(r => [r.agent, r.tasks, r.cost])).toEqual([
      ['Build Worker', '1', '$3.00'], ['Project Lead', '1', '$2.00'], ['Codex Helper', '1', 'not counted'],
    ]);
    await shot('05-twenty-four-hours');

    // Light, as its copy of the frame draws it, still by agent.
    await page.evaluate(() => localStorage.setItem('tars-theme', 'light'));
    await open(page);
    await expect(byAgent).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await expect(panel.locator('[data-agent-row]')).toHaveCount(5, { timeout: 30_000 });
    await shot('06-light');

    // And back by task, which the page opens on again.
    await byTask.click();
    await expect(panel.locator('[data-task-row]')).toHaveCount(9);
    await open(page);
    await expect(panel.locator('[data-task-row]')).toHaveCount(9, { timeout: 30_000 });
    await expect(byTask).toHaveAttribute('aria-checked', 'true');
    await expect(panel.locator('[data-agent-row]')).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    // Kept red or green: what each step read is the artefact.
    recordValues({ seen, pageErrors: errors });
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
