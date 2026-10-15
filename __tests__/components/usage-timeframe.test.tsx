import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mount, settle, elements, ofType, textOf, type Mount } from './hook-runtime';
import UsagePage from '../../src/app/usage/page';
import { forgetClaudeData } from '../../src/hooks/useClaude';
import { BudgetAndLimits, buildBudgetRows } from '../../src/components/Usage/BudgetAndLimits';
import { recordsStart } from '../../src/lib/usage-window';
import { PageHeader, PanelCaption, SegmentedControl } from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Usage page's timeframe drives every figure on it.
 *
 * Until 1.7.9 only the cost chart obeyed it: the tiles, the provider rows and
 * the budget summed everything ever recorded, the tokens and messages charts
 * took the last fourteen days that had any data, and the page added cost up
 * four different ways. Measured on JeanBrasse's history: $10,143.27 in TOTAL COST
 * on every timeframe, beside fourteen bars that added up to $3,717.75.
 *
 * The seed puts spend in six regions, a power of ten each, so a figure summed
 * over the wrong window prints the wrong power of ten:
 *
 *   R0  2026-09-22  today                                    $1
 *   R1  2026-09-20  a Sunday: this week, inside 14 days      $10
 *   R2  2026-09-10  inside 14 days, an earlier week           $100
 *   R3  08-01, 08-31, 09-01: inside 12 weeks only             $1,000
 *   R4  2026-01-15: inside 12 months only                     $10,000
 *   R5  2025-06-01: outside every window                      $100,000
 *
 * so the totals are 111, 1,111 and 11,111. Codex spends on 2026-01-15 only,
 * Gemini on both sides of 1 September (the budget's month), Z.ai shares a day
 * with Claude (a per-model price, not a day's price split), and a `claude`
 * ledger row of $5,000 today is an ACP turn the transcripts already hold: it
 * must change nothing.
 *
 * Every expectation is computed by `reference()` below from the seed alone,
 * with its own window arithmetic, never by the page's `usage-window.ts`: a
 * test that asked the code under test what to expect could not fail.
 *
 * The clock is pinned to 2026-09-22 at noon, and the zone to Tbilisi (UTC+4),
 * where a local day and a UTC day disagree for four hours: CI runs in UTC,
 * where a bucket keyed by `toISOString()` would pass.
 */

type Timeframe = 'daily' | 'weekly' | 'monthly';
const TIMEFRAMES: Timeframe[] = ['daily', 'weekly', 'monthly'];

interface TRow { date: string; model: string; cost: number; input: number; cacheRead: number; cacheWrite: number; output: number; messages: number }
interface LRow { date: string; provider: string; model: string | null; costUSD: number; inputTokens: number; cachedReadTokens: number; cachedWriteTokens: number; outputTokens: number; turns: number }
interface Seed {
  transcripts: TRow[];
  ledger: LRow[];
  /** token-stats.json `extraCost` per local day */
  extra: Record<string, number>;
  rateLimits: { five_hour?: { used_percentage: number; resets_at: number }; seven_day?: { used_percentage: number; resets_at: number } } | null;
  /** Legacy stats-cache.json days: tokensByModel only. */
  legacy?: Array<{ date: string; tokensByModel: Record<string, number> }>;
  lastComputedDate?: string;
}

/** Tokens in proportion to the price, with a cache mix `k` that differs per region. */
const tr = (date: string, model: string, cost: number, k: number): TRow => ({
  date, model, cost, input: 1000 * cost, cacheRead: 1000 * k * cost, cacheWrite: 500 * cost, output: 300 * cost, messages: cost,
});
const lg = (date: string, provider: string, model: string | null, cost: number, k: number): LRow => ({
  date, provider, model, costUSD: cost, inputTokens: 1000 * cost, cachedReadTokens: 1000 * k * cost,
  cachedWriteTokens: 500 * cost, outputTokens: 300 * cost, turns: 1,
});

const RATE_LIMITS = {
  five_hour: { used_percentage: 62.4, resets_at: 0 },
  seven_day: { used_percentage: 31, resets_at: 0 },
};

const SEED: Seed = {
  transcripts: [
    tr('2026-09-22', 'claude-opus-5', 1, 1),            // R0
    tr('2026-09-20', 'claude-opus-5', 10, 2),           // R1
    tr('2026-09-10', 'claude-opus-5', 60, 3),           // R2, with
    tr('2026-09-10', 'glm-4.6', 40, 3),                 //     Z.ai on the same day
    tr('2026-08-01', 'claude-sonnet-5', 500, 4),        // R3
    tr('2026-01-15', 'claude-haiku-4-5', 9000, 5),      // R4
    tr('2025-06-01', 'claude-opus-4-6', 90000, 6),      // R5
    // What Claude Code files a synthetic reply under: a message, and nothing else to name.
    { date: '2026-09-15', model: '<synthetic>', cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 1 },
  ],
  ledger: [
    lg('2025-06-01', 'gemini', 'gemini-2.5-pro', 10000, 6), // R5
    lg('2026-01-15', 'codex', 'gpt-5-codex', 1000, 5),      // R4: Codex's only day
    lg('2026-08-31', 'gemini', 'gemini-3-pro', 200, 4),     // R3, last month
    lg('2026-09-01', 'gemini', 'gemini-3-pro', 300, 4),     // R3, this month
    lg('2026-09-22', 'claude', 'claude-opus-5', 5000, 7),   // an ACP turn of the claude binary: already in the transcripts
  ],
  extra: { '2026-09-22': 0.5, '2026-08-01': 5, '2026-01-15': 50, '2025-06-01': 500 },
  rateLimits: RATE_LIMITS,
};

// ---------------------------------------------------------------------------
// The reference: the page's figures, from the seed and a calendar alone.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Day arithmetic on keys, in UTC so that it owes nothing to the zone under test. */
const addDays = (key: string, n: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayLabel = (key: string) => `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;

interface RefBucket { key: string; label: string; first: string; last: string }
/** 14 days to 22 Sep; 12 Sunday-to-Saturday weeks from 5 Jul; 12 months from Oct 2025. Written out, not derived. */
const WINDOWS: Record<Timeframe, RefBucket[]> = {
  daily: Array.from({ length: 14 }, (_, i) => {
    const key = addDays('2026-09-09', i);
    return { key, label: dayLabel(key), first: key, last: key };
  }),
  weekly: Array.from({ length: 12 }, (_, i) => {
    const key = addDays('2026-07-05', 7 * i);
    return { key, label: `week of ${dayLabel(key)}`, first: key, last: addDays(key, 6) };
  }),
  monthly: Array.from({ length: 12 }, (_, i) => {
    const y = 2025 + Math.floor((9 + i) / 12);
    const m = (9 + i) % 12;
    const key = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    return { key, label: `${MONTHS[m]} ${y}`, first: key, last };
  }),
};
const inWindow = (tf: Timeframe, date: string) => date >= WINDOWS[tf][0].first && date <= WINDOWS[tf].at(-1)!.last;
const bucketIndex = (tf: Timeframe, date: string) => WINDOWS[tf].findIndex(b => date >= b.first && date <= b.last);

const PROVIDER_OF: Record<string, string> = {
  'claude-opus-5': 'claude', 'claude-sonnet-5': 'claude', 'claude-haiku-4-5': 'claude', 'claude-opus-4-6': 'claude', 'glm-4.6': 'zhipu',
  '<synthetic>': 'claude',
};
const LABEL_OF: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', zhipu: 'Zai' };
const MODEL_NAME: Record<string, string> = {
  'claude-opus-5': 'Opus 5', 'claude-sonnet-5': 'Sonnet 5', 'claude-haiku-4-5': 'Claude Haiku 4.5', 'claude-opus-4-6': 'Claude Opus 4.6',
  'glm-4.6': 'glm-4.6', 'gpt-5-codex': 'gpt-5-codex', 'gemini-3-pro': 'gemini-3-pro', 'gemini-2.5-pro': 'gemini-2.5-pro',
  '<synthetic>': '<synthetic>',
};

interface Sum { cost: number; input: number; cacheRead: number; cacheWrite: number; output: number; messages: number }
const zero = (): Sum => ({ cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0 });
const tin = (s: Sum) => s.input + s.cacheRead + s.cacheWrite;

/** Rows the page counts: every transcript row, and every ledger row but Claude's. */
function counted(seed: Seed) {
  return [
    ...seed.transcripts.map(r => ({ ...r, provider: PROVIDER_OF[r.model] })),
    ...seed.ledger.filter(r => r.provider !== 'claude').map(r => ({
      date: r.date, model: r.model ?? '', provider: r.provider, cost: r.costUSD, input: r.inputTokens,
      cacheRead: r.cachedReadTokens, cacheWrite: r.cachedWriteTokens, output: r.outputTokens, messages: 0,
    })),
  ];
}

function reference(seed: Seed, tf: Timeframe) {
  const total = zero();
  const buckets = WINDOWS[tf].map(() => zero());
  const providers = new Map<string, Sum & { models: Set<string> }>();
  for (const r of counted(seed)) {
    if (!inWindow(tf, r.date)) continue;
    const b = buckets[bucketIndex(tf, r.date)];
    const p = providers.get(r.provider) ?? { ...zero(), models: new Set<string>() };
    for (const s of [total, b, p]) {
      s.cost += r.cost; s.input += r.input; s.cacheRead += r.cacheRead; s.cacheWrite += r.cacheWrite;
      s.output += r.output; s.messages += r.messages;
    }
    // A model is named only if it did something: tokens or cost.
    if (r.model && (r.cost > 0 || tin(r) + r.output > 0)) p.models.add(MODEL_NAME[r.model]);
    providers.set(r.provider, p);
  }
  let overQuota = 0;
  for (const [date, x] of Object.entries(seed.extra)) if (inWindow(tf, date)) overQuota += x;
  const rows = [...providers.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost || (tin(b) + b.output) - (tin(a) + a.output))
    .map(([provider, s]) => ({ provider, label: LABEL_OF[provider], models: [...s.models].sort(), in: tin(s), out: s.output, cost: s.cost }));
  return { total, buckets, rows, overQuota };
}

/** The page's number formats, restated: $10,227.39 and 4.2M. */
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const parseUsd = (s: string) => Number(s.replace(/[$,]/g, ''));

// ---------------------------------------------------------------------------
// What the main process hands the page, built from the seed.
// ---------------------------------------------------------------------------

function claudePayload(seed: Seed) {
  type Day = {
    date: string; tokensByModel: Record<string, number>; costUSD?: number; costByModel?: Record<string, number>;
    breakdownByModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    messagesByModel?: Record<string, number>;
  };
  const days = new Map<string, Day>();
  const modelUsage: Record<string, Record<string, number>> = {};
  for (const r of seed.transcripts) {
    const d = days.get(r.date) ?? { date: r.date, tokensByModel: {}, breakdownByModel: {}, messagesByModel: {}, costByModel: {}, costUSD: 0 };
    d.tokensByModel[r.model] = (d.tokensByModel[r.model] ?? 0) + r.input + r.output;
    const b = d.breakdownByModel![r.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    d.breakdownByModel![r.model] = { input: b.input + r.input, output: b.output + r.output, cacheRead: b.cacheRead + r.cacheRead, cacheWrite: b.cacheWrite + r.cacheWrite };
    d.messagesByModel![r.model] = (d.messagesByModel![r.model] ?? 0) + r.messages;
    d.costByModel![r.model] = (d.costByModel![r.model] ?? 0) + r.cost;
    d.costUSD = (d.costUSD ?? 0) + r.cost;
    days.set(r.date, d);
    const u = modelUsage[r.model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0, contextWindow: 0, maxOutputTokens: 0 };
    u.inputTokens += r.input; u.outputTokens += r.output; u.cacheReadInputTokens += r.cacheRead;
    u.cacheCreationInputTokens += r.cacheWrite; u.costUSD += r.cost;
    modelUsage[r.model] = u;
  }
  for (const l of seed.legacy ?? []) days.set(l.date, { date: l.date, tokensByModel: l.tokensByModel });
  const dailyModelTokens = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dailyCosts = Object.fromEntries(Object.entries(seed.extra).map(([d, x]) => [d, { cost: 10 * x, extraCost: x }]));
  return {
    settings: null, projects: [], plugins: [], skills: [], history: [], activeSessions: [],
    rateLimits: seed.rateLimits,
    tokenStats: {
      totalInputTokens: 1, totalOutputTokens: 1, totalCostUsd: 1, sessionCount: 1, dailyCosts,
      // All-time, which the page printed until 1.7.9. Never again.
      extraCostUsd: Object.values(seed.extra).reduce((a, b) => a + b, 0),
    },
    stats: {
      modelUsage,
      dailyModelTokens,
      lastComputedDate: seed.lastComputedDate ?? dailyModelTokens.at(-1)?.date ?? null,
      // history.jsonl's first prompt: the page printed "since" this date, which was not where the data started.
      firstSessionDate: '2024-03-15',
      unreadable: 0, totalSessions: 3, totalMessages: 9,
    },
  };
}

function ledgerPayload(seed: Seed) {
  const daily = [...seed.ledger].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider));
  const providers = new Map<string, { provider: string; inputTokens: number; outputTokens: number; costUSD: number; turns: number; models: string[]; measured: boolean }>();
  for (const r of daily) {
    const p = providers.get(r.provider) ?? { provider: r.provider, inputTokens: 0, outputTokens: 0, costUSD: 0, turns: 0, models: [], measured: true };
    p.inputTokens += r.inputTokens; p.outputTokens += r.outputTokens; p.costUSD += r.costUSD; p.turns += r.turns;
    providers.set(r.provider, p);
  }
  return { providers: [...providers.values()], dailyCost: {}, daily, oldest: daily[0]?.date ?? null };
}

// ---------------------------------------------------------------------------
// Mounting the real page, and reading what it prints.
// ---------------------------------------------------------------------------

type Tree = unknown;
type El = ReactElement<Record<string, unknown>>;
const g = globalThis as unknown as { window?: unknown; document?: unknown };
let page: Mount<Tree> | null = null;
const zone = process.env.TZ;

beforeAll(() => { process.env.TZ = 'Asia/Tbilisi'; });
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0));
});
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
  delete g.document;
  vi.useRealTimers();
});

async function render(seed: Seed = SEED): Promise<Mount<Tree>> {
  // Claude's data is one store for the window now: each render reads its own seed.
  forgetClaudeData();
  g.document = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };
  g.window = {
    electronAPI: {
      claude: { getData: vi.fn(async () => claudePayload(seed)) },
      usage: { byProvider: vi.fn(async () => ledgerPayload(seed)) },
      appSettings: { get: vi.fn(async () => ({ providerBudgets: { codex: 50 } })), save: vi.fn(async () => undefined) },
      cliPaths: { detect: vi.fn(async () => ({})) },
    },
  };
  page = mount(() => UsagePage());
  await settle();
  return page;
}

function select(p: Mount<Tree>, tf: Timeframe) {
  const control = ofType(p.result, SegmentedControl);
  expect(control).toHaveLength(1);
  (control[0].props.onChange as (v: Timeframe) => void)(tf);
}

const tiles = (tree: Tree) => Object.fromEntries(elements(tree)
  .filter(el => typeof el.props.caption === 'string' && typeof el.props.value === 'string')
  .map(el => [el.props.caption as string, { value: el.props.value as string, sub: el.props.sub as string, subClassName: el.props.subClassName as string | undefined }]));
const captions = (tree: Tree) => ofType(tree, PanelCaption).map(el => textOf(el.props.children as never));

/** BY PROVIDER: label, models, in, out, cost, one array per row, in page order. */
const providerRows = (tree: Tree) => elements(tree)
  .filter(el => el.type === 'div' && typeof el.key === 'string' && String(el.props.className ?? '').includes('h-8'))
  .map(row => elements(row.props.children).filter(el => el.type === 'span').map(el => textOf(el.props.children as never)));

/** The bars of the three charts, cost then tokens then messages: every host div a pointer can hover. */
function charts(tree: Tree): { cost: El[]; tokens: El[]; messages: El[] } {
  const bars = elements(tree).filter(el => el.type === 'div' && typeof el.props.onMouseEnter === 'function');
  const n = bars.length / 3;
  expect(Number.isInteger(n) && n > 0, `${bars.length} hoverable bars`).toBe(true);
  return { cost: bars.slice(0, n), tokens: bars.slice(n, 2 * n), messages: bars.slice(2 * n) };
}
type Chart = keyof ReturnType<typeof charts>;

/** Hover one bar and read its card, line by line. */
function card(p: Mount<Tree>, chart: Chart, i: number): string[] {
  (charts(p.result)[chart][i].props.onMouseEnter as () => void)();
  const bar = charts(p.result)[chart][i];
  const box = elements(bar.props.children).find(el => el.type === 'div' && String(el.props.className ?? '').includes('bottom-full'));
  const lines = box
    ? elements(box.props.children).filter(el => el.type === 'p' || el.type === 'span').map(el => textOf(el.props.children as never))
    : [];
  (charts(p.result)[chart][i].props.onMouseLeave as () => void)();
  return lines;
}

const headerActions = (tree: Tree) => ofType(tree, PageHeader)[0]?.props.actions;
const recordsLine = (tree: Tree) => elements(headerActions(tree))
  .filter(el => el.type === 'span').map(el => textOf(el.props.children as never)).join('');
const budgetProps = (tree: Tree) => ofType(tree, BudgetAndLimits)[0]?.props as {
  providerSpend: { provider: string; costUSD: number }[]; rateLimits: typeof RATE_LIMITS | null;
};

const LATEST: Record<Timeframe, string> = { daily: 'TODAY', weekly: 'THIS WEEK', monthly: 'THIS MONTH' };
const LENGTH: Record<Timeframe, string> = { daily: '14 DAYS', weekly: '12 WEEKS', monthly: '12 MONTHS' };
const UNIT: Record<Timeframe, string> = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };

// ---------------------------------------------------------------------------

describe('the Usage page, every figure over the timeframe chosen in its header', () => {
  it('runs where a local day and a UTC day differ, with the clock on 22 Sep 2026', () => {
    // The witness for the zone: without it, a run in UTC would pass a bucket keyed by toISOString().
    expect(new Date('2026-09-21T22:30:00Z').getDate()).toBe(22);
    expect(new Date().getDate()).toBe(22);
  });

  it('puts one timeframe control in the header: 24 hours, 14 days, 12 weeks, 12 months', async () => {
    const p = await render();
    const inHeader = ofType(headerActions(p.result), SegmentedControl);
    expect(inHeader).toHaveLength(1);
    expect(ofType(p.result, SegmentedControl)).toHaveLength(1);
    const control = inHeader[0].props as { ariaLabel: string; value: string; options: Array<{ value: string; label: string }> };
    expect(control.ariaLabel).toBe('Timeframe');
    expect(control.options.map(o => [o.value, o.label])).toEqual([['hourly', '24 hours'], ['daily', '14 days'], ['weekly', '12 weeks'], ['monthly', '12 months']]);
    expect(control.value).toBe('daily');
  });

  for (const tf of TIMEFRAMES) {
    describe(`${tf}`, () => {
      const ref = reference(SEED, tf);

      it('T1: TOTAL COST is the sum of the cost bars and of the provider rows', async () => {
        const p = await render();
        select(p, tf);
        const bars = charts(p.result).cost.map((_, i) => card(p, 'cost', i));
        const barSum = bars.reduce((sum, lines) => sum + parseUsd(lines[1]), 0);
        const rowSum = providerRows(p.result).reduce((sum, row) => sum + parseUsd(row[4]), 0);

        expect(tiles(p.result)['TOTAL COST'].value).toBe(usd(ref.total.cost));
        expect(tiles(p.result)['TOTAL COST'].value).toBe({ daily: '$111.00', weekly: '$1,111.00', monthly: '$11,111.00' }[tf]);
        expect(barSum).toBeCloseTo(ref.total.cost, 6);
        expect(rowSum).toBeCloseTo(ref.total.cost, 6);
        expect(bars.map(lines => lines[1])).toEqual(ref.buckets.map(b => usd(b.cost)));
      });

      it('T2: the TOTAL COST line names the over-quota share of the window, never all time', async () => {
        const p = await render();
        select(p, tf);
        const total = tiles(p.result)['TOTAL COST'];
        expect(total.sub).toBe(`of which ~${usd(ref.overQuota)} over quota`);
        expect(total.sub).toBe({ daily: 'of which ~$0.50 over quota', weekly: 'of which ~$5.50 over quota', monthly: 'of which ~$55.50 over quota' }[tf]);
        expect(total.subClassName).toBe('text-danger');
      });

      it('T3: the second tile is the latest bar: today, this week, this month', async () => {
        const p = await render();
        select(p, tf);
        const t = tiles(p.result);
        const last = charts(p.result).cost.length - 1;
        expect(t[LATEST[tf]]).toBeDefined();
        expect(t[LATEST[tf]].value).toBe(card(p, 'cost', last)[1]);
        expect(t[LATEST[tf]].value).toBe({ daily: '$1.00', weekly: '$11.00', monthly: '$411.00' }[tf]);
        expect(t[LATEST[tf]].sub).toBe({ daily: '22 Sep', weekly: 'week of 20 Sep', monthly: 'Sep 2026' }[tf]);
      });

      it('T4: TOTAL TOKENS is in + out, in being input with cache reads and writes, as each provider row counts it', async () => {
        const p = await render();
        select(p, tf);
        const t = tiles(p.result)['TOTAL TOKENS'];
        expect(t.value).toBe(tok(tin(ref.total) + ref.total.output));
        expect(t.sub).toBe(`${tok(tin(ref.total))} in / ${tok(ref.total.output)} out`);
        if (tf === 'daily') expect([t.value, t.sub]).toEqual(['520.8k', '487.5k in / 33.3k out']);
        // The provider rows count tokens the same way, over the same window.
        expect(providerRows(p.result).map(row => [row[0], row[2], row[3]])).toEqual(ref.rows.map(r => [r.label, tok(r.in), tok(r.out)]));
      });

      it('T5: CACHE READS is the window\'s cache reads, and its share of tokens in', async () => {
        const p = await render();
        select(p, tf);
        const t = tiles(p.result)['CACHE READS'];
        expect(t.value).toBe(tok(ref.total.cacheRead));
        expect(t.sub).toBe(`${((ref.total.cacheRead / tin(ref.total)) * 100).toFixed(1)}% of tokens in`);
        expect(tiles(p.result)['CACHE SAVINGS']).toBeUndefined();
      });

      it('T6: BY PROVIDER lists who did something in the window, priced per model, Claude counted once', async () => {
        const p = await render();
        select(p, tf);
        const rows = providerRows(p.result).map(row => [row[0], row[1].split(', ').sort(), row[4]]);
        expect(rows).toEqual(ref.rows.map(r => [r.label, r.models, usd(r.cost)]));
        const codex = rows.find(row => row[0] === 'Codex');
        if (tf === 'monthly') expect(codex).toEqual(['Codex', ['gpt-5-codex'], '$1,000.00']);
        else expect(codex).toBeUndefined();
        // Z.ai shares 10 Sep with Opus 5: its row is its own price, not half of the day's.
        expect(rows.find(row => row[0] === 'Zai')).toEqual(['Zai', ['glm-4.6'], '$40.00']);
        expect(rows.find(row => row[0] === 'Claude')?.[2]).toBe({ daily: '$71.00', weekly: '$571.00', monthly: '$9,571.00' }[tf]);
      });

      it('T7: the budget rows are this month to date, whatever the timeframe', async () => {
        const p = await render();
        select(p, tf);
        const { providerSpend, rateLimits } = budgetProps(p.result);
        // Gemini: 1 Sep only, not 31 Aug, not all time. Claude: the transcripts' September, not the ACP row.
        expect(providerSpend).toEqual([
          { provider: 'gemini', costUSD: 300 },
          { provider: 'claude', costUSD: 71 },
          { provider: 'codex', costUSD: 0 },
        ]);
        const printed = buildBudgetRows({ rateLimits, providerSpend, budgets: { codex: 50 }, installed: {} }).map(r => `${r.label}: ${r.detail}`);
        expect(printed).toEqual([
          'Claude: 5h window · 62% used',
          'Claude: 7d window · 31% used',
          'Gemini: $300.00 this month · no budget set',
          'Codex: $0.00 of $50.00 this month',
        ]);
      });

      it('T8: the three charts draw the same bars over the window, and every caption names it', async () => {
        const p = await render();
        select(p, tf);
        const c = charts(p.result);
        const keys = WINDOWS[tf].map(b => b.key);
        expect(c.cost.map(el => el.key)).toEqual(keys);
        expect(c.tokens.map(el => el.key)).toEqual(keys);
        expect(c.messages.map(el => el.key)).toEqual(keys);
        expect(captions(p.result)).toEqual([
          `BY PROVIDER · ${LENGTH[tf]}`,
          `${UNIT[tf]} COST · ${LENGTH[tf]}`,
          `${UNIT[tf]} TOKENS · ${LENGTH[tf]}`,
          `${UNIT[tf]} MESSAGES · ${LENGTH[tf]}`,
        ]);
        ref.buckets.forEach((b, i) => {
          const label = WINDOWS[tf][i].label;
          expect(card(p, 'cost', i)[0]).toBe(label);
          expect(card(p, 'tokens', i)[0]).toBe(`${label} · ${tok(tin(b) + b.output)} tokens`);
          expect(card(p, 'messages', i)[0]).toBe(`${label} · ${b.messages.toLocaleString()} ${b.messages === 1 ? 'message' : 'messages'}`);
        });
      });
    });
  }

  it('T2: with no over-quota spend the TOTAL COST line is the window\'s span, never the first prompt\'s date', async () => {
    const p = await render({ ...SEED, extra: {} });
    const spans: string[] = [];
    for (const tf of TIMEFRAMES) {
      select(p, tf);
      spans.push(tiles(p.result)['TOTAL COST'].sub);
      expect(tiles(p.result)['TOTAL COST'].subClassName).toBe('text-muted-foreground');
    }
    expect(spans).toEqual(['9 Sep to 22 Sep', '5 Jul to 22 Sep', '1 Oct 2025 to 22 Sep 2026']);
    expect(JSON.stringify(p.result)).not.toMatch(/2024|since/);
  });

  it('T2: says where the records start when the window reaches past them, from the older of the two sources', async () => {
    // Transcripts from 19 Aug, the ledger from 10 Aug: Claude Code keeps about thirty days.
    const p = await render({
      transcripts: [tr('2026-08-19', 'claude-opus-5', 5, 1), tr('2026-09-22', 'claude-opus-5', 1, 1)],
      ledger: [lg('2026-08-10', 'gemini', 'gemini-3-pro', 2, 1)],
      extra: {},
      rateLimits: null,
    });
    const lines: string[] = [];
    for (const tf of TIMEFRAMES) {
      select(p, tf);
      lines.push(recordsLine(p.result));
    }
    expect(lines).toEqual(['', 'records start 10 Aug 2026', 'records start 10 Aug 2026']);
  });

  it('T7: without rate windows, Claude\'s budget row is its own month to date, not the ACP row the transcripts already hold', async () => {
    // $1,000 more on 5 Sep, so that Claude has the month's largest spend and a row of its own.
    const p = await render({ ...SEED, transcripts: [...SEED.transcripts, tr('2026-09-05', 'claude-opus-5', 1000, 1)], rateLimits: null });
    expect(budgetProps(p.result).providerSpend).toEqual([
      { provider: 'claude', costUSD: 1071 },
      { provider: 'gemini', costUSD: 300 },
      { provider: 'codex', costUSD: 0 },
    ]);
    const printed = buildBudgetRows({ ...budgetProps(p.result), budgets: { codex: 50 }, installed: {} }).map(r => `${r.label}: ${r.detail}`);
    expect(printed).toEqual([
      'Claude: $1071.00 this month · no budget set',
      'Gemini: $300.00 this month · no budget set',
      'Codex: $0.00 of $50.00 this month',
    ]);
  });

  it('ends the window today, so a ledger turn after the last transcript day is counted', async () => {
    const p = await render({
      transcripts: [tr('2026-09-20', 'claude-opus-5', 10, 1)],
      ledger: [lg('2026-09-22', 'gemini', 'gemini-3-pro', 2, 1)],
      extra: {},
      rateLimits: null,
      lastComputedDate: '2026-09-20',
    });
    expect(tiles(p.result).TODAY).toEqual({ value: '$2.00', sub: '22 Sep', subClassName: undefined });
    expect(tiles(p.result)['TOTAL COST'].value).toBe('$12.00');
    expect(charts(p.result).cost.at(-1)?.key).toBe('2026-09-22');
  });

  it('moves the window with the clock: the next morning, today is the 23rd', async () => {
    vi.setSystemTime(new Date(2026, 8, 23, 9, 0, 0));
    const p = await render();
    expect(tiles(p.result).TODAY).toEqual({ value: '$0.00', sub: '23 Sep', subClassName: undefined });
    expect(charts(p.result).cost.map(el => el.key)).toEqual(WINDOWS.daily.map(b => addDays(b.key, 1)));
    expect(tiles(p.result)['TOTAL COST'].value).toBe('$111.00');
  });

  it('counts a day of the legacy stats-cache.json shape in no figure: it has no price and no cache', async () => {
    const legacy = { ...SEED, legacy: [{ date: '2026-09-16', tokensByModel: { 'claude-opus-5': 7_000_000_000 } }] };
    const base = await render();
    const want = { tiles: tiles(base.result), rows: providerRows(base.result) };
    base.unmount();
    const p = await render(legacy);
    expect({ tiles: tiles(p.result), rows: providerRows(p.result) }).toEqual(want);
    expect(card(p, 'tokens', 7)[0]).toBe('16 Sep · 0 tokens');
  });
});

// ---------------------------------------------------------------------------
// T9, the general gate: what lies outside the window cannot move the page.
// ---------------------------------------------------------------------------

/**
 * Every element of the tree, with its props, as text: tiles, header, provider
 * rows, bar heights, ticks, edges. The budget panel's spend is left out by
 * name, because it is month to date on purpose; its rate windows are not
 * scaled at all. Whatever figure is added to the page later is in here too.
 */
function snapshot(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(snapshot);
  if (node === null || node === undefined || typeof node !== 'object') return typeof node === 'function' ? '[fn]' : node;
  const el = node as El;
  if (!el.$$typeof) {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, snapshot(v)]));
  }
  const type = typeof el.type === 'string' ? el.type : ((el.type as { displayName?: string; name?: string })?.displayName ?? (el.type as { name?: string })?.name ?? String(el.type));
  const props = Object.fromEntries(Object.entries(el.props ?? {})
    .filter(([k]) => !(el.type === BudgetAndLimits && k === 'providerSpend'))
    .map(([k, v]) => [k, snapshot(v)]));
  return { type, key: el.key, props };
}

/** The page, and every card of every bar opened one at a time. */
function everything(p: Mount<Tree>): string {
  const out: unknown[] = [snapshot(p.result)];
  for (const chart of ['cost', 'tokens', 'messages'] as const) {
    charts(p.result)[chart].forEach((_, i) => out.push(card(p, chart, i)));
  }
  return JSON.stringify(out);
}

/** Every source scaled by `k` on the days `pick` chooses: transcripts, ledger, token-stats. */
function scale(seed: Seed, pick: (date: string) => boolean, k: number): Seed {
  const t = (r: TRow): TRow => pick(r.date)
    ? { ...r, cost: k * r.cost, input: k * r.input, cacheRead: k * r.cacheRead, cacheWrite: k * r.cacheWrite, output: k * r.output, messages: k * r.messages }
    : r;
  const l = (r: LRow): LRow => pick(r.date)
    ? { ...r, costUSD: k * r.costUSD, inputTokens: k * r.inputTokens, cachedReadTokens: k * r.cachedReadTokens, cachedWriteTokens: k * r.cachedWriteTokens, outputTokens: k * r.outputTokens }
    : r;
  return {
    ...seed,
    transcripts: seed.transcripts.map(t),
    ledger: seed.ledger.map(l),
    extra: Object.fromEntries(Object.entries(seed.extra).map(([d, x]) => [d, pick(d) ? k * x : x])),
  };
}

/** The main seed, plus a day on each side of every window's first day. */
const EDGES: Seed = {
  ...SEED,
  transcripts: [
    ...SEED.transcripts,
    tr('2026-09-09', 'claude-opus-5', 0.25, 2), tr('2026-09-08', 'claude-sonnet-5', 0.75, 3),
    tr('2026-07-05', 'claude-opus-5', 2.5, 4), tr('2026-07-04', 'claude-sonnet-5', 7.5, 5),
    tr('2025-10-01', 'claude-opus-5', 25, 6), tr('2025-09-30', 'claude-sonnet-5', 75, 7),
  ].sort((a, b) => a.date.localeCompare(b.date)),
  ledger: [...SEED.ledger, lg('2026-09-08', 'codex', 'gpt-5-codex', 0.5, 2), lg('2025-09-30', 'codex', 'gpt-5-codex', 5, 2)],
  extra: { ...SEED.extra, '2026-09-08': 3, '2026-07-04': 30, '2025-09-30': 300 },
};

describe('T9: usage outside the window, times seven, moves nothing on the page but the month-to-date budget', () => {
  for (const tf of TIMEFRAMES) {
    it(tf, async () => {
      const read = async (seed: Seed) => {
        const p = await render(seed);
        select(p, tf);
        const all = everything(p);
        p.unmount();
        page = null;
        return all;
      };
      const base = await read(EDGES);
      const outside = await read(scale(EDGES, d => !inWindow(tf, d), 7));
      const inside = await read(scale(EDGES, d => inWindow(tf, d), 7));

      expect(outside).toBe(base);
      // The witness: the same reading does see the window move, so equality above is not blindness.
      expect(inside).not.toBe(base);
    });
  }

  it('the edge days sit where the reference says: in, then just out, of each window', () => {
    expect([inWindow('daily', '2026-09-09'), inWindow('daily', '2026-09-08')]).toEqual([true, false]);
    expect([inWindow('weekly', '2026-07-05'), inWindow('weekly', '2026-07-04')]).toEqual([true, false]);
    expect([inWindow('monthly', '2025-10-01'), inWindow('monthly', '2025-09-30')]).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// The follow-ups of #121, fixed in #130 and pinned at its QA gate.
// ---------------------------------------------------------------------------

describe('the Usage page between two polls, and the rest of #121 follow-ups', () => {
  type Api = { claude: { getData: ReturnType<typeof vi.fn> }; usage: { byProvider: ReturnType<typeof vi.fn> } };
  const api = () => (g.window as { electronAPI: Api }).electronAPI;
  const reads = () => api().usage.byProvider.mock.calls.length;
  const today = (tree: Tree) => parseUsd(tiles(tree)[LATEST.daily].value);
  /** One of useClaude's ten-second polls, and whatever it hands the page. */
  const poll = async () => { vi.advanceTimersByTime(10_000); await settle(); };

  it('shows a cost that grew today, where nothing else moved, and reads the ledger again for it; a poll that changes nothing does neither', async () => {
    const p = await render();
    select(p, 'daily');
    await settle();
    const before = today(p.result);
    const read = reads();

    // The date, the sessions, the projects and the rate windows stay as they were:
    // only the newest day's cost and tokens grow, as they do all day long.
    const grown: Seed = { ...SEED, transcripts: [...SEED.transcripts, tr('2026-09-22', 'claude-opus-5', 1000, 1)] };
    api().claude.getData.mockImplementation(async () => claudePayload(grown));
    await poll();
    expect(today(p.result)).toBeCloseTo(before + 1000, 2);
    expect(reads()).toBe(read + 1);

    await poll();
    expect(today(p.result)).toBeCloseTo(before + 1000, 2);
    expect(reads()).toBe(read + 1);
  });

  it('hands over a poll where only token-stats.json changed', async () => {
    await render();
    const read = reads();
    const more: Seed = { ...SEED, extra: { ...SEED.extra, '2026-09-22': (SEED.extra['2026-09-22'] ?? 0) + 7 } };
    api().claude.getData.mockImplementation(async () => claudePayload(more));
    await poll();
    expect(reads()).toBe(read + 1);
  });

  it("keeps Claude's budget row when another provider spent more this month and Claude has no rate windows", () => {
    const spend = [{ provider: 'gemini', costUSD: 300 }, { provider: 'claude', costUSD: 42.6 }, { provider: 'codex', costUSD: 20 }];
    const rows = buildBudgetRows({ rateLimits: null, providerSpend: spend, budgets: {}, installed: { claude: true, gemini: true, codex: true } });
    expect(rows.map(r => r.providerId)).toEqual(['gemini', 'claude', 'codex']);
  });

  it('adds no second Claude row beside its rate windows', () => {
    const claudeRows = (spend: { provider: string; costUSD: number }[]) =>
      buildBudgetRows({ rateLimits: RATE_LIMITS, providerSpend: spend, budgets: {}, installed: { claude: true, gemini: true } })
        .filter(r => r.providerId === 'claude').length;
    expect(claudeRows([{ provider: 'gemini', costUSD: 300 }])).toBeGreaterThan(0);
    expect(claudeRows([{ provider: 'gemini', costUSD: 300 }, { provider: 'claude', costUSD: 42.6 }])).toBe(claudeRows([{ provider: 'gemini', costUSD: 300 }]));
  });

  it('starts the records at the first day with a price or a split, never at a legacy stats-cache day', async () => {
    const legacy = { date: '2026-03-03', tokensByModel: { 'claude-opus-4-6': 10 } };
    const split = { date: '2026-08-15', tokensByModel: { 'claude-opus-5': 1 }, breakdownByModel: { 'claude-opus-5': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } };
    const priced = { date: '2026-09-01', tokensByModel: { 'claude-opus-5': 1 }, costByModel: { 'claude-opus-5': 1 } };
    expect(recordsStart([legacy, split, priced] as never, null)).toBe('2026-08-15');
    expect(recordsStart([legacy, priced] as never, null)).toBe('2026-09-01');
    expect(recordsStart([legacy] as never, null)).toBeNull();
    expect(recordsStart([legacy] as never, '2026-05-01')).toBe('2026-05-01');

    // On the page: twelve months of stats-cache.json alone said "records start 3 Mar 2026" beside $0.00.
    const p = await render({ transcripts: [], ledger: [], extra: {}, rateLimits: null, legacy: [legacy] });
    expect(recordsLine(p.result)).not.toContain('3 Mar');
  });

  it('names the fifth generation by family and version, and never reads a date as a version', async () => {
    const models = ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1', 'claude-opus-5-20260101', 'claude-sonnet-5', 'claude-haiku-4-5'];
    const p = await render({ transcripts: models.map(m => tr('2026-09-22', m, 1, 1)), ledger: [], extra: {}, rateLimits: null });
    const claude = providerRows(p.result).find(r => r[0] === 'Claude')!;
    expect(claude[1].split(', ').sort()).toEqual(['Claude Haiku 4.5', 'Fable 5.1', 'Opus 5', 'Opus 5.5', 'Sonnet 5']);
  });
});
