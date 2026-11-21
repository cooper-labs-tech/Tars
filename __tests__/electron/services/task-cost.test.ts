import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTaskCosts, taskReport } from '../../../electron/services/task-cost';
import { computeTranscriptUsage, clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';
import { resetCatalogCache } from '../../../electron/services/model-catalog';
import { DATA_DIR } from '../../../electron/constants';
import type { TaskRecord } from '../../../electron/services/task-ledger';

/**
 * What a task cost, read from the transcripts of the sessions it ran in
 * (task-ledger.ts records which), priced as the Usage page prices them.
 *
 * How it can fail, written before the code:
 * 11. A reply is counted in no task, in two, or twice in one: one reply is written as several lines whose usage
 *     grows (the last one holds the whole output), and a resumed session replays earlier replies under the same ids.
 * 12. A reply of the session from before the task, or after the next task of the same session started, is counted
 *     in it; the replies of its subagents (<session>/subagents/agent-*.jsonl) are not counted.
 * 13. A task whose sessions left no transcript (a CLI that writes none) is shown as costing nothing instead of as
 *     not counted; a delegation over ACP loses the cost its run reported.
 * 14. A task's total leaves out the tasks handed on from it, or never ends on a parent link that loops.
 * 15. The transcript is looked for only under the project, when the CLI ran in a worktree.
 * 16. The figures disagree with the Usage page: the same replies, priced, do not add up to what it bills.
 * 17. The report keeps tasks outside the period, project or agent asked for, averages a running task's
 *     duration, or averages a task not counted (no transcript, or no session heard of yet) as if it cost nothing.
 * 18. (the Frontend's note on #311) The page cannot ask for its own window: whole 24-hour periods back from now made it
 *     ask a minute early, cut at its window's start itself, and work its averages out again over what it kept.
 *     An exact start, `since`, must keep the tasks started from it and no other, and the report's averages must then
 *     be those of the tasks listed.
 */

const T0 = Date.UTC(2026, 9, 4, 18, 0, 0);
const MODEL = 'claude-opus-5';
let home: string;

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'task-a', agentId: 'worker-1', projectPath: '/work/tars', worktreePath: null, provider: 'claude', model: null,
    accountId: null, source: 'tars', requesterAgentId: null, parentTaskId: null, text: 'build it',
    startedAt: T0, endedAt: T0 + 60_000, lastAt: T0 + 60_000, outcome: 'completed', turns: 1, sessionIds: ['sess-1'],
    ...over,
  };
}

/** One reply line; `input` and `output` in tokens. */
function reply(id: string, atMs: number, input: number, output: number, model = MODEL) {
  return {
    type: 'assistant', requestId: `req_${id}`, timestamp: new Date(atMs).toISOString(),
    message: { id, model, usage: { input_tokens: input, output_tokens: output } },
  };
}

function transcript(dir: string, name: string, lines: unknown[]): void {
  const full = path.join(home, '.claude', 'projects', dir);
  fs.mkdirSync(path.dirname(path.join(full, name)), { recursive: true });
  fs.writeFileSync(path.join(full, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** Opus at $1 a million tokens in, $2 out: the costs below read as token counts. */
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-task-cost-'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: { [MODEL]: { id: MODEL, name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  resetCatalogCache();
  clearTranscriptUsageCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what a task cost', () => {
  it('11. each reply once, at its whole usage, in the one task it belongs to', async () => {
    transcript('-work-tars', 'sess-1.jsonl', [
      reply('m1', T0 + 1_000, 1_000_000, 100_000),
      reply('m1', T0 + 1_500, 1_000_000, 500_000),
      reply('m2', T0 + 2_000, 2_000_000, 0),
    ]);
    transcript('-work-tars', 'sess-2.jsonl', [reply('m1', T0 + 1_500, 1_000_000, 500_000), reply('m3', T0 + 90_000, 0, 1_000_000)]);
    const tasks = [task({ id: 'a', sessionIds: ['sess-1'] }), task({ id: 'b', startedAt: T0 + 80_000, endedAt: T0 + 99_000, sessionIds: ['sess-2'] })];

    const costs = await readTaskCosts(tasks, { homeDir: home });

    expect(costs.get('a')).toMatchObject({ costUSD: 4, tokens: { input: 3_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 } });
    expect(costs.get('b')).toMatchObject({ costUSD: 2, tokens: { input: 0, output: 1_000_000 } });
  });

  it('12. the replies inside the task only, its subagents\' included', async () => {
    transcript('-work-tars', 'sess-1.jsonl', [
      reply('before', T0 - 5_000, 7_000_000, 0),
      reply('a1', T0 + 1_000, 1_000_000, 0),
      reply('b1', T0 + 70_000, 0, 1_000_000),
    ]);
    transcript('-work-tars', 'sess-1/subagents/agent-x.jsonl', [reply('sub1', T0 + 2_000, 3_000_000, 0)]);
    const tasks = [
      task({ id: 'a', endedAt: T0 + 60_000 }),
      task({ id: 'b', startedAt: T0 + 65_000, endedAt: T0 + 75_000 }),
    ];

    const costs = await readTaskCosts(tasks, { homeDir: home });

    expect(costs.get('a')?.costUSD).toBe(4);
    expect(costs.get('b')?.costUSD).toBe(2);
  });

  it('13. not counted, rather than nothing, without a transcript; an ACP run at what it reported', async () => {
    const tasks = [
      task({ id: 'codex', provider: 'codex', sessionIds: ['sess-none'] }),
      task({ id: 'acp', source: 'acp', sessionIds: [], acp: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedWriteTokens: 0, costUSD: 0.5 } }),
    ];

    const costs = await readTaskCosts(tasks, { homeDir: home });

    expect(costs.get('codex')).toMatchObject({ costUSD: null, tokens: null });
    expect(costs.get('acp')).toMatchObject({ costUSD: 0.5, tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } });
  });

  it('14. a total that holds the tasks handed on, and ends on a loop', async () => {
    transcript('-work-tars', 'sess-1.jsonl', [reply('p', T0 + 1_000, 1_000_000, 0)]);
    transcript('-work-tars', 'sess-2.jsonl', [reply('c', T0 + 2_000, 2_000_000, 0)]);
    transcript('-work-tars', 'sess-3.jsonl', [reply('g', T0 + 3_000, 4_000_000, 0)]);
    const tasks = [
      task({ id: 'parent', sessionIds: ['sess-1'] }),
      task({ id: 'child', agentId: 'worker-2', parentTaskId: 'parent', sessionIds: ['sess-2'] }),
      task({ id: 'grandchild', agentId: 'worker-3', parentTaskId: 'child', sessionIds: ['sess-3'] }),
      task({ id: 'not-counted', agentId: 'worker-4', parentTaskId: 'parent', sessionIds: ['sess-none'] }),
      task({ id: 'loop-1', agentId: 'worker-5', parentTaskId: 'loop-2', sessionIds: [] }),
      task({ id: 'loop-2', agentId: 'worker-6', parentTaskId: 'loop-1', sessionIds: [] }),
    ];

    const report = taskReport(tasks, await readTaskCosts(tasks, { homeDir: home }), {}, T0 + 3_600_000);
    const of = (id: string) => report.tasks.find((t) => t.id === id)!;

    expect(of('parent')).toMatchObject({ costUSD: 1, totalCostUSD: 7, totalPartial: true });
    expect(of('child')).toMatchObject({ costUSD: 2, totalCostUSD: 6, totalPartial: false });
    expect(of('loop-1').totalCostUSD).toBe(0);
  });

  it('15. found under the worktree the CLI ran in', async () => {
    transcript('-work-tars--worktrees-feature', 'sess-1.jsonl', [reply('w', T0 + 1_000, 1_000_000, 0)]);

    const costs = await readTaskCosts([task({ id: 'a', worktreePath: '/work/tars/.worktrees/feature' })], { homeDir: home });

    expect(costs.get('a')?.costUSD).toBe(1);
  });

  it('16. adds up to what the Usage page bills for the same replies', async () => {
    transcript('-work-tars', 'sess-1.jsonl', [
      reply('m1', T0 + 1_000, 1_234_567, 1_000),
      reply('m1', T0 + 1_100, 1_234_567, 76_543),
      { ...reply('m2', T0 + 2_000, 10, 20), message: { id: 'm2', model: MODEL, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3_000_000, cache_creation_input_tokens: 400_000 } } },
    ]);
    transcript('-work-tars', 'sess-1/subagents/agent-y.jsonl', [reply('s', T0 + 3_000, 5_000, 6_000)]);

    const costs = await readTaskCosts([task({ id: 'a' })], { homeDir: home });
    const page = await computeTranscriptUsage(home);

    expect(costs.get('a')!.costUSD).toBeCloseTo(page.modelUsage[MODEL].costUSD, 9);
  });
});

describe('the report', () => {
  it('17. the tasks asked for, newest first, and averages over what was counted and ended', async () => {
    transcript('-work-tars', 'sess-1.jsonl', [reply('a', T0 + 1_000, 1_000_000, 0)]);
    transcript('-work-tars', 'sess-2.jsonl', [reply('b', T0 + 100_000, 3_000_000, 0)]);
    const tasks = [
      task({ id: 'old', startedAt: T0 - 10 * 86_400_000, endedAt: T0 - 10 * 86_400_000 + 1_000, sessionIds: [] }),
      task({ id: 'a', sessionIds: ['sess-1'], endedAt: T0 + 60_000 }),
      task({ id: 'b', startedAt: T0 + 90_000, endedAt: T0 + 210_000, sessionIds: ['sess-2'] }),
      task({ id: 'running', startedAt: T0 + 300_000, endedAt: null, outcome: 'running', sessionIds: [] }),
      task({ id: 'codex', agentId: 'worker-2', provider: 'codex', model: 'gpt-5.5', sessionIds: ['sess-none'] }),
      task({ id: 'elsewhere', projectPath: '/work/other', sessionIds: [] }),
    ];
    const costs = await readTaskCosts(tasks, { homeDir: home });

    const report = taskReport(tasks, costs, { sinceDays: 7, projectPath: '/work/tars' }, T0 + 400_000);

    expect(report.tasks.map((t) => t.id)).toEqual(['running', 'b', 'a', 'codex']);
    expect(report.tasks.find((t) => t.id === 'running')).toMatchObject({ durationMs: null });
    expect(report.notCounted).toBe(2);
    expect(report.averages.byAgent['worker-1']).toEqual({ tasks: 3, counted: 2, costUSD: (1 + 3) / 2, durationMs: (60_000 + 120_000) / 2 });
    expect(report.averages.byAgent['worker-2']).toEqual({ tasks: 1, counted: 0, costUSD: null, durationMs: 60_000 });
    expect(report.averages.byModel[MODEL]).toMatchObject({ tasks: 2, counted: 2, costUSD: 2 });

    expect(taskReport(tasks, costs, { agentId: 'worker-2' }, T0 + 400_000).tasks.map((t) => t.id)).toEqual(['codex']);
  });
});


describe('an exact start', () => {
  it('18. keeps the tasks started from it, with averages over those alone, before any period', async () => {
    const tasks = [
      task({ id: 'before', startedAt: T0 - 60_000, endedAt: T0 - 30_000, sessionIds: [] }),
      task({ id: 'at', startedAt: T0, endedAt: T0 + 60_000, sessionIds: [] }),
      task({ id: 'after', startedAt: T0 + 120_000, endedAt: T0 + 240_000, sessionIds: [] }),
    ];
    const costs = await readTaskCosts(tasks, { homeDir: home });

    const report = taskReport(tasks, costs, { since: T0, sinceDays: 30 }, T0 + 300_000);

    expect(report.tasks.map((t) => t.id)).toEqual(['after', 'at']);
    expect(report.averages.byAgent['worker-1']).toMatchObject({ tasks: 2, durationMs: (60_000 + 120_000) / 2 });
  });
});
