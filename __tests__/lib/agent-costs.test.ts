import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import {
  agentViewFilter,
  nextAgentSort,
  projectName,
  sortAgentRows,
  totalsByAgent,
  usageViewOf,
  viewCounts,
} from '../../src/lib/agent-costs';
import type { AgentSortKey, AgentTotal } from '../../src/lib/agent-costs';
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
 *
 * Sorting by a column's header (JeanBrasse, 18/10, for 2.0.4: a click sorts
 * highest first, a second lowest first, a third gives the default order back),
 * written before its code. How it can fail:
 * 10. the clicks: a first click on a column of figures sorts lowest first or
 *     not at all, a first click on a column of words (Agent, Project,
 *     Provider) sorts Z to A rather than A to Z (JeanBrasse, 18/10: words A
 *     to Z first, figures highest first), a second does not turn the order
 *     round, a third leaves a sort rather than the default order; a click on
 *     another header goes on with the first one's turn rather than starting
 *     at its own first order;
 * 11. a column's order: the tasks compared as text (9 before 10), a time, a
 *     count of tokens or a cost compared as it is written (`1 h 05` before
 *     `29 min`, `$10.00` before `$9.00`, `$1.5` before `$1.25`) rather than by
 *     its value; a project compared by its whole path rather than the
 *     folder's name the row shows, or by case (`Zeta` before `alpha`, `Tars`
 *     apart from `tars`); the figures in a name read as letters (`account 10`
 *     before `account 2`); a provider by one the row does not show first;
 * 12. a value the row does not have (no time, no tokens, nothing counted, no
 *     project) sorts first one way, as 0 or as -1, rather than last both ways;
 * 13. rows of equal value come in an order of their own, or reversed with the
 *     direction, rather than in the default order;
 * 14. the rows themselves: the sort reorders the array it is given, so the
 *     third click has no default order to give back, or a row is lost or
 *     listed twice;
 * 15. the agent's own name: not sortable, compared by the agent's id rather
 *     than the name its row shows, by case or with its figures read as
 *     letters, or a deleted agent sorted among the names as "deleted agent"
 *     rather than last both ways.
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

/** A row as totalsByAgent gives it, without tasks to add up. */
function row(agentId: string, over: Partial<AgentTotal> = {}): AgentTotal {
  return {
    agentId, tasks: 1, counted: 1, running: 0, costUSD: 1, partial: false,
    tokens: 1_000, durationMs: 60_000, projectPath: '/Users/me/projects/tars', providers: ['Claude'],
    ...over,
  };
}
const ids = (rows: AgentTotal[]) => rows.map(r => r.agentId);
const FIGURES: AgentSortKey[] = ['tasks', 'time', 'tokens', 'cost'];
const WORDS: AgentSortKey[] = ['agent', 'project', 'provider'];
const KEYS: AgentSortKey[] = [...WORDS, ...FIGURES];

describe('the clicks on a header (10)', () => {
  it('sorts a column of figures highest first, then lowest first, then gives the default order back', () => {
    for (const key of FIGURES) {
      const first = nextAgentSort(null, key);
      expect(first, key).toEqual({ key, direction: 'descending' });
      const second = nextAgentSort(first, key);
      expect(second, key).toEqual({ key, direction: 'ascending' });
      expect(nextAgentSort(second, key), key).toBeNull();
    }
  });

  it('sorts a column of words A to Z, then Z to A, then gives the default order back', () => {
    for (const key of WORDS) {
      const first = nextAgentSort(null, key);
      expect(first, key).toEqual({ key, direction: 'ascending' });
      const second = nextAgentSort(first, key);
      expect(second, key).toEqual({ key, direction: 'descending' });
      expect(nextAgentSort(second, key), key).toBeNull();
    }
  });

  it('starts another header at its own first order, wherever the first one was', () => {
    expect(nextAgentSort({ key: 'cost', direction: 'descending' }, 'tokens')).toEqual({ key: 'tokens', direction: 'descending' });
    expect(nextAgentSort({ key: 'cost', direction: 'ascending' }, 'tokens')).toEqual({ key: 'tokens', direction: 'descending' });
    expect(nextAgentSort({ key: 'cost', direction: 'descending' }, 'project')).toEqual({ key: 'project', direction: 'ascending' });
    expect(nextAgentSort({ key: 'project', direction: 'descending' }, 'agent')).toEqual({ key: 'agent', direction: 'ascending' });
  });
});

describe('a column\'s order (11)', () => {
  it('compares the tasks, the time, the tokens and the cost by their values, not as they are written', () => {
    const nine = row('nine', { tasks: 9, durationMs: 29 * 60_000, tokens: 9_000, costUSD: 9 });
    const ten = row('ten', { tasks: 10, durationMs: 65 * 60_000, tokens: 10_000, costUSD: 10 });
    for (const key of ['tasks', 'time', 'tokens', 'cost'] as const) {
      expect(ids(sortAgentRows([nine, ten], { key, direction: 'descending' })), key).toEqual(['ten', 'nine']);
      expect(ids(sortAgentRows([ten, nine], { key, direction: 'ascending' })), key).toEqual(['nine', 'ten']);
    }
  });

  it('compares a project by the folder\'s name the row shows, whatever its case or the path before it', () => {
    const rows = [
      row('a', { projectPath: '/a/zulu' }),
      row('b', { projectPath: '/z/alpha' }),
      row('c', { projectPath: 'C:\\Users\\me\\Mike' }),
    ];
    expect(ids(sortAgentRows(rows, { key: 'project', direction: 'descending' }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortAgentRows(rows, { key: 'project', direction: 'ascending' }))).toEqual(['b', 'c', 'a']);
  });

  it('compares costs with cents by their values, where text and numbers disagree (the gate of #454, U8)', () => {
    const rows = [row('quarter', { costUSD: 1.25 }), row('half', { costUSD: 1.5 })];
    expect(ids(sortAgentRows(rows, { key: 'cost', direction: 'descending' }))).toEqual(['half', 'quarter']);
    expect(ids(sortAgentRows(rows, { key: 'cost', direction: 'ascending' }))).toEqual(['quarter', 'half']);
  });

  it('reads the figures in a name as numbers, account 2 before account 10 (U5)', () => {
    const rows = [row('ten', { providers: ['Claude · account 10'] }), row('two', { providers: ['Claude · account 2'] })];
    expect(ids(sortAgentRows(rows, { key: 'provider', direction: 'ascending' }))).toEqual(['two', 'ten']);
    expect(ids(sortAgentRows(rows, { key: 'provider', direction: 'descending' }))).toEqual(['ten', 'two']);
  });

  it('takes two names that differ only by their case as equal, in the default order both ways (U4)', () => {
    const rows = [row('upper', { projectPath: '/p/Tars' }), row('lower', { projectPath: '/q/tars' })];
    expect(ids(sortAgentRows(rows, { key: 'project', direction: 'ascending' }))).toEqual(['upper', 'lower']);
    expect(ids(sortAgentRows(rows, { key: 'project', direction: 'descending' }))).toEqual(['upper', 'lower']);
  });

  it('compares a provider by the one the row shows first, its account included', () => {
    const rows = [
      row('main', { providers: ['Claude · Main', 'Codex'] }),
      row('codex', { providers: ['Codex'] }),
      row('second', { providers: ['Claude · Second'] }),
      row('plain', { providers: ['Claude', 'Gemini'] }),
    ];
    expect(ids(sortAgentRows(rows, { key: 'provider', direction: 'descending' }))).toEqual(['codex', 'second', 'main', 'plain']);
    expect(ids(sortAgentRows(rows, { key: 'provider', direction: 'ascending' }))).toEqual(['plain', 'main', 'second', 'codex']);
  });
});

describe('a value the row does not have (12)', () => {
  it('goes last highest first and last lowest first', () => {
    const rows = [
      row('none', { durationMs: null, tokens: null, costUSD: null, counted: 0, projectPath: null }),
      row('low', { durationMs: 1, tokens: 1, costUSD: 0, projectPath: '/p/alpha' }),
      row('high', { durationMs: 2, tokens: 2, costUSD: 2, projectPath: '/p/beta' }),
    ];
    for (const key of ['time', 'tokens', 'cost', 'project'] as const) {
      expect(ids(sortAgentRows(rows, { key, direction: 'descending' })), key).toEqual(['high', 'low', 'none']);
      expect(ids(sortAgentRows(rows, { key, direction: 'ascending' })), key).toEqual(['low', 'high', 'none']);
    }
  });
});

describe('rows of equal value (13)', () => {
  it('keep the default order, whichever way the column is sorted', () => {
    const rows = [
      row('first', { tasks: 2, projectPath: '/p/tars', providers: ['Codex'] }),
      row('lone', { tasks: 1, projectPath: '/p/site', providers: ['Claude'] }),
      row('second', { tasks: 2, projectPath: '/p/tars', providers: ['Codex'] }),
      row('third', { tasks: 2, projectPath: '/p/tars', providers: ['Codex'] }),
    ];
    expect(ids(sortAgentRows(rows, { key: 'tasks', direction: 'descending' }))).toEqual(['first', 'second', 'third', 'lone']);
    expect(ids(sortAgentRows(rows, { key: 'tasks', direction: 'ascending' }))).toEqual(['lone', 'first', 'second', 'third']);
    expect(ids(sortAgentRows(rows, { key: 'project', direction: 'descending' }))).toEqual(['first', 'second', 'third', 'lone']);
    expect(ids(sortAgentRows(rows, { key: 'project', direction: 'ascending' }))).toEqual(['lone', 'first', 'second', 'third']);
    expect(ids(sortAgentRows(rows, { key: 'provider', direction: 'ascending' }))).toEqual(['lone', 'first', 'second', 'third']);
  });
});

describe('the rows themselves (14)', () => {
  it('sorts a copy, keeps every row once, and gives the rows as they came without a sort', () => {
    const rows = [row('b', { costUSD: 1 }), row('a', { costUSD: 3 }), row('c', { costUSD: 2 })];
    const before = ids(rows);
    for (const key of KEYS) {
      for (const direction of ['descending', 'ascending'] as const) {
        const sorted = sortAgentRows(rows, { key, direction });
        expect(sorted).not.toBe(rows);
        expect([...ids(sorted)].sort()).toEqual(['a', 'b', 'c']);
      }
    }
    expect(ids(rows)).toEqual(before);
    expect(ids(sortAgentRows(rows, null))).toEqual(before);
  });
});

describe('the agent\'s own name (15)', () => {
  const names = { b: 'bo', a: 'Ada', ten: 'Agent 10', two: 'Agent 2' };
  const rows = [row('b'), row('gone'), row('ten'), row('a'), row('two')];

  it('sorts by the name the row shows, whatever its case, its figures as numbers', () => {
    expect(ids(sortAgentRows(rows, { key: 'agent', direction: 'ascending' }, names))).toEqual(['a', 'two', 'ten', 'b', 'gone']);
    expect(ids(sortAgentRows(rows, { key: 'agent', direction: 'descending' }, names))).toEqual(['b', 'ten', 'two', 'a', 'gone']);
  });

  it('puts an agent since deleted last both ways, as a row without the value', () => {
    for (const direction of ['ascending', 'descending'] as const) {
      expect(ids(sortAgentRows(rows, { key: 'agent', direction }, names)).at(-1), direction).toBe('gone');
    }
  });
});
