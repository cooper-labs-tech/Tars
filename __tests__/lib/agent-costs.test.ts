import { describe, it, expect } from 'vitest';
import {
  agentViewFilter,
  projectName,
  totalsByAgent,
  usageViewOf,
  viewCounts,
} from '../../src/lib/agent-costs';
import type { TaskEntry } from '../../src/types/electron';

/**
 * What the Usage page says of each agent: the tasks of the timeframe and the
 * project picked, one row per agent (JeanBrasse, 13/10: "l'usage par agent et pas par
 * tâche aussi ? Je veux avoir le choix de regarder l'un ou l'autre"). Frame:
 * `Usage · cost per agent`, and its light copy. Written before the code. How it
 * can fail:
 * 1. counted twice: an agent's cost takes a task's total, with the work it
 *    handed on, rather than its own, so a delegation's cost sits in two rows
 *    and the rows add up to more than was spent;
 * 2. not counted: a task with no cost weighs as $0 in its agent's sum, an agent
 *    with nothing counted reads $0.00 rather than not counted, or a sum that
 *    leaves a task out, or holds one counted only in part, is not said partial;
 * 3. the tokens leave out the cache, or an agent with no tokens counted reads 0
 *    rather than none;
 * 4. the time adds a task still running as 0 or as NaN, an agent whose every
 *    task runs reads 0 s rather than none, or the running ones are not said;
 * 5. agents folded together: rows keyed by name, so two agents of one name, or
 *    two deleted agents, read as one;
 * 6. its project and provider are its first task's rather than its latest's,
 *    an account no longer there is named, one provider is listed twice, or two
 *    as one; a project's folder written with backslashes (Windows) reads as the
 *    whole path;
 * 7. the order: not the dearest first, the uncounted not last, or ties left to
 *    the order the tasks came in, so the rows move from one reading to the next;
 * 8. the switch's counts: the agents counted under the agent picked (one)
 *    rather than under the project alone, or the tasks counted without the
 *    pickers; the agent view keeps the agent picked, and shows one row;
 * 9. the view remembered: a stored value that is not one of the two views
 *    (another version's, a typo, nothing) opens on no view rather than by task.
 */

const DAY = 86_400_000;
const T0 = new Date(2026, 9, 5, 14, 0).getTime();

function task(over: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 't1', agentId: 'lead', projectPath: '/Users/me/projects/tars', worktreePath: null,
    provider: 'claude', model: 'claude-opus-5-5', accountId: null,
    source: 'terminal', requesterAgentId: null, parentTaskId: null,
    text: 'fix the build on main',
    startedAt: T0, endedAt: T0 + 29 * 60_000, lastAt: T0 + 29 * 60_000,
    outcome: 'completed', turns: 6, sessionIds: ['s1'],
    costUSD: 2.1, tokens: { input: 1_000_000, output: 100_000, cacheRead: 3_000_000, cacheWrite: 0 },
    byModel: { 'claude-opus-5-5': 2.1 },
    totalCostUSD: 2.1, totalPartial: false, durationMs: 29 * 60_000,
    ...over,
  };
}

const LABELS = { default: 'Main', 'acct-2': 'Second' };
const byId = (rows: ReturnType<typeof totalsByAgent>) => Object.fromEntries(rows.map(r => [r.agentId, r]));

describe('counted once (1)', () => {
  it('adds up each agent\'s own costs, never the totals with the work handed on', () => {
    const lead = task({ id: 'lead-1', agentId: 'lead', costUSD: 2.1, totalCostUSD: 5.1 });
    const worker = task({ id: 'worker-1', agentId: 'worker', parentTaskId: 'lead-1', source: 'agent', requesterAgentId: 'lead', costUSD: 3, totalCostUSD: 3 });
    const rows = byId(totalsByAgent([lead, worker], LABELS));
    expect(rows.lead.costUSD).toBeCloseTo(2.1, 10);
    expect(rows.worker.costUSD).toBeCloseTo(3, 10);
    expect((rows.lead.costUSD ?? 0) + (rows.worker.costUSD ?? 0)).toBeCloseTo(5.1, 10);
  });
});

describe('not counted (2)', () => {
  it('says not counted for an agent none of whose tasks is, never $0', () => {
    const rows = totalsByAgent([task({ agentId: 'codex', provider: 'codex', costUSD: null, tokens: null, byModel: {}, totalCostUSD: 0 })], LABELS);
    expect(rows[0]).toMatchObject({ agentId: 'codex', tasks: 1, counted: 0, costUSD: null, tokens: null, partial: false });
  });

  it('leaves a task not counted out of the sum and says partial, as for one counted only in part', () => {
    const rows = byId(totalsByAgent([
      task({ id: 'a', agentId: 'lead', costUSD: 2 }),
      task({ id: 'b', agentId: 'lead', costUSD: null, tokens: null, byModel: {}, totalCostUSD: 0 }),
      task({ id: 'c', agentId: 'qa', costUSD: 1, partial: true }),
      task({ id: 'd', agentId: 'qa', costUSD: 0.5 }),
      task({ id: 'e', agentId: 'whole', costUSD: 1 }),
    ], LABELS));
    expect(rows.lead).toMatchObject({ tasks: 2, counted: 1, costUSD: 2, partial: true });
    expect(rows.qa).toMatchObject({ tasks: 2, counted: 2, costUSD: 1.5, partial: true });
    expect(rows.whole).toMatchObject({ tasks: 1, counted: 1, costUSD: 1, partial: false });
  });
});

describe('the tokens (3)', () => {
  it('adds every token with the cache\'s, and none when no task counted any', () => {
    const rows = byId(totalsByAgent([
      task({ id: 'a', agentId: 'lead', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
      task({ id: 'b', agentId: 'lead', tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } }),
      task({ id: 'c', agentId: 'lead', costUSD: null, tokens: null, byModel: {} }),
      task({ id: 'd', agentId: 'codex', costUSD: null, tokens: null, byModel: {} }),
    ], LABELS));
    expect(rows.lead.tokens).toBe(110);
    expect(rows.codex.tokens).toBeNull();
  });
});

describe('the time and the tasks running (4)', () => {
  it('adds the time of the tasks that ended, says the running ones apart, and gives no time when none ended', () => {
    const running = { endedAt: null, outcome: 'running' as const, durationMs: null };
    const rows = byId(totalsByAgent([
      task({ id: 'a', agentId: 'lead', durationMs: 29 * 60_000 }),
      task({ id: 'b', agentId: 'lead', durationMs: 44 * 60_000 }),
      task({ id: 'c', agentId: 'lead', ...running }),
      task({ id: 'd', agentId: 'writer', ...running }),
    ], LABELS));
    expect(rows.lead).toMatchObject({ tasks: 3, running: 1, durationMs: 73 * 60_000 });
    expect(rows.writer).toMatchObject({ tasks: 1, running: 1, durationMs: null });
    expect(Number.isNaN(rows.lead.durationMs)).toBe(false);
  });
});

describe('one row per agent (5)', () => {
  it('keeps agents apart by their id, whatever their names, deleted ones included', () => {
    const rows = totalsByAgent([
      task({ id: 'a', agentId: 'ghost-1', costUSD: 1 }),
      task({ id: 'b', agentId: 'ghost-2', costUSD: 2 }),
      task({ id: 'c', agentId: 'ghost-1', costUSD: 1 }),
    ], LABELS);
    expect(rows.map(r => [r.agentId, r.tasks, r.costUSD])).toEqual([['ghost-1', 2, 2], ['ghost-2', 1, 2]]);
  });
});

describe('its project and provider (6)', () => {
  it('names the project and the provider of its latest task, the others after, each once', () => {
    const rows = totalsByAgent([
      task({ id: 'old', agentId: 'lead', startedAt: T0 - 3 * DAY, projectPath: '/Users/me/projects/site', accountId: 'acct-2' }),
      task({ id: 'new', agentId: 'lead', startedAt: T0, projectPath: '/Users/me/projects/tars', accountId: 'default' }),
      task({ id: 'mid', agentId: 'lead', startedAt: T0 - DAY, projectPath: '/Users/me/projects/tars', accountId: 'acct-2' }),
      task({ id: 'gone', agentId: 'lead', startedAt: T0 - 4 * DAY, accountId: 'acct-removed' }),
      task({ id: 'gem', agentId: 'lead', startedAt: T0 - 5 * DAY, provider: 'gemini', accountId: null }),
    ], LABELS);
    expect(rows[0].projectPath).toBe('/Users/me/projects/tars');
    expect(rows[0].providers).toEqual(['Claude · Main', 'Claude · Second', 'Claude', 'Gemini']);
  });

  it('keeps the latest project a task named when the latest names none', () => {
    const rows = byId(totalsByAgent([
      task({ id: 'a', agentId: 'lead', startedAt: T0, projectPath: null }),
      task({ id: 'b', agentId: 'lead', startedAt: T0 - DAY, projectPath: '/Users/me/projects/tars' }),
      task({ id: 'c', agentId: 'writer', startedAt: T0, projectPath: '' }),
      task({ id: 'd', agentId: 'writer', startedAt: T0 - DAY, projectPath: '/Users/me/projects/site' }),
    ], LABELS));
    expect(rows.lead.projectPath).toBe('/Users/me/projects/tars');
    expect(rows.writer.projectPath).toBe('/Users/me/projects/site');
  });

  it('writes a project by its folder\'s name, from a POSIX or a Windows path, and none without one', () => {
    expect(projectName('/Users/me/projects/tars')).toBe('tars');
    expect(projectName('/Users/me/projects/tars/')).toBe('tars');
    expect(projectName('C:\\Users\\me\\projects\\tars')).toBe('tars');
    expect(projectName(null)).toBe('-');
    expect(projectName('/Users/me/projects/a\u202Eb\nc')).toBe('a b c');
  });
});

describe('the order (7)', () => {
  it('puts the dearest first, the uncounted last, and settles ties by tasks then by id', () => {
    const order = totalsByAgent([
      task({ id: '1', agentId: 'cheap', costUSD: 0.04 }),
      task({ id: '2', agentId: 'codex-b', costUSD: null, tokens: null, byModel: {} }),
      task({ id: '3', agentId: 'dear', costUSD: 3.61 }),
      task({ id: '4', agentId: 'codex-a', costUSD: null, tokens: null, byModel: {} }),
      task({ id: '5', agentId: 'tie-one', costUSD: 1 }),
      task({ id: '6', agentId: 'tie-two', costUSD: 0.5 }),
      task({ id: '7', agentId: 'tie-two', costUSD: 0.5 }),
      task({ id: '8', agentId: 'free', costUSD: 0 }),
    ], LABELS).map(r => r.agentId);
    expect(order).toEqual(['dear', 'tie-two', 'tie-one', 'cheap', 'free', 'codex-a', 'codex-b']);
  });

  it('gives the same rows whatever order the tasks came in', () => {
    const tasks = [
      task({ id: '1', agentId: 'b', costUSD: 1 }), task({ id: '2', agentId: 'a', costUSD: 1 }),
      task({ id: '3', agentId: 'c', costUSD: null, tokens: null }), task({ id: '4', agentId: 'd', costUSD: null, tokens: null }),
    ];
    expect(totalsByAgent([...tasks].reverse(), LABELS)).toEqual(totalsByAgent(tasks, LABELS));
  });

  it('has no row without a task', () => {
    expect(totalsByAgent([], LABELS)).toEqual([]);
  });
});

describe('the switch\'s counts (8)', () => {
  const tasks = [
    task({ id: '1', agentId: 'lead', projectPath: '/p/tars' }),
    task({ id: '2', agentId: 'lead', projectPath: '/p/tars' }),
    task({ id: '3', agentId: 'worker', projectPath: '/p/tars' }),
    task({ id: '4', agentId: 'writer', projectPath: '/p/site' }),
  ];

  it('counts the tasks under both pickers, and the agents under the project alone', () => {
    expect(viewCounts(tasks, { projectPath: null, agentId: null })).toEqual({ tasks: 4, agents: 3 });
    expect(viewCounts(tasks, { projectPath: '/p/tars', agentId: null })).toEqual({ tasks: 3, agents: 2 });
    expect(viewCounts(tasks, { projectPath: '/p/tars', agentId: 'lead' })).toEqual({ tasks: 2, agents: 2 });
    expect(viewCounts(tasks, { projectPath: null, agentId: 'writer' })).toEqual({ tasks: 1, agents: 3 });
  });

  it('keeps the project picked in the agent view and leaves the agent picked aside', () => {
    expect(agentViewFilter({ projectPath: '/p/tars', agentId: 'lead' })).toEqual({ projectPath: '/p/tars', agentId: null });
    expect(agentViewFilter({ projectPath: null, agentId: 'lead' })).toEqual({ projectPath: null, agentId: null });
  });
});

describe('the view remembered (9)', () => {
  it('opens on the agent view only when that is what was stored, by task otherwise', () => {
    expect(usageViewOf('agent')).toBe('agent');
    expect(usageViewOf('task')).toBe('task');
    for (const stored of [null, undefined, '', 'agents', 'AGENT', ' agent', 'by-agent', '{"view":"agent"}']) {
      expect(usageViewOf(stored)).toBe('task');
    }
  });
});
