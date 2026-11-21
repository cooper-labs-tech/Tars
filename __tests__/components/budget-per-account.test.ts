import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBudgetRows } from '../../src/components/Usage/BudgetAndLimits';

/**
 * Budget & limits with several Claude accounts, on #277's counters
 * (`claude:getData().accountRateLimits`, AUDIT-USAGE-COMPTES.md gap 6: only
 * account 1 wrote rate-limits.json, so the page showed account 1's bars while
 * every agent ran on account 2). Frame: `Usage · limits per account` and its
 * light copy. Written before the code. How it can fail:
 * 1. with two accounts or more, Claude's rows are still account 1's, under
 *    "Claude": the bars of an account no agent may be running on;
 * 2. an account's rows out of Settings' order, or not under "Claude · <name>";
 * 3. a window past its reset (null, on an account that has reported) keeps a
 *    percentage, or loses its row, where it says reset over an empty bar; and
 *    one that passes its reset between two reads, still holding its figures,
 *    is timed as one that has not ("resets in -1m"), where it says reset as
 *    Claude's own rows do (#279), while one with no reset time (0) is unknown,
 *    not passed;
 * 4. an account that has reported nothing yet gets rows of zeros or "reset":
 *    it has no figures, and Claude has no rows before its first status line;
 * 5. with the option off (no accounts) or a single account, Claude's two rows
 *    change: they stay as they are;
 * 6. Claude's spend row comes back beside the accounts' rows.
 */

const NOW = new Date(2026, 9, 1, 12, 0, 0);
const now = () => Math.floor(NOW.getTime() / 1000);
const win = (usedPercentage: number, inSeconds: number) => ({ usedPercentage, resetsAt: now() + inSeconds });
const account = (accountId: string, label: string, fiveHour: ReturnType<typeof win> | null, sevenDay: ReturnType<typeof win> | null, updatedAt: number | null = NOW.getTime() - 60_000) =>
  ({ accountId, label, fiveHour, sevenDay, updatedAt });

const RATE_LIMITS = {
  five_hour: { used_percentage: 97, resets_at: now() + 1800 },
  seven_day: { used_percentage: 40, resets_at: now() + 86_400 },
};
const rows = (accounts: ReturnType<typeof account>[] | undefined, spend: { provider: string; costUSD: number }[] = []) =>
  buildBudgetRows({ rateLimits: RATE_LIMITS, accounts, providerSpend: spend, budgets: {}, installed: {} })
    .map(r => [r.label, r.detail, r.percent]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('Budget & limits, one pair of rows per Claude account', () => {
  it('gives each account its own windows, in Settings\' order, under Claude and its name (1, 2)', () => {
    expect(rows([
      account('default', 'Personal', win(62.4, 1800), win(31, 3 * 86_400)),
      account('acct-2', 'Team B', win(12, 2 * 3600), win(8, 5 * 86_400)),
    ])).toEqual([
      ['Claude · Personal', '5h window · 62% used · resets in 30m', 62],
      ['Claude · Personal', '7d window · 31% used · resets in 3d', 31],
      ['Claude · Team B', '5h window · 12% used · resets in 2h', 12],
      ['Claude · Team B', '7d window · 8% used · resets in 5d', 8],
    ]);
  });

  it('says reset over an empty bar for a window past its reset (3)', () => {
    expect(rows([
      account('default', 'Personal', win(62, 1800), win(31, 86_400)),
      account('acct-2', 'Team B', null, win(8, 86_400)),
    ]).slice(2)).toEqual([
      ['Claude · Team B', '5h window · reset', 0],
      ['Claude · Team B', '7d window · 8% used · resets in 1d', 8],
    ]);
  });

  it('says reset over an empty bar for a window that passed its reset since it was read (3)', () => {
    expect(rows([
      account('default', 'Personal', win(62, -90), win(31, 86_400)),
      account('acct-2', 'Team B', win(12, 0), win(8, 5 * 86_400)),
    ])).toEqual([
      ['Claude · Personal', '5h window · reset', 0],
      ['Claude · Personal', '7d window · 31% used · resets in 1d', 31],
      ['Claude · Team B', '5h window · reset', 0],
      ['Claude · Team B', '7d window · 8% used · resets in 5d', 8],
    ]);
    expect(rows([
      account('default', 'Personal', { usedPercentage: 40, resetsAt: 0 }, win(31, 86_400)),
      account('acct-2', 'Team B', win(12, 3600), win(8, 5 * 86_400)),
    ])[0]).toEqual(['Claude · Personal', '5h window · 40% used', 40]);
  });

  it('gives no rows to an account that has reported nothing yet (4)', () => {
    expect(rows([
      account('default', 'Personal', win(62, 1800), win(31, 86_400)),
      account('acct-2', 'Team B', null, null, null),
    ]).map(r => r[0])).toEqual(['Claude · Personal', 'Claude · Personal']);
  });

  it('keeps Claude\'s two rows as they are with the option off or a single account (5)', () => {
    const asToday = [
      ['Claude', '5h window · 97% used · resets in 30m', 97],
      ['Claude', '7d window · 40% used · resets in 1d', 40],
    ];
    expect(rows(undefined)).toEqual(asToday);
    expect(rows([])).toEqual(asToday);
    expect(rows([account('default', 'Personal', win(5, 1800), win(5, 86_400))])).toEqual(asToday);
  });

  it('adds no Claude spend row beside the accounts\' rows (6)', () => {
    const labels = rows([
      account('default', 'Personal', win(62, 1800), win(31, 86_400)),
      account('acct-2', 'Team B', win(12, 7200), win(8, 86_400)),
    ], [{ provider: 'claude', costUSD: 12 }, { provider: 'codex', costUSD: 3 }]).map(r => r[0]);
    expect(labels.filter(l => l === 'Claude')).toEqual([]);
    expect(labels).toContain('Codex');
  });
});
