import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeTranscriptUsage, clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';

let home: string;

function writeTranscript(name: string, lines: unknown[]) {
  const dir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map(l => JSON.stringify(l)).join('\n'));
}

function assistant(id: string, requestId: string, over: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: '2026-08-20T12:00:00.000Z',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 4000,
        cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 0 },
        ...over,
      },
    },
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-'));
  clearTranscriptUsageCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  clearTranscriptUsageCache();
});

describe('computeTranscriptUsage', () => {
  it('sums tokens per model from the transcripts', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);

    const { modelUsage } = (await computeTranscriptUsage(home));

    expect(modelUsage['claude-opus-5'].inputTokens).toBe(2000);
    expect(modelUsage['claude-opus-5'].outputTokens).toBe(1000);
    expect(modelUsage['claude-opus-5'].cacheReadInputTokens).toBe(4000);
  });

  it('counts a resumed message once, not once per transcript', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b-resumed.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_9', 'req_9')]);

    const { modelUsage } = (await computeTranscriptUsage(home));

    expect(modelUsage['claude-opus-5'].inputTokens).toBe(2000);
  });

  it('prices 1h cache writes above 5m ones', async () => {
    writeTranscript('hour.jsonl', [assistant('msg_1', 'req_1')]);
    const hourly = (await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].costUSD;

    clearTranscriptUsageCache();
    fs.rmSync(path.join(home, '.claude', 'projects', 'demo'), { recursive: true });
    writeTranscript('five.jsonl', [
      assistant('msg_1', 'req_1', {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 4000 },
      }),
    ]);
    const fiveMin = (await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].costUSD;

    expect(hourly).toBeGreaterThan(fiveMin);
    // Opus 5: 4000 tokens at $10/MTok vs $6.25/MTok
    expect(hourly - fiveMin).toBeCloseTo((4000 / 1e6) * (10 - 6.25), 6);
  });

  it('ignores synthetic messages and rolls tokens up per day', async () => {
    writeTranscript('a.jsonl', [
      assistant('msg_1', 'req_1'),
      { ...assistant('msg_2', 'req_2'), message: { id: 'msg_2', model: '<synthetic>', usage: { input_tokens: 99 } } },
    ]);

    const usage = (await computeTranscriptUsage(home));

    expect(Object.keys(usage.modelUsage)).toEqual(['claude-opus-5']);
    expect(usage.dailyModelTokens).toHaveLength(1);
    expect(usage.dailyModelTokens[0].date).toBe('2026-08-20');
    expect(usage.dailyModelTokens[0].tokensByModel).toEqual({ 'claude-opus-5': 1500 });
    expect(usage.lastComputedDate).toBe('2026-08-20');
  });

  it('prices each day from that day\'s own tokens, cache reads included', async () => {
    // Two days with identical input+output but wildly different cache reads.
    // The page used to rebuild a day from input+output times an all-time
    // blended rate, which made these two days cost exactly the same.
    const cheap = {
      ...assistant('msg_cheap', 'req_cheap', {
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
      timestamp: '2026-08-20T12:00:00.000Z',
    };
    const dear = {
      ...assistant('msg_dear', 'req_dear', {
        cache_read_input_tokens: 100_000_000,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
      timestamp: '2026-08-21T12:00:00.000Z',
    };
    writeTranscript('a.jsonl', [cheap, dear]);

    const days = (await computeTranscriptUsage(home)).dailyModelTokens;
    const byDate = Object.fromEntries(days.map(d => [d.date, d]));

    // Same tokensByModel on both days - that is exactly why the old estimate
    // could not tell them apart.
    expect(byDate['2026-08-20'].tokensByModel).toEqual(byDate['2026-08-21'].tokensByModel);

    // Opus 5: input $5, output $25, cache read $0.50 per MTok.
    expect(byDate['2026-08-20'].costUSD).toBeCloseTo(
      (1000 / 1e6) * 5 + (500 / 1e6) * 25, 6,
    );
    expect(byDate['2026-08-21'].costUSD).toBeCloseTo(
      (1000 / 1e6) * 5 + (500 / 1e6) * 25 + (100_000_000 / 1e6) * 0.5, 6,
    );

    // And the days still add up to the all-time total.
    const total = days.reduce((sum, d) => sum + d.costUSD, 0);
    expect(total).toBeCloseTo((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].costUSD, 6);
  });

  it('tops up a message written as several lines instead of keeping the first', async () => {
    // Claude Code writes one line per content block; the earlier lines carry a
    // partial output_tokens and the last line carries the real one.
    writeTranscript('a.jsonl', [
      assistant('msg_1', 'req_1', { output_tokens: 1 }),
      assistant('msg_1', 'req_1', { output_tokens: 1 }),
      assistant('msg_1', 'req_1', { output_tokens: 500 }),
    ]);

    const usage = (await computeTranscriptUsage(home));

    // 500, not 1 (first-wins) and not 502 (no dedupe at all).
    expect(usage.modelUsage['claude-opus-5'].outputTokens).toBe(500);
    expect(usage.modelUsage['claude-opus-5'].inputTokens).toBe(1000);
    expect(usage.modelUsage['claude-opus-5'].cacheReadInputTokens).toBe(2000);
    expect(usage.dailyModelTokens[0].tokensByModel['claude-opus-5']).toBe(1500);
  });
});

describe('the per-file cache', () => {
  /**
   * Every cache miss used to re-read and re-parse every transcript under
   * ~/.claude/projects, measured at 414ms against 116MB on the author's
   * machine, synchronously on the main process, once a minute for as long as a
   * Usage, Agents or Projects tab was open. A file is keyed on (mtimeMs, size)
   * now, so the recurring cost is a stat per file: 7ms on the same data, with
   * identical totals.
   *
   * These tests pin the two things that could go wrong: a changed file must be
   * re-read, and a stale file must not keep contributing after it is deleted.
   */

  /** Force the 60s result memo to expire without clearing the per-file map. */
  async function expireResultMemo() {
    const real = Date.now;
    const at = real();
    Date.now = () => at + 61_000;
    try {
      return (await computeTranscriptUsage(home));
    } finally {
      Date.now = real;
    }
  }

  it('re-reads a transcript that has grown', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].inputTokens).toBe(1000);

    // A live session appends. Size changes, so the cache key changes.
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);
    expect((await expireResultMemo()).modelUsage['claude-opus-5'].inputTokens).toBe(2000);
  });

  it('stops counting a transcript that has been deleted', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b.jsonl', [assistant('msg_2', 'req_2')]);
    expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].inputTokens).toBe(2000);

    fs.unlinkSync(path.join(home, '.claude', 'projects', 'demo', 'b.jsonl'));
    expect((await expireResultMemo()).modelUsage['claude-opus-5'].inputTokens).toBe(1000);
  });

  it('still deduplicates across files when the second read is cached', async () => {
    // A resumed session replays its earlier messages into a new transcript, so
    // the same message id lands in two files. Caching per file must not turn
    // that back into double counting on the second pass.
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_9', 'req_9')]);

    const first = (await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].inputTokens;
    const second = (await expireResultMemo()).modelUsage['claude-opus-5'].inputTokens;

    expect(first).toBe(2000);
    expect(second).toBe(2000);
  });

  it('gives the same answer warm as it does cold', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);
    writeTranscript('b.jsonl', [assistant('msg_3', 'req_3')]);

    const cold = (await computeTranscriptUsage(home));
    const warm = (await expireResultMemo());
    clearTranscriptUsageCache();
    const coldAgain = (await computeTranscriptUsage(home));

    expect(warm).toEqual(cold);
    expect(coldAgain).toEqual(cold);
  });

  /* ── Messages per day ─────────────────────────────────────────────────── */

  it('counts a reply once even though it is written as several lines', async () => {
    // One API response, three content blocks, same message id: the token
    // totals top up across them, but it is one message. Counting lines here
    // roughly doubles every day on the chart.
    writeTranscript('a.jsonl', [
      assistant('msg_1', 'req_1', { output_tokens: 100 }),
      assistant('msg_1', 'req_1', { output_tokens: 300 }),
      assistant('msg_1', 'req_1', { output_tokens: 500 }),
    ]);

    const { dailyModelTokens } = (await computeTranscriptUsage(home));

    expect(dailyModelTokens).toHaveLength(1);
    expect(dailyModelTokens[0].messagesByModel['claude-opus-5']).toBe(1);
  });

  it('counts distinct replies separately', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);

    const { dailyModelTokens } = (await computeTranscriptUsage(home));

    expect(dailyModelTokens[0].messagesByModel['claude-opus-5']).toBe(2);
  });

  it('keeps the count per model, so a day of two models splits', async () => {
    const other = { ...assistant('msg_9', 'req_9') };
    other.message = { ...other.message, model: 'claude-sonnet-5' };
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), other]);

    const { dailyModelTokens } = (await computeTranscriptUsage(home));

    expect(dailyModelTokens[0].messagesByModel).toEqual({
      'claude-opus-5': 1,
      'claude-sonnet-5': 1,
    });
  });

  it('does not count a replayed message twice across transcripts', async () => {
    // A resumed session replays its earlier messages into a new file under the
    // same ids, which is why the dedup is global rather than per file.
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b.jsonl', [assistant('msg_1', 'req_1')]);

    const { dailyModelTokens } = (await computeTranscriptUsage(home));

    expect(dailyModelTokens[0].messagesByModel['claude-opus-5']).toBe(1);
  });

  it('still reports the day cost alongside the count', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);

    const { dailyModelTokens } = (await computeTranscriptUsage(home));

    // costUSD was briefly dropped from the interface while the count was
    // added, and nothing failed: the literal is built inside a .map(), so
    // excess-property checking never sees it.
    expect(typeof dailyModelTokens[0].costUSD).toBe('number');
    expect(dailyModelTokens[0].costUSD).toBeGreaterThan(0);
  });
});

describe('cost per model per day', () => {
  /**
   * The Usage page windows every figure by day now, per model as well as in
   * total: BY PROVIDER splits a period's cost by model. `costUSD` is not split,
   * and pricing `breakdownByModel` again in the renderer cannot be right,
   * because it keeps cache writes as one number while a 1h write costs 2x base
   * and a 5m one 1.25x. Measured on the author's history: re-pricing every
   * write at the 5m rate came out $656.84 (6.5%) under. So main hands over
   * each day's cost per model, and these are the two sums it has to satisfy.
   *
   * Prices below are the compiled-in floor this suite runs on (no catalogue in
   * the throwaway HOME). Opus: $5 in, $25 out, $0.50 cache read, $6.25 per 5m
   * write, $10 per 1h write. Sonnet: $3, $15, $0.30, $3.75, $6.
   */
  const OPUS = 'claude-opus-5';
  const SONNET = 'claude-sonnet-5';

  function turn(
    id: string,
    model: string,
    timestamp: string | undefined,
    usage: Record<string, unknown>,
  ) {
    return {
      type: 'assistant',
      requestId: `req_${id}`,
      ...(timestamp ? { timestamp } : {}),
      message: { id, model, usage },
    };
  }

  const writes = (h1: number, m5: number) => ({
    cache_creation_input_tokens: h1 + m5,
    cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 },
  });

  const DAY_A = '2026-08-20T12:00:00.000Z';
  const DAY_B = '2026-08-21T12:00:00.000Z';

  function seed() {
    writeTranscript('a.jsonl', [
      // One reply in two lines: the first carries a partial output count, the
      // second the whole one, and the dedup tops the first up.
      turn('m1', OPUS, DAY_A, { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 2000, ...writes(3000, 1000) }),
      turn('m1', OPUS, DAY_A, { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 2000, ...writes(3000, 1000) }),
      turn('m2', SONNET, DAY_A, { input_tokens: 2000, output_tokens: 100, ...writes(8000, 0) }),
      turn('m3', OPUS, DAY_B, { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 1_000_000 }),
      // No timestamp: counted in the model's total, and on no day.
      turn('m5', OPUS, undefined, { input_tokens: 1_000_000, output_tokens: 0 }),
    ]);
    // A resumed session replays m3 into a new transcript under the same id.
    writeTranscript('b-resumed.jsonl', [
      turn('m3', OPUS, DAY_B, { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 1_000_000 }),
      turn('m4', SONNET, DAY_B, { input_tokens: 100, output_tokens: 10, ...writes(0, 2000) }),
    ]);
  }

  /** What each turn costs, priced by hand. */
  const M1 = 1000 * 5e-6 + 400 * 25e-6 + 2000 * 0.5e-6 + 1000 * 6.25e-6 + 3000 * 10e-6; // 0.05225
  const M2 = 2000 * 3e-6 + 100 * 15e-6 + 8000 * 6e-6; // 0.0555
  const M3 = 500 * 5e-6 + 50 * 25e-6 + 1_000_000 * 0.5e-6; // 0.50375
  const M4 = 100 * 3e-6 + 10 * 15e-6 + 2000 * 3.75e-6; // 0.00795
  const M5 = 1_000_000 * 5e-6; // 5, undated

  it('gives each day its cost per model, 1h and 5m writes priced apart', async () => {
    seed();
    const { dailyModelTokens } = await computeTranscriptUsage(home);
    const byDate = Object.fromEntries(dailyModelTokens.map(d => [d.date, d]));

    expect(Object.keys(byDate)).toEqual(['2026-08-20', '2026-08-21']);
    expect(Object.keys(byDate['2026-08-20'].costByModel).sort()).toEqual([OPUS, SONNET]);
    expect(byDate['2026-08-20'].costByModel[OPUS]).toBeCloseTo(M1, 12);
    expect(byDate['2026-08-20'].costByModel[SONNET]).toBeCloseTo(M2, 12);
    expect(byDate['2026-08-21'].costByModel[OPUS]).toBeCloseTo(M3, 12);
    expect(byDate['2026-08-21'].costByModel[SONNET]).toBeCloseTo(M4, 12);
  });

  it('adds up to the day\'s cost over its models', async () => {
    seed();
    const { dailyModelTokens } = await computeTranscriptUsage(home);

    expect(dailyModelTokens.length).toBeGreaterThan(0);
    for (const day of dailyModelTokens) {
      const sum = Object.values(day.costByModel).reduce((s, c) => s + c, 0);
      expect(sum, day.date).toBeCloseTo(day.costUSD, 12);
      // The same models as the tokens: a model that spent is a model that ran.
      expect(Object.keys(day.costByModel).sort(), day.date).toEqual(Object.keys(day.breakdownByModel).sort());
    }
  });

  it('adds up to each model\'s total over the days, less what carries no date', async () => {
    seed();
    const { modelUsage, dailyModelTokens } = await computeTranscriptUsage(home);
    const overDays = (model: string) =>
      dailyModelTokens.reduce((s, d) => s + (d.costByModel[model] ?? 0), 0);

    expect(modelUsage[OPUS].costUSD).toBeCloseTo(M1 + M3 + M5, 12);
    expect(modelUsage[SONNET].costUSD).toBeCloseTo(M2 + M4, 12);
    expect(overDays(SONNET)).toBeCloseTo(modelUsage[SONNET].costUSD, 12);
    // The undated turn is the whole of the difference, and nothing else is.
    expect(overDays(OPUS)).toBeCloseTo(modelUsage[OPUS].costUSD - M5, 12);
  });
});

describe('an expired memo, scanned again only when a transcript moved', () => {
  /**
   * Past the minute, the memo was rebuilt whether a transcript had moved or
   * not: the walk, a stat per file and the whole adding up, 0.2 to 0.5 s on
   * JeanBrasse's 1826 transcripts, once a minute for as long as a page polls, all
   * night. It is kept now while every transcript has the path, the size and the
   * time it had (and the prices are the ones it was priced with:
   * transcript-usage-pricing.test.ts).
   *
   * How it can fail, written before the code:
   * 1. an unchanged memo is rebuilt all the same;
   * 2. a change is missed: a transcript rewritten to the same size with a new
   *    time, one added in a folder of its own. A deleted one is "stops counting
   *    a transcript that has been deleted" above;
   * 3. a pass that could not read a transcript is kept, and the failure with
   *    it: a file made readable again keeps its time and size. "is not
   *    remembered as empty" in transcript-usage-chunking.test.ts holds that
   *    one, and caught the first version of this change.
   */
  let skew = 0;
  beforeEach(() => { skew = 0; });

  /** A minute later each time, the per-file map left as it is. */
  async function aMinuteLater() {
    const real = Date.now;
    skew += 61_000;
    const at = real();
    Date.now = () => at + skew;
    try {
      return await computeTranscriptUsage(home);
    } finally {
      Date.now = real;
    }
  }

  it('1. keeps the memo it had, the same object, while no transcript moved', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    const before = await computeTranscriptUsage(home);

    expect(await aMinuteLater()).toBe(before);
    expect(await aMinuteLater()).toBe(before);
  });

  it('2. reads again a transcript rewritten to the same size, with a new time', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].inputTokens).toBe(1000);

    const file = path.join(home, '.claude', 'projects', 'demo', 'a.jsonl');
    const size = fs.statSync(file).size;
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1', { input_tokens: 3000 })]);
    expect(fs.statSync(file).size).toBe(size);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);

    expect((await aMinuteLater()).modelUsage['claude-opus-5'].inputTokens).toBe(3000);
  });

  it('2. counts a transcript added in a folder of its own', async () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].inputTokens).toBe(1000);

    const other = path.join(home, '.claude', 'projects', 'another-project');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'b.jsonl'), JSON.stringify(assistant('msg_2', 'req_2')));

    expect((await aMinuteLater()).modelUsage['claude-opus-5'].inputTokens).toBe(2000);
  });
});
