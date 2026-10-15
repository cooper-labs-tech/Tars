import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Usage page's claude:getData, served from what the scan last found.
 *
 * The first claude:getData after a launch waited for the whole transcript scan:
 * 2.4 to 3 s on JeanBrasse's 1826 transcripts (the Frontend's harness of #233), and
 * each one after the minute's memo ran out waited again. The scan starts at
 * launch now, and the page is handed the last numbers at once while a stale
 * memo is refreshed behind it: its poll, every 10 s, picks the new ones up.
 * The bots' /stats still get numbers no older than the minute.
 *
 * How it can fail, written before the code:
 * 1. nothing starts the scan at launch, so the first page still waits for all of it;
 * 2. with nothing computed yet, the page is handed nothing instead of the scan
 *    under way;
 * 3. a memo younger than the minute is computed again;
 * 4. a stale memo makes the page wait for the refresh;
 * 5. the stale numbers are served and never refreshed, or each poll starts a
 *    refresh of its own;
 * 6. a refresh that fails drops the numbers the page had, or leaves no refresh
 *    possible after it;
 * 7. /stats on a bot is handed numbers older than the minute;
 * 8. the launch's scan is priced with a catalogue the app replaces a moment
 *    later: loadCatalog installs its fresh disk copy as it is called, and a
 *    scan started before it saw another object, so the first minute past it
 *    scanned everything again (measured in the app: the first expired visit's
 *    claude:getData 185 ms, the reads it holds sharing the loop with that scan).
 *
 * The scan itself is a stand-in here, one that answers when a case says so:
 * what is under test is who waits for it and who does not.
 */

interface Deferred { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

const scans = vi.hoisted(() => ({ list: [] as Array<{ promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> }));

vi.mock('../../../electron/services/transcript-usage', () => ({
  // Each call a scan of its own, so a caller that should have joined the one
  // under way shows up as a second scan.
  computeTranscriptUsage: vi.fn(() => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    scans.list.push({ promise, resolve, reject } satisfies Deferred);
    return promise;
  }),
}));

function usage(input: number) {
  return {
    modelUsage: { 'claude-opus-5': { inputTokens: input, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation1hTokens: 0, cacheCreation5mTokens: 0, webSearchRequests: 0, costUSD: input / 1e6 } },
    dailyModelTokens: [],
    lastComputedDate: '2026-09-28',
    unreadable: 0,
  };
}

type Service = typeof import('../../../electron/services/claude-service');
let service: Service;
let now: number;

beforeEach(async () => {
  scans.list.length = 0;
  now = Date.parse('2026-09-28T04:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.resetModules();
  service = await import('../../../electron/services/claude-service');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const inputOf = (stats: unknown) => (stats as { modelUsage: Record<string, { inputTokens: number }> } | null)?.modelUsage['claude-opus-5'].inputTokens;

/** What a call gives within 50 ms, or 'waited'. */
async function atOnce<T>(p: Promise<T>): Promise<T | 'waited'> {
  return Promise.race([p, new Promise<'waited'>(resolve => setTimeout(() => resolve('waited'), 50))]);
}

async function settled() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

describe("the page's stats", () => {
  it('1, 2. start being computed at launch, and the first page is handed that scan when it ends', async () => {
    service.prewarmClaudeStats();
    expect(scans.list).toHaveLength(1);

    const first = service.getClaudeStatsNow();
    expect(await atOnce(first)).toBe('waited');

    scans.list[0].resolve(usage(1));
    expect(inputOf(await first)).toBe(1);
    expect(scans.list).toHaveLength(1);
  });

  it('3. younger than the minute, are served as they are', async () => {
    service.prewarmClaudeStats();
    scans.list[0].resolve(usage(1));
    await settled();

    now += 59_000;
    expect(inputOf(await atOnce(service.getClaudeStatsNow()))).toBe(1);
    expect(scans.list).toHaveLength(1);
  });

  it('4, 5. older than the minute, are served at once, and one refresh starts whatever the polls', async () => {
    service.prewarmClaudeStats();
    scans.list[0].resolve(usage(1));
    await settled();

    now += 61_000;
    for (let i = 0; i < 5; i++) expect(inputOf(await atOnce(service.getClaudeStatsNow()))).toBe(1);
    expect(scans.list).toHaveLength(2);

    scans.list[1].resolve(usage(2));
    await settled();
    expect(inputOf(await atOnce(service.getClaudeStatsNow()))).toBe(2);
    expect(scans.list).toHaveLength(2);
  });

  it('6. keep the last numbers when a refresh fails, and the next stale poll tries again', async () => {
    service.prewarmClaudeStats();
    scans.list[0].resolve(usage(1));
    await settled();

    now += 61_000;
    expect(inputOf(await atOnce(service.getClaudeStatsNow()))).toBe(1);
    scans.list[1].reject(new Error('the disk went away'));
    await settled();

    expect(inputOf(await atOnce(service.getClaudeStatsNow()))).toBe(1);
    expect(scans.list).toHaveLength(3);
    scans.list[2].resolve(usage(3));
    await settled();
    expect(inputOf(await atOnce(service.getClaudeStatsNow()))).toBe(3);
  });
});

describe("the bots' /stats", () => {
  it('7. wait for numbers no older than the minute', async () => {
    service.prewarmClaudeStats();
    scans.list[0].resolve(usage(1));
    await settled();

    now += 61_000;
    const fresh = service.getClaudeStats();
    expect(await atOnce(fresh)).toBe('waited');
    scans.list[1].resolve(usage(2));
    expect(inputOf(await fresh)).toBe(2);
  });
});

describe('main.ts', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../../electron/main.ts'), 'utf-8');

  it('8. starts the scan after the catalogue has installed its copy on disk', () => {
    const ready = main.indexOf('app.whenReady()');
    const catalogue = main.indexOf('loadCatalog()', ready);
    expect(catalogue).toBeGreaterThan(ready);
    expect(main.indexOf('prewarmClaudeStats()', ready)).toBeGreaterThan(catalogue);
  });

  it('1. starts the scan once the app is ready, hands the page the stats at once, and the bots fresh ones', () => {
    const ready = main.indexOf('app.whenReady()');
    const prewarm = main.indexOf('prewarmClaudeStats()');
    expect(prewarm).toBeGreaterThan(ready);
    expect(main).toMatch(/getClaudeStats: getClaudeStatsNow,/);
    const telegram = /initTelegramBotService\(([\s\S]*?)\n  \);/.exec(main)?.[1] ?? '';
    expect(telegram).toMatch(/\bgetClaudeStats,/);
    expect(telegram).not.toMatch(/getClaudeStatsNow/);
  });
});
