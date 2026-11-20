import '../setup/home-guard';
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mount, settle, elements, ofType, textOf, type Mount } from './hook-runtime';
import UsagePage from '../../src/app/usage/page';
import { BudgetAndLimits } from '../../src/components/Usage/BudgetAndLimits';
import { PageHeader, PanelCaption, SegmentedControl } from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Usage page's "24 hours" view, on #275's contract: the transcripts' hours
 * (`stats.hourlyModelTokens`) and the ledger's (`usage.byProvider().hourly`),
 * 48 hours of each, of which the page shows the current hour and the 23
 * before it. Frames: `Usage · last 24 hours` and its light copy. Written
 * before the code. How it can fail:
 * 1. no "24 hours" in the timeframe control, or not first, or it becomes the
 *    page's default;
 * 2. the window is not the current hour and the 23 before it: 25 bars, an
 *    hour of the day before counted, or the bars ending on the last hour that
 *    has data;
 * 3. the ledger's claude rows counted: they are Claude's ACP turns, already
 *    in its transcripts (#275's gate), so its spend counts twice;
 * 4. a model filed by its name where its sessions name its provider: an
 *    OpenRouter-served claude-sonnet-5 under Claude, in the hours and the days;
 * 5. the figures disagree: TOTAL COST against the bars and the provider rows;
 * 6. the words: THIS HOUR and its hour, "since 13:00 yesterday", the hourly
 *    captions, the ticks and the edges the frame draws;
 * 7. what is not the timeframe's moves with it: the budget's month to date
 *    read from the hours, "records start" or an over-quota share said of 24
 *    hours, or "nothing recorded yet" for a window that is merely quiet;
 * 8. a bar's hover card hangs out of its panel: 24 bars are narrower than 14.
 *
 * Every expectation is computed from the seed with its own arithmetic. The
 * clock is pinned to 22 Sep 2026 at 12:30 in Tbilisi (UTC+4), so the current
 * hour starts at 12:00 local, 08:00 UTC, and the window at 13:00 yesterday.
 */

// The zone is pinned here, before anything below reads the clock: the seed's
// hours are computed as this file loads. Pinned in a beforeAll, it came after
// them, and in any zone but UTC+4 (CI runs in UTC) the page's clock and its
// seed were four hours apart.
const zone = process.env.TZ;
process.env.TZ = 'Asia/Tbilisi';

const H = 3_600_000;
const NOW = () => new Date(2026, 8, 22, 12, 30, 0);
const H0 = () => Math.floor(NOW().getTime() / H) * H; // 12:00 local
const at = (hoursBefore: number) => H0() - hoursBefore * H;

interface TH { hour: number; model: string; cost: number; input: number; cacheRead: number; cacheWrite: number; output: number; messages: number }
interface LH { hour: number; provider: string; model: string | null; costUSD: number; inputTokens: number; cachedReadTokens: number; cachedWriteTokens: number; outputTokens: number; turns: number }
const th = (hoursBefore: number, model: string, cost: number): TH => ({
  hour: at(hoursBefore), model, cost, input: 1000 * cost, cacheRead: 3000 * cost, cacheWrite: 500 * cost, output: 300 * cost, messages: cost >= 1 ? cost : 1,
});
const lh = (hoursBefore: number, provider: string, model: string | null, cost: number): LH => ({
  hour: at(hoursBefore), provider, model, costUSD: cost, inputTokens: 1000 * cost, cachedReadTokens: 2000 * cost,
  cachedWriteTokens: 0, outputTokens: 200 * cost, turns: 1,
});

// Inside the window: this hour, 5 h, 2 h and 1 h before, and its first hour (23 h before).
// Outside it: 24 h and 40 h before, which the 48 hours main sends still hold.
const HOURS: TH[] = [
  th(0, 'claude-opus-5', 1),
  th(5, 'claude-opus-5', 10),
  th(23, 'claude-opus-5', 100),
  th(24, 'claude-opus-5', 1000),
  th(40, 'claude-opus-5', 10000),
  th(2, 'claude-sonnet-5', 20),
];
const LEDGER_HOURS: LH[] = [
  lh(1, 'codex', 'gpt-5.3-codex', 3),
  lh(0, 'claude', 'claude-opus-5', 5000), // an ACP turn of the claude binary: in its transcript already
  lh(30, 'codex', 'gpt-5.3-codex', 30000),
];
const PROVIDER_BY_MODEL = { 'claude-sonnet-5': 'openrouter', 'claude-opus-5': 'claude' };

// The days, for the 14 days view and the budget: Claude today, OpenRouter's
// sonnet on the 20th, Codex in the ledger on the 21st.
const DAYS = [
  { date: '2026-09-22', model: 'claude-opus-5', cost: 7 },
  { date: '2026-09-20', model: 'claude-sonnet-5', cost: 8 },
];
const LEDGER_DAYS = [
  { date: '2026-09-21', provider: 'codex', model: 'gpt-5.3-codex', costUSD: 4, inputTokens: 4000, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 800, turns: 1 },
];

// ---------------------------------------------------------------------------
// The reference, from the seed alone.
// ---------------------------------------------------------------------------

const PROVIDER_OF = (model: string) => (PROVIDER_BY_MODEL as Record<string, string>)[model] ?? 'claude';
const LABEL_OF: Record<string, string> = { claude: 'Claude', openrouter: 'OpenRouter', codex: 'Codex' };
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => `${pad(new Date(ms).getHours())}:00`;
const inWindow = (hour: number) => hour >= at(23) && hour <= at(0);

function reference() {
  const counted = [
    ...HOURS.map(r => ({ hour: r.hour, provider: PROVIDER_OF(r.model), cost: r.cost, tin: r.input + r.cacheRead + r.cacheWrite, out: r.output, messages: r.messages })),
    ...LEDGER_HOURS.filter(r => r.provider !== 'claude').map(r => ({
      hour: r.hour, provider: r.provider, cost: r.costUSD, tin: r.inputTokens + r.cachedReadTokens + r.cachedWriteTokens, out: r.outputTokens, messages: 0,
    })),
  ].filter(r => inWindow(r.hour));
  const bars = Array.from({ length: 24 }, (_, i) => {
    const start = at(23 - i);
    return { start, label: clock(start), tick: pad(new Date(start).getHours()), cost: counted.filter(r => r.hour === start).reduce((s, r) => s + r.cost, 0) };
  });
  const providers = new Map<string, number>();
  for (const r of counted) providers.set(r.provider, (providers.get(r.provider) ?? 0) + r.cost);
  return {
    total: counted.reduce((s, r) => s + r.cost, 0),
    thisHour: bars[23].cost,
    bars,
    rows: [...providers.entries()].sort(([, a], [, b]) => b - a).map(([p, cost]) => [LABEL_OF[p], cost] as const),
  };
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseUsd = (s: string) => Number(s.replace(/[$,]/g, ''));

// ---------------------------------------------------------------------------
// What main hands the page.
// ---------------------------------------------------------------------------

function bucketOf(rows: Array<{ model: string; cost: number; input: number; cacheRead: number; cacheWrite: number; output: number; messages: number }>) {
  const b = { tokensByModel: {} as Record<string, number>, breakdownByModel: {} as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>, messagesByModel: {} as Record<string, number>, costUSD: 0, costByModel: {} as Record<string, number>, costByAccount: { '': 0 } as Record<string, number> };
  for (const r of rows) {
    b.tokensByModel[r.model] = (b.tokensByModel[r.model] ?? 0) + r.input + r.output;
    const s = b.breakdownByModel[r.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    b.breakdownByModel[r.model] = { input: s.input + r.input, output: s.output + r.output, cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite };
    b.messagesByModel[r.model] = (b.messagesByModel[r.model] ?? 0) + r.messages;
    b.costByModel[r.model] = (b.costByModel[r.model] ?? 0) + r.cost;
    b.costUSD += r.cost;
    b.costByAccount[''] += r.cost;
  }
  return b;
}

function claudePayload() {
  const hours = [...new Set(HOURS.map(r => r.hour))].sort((a, b) => a - b)
    .map(hour => ({ hour, ...bucketOf(HOURS.filter(r => r.hour === hour)) }));
  const days = [...new Set(DAYS.map(d => d.date))].sort()
    .map(date => ({ date, ...bucketOf(DAYS.filter(d => d.date === date).map(d => ({ model: d.model, cost: d.cost, input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, messages: 1 }))) }));
  return {
    settings: null, projects: [], plugins: [], skills: [], history: [], activeSessions: [], rateLimits: null, tokenStats: null,
    stats: {
      modelUsage: {}, dailyModelTokens: days, hourlyModelTokens: hours, providerByModel: PROVIDER_BY_MODEL,
      lastComputedDate: '2026-09-22', unreadable: 0, totalSessions: 2, totalMessages: 5,
    },
  };
}

function ledgerPayload() {
  return { providers: [], dailyCost: {}, daily: LEDGER_DAYS, oldest: '2026-09-21', hourly: LEDGER_HOURS };
}

// ---------------------------------------------------------------------------

type Tree = unknown;
type El = ReactElement<Record<string, unknown>>;
const g = globalThis as unknown as { window?: unknown; document?: unknown };
let page: Mount<Tree> | null = null;
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW());
});
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
  delete g.document;
  vi.useRealTimers();
});

async function render(): Promise<Mount<Tree>> {
  g.document = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };
  g.window = {
    electronAPI: {
      claude: { getData: vi.fn(async () => claudePayload()) },
      usage: { byProvider: vi.fn(async () => ledgerPayload()) },
      appSettings: { get: vi.fn(async () => ({ providerBudgets: { codex: 50 } })), save: vi.fn(async () => undefined) },
      cliPaths: { detect: vi.fn(async () => ({})) },
    },
  };
  page = mount(() => UsagePage());
  await settle();
  return page;
}

const control = (p: Mount<Tree>) => ofType(p.result, SegmentedControl)[0].props as { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void };
const select = (p: Mount<Tree>, value: string) => control(p).onChange(value);
const tiles = (tree: Tree) => Object.fromEntries(elements(tree)
  .filter(el => typeof el.props.caption === 'string' && typeof el.props.value === 'string')
  .map(el => [el.props.caption as string, { value: el.props.value as string, sub: el.props.sub as string, subClassName: el.props.subClassName as string | undefined }]));
const captions = (tree: Tree) => ofType(tree, PanelCaption).map(el => textOf(el.props.children as never));
const providerRows = (tree: Tree) => elements(tree)
  .filter(el => el.type === 'div' && typeof el.key === 'string' && String(el.props.className ?? '').includes('h-8'))
  .map(row => elements(row.props.children).filter(el => el.type === 'span').map(el => textOf(el.props.children as never)));
function charts(tree: Tree): { cost: El[]; tokens: El[]; messages: El[] } {
  const bars = elements(tree).filter(el => el.type === 'div' && typeof el.props.onMouseEnter === 'function');
  const n = bars.length / 3;
  return { cost: bars.slice(0, n), tokens: bars.slice(n, 2 * n), messages: bars.slice(2 * n) };
}
/** Hover one bar: its card's lines, and the class its card hangs by. */
function card(p: Mount<Tree>, chart: 'cost' | 'tokens' | 'messages', i: number): { lines: string[]; anchor: string } {
  (charts(p.result)[chart][i].props.onMouseEnter as () => void)();
  const bar = charts(p.result)[chart][i];
  const box = elements(bar.props.children).find(el => el.type === 'div' && String(el.props.className ?? '').includes('bottom-full'));
  const lines = box ? elements(box.props.children).filter(el => el.type === 'p').map(el => textOf(el.props.children as never)) : [];
  const anchor = String(box?.props.className ?? '');
  (charts(p.result)[chart][i].props.onMouseLeave as () => void)();
  return { lines, anchor };
}
const ticks = (bar: El) => elements(bar.props.children).filter(el => el.type === 'span').map(el => textOf(el.props.children as never));
const allText = (tree: Tree) => elements(tree).flatMap(el => (typeof el.props.children === 'string' ? [el.props.children] : []));
const budgetSpend = (tree: Tree) => (ofType(tree, BudgetAndLimits)[0]?.props as { providerSpend: unknown }).providerSpend;
const headerText = (tree: Tree) => elements(ofType(tree, PageHeader)[0]?.props.actions).filter(el => el.type === 'span').map(el => textOf(el.props.children as never)).join('');

describe('the Usage page over the last 24 hours', () => {
  const ref = reference();

  it('runs in a zone where local and UTC hours carry different numbers', () => {
    expect(new Date(H0()).getHours()).toBe(12);
    expect(new Date(H0()).getUTCHours()).toBe(8);
  });

  it('offers 24 hours first in the timeframe control, and keeps 14 days the default (1)', async () => {
    const p = await render();
    expect(control(p).options.map(o => [o.value, o.label])).toEqual([['hourly', '24 hours'], ['daily', '14 days'], ['weekly', '12 weeks'], ['monthly', '12 months']]);
    expect(control(p).value).toBe('daily');
  });

  it('shows the current hour and the 23 before it, from 13:00 yesterday, ticked and edged as the frame (2, 6)', async () => {
    const p = await render();
    select(p, 'hourly');
    const cost = charts(p.result).cost;
    expect(cost).toHaveLength(24);
    expect(cost.map(bar => ticks(bar)[0])).toEqual(ref.bars.map(b => b.tick));
    expect(ref.bars[0].tick).toBe('13');
    expect(ref.bars[23].tick).toBe('12');
    expect(card(p, 'cost', 0).lines[0]).toBe('13:00');
    expect(card(p, 'cost', 23).lines[0]).toBe('12:00');
    const text = allText(p.result);
    expect(text).toContain('13:00');
    expect(text).toContain('this hour');
  });

  it('adds up the window alone, without the ledger\'s claude rows, and agrees with its bars and rows (2, 3, 5)', async () => {
    const p = await render();
    select(p, 'hourly');
    expect(ref.total).toBe(134);
    expect(tiles(p.result)['TOTAL COST'].value).toBe(usd(ref.total));
    const bars = charts(p.result).cost.map((_, i) => parseUsd(card(p, 'cost', i).lines[1]));
    expect(bars).toEqual(ref.bars.map(b => b.cost));
    expect(bars.reduce((a, b) => a + b, 0)).toBeCloseTo(ref.total, 6);
    expect(providerRows(p.result).reduce((s, row) => s + parseUsd(row[4]), 0)).toBeCloseTo(ref.total, 6);
  });

  it('files each model under the provider its sessions ran under, in the hours and the days (4)', async () => {
    const p = await render();
    select(p, 'hourly');
    expect(providerRows(p.result).map(row => [row[0], parseUsd(row[4])])).toEqual(ref.rows.map(([label, cost]) => [label, cost]));
    expect(ref.rows.map(([label]) => label)).toEqual(['Claude', 'OpenRouter', 'Codex']);
    select(p, 'daily');
    expect(providerRows(p.result).find(row => row[0] === 'OpenRouter')?.[4]).toBe('$8.00');
  });

  it('says THIS HOUR, since when, and the hourly captions (6)', async () => {
    const p = await render();
    select(p, 'hourly');
    const t = tiles(p.result);
    expect([t['THIS HOUR']?.value, t['THIS HOUR']?.sub]).toEqual([usd(ref.thisHour), '12:00']);
    expect(t['TOTAL COST'].sub).toBe('since 13:00 yesterday');
    expect(captions(p.result)).toEqual(expect.arrayContaining(['BY PROVIDER · 24 HOURS', 'HOURLY COST · 24 HOURS', 'HOURLY TOKENS · 24 HOURS', 'HOURLY MESSAGES · 24 HOURS']));
  });

  it('says since 00:00 today when the window starts today, at 23:30 (6)', async () => {
    vi.setSystemTime(new Date(2026, 8, 22, 23, 30, 0));
    const p = await render();
    select(p, 'hourly');
    expect(tiles(p.result)['TOTAL COST'].sub).toBe('since 00:00 today');
    expect(tiles(p.result)['THIS HOUR'].sub).toBe('23:00');
  });

  it('leaves the budget\'s month to date, and the words about days, to the days (7)', async () => {
    const p = await render();
    const daily = budgetSpend(p.result);
    select(p, 'hourly');
    expect(budgetSpend(p.result)).toEqual(daily);
    expect(headerText(p.result)).not.toContain('records start');
    expect(tiles(p.result)['TOTAL COST'].sub).not.toContain('over quota');
  });

  it('hangs every hover card inside its panel: the 7 bars at each end anchor at their own edge (8)', async () => {
    const p = await render();
    select(p, 'hourly');
    for (let i = 0; i < 24; i++) {
      const { anchor } = card(p, 'tokens', i);
      const want = i < 7 ? 'left-0' : i >= 17 ? 'right-0' : '-translate-x-1/2';
      expect(anchor, `bar ${i}`).toContain(want);
    }
  });
});
