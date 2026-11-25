import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * What the Usage page can window is what these two channels hand it.
 *
 * The page cuts one window (14 days, 12 weeks or 12 months) from every figure
 * it prints. It can only do that from rows that carry a day, so each source has
 * to arrive per day, already priced, and in a shape whose sums agree with the
 * totals printed beside them. These cases go through the handlers the window
 * calls, `claude:getData` and `usage:by-provider`, with the real scan, the
 * real ledger and the real stats reader underneath, in a temp HOME.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-usage-days-${process.pid}-${Date.now()}`),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.9', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { getClaudeStats, clearClaudeStatsCache } from '../../../electron/services/claude-service';
import { clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';

/** Every dependency is a stub, except the ones named: the stats reader is real. */
function deps(real: Partial<IpcHandlerDependencies>): IpcHandlerDependencies {
  const fn = () => vi.fn() as never;
  return new Proxy({ ...real } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      const value = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : fn();
      target[key] = value;
      return value;
    },
  }) as IpcHandlerDependencies;
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`${channel} was never registered`);
  return handler({}, ...args) as Promise<T>;
}

interface Day {
  date: string;
  tokensByModel: Record<string, number>;
  breakdownByModel?: Record<string, unknown>;
  messagesByModel?: Record<string, number>;
  costUSD?: number;
  costByModel?: Record<string, number>;
}
interface Stats {
  modelUsage: Record<string, { inputTokens: number; costUSD: number }>;
  dailyModelTokens: Day[];
  lastComputedDate?: string;
  [key: string]: unknown;
}
const statsOf = async () => (await call<{ stats: Stats }>('claude:getData')).stats;

const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';

function transcript(name: string, turns: Array<[id: string, model: string, timestamp: string, usage: Record<string, unknown>]>) {
  const dir = path.join(tmpHome, '.claude', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), turns.map(([id, model, timestamp, usage]) => JSON.stringify({
    type: 'assistant', requestId: `req_${id}`, timestamp, message: { id, model, usage },
  })).join('\n'));
}

/** Two days, two models, and cache writes of both lifetimes on the same day. */
function seedTranscripts() {
  transcript('a.jsonl', [
    ['m1', OPUS, '2026-08-20T12:00:00.000Z', {
      input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 4000,
      cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 1000 },
    }],
    ['m2', SONNET, '2026-08-20T13:00:00.000Z', { input_tokens: 2000, output_tokens: 100 }],
    ['m3', OPUS, '2026-08-21T12:00:00.000Z', { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 1_000_000 }],
  ]);
}

beforeAll(() => {
  registerIpcHandlers(deps({ getClaudeStats }));
});

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpHome, '.tars'), { recursive: true });
  clearClaudeStatsCache();
  clearTranscriptUsageCache();
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('claude:getData, per day', () => {
  it('prices every day per model, and the sums agree with the day and with the model', async () => {
    seedTranscripts();

    const stats = await statsOf();
    const days = stats.dailyModelTokens;

    expect(days.map(d => d.date)).toEqual(['2026-08-20', '2026-08-21']);
    for (const day of days) {
      const overModels = Object.values(day.costByModel ?? {}).reduce((s, c) => s + c, 0);
      expect(overModels, day.date).toBeCloseTo(day.costUSD ?? NaN, 12);
    }
    for (const model of [OPUS, SONNET]) {
      const overDays = days.reduce((s, d) => s + (d.costByModel?.[model] ?? 0), 0);
      expect(overDays, model).toBeCloseTo(stats.modelUsage[model].costUSD, 12);
    }
    // The 1h writes at 2x base ($10) and the 5m ones at 1.25x ($6.25), not
    // one rate for the lot: the split this channel exists to carry.
    expect(days[0].costByModel?.[OPUS]).toBeCloseTo(
      1000 * 5e-6 + 400 * 25e-6 + 2000 * 0.5e-6 + 3000 * 10e-6 + 1000 * 6.25e-6, 12,
    );
  });

  /**
   * ~/.claude/stats-cache.json, which Claude Code writes for some accounts,
   * carries per-day input+output tokens and no cost, no cache and no replies.
   * Its presence used to skip the transcripts altogether, so on those machines
   * nothing but the tokens chart could ever follow a window.
   */
  const LEGACY = {
    version: 2,
    lastComputedDate: '2026-08-01',
    dailyActivity: [{ date: '2026-08-01', messageCount: 12, sessionCount: 2, toolCallCount: 5 }],
    dailyModelTokens: [{ date: '2026-08-01', tokensByModel: { [OPUS]: 123_456 } }],
    modelUsage: {
      [OPUS]: {
        inputTokens: 100_000, outputTokens: 23_456, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        webSearchRequests: 0, costUSD: 0, contextWindow: 0,
      },
    },
    totalSessions: 42,
    totalMessages: 420,
    firstSessionDate: '2026-01-01T00:00:00.000Z',
    hourCounts: { 10: 3 },
  };

  function writeLegacyCache() {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'stats-cache.json'), JSON.stringify(LEGACY));
  }

  it('gives the stats-cache.json machine the same days as everyone else when it has transcripts', async () => {
    writeLegacyCache();
    seedTranscripts();

    const stats = await statsOf();

    // Days, tokens and cost from the transcripts...
    expect(stats.dailyModelTokens.map(d => d.date)).toEqual(['2026-08-20', '2026-08-21']);
    for (const day of stats.dailyModelTokens) {
      expect(typeof day.costUSD, day.date).toBe('number');
      expect(Object.keys(day.costByModel ?? {}).length, day.date).toBeGreaterThan(0);
      expect(day.breakdownByModel, day.date).toBeDefined();
      expect(day.messagesByModel, day.date).toBeDefined();
    }
    expect(stats.modelUsage[OPUS].inputTokens).toBe(1500);
    expect(stats.lastComputedDate).toBe('2026-08-21');
    // ...and what only the cache counts, kept.
    expect(stats.totalSessions).toBe(42);
    expect(stats.totalMessages).toBe(420);
    expect(stats.firstSessionDate).toBe(LEGACY.firstSessionDate);
    expect(stats.dailyActivity).toEqual(LEGACY.dailyActivity);
    expect(stats.hourCounts).toEqual({ 10: 3 });
  });

  it('keeps the stats cache as it is when there is no transcript to read', async () => {
    writeLegacyCache();

    expect(await statsOf()).toEqual(LEGACY);
  });
});

describe('usage:by-provider, per day', () => {
  // Tbilisi, UTC+4, so that a local day and a UTC day can disagree: CI runs in UTC.
  const zone = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Asia/Tbilisi'; });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  // And a fixed now, since `sinceDays` counts back from it: without this the
  // rows below fall out of a 30-day window a month after they were written.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  const ledgerLine = (ts: string, provider: string, model: string | undefined, costUSD: number) => JSON.stringify({
    ts, agentId: 'a', provider, ...(model ? { model } : {}),
    inputTokens: 10, outputTokens: 2, cachedReadTokens: 5, cachedWriteTokens: 1, costUSD, transport: 'acp',
  });

  interface ByProvider {
    providers: Array<{ provider: string; costUSD: number; turns: number; inputTokens: number; outputTokens: number }>;
    dailyCost: Record<string, number>;
    daily: Array<{ date: string; provider: string; model: string | null; costUSD: number; turns: number; inputTokens: number; outputTokens: number }>;
    oldest: string | null;
  }

  it('hands over every day of the ledger, keyed by local day, adding up to its totals', async () => {
    expect(new Date('2026-09-21T22:30:00.000Z').getDate()).toBe(22); // the zone took
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    fs.writeFileSync(path.join(tmpHome, '.tars', 'usage-ledger.jsonl'), [
      ledgerLine(old, 'gemini', 'gemini-3-pro', 1000),
      ledgerLine('2026-09-21T22:30:00.000Z', 'codex', 'gpt-9', 1), // 02:30 on the 22nd in Tbilisi
      ledgerLine('2026-09-22T10:00:00.000Z', 'codex', 'gpt-9', 10),
      ledgerLine('2026-09-22T11:00:00.000Z', 'codex', undefined, 100),
    ].join('\n') + '\n');

    const all = await call<ByProvider>('usage:by-provider', {});
    const recent = await call<ByProvider>('usage:by-provider', { sinceDays: 30 });

    const codexDays = all.daily.filter(d => d.provider === 'codex');
    expect(codexDays.map(d => [d.date, d.model, d.turns, d.costUSD])).toEqual([
      ['2026-09-22', null, 1, 100],
      ['2026-09-22', 'gpt-9', 2, 11],
    ]);
    expect(all.daily.some(d => d.date === '2026-09-21')).toBe(false);

    // Whatever sinceDays says: the totals shrink to 30 days, the days do not.
    expect(recent.providers.map(p => p.provider)).toEqual(['codex']);
    expect(all.providers.map(p => p.provider)).toEqual(['gemini', 'codex']);
    // dailyCost keeps its own default of thirty days, as it always had.
    expect(all.dailyCost).toEqual({ '2026-09-22': 111 });
    expect(recent.daily).toEqual(all.daily);
    expect(recent.oldest).toBe(all.oldest);
    expect(all.oldest).toBe(all.daily[0].date);
    expect(all.daily[0].provider).toBe('gemini');

    // And the days add up to the all-time totals the same channel returns.
    for (const totals of all.providers) {
      const rows = all.daily.filter(d => d.provider === totals.provider);
      expect(rows.reduce((s, d) => s + d.turns, 0), totals.provider).toBe(totals.turns);
      expect(rows.reduce((s, d) => s + d.inputTokens, 0), totals.provider).toBe(totals.inputTokens);
      expect(rows.reduce((s, d) => s + d.outputTokens, 0), totals.provider).toBe(totals.outputTokens);
      expect(rows.reduce((s, d) => s + d.costUSD, 0), totals.provider).toBeCloseTo(totals.costUSD, 12);
    }
  });

  it('says there is no first day when nothing was ever recorded', async () => {
    const empty = await call<ByProvider>('usage:by-provider', {});

    expect(empty).toEqual({ providers: [], dailyCost: {}, daily: [], oldest: null, hourly: [] });
  });
});
