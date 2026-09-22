import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The ledger is the only place a non-Claude CLI's usage can be counted: those
 * CLIs write no transcript, so if the turn is not recorded as it happens the
 * spend is simply invisible.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-ledger-'));

vi.mock('../../../electron/constants', () => ({ DATA_DIR: tmp }));
vi.mock('../../../electron/services/model-catalog', () => ({
  priceFor: (modelId: string) =>
    modelId === 'gpt-9' ? { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 } : null,
}));

let ledger: typeof import('../../../electron/services/usage-ledger');

beforeEach(async () => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  vi.resetModules();
  ledger = await import('../../../electron/services/usage-ledger');
});

describe('recordUsage', () => {
  it('keeps the cost the agent reported', () => {
    ledger.recordUsage({
      agentId: 'a1', provider: 'claude', model: 'claude-opus-5',
      inputTokens: 10, outputTokens: 20, costUSD: 0.42, transport: 'acp',
    });

    expect(ledger.readLedger()[0].costUSD).toBe(0.42);
  });

  it('prices the turn from the catalogue when the agent reported none', () => {
    ledger.recordUsage({
      agentId: 'a1', provider: 'codex', model: 'gpt-9',
      inputTokens: 1_000_000, outputTokens: 1_000_000, transport: 'acp',
    });

    // 1M in at $2 + 1M out at $8
    expect(ledger.readLedger()[0].costUSD).toBeCloseTo(10, 6);
  });

  it('leaves the cost unset for a model nobody can price', () => {
    ledger.recordUsage({
      agentId: 'a1', provider: 'mystery', model: 'unknown-1',
      inputTokens: 100, outputTokens: 100, transport: 'acp',
    });

    expect(ledger.readLedger()[0].costUSD).toBeUndefined();
  });
});

describe('providerTotals', () => {
  it('sums turns per provider, dearest first', () => {
    ledger.recordUsage({ agentId: 'a', provider: 'claude', model: 'claude-opus-5', inputTokens: 10, outputTokens: 5, costUSD: 1, transport: 'acp' });
    ledger.recordUsage({ agentId: 'b', provider: 'claude', model: 'claude-opus-5', inputTokens: 20, outputTokens: 5, costUSD: 2, transport: 'acp' });
    ledger.recordUsage({ agentId: 'c', provider: 'gemini', model: 'gemini-3-pro', inputTokens: 1, outputTokens: 1, costUSD: 0.5, transport: 'acp' });

    const totals = ledger.providerTotals();

    expect(totals.map(t => t.provider)).toEqual(['claude', 'gemini']);
    expect(totals[0]).toMatchObject({ turns: 2, inputTokens: 30, outputTokens: 10, costUSD: 3 });
    expect(totals[0].models).toEqual(['claude-opus-5']);
  });

  it('ignores entries older than the window', () => {
    const file = ledger.ledgerPath();
    fs.writeFileSync(file, `${JSON.stringify({
      ts: '2020-01-01T00:00:00.000Z', agentId: 'old', provider: 'claude',
      inputTokens: 999, outputTokens: 999, costUSD: 99, transport: 'acp',
    })}\n`);
    ledger.recordUsage({ agentId: 'new', provider: 'claude', inputTokens: 1, outputTokens: 1, costUSD: 1, transport: 'acp' });

    const totals = ledger.providerTotals(7);

    expect(totals[0].turns).toBe(1);
    expect(totals[0].costUSD).toBe(1);
  });
});

describe('dailyCost', () => {
  it('buckets spend by day', () => {
    ledger.recordUsage({ agentId: 'a', provider: 'claude', inputTokens: 1, outputTokens: 1, costUSD: 1.5, transport: 'acp' });
    ledger.recordUsage({ agentId: 'b', provider: 'codex', inputTokens: 1, outputTokens: 1, costUSD: 2.5, transport: 'acp' });

    // entry.ts is recorded as a local `new Date()`, and dailyCost() must key
    // by that same local calendar day. Not the UTC day, which disagrees with
    // it for roughly a third of the globe at any given moment.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(ledger.dailyCost()[today]).toBeCloseTo(4, 6);
  });

  it('keys a turn by its local calendar day, not its UTC calendar day', () => {
    // Fixed instant chosen so UTC and a positive-offset local day disagree:
    // 2026-08-23T22:30:00Z is still 2026-08-23 in UTC, but already
    // 2026-08-24 for any timezone at UTC+2 or later (e.g. UTC+4).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T22:30:00.000Z'));
    try {
      ledger.recordUsage({ agentId: 'a', provider: 'claude', inputTokens: 1, outputTokens: 1, costUSD: 3, transport: 'acp' });

      // Read on the same pinned clock: dailyCost keeps the last 30 days, and
      // read on the real one this turn left the window at 2026-09-22T22:30Z,
      // thirty days after the instant above, and the test went red for good.
      const recordedAt = new Date(ledger.readLedger()[0].ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      const localDay = `${recordedAt.getFullYear()}-${pad(recordedAt.getMonth() + 1)}-${pad(recordedAt.getDate())}`;
      const utcDay = recordedAt.toISOString().slice(0, 10);

      expect(ledger.dailyCost()[localDay]).toBeCloseTo(3, 6);
      if (localDay !== utcDay) {
        expect(ledger.dailyCost()[utcDay]).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('usageByProvider, per day', () => {
  /**
   * The Usage page cuts one window from every source it prints. The ledger's
   * totals cannot be windowed by day (`providerTotals(sinceDays)` counts 24-hour
   * periods back from now) and `dailyCost` stops at thirty days, so the ledger
   * hands over every turn per local day, provider and model, and the page sums
   * what falls in its window.
   *
   * Run in Tbilisi, UTC+4, where the local and UTC days disagree for four hours
   * a day. CI runs in UTC, where they never do, and a test that relied on the
   * machine's zone would pass there with the day keyed wrong.
   */
  const zone = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Asia/Tbilisi'; });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  const line = (ts: string, provider: string, over: Record<string, unknown> = {}) => JSON.stringify({
    ts, agentId: 'a', provider, inputTokens: 1, outputTokens: 1, transport: 'acp', ...over,
  });
  const write = (lines: string[]) => fs.writeFileSync(ledger.ledgerPath(), `${lines.join('\n')}\n`);

  it('is empty, and names no first day, when nothing was recorded', () => {
    expect(ledger.usageByProvider()).toEqual({ providers: [], dailyCost: {}, daily: [], oldest: null });
  });

  it('keys a turn by its local day: 02:30 in Tbilisi is that day, not the UTC day before', () => {
    // The witness that the zone above took. Without it this would run in the
    // machine's zone, and in UTC slicing the timestamp gives the same days.
    expect(new Date('2026-09-21T22:30:00.000Z').getDate()).toBe(22);
    write([
      line('2026-09-21T22:30:00.000Z', 'codex', { costUSD: 1 }), // 02:30 on the 22nd
      line('2026-09-22T19:30:00.000Z', 'codex', { costUSD: 10 }), // 23:30 on the 22nd
      line('2026-09-22T20:30:00.000Z', 'codex', { costUSD: 100 }), // 00:30 on the 23rd
    ]);

    const { daily, oldest } = ledger.usageByProvider();

    expect(daily.map(d => [d.date, d.turns, d.costUSD])).toEqual([
      ['2026-09-22', 2, 11],
      ['2026-09-23', 1, 100],
    ]);
    expect(oldest).toBe('2026-09-22');
  });

  it('adds up to providerTotals() over the whole file, whatever else the file holds', () => {
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    write([
      line(ago(400), 'codex', { model: 'gpt-9', inputTokens: 100, outputTokens: 10, cachedReadTokens: 7, cachedWriteTokens: 3, costUSD: 2 }),
      line(ago(45), 'gemini', { model: 'gemini-3-pro', inputTokens: 50, outputTokens: 5, costUSD: 0.5 }),
      line(ago(45), 'gemini', { model: 'gemini-3-pro', inputTokens: 50, outputTokens: 5, costUSD: 0.25 }),
      line(ago(2), 'codex', { model: 'gpt-9', costUSD: 1 }),
      line(ago(2), 'codex', { inputTokens: 4, outputTokens: 4 }), // no model, no cost
      line(ago(0), 'claude', { model: 'claude-opus-5', inputTokens: 9, outputTokens: 9, cachedReadTokens: 90, costUSD: 0.125 }),
      // Five lines that are not a turn, and must be missing from every sum alike.
      'not json',
      JSON.stringify({ agentId: 'x', provider: 'codex', inputTokens: 999, outputTokens: 999, costUSD: 999, transport: 'acp' }),
      JSON.stringify({ ts: 'yesterday', agentId: 'x', provider: 'codex', inputTokens: 999, outputTokens: 999, costUSD: 999, transport: 'acp' }),
      JSON.stringify({ ts: ago(1), agentId: 'x', inputTokens: 999, outputTokens: 999, costUSD: 999, transport: 'acp' }),
      'null',
    ]);

    const totals = ledger.providerTotals();
    const { daily } = ledger.usageByProvider();
    const summed = new Map<string, { inputTokens: number; outputTokens: number; costUSD: number; turns: number }>();
    for (const row of daily) {
      const s = summed.get(row.provider) ?? { inputTokens: 0, outputTokens: 0, costUSD: 0, turns: 0 };
      s.inputTokens += row.inputTokens;
      s.outputTokens += row.outputTokens;
      s.costUSD += row.costUSD;
      s.turns += row.turns;
      summed.set(row.provider, s);
    }

    expect(totals.map(t => t.provider).sort()).toEqual(['claude', 'codex', 'gemini']);
    expect([...summed.keys()].sort()).toEqual(['claude', 'codex', 'gemini']);
    for (const t of totals) {
      const s = summed.get(t.provider)!;
      expect(s.turns, t.provider).toBe(t.turns);
      expect(s.inputTokens, t.provider).toBe(t.inputTokens);
      expect(s.outputTokens, t.provider).toBe(t.outputTokens);
      expect(s.costUSD, t.provider).toBeCloseTo(t.costUSD, 12);
    }
    expect(daily.reduce((n, d) => n + d.turns, 0)).toBe(6);
    // Cache tokens, which the totals do not carry, against the file itself.
    expect(daily.reduce((n, d) => n + d.cachedReadTokens, 0)).toBe(97);
    expect(daily.reduce((n, d) => n + d.cachedWriteTokens, 0)).toBe(3);
    // A turn with no model is a row of its own, not folded into one with a model.
    expect(daily.filter(d => d.provider === 'codex' && d.model === null)).toHaveLength(1);
  });

  it('names the first day still in the file, which a trim moves forward', () => {
    const lines: string[] = [];
    for (let i = 0; i < 8_000; i++) lines.push(line('2025-12-01T12:00:00.000Z', 'codex', { costUSD: 0.001 }));
    for (let i = 0; i < 12_000; i++) lines.push(line('2026-01-15T12:00:00.000Z', 'codex', { costUSD: 0.001 }));
    write(lines);

    expect(ledger.usageByProvider().oldest).toBe('2025-12-01');

    // The 20 001st line: past 20 000 the file keeps its last 12 000.
    ledger.recordUsage({ agentId: 'a', provider: 'codex', inputTokens: 1, outputTokens: 1, costUSD: 1, transport: 'acp' });

    const { daily, oldest } = ledger.usageByProvider();
    expect(ledger.readLedger()).toHaveLength(12_000);
    expect(oldest).toBe('2026-01-15');
    expect(daily[0]).toMatchObject({ date: '2026-01-15', turns: 11_999 });
    expect(daily.some(d => d.date === '2025-12-01')).toBe(false);
  });
});
