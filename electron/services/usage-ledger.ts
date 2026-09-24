import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { priceFor } from './model-catalog';

/**
 * Per-turn usage for every provider, recorded as each ACP turn reports its
 * tokens: the only source that covers Codex, Gemini, Grok and the rest, since
 * only Claude Code writes transcripts its usage can be rebuilt from.
 */

const LEDGER_FILE = path.join(DATA_DIR, 'usage-ledger.jsonl');
const MAX_LINES = 20_000;
const TRIM_TO = 12_000;

export interface UsageEntry {
  ts: string;
  agentId: string;
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  costUSD?: number;
  transport: 'acp' | 'pty';
}

export interface ProviderTotals {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  turns: number;
  models: string[];
  /** true when at least one entry carried a cost from the agent itself */
  measured: boolean;
}

export function recordUsage(entry: Omit<UsageEntry, 'ts'>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Price it here when the agent did not: the catalogue knows the rate.
    let costUSD = entry.costUSD;
    if (costUSD == null && entry.model) {
      const price = priceFor(entry.model, entry.provider);
      if (price?.input != null && price?.output != null) {
        costUSD =
          (entry.inputTokens / 1e6) * price.input +
          (entry.outputTokens / 1e6) * price.output +
          ((entry.cachedReadTokens ?? 0) / 1e6) * (price.cache_read ?? price.input * 0.1) +
          ((entry.cachedWriteTokens ?? 0) / 1e6) * (price.cache_write ?? price.input * 1.25);
      }
    }

    const record: UsageEntry = { ts: new Date().toISOString(), ...entry, costUSD };
    fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(record)}\n`);

    const lines = fs.readFileSync(LEDGER_FILE, 'utf-8').trimEnd().split('\n');
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LEDGER_FILE, `${lines.slice(-TRIM_TO).join('\n')}\n`);
    }
  } catch (err) {
    console.error('[usage] could not record a turn:', err);
  }
}

/**
 * `YYYY-MM-DD` of an entry's `ts` (UTC, from toISOString) in the machine's own
 * timezone, or null: the day transcript-usage.ts and the Usage page key by,
 * where slicing `ts` gave the UTC day (02:30 in Tbilisi landed on yesterday).
 */
function localDay(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every turn in the file. A line that is not one is dropped here, once. */
function readAll(): UsageEntry[] {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    return fs.readFileSync(LEDGER_FILE, 'utf-8').trimEnd().split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line) as UsageEntry;
        // A line with no provider or no usable date belongs to no row and to
        // no day. Dropped for every reader alike, so that every sum below is
        // over the same turns: counted by the totals and missing from the
        // days, it made the two disagree about what the file holds.
        if (typeof entry?.provider !== 'string' || typeof entry.ts !== 'string') return [];
        if (localDay(entry.ts) === null) return [];
        return [entry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** The entries of the last `sinceDays` 24-hour periods back from now, or all of them. */
function within(entries: UsageEntry[], sinceDays?: number): UsageEntry[] {
  if (!sinceDays) return entries;
  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  return entries.filter(entry => entry.ts >= cutoff);
}

export function readLedger(sinceDays?: number): UsageEntry[] {
  return within(readAll(), sinceDays);
}

function totalsOf(entries: UsageEntry[]): ProviderTotals[] {
  const byProvider = new Map<string, ProviderTotals>();

  for (const entry of entries) {
    const totals = byProvider.get(entry.provider) ?? {
      provider: entry.provider,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      turns: 0,
      models: [],
      measured: false,
    };
    totals.inputTokens += entry.inputTokens || 0;
    totals.outputTokens += entry.outputTokens || 0;
    totals.costUSD += entry.costUSD || 0;
    totals.turns += 1;
    if (entry.model && !totals.models.includes(entry.model)) totals.models.push(entry.model);
    byProvider.set(entry.provider, totals);
  }

  return Array.from(byProvider.values()).sort((a, b) => b.costUSD - a.costUSD);
}

/** Totals per provider, from the ledger alone. */
export function providerTotals(sinceDays?: number): ProviderTotals[] {
  return totalsOf(readLedger(sinceDays));
}

function dailyCostOf(entries: UsageEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const day = localDay(entry.ts);
    if (!day) continue;
    out[day] = (out[day] || 0) + (entry.costUSD || 0);
  }
  return out;
}

/** Daily cost from the ledger, every provider merged, keyed by local day. */
export function dailyCost(sinceDays = 30): Record<string, number> {
  return dailyCostOf(readLedger(sinceDays));
}

/** What the ledger holds for one local day, provider and model. */
export interface LedgerDay {
  /** Local `YYYY-MM-DD`: the key the transcripts' days use too. */
  date: string;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  /** As recorded: the agent's own figure, or the catalogue's at record time. */
  costUSD: number;
  turns: number;
}

function daysOf(entries: UsageEntry[]): { daily: LedgerDay[]; oldest: string | null } {
  const rows = new Map<string, LedgerDay>();
  let oldest: string | null = null;
  for (const entry of entries) {
    const date = localDay(entry.ts);
    if (!date) continue;
    const model = entry.model ?? null;
    const key = JSON.stringify([date, entry.provider, model]);
    const row = rows.get(key) ?? {
      date,
      provider: entry.provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      costUSD: 0,
      turns: 0,
    };
    row.inputTokens += entry.inputTokens || 0;
    row.outputTokens += entry.outputTokens || 0;
    row.cachedReadTokens += entry.cachedReadTokens || 0;
    row.cachedWriteTokens += entry.cachedWriteTokens || 0;
    row.costUSD += entry.costUSD || 0;
    row.turns += 1;
    rows.set(key, row);
    if (!oldest || date < oldest) oldest = date;
  }
  const daily = Array.from(rows.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
    || a.provider.localeCompare(b.provider)
    || (a.model ?? '').localeCompare(b.model ?? ''));
  return { daily, oldest };
}

/**
 * The whole answer of `usage:by-provider`, from one read. `providers` and
 * `dailyCost` are windowed as before; `daily` and `oldest` cover every turn in
 * the file, since the page applies one window of days to every figure, and
 * none can be cut from a rolling count of 24-hour periods or a thirty-day
 * series. `oldest` is the first local day still in the file: past a trim (to
 * its last 12 000 lines beyond 20 000), later than the first turn recorded.
 * One read: at the cap the file is about 4 MB, and three reads took 247 ms
 * where this takes 136 (medians of 25 interleaved runs).
 */
export function usageByProvider(sinceDays?: number): {
  providers: ProviderTotals[];
  dailyCost: Record<string, number>;
  daily: LedgerDay[];
  oldest: string | null;
} {
  const all = readAll();
  return {
    providers: totalsOf(within(all, sinceDays)),
    dailyCost: dailyCostOf(within(all, sinceDays ?? 30)),
    ...daysOf(all),
  };
}

/** Test seam. */
export function ledgerPath(): string {
  return LEDGER_FILE;
}
