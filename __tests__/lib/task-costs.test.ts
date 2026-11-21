import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import {
  TASKS_PAGE,
  agentName,
  agentOptions,
  averagesBy,
  dominantModel,
  durationLabel,
  endLabel,
  filterTasks,
  inWindow,
  moneyText,
  moreLabel,
  projectOptions,
  providerText,
  sinceDaysFor,
  sourceText,
  startLabel,
  taskText,
  tokensTotal,
  totalText,
} from '../../src/lib/task-costs';
import type { TaskEntry } from '../../src/types/electron';

/**
 * What the Usage page says of each task (#305's usage.tasks), and the
 * averages it draws from them. Frame: `Usage · cost per task`, and its light
 * copy. Written before the code. How it can fail:
 * 1. the window: usage.tasks counts back in whole 24-hour periods, the page in
 *    its own window (14 days from local midnight 13 days back, 24 hours from
 *    the hour 23 hours back); a task started before the window is listed, or
 *    one inside it is dropped;
 * 2. a task not counted (a CLI that writes no transcript) reads $0.00, as if
 *    free, or weighs as 0 in a mean;
 * 3. the total: one that leaves out a task not counted is not said to be
 *    partial, or a task not counted whose children are hides their cost;
 * 4. the averages: a mean cost over every task instead of the counted ones, a
 *    mean time that counts a task still running, a model's average filed
 *    under the model the agent was launched on when its replies came from
 *    another, or an order that moves from one reading to the next;
 * 5. the filters keep a task of another project or agent, their options miss
 *    one of the window's, or a deleted agent shows as its id;
 * 6. who handed a task over is not said, or an agent's hand-off loses its
 *    requester's name;
 * 7. a task of another day reads as today's, an end on another day than its
 *    start reads as a time of the start's day, or a task still running gets an
 *    end and a time;
 * 8. a time is not read as seconds, minutes, or hours and minutes;
 * 9. the provider: a Claude account's name is lost, an account no longer
 *    there is named, or an agent that never set its provider (Claude) reads
 *    as nothing;
 * 10. the tokens leave out the cache, or a task not counted shows 0;
 * 11. "show more" offers more tasks than are left;
 * 12. a task's text or an agent's name, written by an agent or a person,
 *     carries what hides, turns or breaks a line (a U+202E, a line break, a
 *     zero width space), and turns its row around on screen (the Audit's Low
 *     at this PR's gate).
 */

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 5, 14, 45, 0);

function task(over: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 't1', agentId: 'lead', projectPath: '/Users/me/projects/tars', worktreePath: null,
    provider: 'claude', model: 'claude-opus-5-5', accountId: null,
    source: 'terminal', requesterAgentId: null, parentTaskId: null,
    text: 'fix the build on main',
    startedAt: new Date(2026, 9, 5, 14, 2).getTime(), endedAt: new Date(2026, 9, 5, 14, 31).getTime(),
    lastAt: new Date(2026, 9, 5, 14, 31).getTime(),
    outcome: 'completed', turns: 6, sessionIds: ['s1'],
    costUSD: 2.1, tokens: { input: 1_000_000, output: 100_000, cacheRead: 3_000_000, cacheWrite: 0 },
    byModel: { 'claude-opus-5-5': 2.1 },
    totalCostUSD: 2.1, totalPartial: false, durationMs: 29 * 60_000,
    ...over,
  };
}

describe('the window (1)', () => {
  const fourteenDays = new Date(2026, 8, 22);
  const lastDayHour = new Date(2026, 9, 4, 15, 0);

  it.each([['14 days', fourteenDays], ['24 hours', lastDayHour]])('reaches back to the start of %s, and a minute before it at most', (_, start) => {
    const since = sinceDaysFor(start, NOW.getTime());
    const from = NOW.getTime() - since * DAY;
    expect(from).toBeLessThanOrEqual(start.getTime());
    expect(start.getTime() - from).toBeLessThanOrEqual(60_000);
  });

  it('keeps the tasks started in the window, from its first moment, and none before', () => {
    const at = (ms: number, id: string) => task({ id, startedAt: ms });
    const kept = inWindow([at(fourteenDays.getTime(), 'first'), at(fourteenDays.getTime() - 1, 'before'), at(NOW.getTime(), 'now')], fourteenDays);
    expect(kept.map(t => t.id)).toEqual(['first', 'now']);
  });
});

describe('not counted (2) and the total (3)', () => {
  it('says not counted, never $0.00, and writes money as the page does', () => {
    expect(moneyText(null)).toBe('not counted');
    expect(moneyText(0)).toBe('$0.00');
    expect(moneyText(1234.5)).toBe('$1,234.50');
  });

  it('says partial when the total leaves a task out, and shows what was counted under one not counted', () => {
    expect(totalText(task({ costUSD: 2.1, totalCostUSD: 5.1, totalPartial: true }))).toEqual({ text: '$5.10', partial: true });
    expect(totalText(task({ costUSD: 2, totalCostUSD: 2, totalPartial: false }))).toEqual({ text: '$2.00', partial: false });
    expect(totalText(task({ costUSD: null, totalCostUSD: 3, totalPartial: true }))).toEqual({ text: '$3.00', partial: true });
    expect(totalText(task({ costUSD: null, totalCostUSD: 0, totalPartial: true }))).toEqual({ text: 'not counted', partial: false });
  });
});

describe('the averages (4)', () => {
  it('means the cost over the counted tasks and the time over the ended ones', () => {
    const rows = averagesBy([
      task({ id: 'a', costUSD: 1, durationMs: 10 * 60_000 }),
      task({ id: 'b', costUSD: null, durationMs: 20 * 60_000 }),
      task({ id: 'c', costUSD: 3, durationMs: null, endedAt: null, outcome: 'running' }),
    ], t => t.agentId);
    expect(rows).toEqual([{ key: 'lead', tasks: 3, counted: 2, costUSD: 2, durationMs: 15 * 60_000 }]);
  });

  it('says nothing of a cost no task counted, or of a time no task ended', () => {
    const rows = averagesBy([task({ costUSD: null, durationMs: null, endedAt: null, outcome: 'running' })], t => t.agentId);
    expect(rows).toEqual([{ key: 'lead', tasks: 1, counted: 0, costUSD: null, durationMs: null }]);
  });

  it('files a task under the model its replies spent most on, else the one it was launched on', () => {
    expect(dominantModel(task({ model: 'opus', byModel: { 'claude-sonnet-5': 0.4, 'claude-opus-5-5': 1.2 } }))).toBe('claude-opus-5-5');
    expect(dominantModel(task({ model: 'gpt-5.3-codex', byModel: {} }))).toBe('gpt-5.3-codex');
    expect(dominantModel(task({ model: null, byModel: {} }))).toBeNull();
  });

  it('orders by tasks, then by cost with the uncounted last, then by name', () => {
    const rows = averagesBy([
      task({ id: '1', agentId: 'codex', costUSD: null }),
      task({ id: '2', agentId: 'scout', costUSD: 0.04 }),
      task({ id: '3', agentId: 'worker', costUSD: 3 }),
      task({ id: '4', agentId: 'worker', costUSD: 0.6 }),
      task({ id: '5', agentId: 'lead', costUSD: 2.1 }),
      task({ id: '6', agentId: 'qa', costUSD: 2.1 }),
    ], t => t.agentId);
    expect(rows.map(r => r.key)).toEqual(['worker', 'lead', 'qa', 'scout', 'codex']);
  });
});

describe('the filters (5)', () => {
  const tasks = [
    task({ id: '1', agentId: 'lead', projectPath: '/p/tars' }),
    task({ id: '2', agentId: 'worker', projectPath: '/p/tars' }),
    task({ id: '3', agentId: 'writer', projectPath: '/p/site' }),
    task({ id: '4', agentId: 'ghost', projectPath: null }),
  ];

  it('keeps the tasks of the project and of the agent picked, and all with none picked', () => {
    expect(filterTasks(tasks, { projectPath: '/p/tars', agentId: null }).map(t => t.id)).toEqual(['1', '2']);
    expect(filterTasks(tasks, { projectPath: null, agentId: 'writer' }).map(t => t.id)).toEqual(['3']);
    expect(filterTasks(tasks, { projectPath: '/p/tars', agentId: 'writer' })).toEqual([]);
    expect(filterTasks(tasks, { projectPath: null, agentId: null })).toHaveLength(4);
  });

  it('offers every project and agent of the window, by name, with how many tasks each has', () => {
    expect(projectOptions(tasks)).toEqual([
      { value: '/p/site', label: 'site', hint: '1 task' },
      { value: '/p/tars', label: 'tars', hint: '2 tasks' },
    ]);
    expect(agentOptions(tasks, { lead: 'Lead', worker: 'Worker', writer: 'Writer' })).toEqual([
      { value: 'ghost', label: 'deleted agent', hint: '1 task' },
      { value: 'lead', label: 'Lead', hint: '1 task' },
      { value: 'worker', label: 'Worker', hint: '1 task' },
      { value: 'writer', label: 'Writer', hint: '1 task' },
    ]);
  });
});

describe('who handed it over (6)', () => {
  const names = { lead: 'Lead' };

  it.each([
    [{ source: 'terminal' as const }, 'typed'],
    [{ source: 'agent' as const, requesterAgentId: 'lead' }, 'from Lead'],
    [{ source: 'agent' as const, requesterAgentId: 'gone' }, 'from an agent'],
    [{ source: 'tars' as const }, 'from Tars'],
    [{ source: 'telegram' as const }, 'from Telegram'],
    [{ source: 'slack' as const }, 'from Slack'],
    [{ source: 'discord' as const }, 'from Discord'],
    [{ source: 'hermes' as const }, 'from Hermes'],
    [{ source: 'acp' as const }, 'over ACP'],
    [{ source: 'acp' as const, requesterAgentId: 'lead' }, 'over ACP, from Lead'],
  ])('%o reads "%s"', (over, text) => {
    expect(sourceText(task(over), names)).toBe(text);
  });
});

describe('the times (7, 8)', () => {
  it('writes a start of today as its time, of another day with its date, of another year as its date alone', () => {
    expect(startLabel(new Date(2026, 9, 5, 14, 2).getTime(), NOW)).toBe('14:02');
    expect(startLabel(new Date(2026, 9, 4, 23, 58).getTime(), NOW)).toBe('4 Oct 23:58');
    expect(startLabel(new Date(2025, 9, 4, 23, 58).getTime(), NOW)).toBe('4 Oct 2025');
  });

  it('writes an end on its start\'s day as a time, on another day with its date, and none while running', () => {
    expect(endLabel(task(), NOW)).toBe('14:31');
    expect(endLabel(task({ startedAt: new Date(2026, 9, 4, 23, 58).getTime(), endedAt: new Date(2026, 9, 5, 0, 41).getTime() }), NOW)).toBe('5 Oct 00:41');
    expect(endLabel(task({ endedAt: null, outcome: 'running', durationMs: null }), NOW)).toBe('running');
  });

  it('writes a time in seconds, minutes, or hours and minutes, and none while running', () => {
    expect(durationLabel(null)).toBe('-');
    expect(durationLabel(0)).toBe('0 s');
    expect(durationLabel(42_400)).toBe('42 s');
    expect(durationLabel(60_000)).toBe('1 min');
    expect(durationLabel(29 * 60_000 + 59_000)).toBe('29 min');
    expect(durationLabel(65 * 60_000)).toBe('1 h 05');
    expect(durationLabel(26 * 3_600_000 + 10 * 60_000)).toBe('26 h 10');
  });
});

describe('the provider (9) and the tokens (10)', () => {
  const labels = { default: 'Main', 'acct-1a2b3c': 'Second' };

  it('names the Claude account a task ran on, and the provider otherwise', () => {
    expect(providerText(task({ accountId: 'acct-1a2b3c' }), labels)).toBe('Claude · Second');
    expect(providerText(task({ accountId: 'default' }), labels)).toBe('Claude · Main');
    expect(providerText(task({ accountId: 'acct-gone00' }), labels)).toBe('Claude');
    expect(providerText(task({ provider: null }), {})).toBe('Claude');
    expect(providerText(task({ provider: 'codex', accountId: null }), labels)).toBe('Codex');
    expect(providerText(task({ provider: 'some-cli', accountId: null }), labels)).toBe('some-cli');
  });

  it('counts the tokens with the cache, and none for a task not counted', () => {
    expect(tokensTotal(task({ tokens: { input: 1, output: 2, cacheRead: 30, cacheWrite: 400 } }))).toBe(433);
    expect(tokensTotal(task({ tokens: null, costUSD: null }))).toBeNull();
  });
});

describe('show more (11)', () => {
  it('offers twenty more at most, and what is left after that', () => {
    expect(TASKS_PAGE).toBe(20);
    expect(moreLabel(20, 45)).toBe('show 20 more');
    expect(moreLabel(40, 45)).toBe('show 5 more');
    expect(moreLabel(45, 45)).toBeNull();
  });
});

describe('what an agent or a person wrote (12)', () => {
  it('flattens what hides, turns or breaks the line, in a task\'s text and in an agent\'s name', () => {
    expect(taskText(task({ text: 'fix\u202Ethe build\n  now\u200B' }))).toBe('fix the build now');
    expect(agentName('lead', { lead: 'Ev\u202Eil\u2028Lead' })).toBe('Ev il Lead');
    expect(sourceText(task({ source: 'agent', requesterAgentId: 'lead' }), { lead: 'Ev\u202Eil' })).toBe('from Ev il');
    expect(agentOptions([task()], { lead: 'Ev\u202Eil' }).map(o => o.label)).toEqual(['Ev il']);
  });
});

