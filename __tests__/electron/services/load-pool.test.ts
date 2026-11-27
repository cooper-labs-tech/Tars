import { describe, it, expect } from 'vitest';
import {
  parseTasksJsonl, parseWindowJson, planArrivals, DEFAULT_WINDOW, expectedArrivals, type LoadTask,
} from '../../../electron/services/load-pool';

/**
 * A load pool (trace feature C3, 27/11): `~/.tars/load-pools/<pool>/tasks.jsonl` and `window.json`, written by agents,
 * read by Tars only. Every line is validated; a refused line is listed as `tasks.jsonl:<line>` with its reason, never
 * dropped silently. The window's arrivals are planned from its seed: the same seed and pool give the same schedule.
 *
 * How it fails, written before the code:
 *  1. A line that is not a JSON object (a typo, an array, a number) is dropped silently, or stops the whole file.
 *  2. A field breaks its rule and the line is taken: task_id missing, empty or seen on an earlier line; project not an
 *     absolute path; repo not `owner/name` nor null; base_commit not 40 hex; prompt empty; setup not strings;
 *     test_cmd not a string nor null; time_cap_min outside 10 to 120 or not whole; harnesses not a list of the
 *     endpoint harnesses (codex, pi, qwen-code, opencode) nor null (a Claude harness above all); weight negative or not
 *     a number; max_runs under 1 or not whole; split not train, heldout or eval; train_ok true for heldout or eval,
 *     or not a boolean; language, source, licence not a string nor null; expected_tools not strings.
 *  3. A refused line's number is not the file's (blank lines skipped yet counted), or its reason names nothing.
 *  4. Defaults are wrong: setup missing is none, expected_tools missing is none.
 *  5. A field the format does not know refuses the line (it is kept out, the line taken), or reaches the record.
 *  6. window.json: a value outside its rule is taken (a rate of 0 or negative, a distribution or a pick other than
 *     the one Tars runs, a seed not whole, a length outside 1 to 1440 minutes, max_concurrent outside 1 to 16,
 *     initial_sessions over max_concurrent); or one bad value throws the whole file away. Each is refused as
 *     `window.json:<key>` and its default kept. A missing or unreadable file is the defaults.
 *  7. The plan: not the same for the same seed; the initial sessions not at the start; a gap not exponential (the
 *     mean of many gaps far from 1/rate, or the right mean but another spread); a task picked past its max_runs, or one of weight 0 picked; an arrival
 *     planned at or past the window's end; the pick not weighted (a task of weight 3 not about three times as often
 *     as one of weight 1); the plan going on once every run is used.
 *  8. A huge file or line is read whole into memory (the file is 4 MiB at most, a line 64 KiB).
 */

const BASE = 'a'.repeat(40);
const task = (over: Record<string, unknown> = {}) => JSON.stringify({
  task_id: 't-1', project: '/work/atlas', repo: 'example-org/atlas', base_commit: BASE, prompt: 'Fix the retry header.',
  language: 'typescript', setup: ['npm ci'], test_cmd: 'npm test', time_cap_min: 30, expected_tools: ['shell'],
  harnesses: ['codex'], weight: 1, max_runs: 1, split: 'train', train_ok: true, source: 'backlog', licence: null, ...over,
});

describe('tasks.jsonl', () => {
  it('1 and 3: a line that is no object is refused with its own line number; blank lines are counted', () => {
    const r = parseTasksJsonl(`${task()}\n\nnot json\n[1,2]\n42\n${task({ task_id: 't-2' })}\n`);
    expect(r.tasks.map(t => t.task_id)).toEqual(['t-1', 't-2']);
    expect(r.tasks.map(t => t.line)).toEqual([1, 6]);
    expect(r.refused.map(x => `${x.file}:${x.line}`)).toEqual(['tasks.jsonl:3', 'tasks.jsonl:4', 'tasks.jsonl:5']);
    for (const x of r.refused) expect(x.reason.length).toBeGreaterThan(5);
  });

  it('2: every field rule refuses its line, naming the field', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ task_id: '' }, 'task_id'], [{ task_id: undefined }, 'task_id'], [{ project: 'relative/path' }, 'project'],
      [{ repo: 'not a repo' }, 'repo'], [{ repo: 'a/b/c' }, 'repo'], [{ base_commit: 'abc' }, 'base_commit'],
      [{ base_commit: 'g'.repeat(40) }, 'base_commit'], [{ prompt: '' }, 'prompt'], [{ prompt: 3 }, 'prompt'],
      [{ setup: 'npm ci' }, 'setup'], [{ setup: [1] }, 'setup'], [{ test_cmd: 5 }, 'test_cmd'],
      [{ time_cap_min: 9 }, 'time_cap_min'], [{ time_cap_min: 121 }, 'time_cap_min'], [{ time_cap_min: 30.5 }, 'time_cap_min'],
      [{ harnesses: ['claude'] }, 'harnesses'], [{ harnesses: 'codex' }, 'harnesses'], [{ harnesses: [] }, 'harnesses'],
      [{ weight: -1 }, 'weight'], [{ weight: '1' }, 'weight'], [{ max_runs: 0 }, 'max_runs'], [{ max_runs: 1.5 }, 'max_runs'],
      [{ split: 'test' }, 'split'], [{ split: 'heldout', train_ok: true }, 'train_ok'], [{ split: 'eval', train_ok: true }, 'train_ok'],
      [{ train_ok: 'yes' }, 'train_ok'], [{ language: 7 }, 'language'], [{ source: [] }, 'source'], [{ licence: 1 }, 'licence'],
      [{ expected_tools: 'shell' }, 'expected_tools'],
    ];
    for (const [over, field] of bad) {
      const r = parseTasksJsonl(task(over));
      expect(r.tasks, JSON.stringify(over)).toEqual([]);
      expect(r.refused[0]?.reason, JSON.stringify(over)).toContain(field);
    }
    // A task_id seen on an earlier line: the later one is refused, naming the earlier.
    const dup = parseTasksJsonl(`${task()}\n${task()}\n`);
    expect(dup.tasks).toHaveLength(1);
    expect(dup.refused).toEqual([expect.objectContaining({ line: 2, reason: expect.stringContaining('line 1') })]);
  });

  it('4 and 5: defaults, and fields the format does not know left out', () => {
    const r = parseTasksJsonl(JSON.stringify({ ...JSON.parse(task()), setup: undefined, expected_tools: undefined, extra_field: 'x' }));
    const t = r.tasks[0] as LoadTask & Record<string, unknown>;
    expect(t.setup).toEqual([]);
    expect(t.expected_tools).toEqual([]);
    expect('extra_field' in t).toBe(false);
    expect(r.refused).toEqual([]);
    // Every endpoint harness, and null (any), are taken; heldout and eval with train_ok false too.
    expect(parseTasksJsonl(task({ harnesses: ['codex', 'pi', 'qwen-code', 'opencode'] })).tasks).toHaveLength(1);
    expect(parseTasksJsonl(task({ harnesses: null, repo: null })).tasks).toHaveLength(1);
    expect(parseTasksJsonl(task({ split: 'heldout', train_ok: false })).tasks).toHaveLength(1);
  });

  it('8: a file over 4 MiB is refused whole; a line over 64 KiB is refused alone', () => {
    const long = task({ prompt: 'x'.repeat(70 * 1024) });
    const r = parseTasksJsonl(`${long}\n${task({ task_id: 't-2' })}\n`);
    expect(r.tasks.map(t => t.task_id)).toEqual(['t-2']);
    expect(r.refused[0]).toMatchObject({ line: 1, reason: expect.stringContaining('64 KiB') });
    const huge = parseTasksJsonl(`${task()}\n`.repeat(1) + ' '.repeat(4 * 1024 * 1024));
    expect(huge.tasks).toEqual([]);
    expect(huge.refused[0]).toMatchObject({ file: 'tasks.jsonl', line: 0, reason: expect.stringContaining('4 MiB') });
  });
});

describe('window.json', () => {
  it('6: each value outside its rule is refused alone, its default kept; no file is the defaults', () => {
    expect(parseWindowJson(undefined)).toEqual({ window: DEFAULT_WINDOW, refused: [] });
    expect(parseWindowJson('not json').window).toEqual(DEFAULT_WINDOW);
    expect(parseWindowJson('not json').refused[0]).toMatchObject({ file: 'window.json', reason: expect.any(String) });
    const r = parseWindowJson(JSON.stringify({ rate_per_hour: 0, distribution: 'uniform', seed: 1.5, window_min: 2000, max_concurrent: 17, initial_sessions: 2, pick: 'random' }));
    expect(r.window).toEqual({ ...DEFAULT_WINDOW, initial_sessions: 2 });
    expect(r.refused.map(x => x.key).sort()).toEqual(['distribution', 'max_concurrent', 'pick', 'rate_per_hour', 'seed', 'window_min']);
    expect(parseWindowJson(JSON.stringify({ max_concurrent: 2, initial_sessions: 3 })).refused.map(x => x.key)).toEqual(['initial_sessions']);
    expect(parseWindowJson(JSON.stringify({ rate_per_hour: 12, seed: 4711, window_min: 90, max_concurrent: 4, initial_sessions: 2 })).window)
      .toEqual({ ...DEFAULT_WINDOW, rate_per_hour: 12, seed: 4711, window_min: 90, max_concurrent: 4, initial_sessions: 2 });
  });
});

describe('the plan of arrivals', () => {
  const tasks = (specs: Array<[string, number, number]>): LoadTask[] => specs.map(([id, weight, maxRuns], i) =>
    ({ ...JSON.parse(task({ task_id: id, weight, max_runs: maxRuns })), setup: ['npm ci'], expected_tools: ['shell'], line: i + 1 }) as LoadTask);

  it('7: the same seed, the same plan; another seed, another; initial sessions at the start; inside the window', () => {
    const pool = tasks([['a', 1, 50], ['b', 1, 50]]);
    const w = { ...DEFAULT_WINDOW, rate_per_hour: 12, window_min: 90, initial_sessions: 2, seed: 4711 };
    const one = planArrivals(w, pool);
    expect(planArrivals(w, pool)).toEqual(one);
    expect(planArrivals({ ...w, seed: 4712 }, pool)).not.toEqual(one);
    expect(one.slice(0, 2).map(a => a.offsetMs)).toEqual([0, 0]);
    expect(one.every(a => a.offsetMs < 90 * 60_000)).toBe(true);
    expect(one.map(a => a.n)).toEqual(one.map((_, i) => i + 1));
    expect(expectedArrivals(w)).toBe(2 + 18);
  });

  it('7: the gaps are exponential at the rate asked', () => {
    const pool = tasks([['a', 1, 100000]]);
    const plan = planArrivals({ ...DEFAULT_WINDOW, rate_per_hour: 60, window_min: 24 * 60 - 1, seed: 3 }, pool);
    const gaps = plan.slice(1).map((a, i) => a.offsetMs - plan[i].offsetMs);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    // 60 an hour: a minute on average; about 1440 arrivals, so the mean is within a few percent.
    expect(mean / 60_000).toBeGreaterThan(0.9);
    expect(mean / 60_000).toBeLessThan(1.1);
    expect(plan.length).toBeGreaterThan(1300);
    expect(plan.length).toBeLessThan(1600);
    // Spread as an exponential, not only its mean: e^-2, about 13.5 %, of the gaps over twice the mean (none for
    // gaps uniform on 0 to twice the mean, which have the same mean: found by the mutation bench).
    const long = gaps.filter(g => g > 2 * mean).length / gaps.length;
    expect(long).toBeGreaterThan(0.09);
    expect(long).toBeLessThan(0.19);
  });

  it('7: weighted, without replacement: max_runs never passed, weight 0 never picked, weight 3 about three times weight 1, the plan ends when all are used', () => {
    const counts = (p: ReturnType<typeof planArrivals>) => p.reduce<Record<string, number>>((c, a) => ({ ...c, [a.taskId]: (c[a.taskId] ?? 0) + 1 }), {});
    const capped = planArrivals({ ...DEFAULT_WINDOW, rate_per_hour: 600, window_min: 600, seed: 9 }, tasks([['a', 1, 2], ['b', 1, 3], ['z', 0, 5]]));
    expect(counts(capped)).toEqual({ a: 2, b: 3 });
    expect(capped).toHaveLength(5);
    // About 1200 arrivals, so the ratio sits near 3, far from either bound, whatever the seed.
    const weighted = counts(planArrivals({ ...DEFAULT_WINDOW, rate_per_hour: 120, window_min: 600, seed: 11 }, tasks([['heavy', 3, 10000], ['light', 1, 10000]])));
    const ratio = weighted.heavy / weighted.light;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(4.5);
  });
});
