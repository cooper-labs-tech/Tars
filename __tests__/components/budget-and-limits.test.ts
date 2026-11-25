import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { buildBudgetRows } from '../../src/components/Usage/BudgetAndLimits';

/**
 * The point of this panel is that it is honest per provider: a subscription
 * has windows, an API key has spend against a budget, and a local model has no
 * meter at all. The old one only understood the first case.
 *
 * And honest about time: a window whose reset time has passed has started
 * again, so the percentage the last status line recorded belongs to the old
 * one. It kept showing, "97% used · resetting", until the next status line,
 * sometimes for hours with no agent running (the Audit's
 * AUDIT-USAGE-COMPTES.md, gap 7). Written before the fix, as the way it fails:
 * a window past its reset shows its old percentage and "resetting", or its
 * bar stays full, or a window still running is taken for reset.
 */

describe('buildBudgetRows', () => {
  const base = { budgets: {}, installed: {}, providerSpend: [] };

  it('turns Claude subscription windows into rows', () => {
    const rows = buildBudgetRows({
      ...base,
      rateLimits: {
        five_hour: { used_percentage: 62.4, resets_at: Date.now() / 1000 + 3600 },
        seven_day: { used_percentage: 31 },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('subscription');
    expect(rows[0].percent).toBe(62);
    expect(rows[0].detail).toContain('5h window');
    expect(rows[0].detail).toContain('resets in 1h');
    expect(rows[1].detail).toContain('7d window');
  });

  it('shows spend against a budget when one is set', () => {
    const rows = buildBudgetRows({
      ...base,
      rateLimits: null,
      providerSpend: [{ provider: 'codex', costUSD: 18.4 }],
      budgets: { codex: 50 },
    });

    expect(rows[0]).toMatchObject({ kind: 'pay-as-you-go', percent: 37 });
    expect(rows[0].detail).toBe('$18.40 of $50.00 this month');
  });

  it('reports spend without a bar when no budget is set', () => {
    const rows = buildBudgetRows({
      ...base,
      rateLimits: null,
      providerSpend: [{ provider: 'gemini', costUSD: 4.1 }],
    });

    expect(rows[0].percent).toBeNull();
    expect(rows[0].detail).toContain('no budget set');
  });

  it('says a local model is not metered rather than showing zero', () => {
    const rows = buildBudgetRows({
      ...base,
      rateLimits: null,
      providerSpend: [{ provider: 'local', costUSD: 0 }],
    });

    expect(rows[0]).toMatchObject({ kind: 'local', percent: null, detail: 'not metered' });
  });

  it('does not list Claude twice when it already has windows', () => {
    const rows = buildBudgetRows({
      ...base,
      rateLimits: { five_hour: { used_percentage: 10 } },
      providerSpend: [{ provider: 'claude', costUSD: 900 }, { provider: 'codex', costUSD: 1 }],
    });

    expect(rows.filter(r => r.providerId === 'claude')).toHaveLength(1);
    expect(rows.some(r => r.providerId === 'codex')).toBe(true);
  });

  it('says a window past its reset is reset, with an empty bar, and leaves a running one alone', () => {
    const now = Date.now() / 1000;
    const rows = buildBudgetRows({
      ...base,
      rateLimits: {
        five_hour: { used_percentage: 97, resets_at: now - 60 },
        seven_day: { used_percentage: 31, resets_at: now + 3 * 86_400 },
      },
    });
    expect(rows[0]).toMatchObject({ percent: 0, detail: '5h window · reset' });
    expect(rows[1].percent).toBe(31);
    expect(rows[1].detail).toBe('7d window · 31% used · resets in 3d');
  });

  it('is empty when nothing has reported anything', () => {
    expect(buildBudgetRows({ ...base, rateLimits: null })).toEqual([]);
  });
});
