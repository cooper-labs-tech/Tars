'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import { PROVIDER_REGISTRY } from '@/lib/providers';
import { ProviderIconRenderer } from '@/components/ui/ProviderBadge';
import { LoadingState } from '@/components/ui';

/**
 * Budget and limits, per provider.
 *
 * The old panel showed Claude's subscription windows and nothing else, so a
 * user on Codex or Gemini saw an empty box telling them to enable a status
 * line. Providers do not share a notion of "quota": a subscription has rolling
 * windows, an API key has spend against whatever budget you set, and a local
 * model has no meter at all. Each row shows the limit that provider actually
 * has, and says so plainly when there is none.
 */

interface RateWindow {
  used_percentage: number;
  resets_at?: number;
}

export interface BudgetRow {
  providerId: string;
  label: string;
  kind: 'subscription' | 'pay-as-you-go' | 'local';
  detail: string;
  /** null when the provider has no meter */
  percent: number | null;
}

/**
 * One Claude account's counters, as `claude:getData` hands them (#277).
 */
export interface AccountWindows {
  accountId: string;
  label: string;
  fiveHour: { usedPercentage: number; resetsAt: number } | null;
  sevenDay: { usedPercentage: number; resetsAt: number } | null;
  updatedAt: number | null;
}

/** Two accounts or more: Claude's rows are theirs. With the option off, or one account, they stay account 1's. */
const perAccount = (accounts?: AccountWindows[]) => (accounts?.length ?? 0) >= 2;

/** How long until a window resets, for one that has not yet: a passed one says reset in its row. */
function humanReset(resetsAt: number | undefined, nowSec: number): string {
  if (!resetsAt) return '';
  const seconds = resetsAt - nowSec;
  // Round to whole minutes first, then carry: rounding the remainder on its
  // own yields "60m" just under the hour, and "1h 60m" just under two.
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `resets in ${Math.round(hours / 24)}d`;
  if (hours > 0) return minutes ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`;
  return `resets in ${minutes}m`;
}

export function buildBudgetRows(opts: {
  rateLimits?: { five_hour?: RateWindow; seven_day?: RateWindow } | null;
  /**
   * Each Claude account in use, in the order of Settings (#277).
   */
  accounts?: AccountWindows[];
  providerSpend: { provider: string; costUSD: number }[];
  budgets: Record<string, number>;
  installed: Record<string, boolean>;
}): BudgetRow[] {
  const rows: BudgetRow[] = [];
  const labelFor = (id: string) => PROVIDER_REGISTRY.find(p => p.id === id)?.label ?? id;
  const nowSec = Date.now() / 1000;

  for (const [key, window] of [
    ['5h window', perAccount(opts.accounts) ? undefined : opts.rateLimits?.five_hour],
    ['7d window', perAccount(opts.accounts) ? undefined : opts.rateLimits?.seven_day],
  ] as const) {
    if (!window) continue;
    // Past its reset the window has started again, and the percentage the last
    // status line recorded is the old window's: it stayed on screen until the
    // next status line, sometimes for hours with no agent running.
    // No reset time (absent, or 0) is unknown, as humanReset reads it, not passed.
    const reset = !!window.resets_at && window.resets_at <= nowSec;
    const pct = reset ? 0 : Math.round(window.used_percentage);
    rows.push({
      providerId: 'claude',
      label: 'Claude',
      kind: 'subscription',
      detail: reset
        ? `${key} · reset`
        : [`${key}`, `${pct}% used`, humanReset(window.resets_at, nowSec)].filter(Boolean).join(' · '),
      percent: pct,
    });
  }
  if (perAccount(opts.accounts)) rows.push(...accountRows(opts.accounts!, nowSec));

  for (const spend of opts.providerSpend) {
    const id = spend.provider;
    if (!id) continue;
    // Already covered by its rate windows, when it has any. Not "any row so
    // far": with no windows, Claude's row vanished whenever another provider
    // had spent more this month and sorted first.
    if (id === 'claude' && rows.some(r => r.providerId === 'claude')) continue;
    if (id === 'local' || id === 'tasmania') {
      // A model running on this machine has no bill and no rate window. Say so:
      // the cell used to hold a bare dash, which reads as missing data.
      rows.push({ providerId: id, label: labelFor(id), kind: 'local', detail: 'not metered', percent: null });
      continue;
    }
    const budget = opts.budgets[id];
    rows.push({
      providerId: id,
      label: labelFor(id),
      kind: 'pay-as-you-go',
      detail: budget
        ? `$${spend.costUSD.toFixed(2)} of $${budget.toFixed(2)} this month`
        : `$${spend.costUSD.toFixed(2)} this month · no budget set`,
      percent: budget ? Math.min(999, Math.round((spend.costUSD / budget) * 100)) : null,
    });
  }

  return rows;
}

/**
 * Each account's 5 h and weekly rows, in the order of Settings, under Claude
 * and the account's name. A window null on an account that has reported is
 * past its reset (#277 leaves it out): it says reset over an empty bar. An
 * account that has reported nothing yet has no rows, as Claude has none
 * before its first status line. Frame: `Usage · limits per account`.
 */
function accountRows(accounts: AccountWindows[], nowSec: number): BudgetRow[] {
  return accounts.flatMap(account => (account.updatedAt === null ? [] : ([
    ['5h window', account.fiveHour],
    ['7d window', account.sevenDay],
  ] as const).map(([key, window]): BudgetRow => {
    // One that passed its reset since it was read is reset too, as Claude's
    // own rows say it: humanReset times a window that has not.
    const reset = !window || (!!window.resetsAt && window.resetsAt <= nowSec);
    const pct = reset ? 0 : Math.round(window.usedPercentage);
    return {
      providerId: 'claude',
      label: `Claude · ${account.label}`,
      kind: 'subscription',
      detail: reset ? `${key} · reset` : [key, `${pct}% used`, humanReset(window.resetsAt, nowSec)].filter(Boolean).join(' · '),
      percent: pct,
    };
  })));
}

/**
 * The monthly ceiling for one provider, edited in place.
 *
 * Deliberately not a Settings page: the number caps the figure printed two
 * lines above it, and sending someone to another screen to type it is how the
 * old copy ended up pointing at a field that was never built. Empty clears it,
 * which is why the value is held as a string while it is being typed.
 */
function BudgetField({
  providerId,
  value,
  onSave,
}: {
  providerId: string;
  value: number | undefined;
  onSave: (providerId: string, monthly: number | null) => void;
}) {
  const [draft, setDraft] = useState(value != null ? String(value) : '');
  const [editing, setEditing] = useState(false);

  // Follow the stored value while the field is idle, so a save elsewhere or a
  // reload does not leave a stale number sitting in the box.
  useEffect(() => {
    if (!editing) setDraft(value != null ? String(value) : '');
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === '') return onSave(providerId, null);
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(value != null ? String(value) : '');
      return;
    }
    onSave(providerId, parsed);
  };

  return (
    <label className="flex items-center gap-2 text-[10.5px] text-text-muted">
      <span>monthly budget</span>
      <span className="flex items-center gap-1">
        <span aria-hidden>$</span>
        <input
          value={draft}
          onChange={e => { setEditing(true); setDraft(e.target.value); }}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.currentTarget.blur(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(value != null ? String(value) : ''); e.currentTarget.blur(); }
          }}
          inputMode="decimal"
          placeholder="none"
          aria-label={`Monthly budget for ${providerId}, in dollars`}
          className="h-[26px] w-20 bg-bg-tertiary px-2 font-mono text-[11px] text-text-primary outline-none focus:ring-1 focus:ring-primary"
        />
      </span>
      <span>{value != null ? 'tracked against this' : 'not tracked until you set one'}</span>
    </label>
  );
}

/**
 * Memoised: a hover on the page's charts redraws none of it. Mounted with the page, so its settings and CLI reads go
 * out beside the transcripts' rather than after them; until their limits come it says so (`Usage · cards while they
 * read`), rather than that no provider has reported one.
 */
export const BudgetAndLimits = memo(function BudgetAndLimits({
  rateLimits,
  accounts,
  providerSpend,
  reading = false,
}: {
  rateLimits?: { five_hour?: RateWindow; seven_day?: RateWindow } | null;
  accounts?: AccountWindows[];
  providerSpend: { provider: string; costUSD: number }[];
  /** The transcripts' read, which brings the limits, still under way. */
  reading?: boolean;
}) {
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [installed, setInstalled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.electronAPI?.appSettings?.get().then(s => {
      if (s?.providerBudgets) setBudgets(s.providerBudgets);
    }).catch(() => undefined);
    window.electronAPI?.cliPaths?.detect?.().then(paths => {
      setInstalled(Object.fromEntries(Object.entries(paths ?? {}).map(([k, v]) => [k, !!v])));
    }).catch(() => undefined);
  }, []);

  /**
   * A budget is set here, on the row that shows the spend it caps. The panel
   * used to say "set a monthly budget in Settings" and there was no such
   * setting anywhere in the app: the value was read through an unchecked cast
   * to a field that did not exist, so it was always empty and the sentence was
   * an instruction nobody could follow.
   */
  const saveBudget = useCallback(async (providerId: string, monthly: number | null) => {
    setBudgets(prev => {
      const next = { ...prev };
      if (monthly === null) delete next[providerId];
      else next[providerId] = monthly;
      window.electronAPI?.appSettings?.save({ providerBudgets: next }).catch(() => undefined);
      return next;
    });
  }, []);

  const rows = useMemo(
    () => buildBudgetRows({ rateLimits, accounts, providerSpend, budgets, installed }),
    [rateLimits, accounts, providerSpend, budgets, installed],
  );

  if (reading) {
    return (
      <div data-loading className="border border-border-primary bg-bg-secondary p-4">
        <LoadingState loading what="Reading each provider's limits…" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="border border-border-primary bg-bg-secondary p-4">
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <Gauge className="w-4 h-4 shrink-0" />
          <p>
            No provider has reported a limit or any spend yet. Run an agent, and its provider
            appears here with whatever limit it actually has.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-border-primary bg-bg-secondary p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="text-[12.5px]">Budget &amp; limits</div>
        {/* The one panel the page's timeframe does not reach: a budget is
            monthly and a rate window is whatever it is right now. */}
        <p className="text-[10.5px] text-text-muted hidden sm:block">
          spend is month to date, windows are live: the timeframe does not apply here
        </p>
      </div>

      <div className="space-y-2">
        {rows.map((row, i) => {
          const icon = PROVIDER_REGISTRY.find(p => p.id === row.providerId)?.icon;
          const over = row.percent !== null && row.percent >= 90;
          return (
            <div key={`${row.providerId}-${i}`} className="border border-border-primary p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {icon && <ProviderIconRenderer icon={icon} className="w-3.5 h-3.5 shrink-0" />}
                  <span className="text-xs font-medium">{row.label}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 bg-bg-tertiary text-text-muted">
                    {row.kind}
                  </span>
                </div>
                <span className={`text-[11px] font-mono ${over ? 'text-accent-red' : 'text-text-secondary'}`}>
                  {row.detail}
                </span>
              </div>

              {row.percent === null ? (
                row.kind === 'local' ? (
                  <p className="text-[10.5px] text-text-muted">no metering: runs on your machine</p>
                ) : (
                  <BudgetField
                    providerId={row.providerId}
                    value={budgets[row.providerId]}
                    onSave={saveBudget}
                  />
                )
              ) : (
                <div className="h-[5px] bg-bg-tertiary">
                  <div
                    className={`h-full ${over ? 'bg-accent-red' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, row.percent)}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
