import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred, type Mount } from '../components/hook-runtime';
import { useClaude, readClaudeData, forgetClaudeData } from '../../src/hooks/useClaude';
import { useSettings } from '../../src/hooks/useSettings';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../components/hook-runtime')).hooks,
}));

/**
 * Claude Code's data in the window: one store for every page instead of a
 * claude:getData per page (JeanBrasse's speed list, the renderer's side). The pages
 * that read it are Usage, Projects, Extensions (skills and plugins), Agents,
 * Settings (its skills) and Brain's agents graph. Main keeps its answer a
 * minute (STATS_TTL_MS, the transcript scan's CACHE_TTL); past that, the next
 * read is a whole scan, 2656 to 3270 ms on JeanBrasse's machine. Written before the
 * store, as the ways it can fail:
 * 1. every page asks main again: two pages mounted together, or one after the
 *    other within a poll, make two reads where one answer serves both;
 * 2. a page that comes back after the data was read shows its loading state
 *    and waits for main again, instead of what is known;
 * 3. showing what is known, it never reads again: data older than a poll is
 *    shown and not refreshed behind it;
 * 4. each page polls on its own, a poll runs with no page open, or while the
 *    window is hidden;
 * 5. a poll that changes nothing hands the pages a new object (the old hook's
 *    comparison, kept);
 * 6. a failed first read shows no error, or a failed read after data arrived
 *    blanks the page;
 * 7. Settings waits for Claude's data before it shows anything, when all it
 *    takes from it is the skills list; or it asks for that data first, and a
 *    whole transcript scan in main runs ahead of the settings it shows.
 */

type Api = { claude: { getData: ReturnType<typeof vi.fn> } };
const g = globalThis as unknown as { window?: { electronAPI: Api & Record<string, unknown> }; document?: unknown };
const pages: Mount<ReturnType<typeof useClaude>>[] = [];
let visibility: 'visible' | 'hidden' = 'visible';
const payload = (n: number) => ({
  settings: null, stats: null, plugins: [], history: [], activeSessions: [], rateLimits: null, tokenStats: null,
  skills: [{ name: `skill-${n}`, source: 'user', path: `/skills/${n}` }],
  projects: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `p${i}`, path: `/p${i}`, sessions: [], lastAccessed: 0 })),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(2026, 8, 28, 12, 0, 0));
  visibility = 'visible';
  g.document = { get visibilityState() { return visibility; }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  g.window = { electronAPI: { claude: { getData: vi.fn(async () => payload(1)) } } };
  forgetClaudeData();
});
afterEach(() => {
  while (pages.length) pages.pop()!.unmount();
  delete g.window;
  delete g.document;
  vi.useRealTimers();
});

const getData = () => g.window!.electronAPI.claude.getData;
const page = () => { const p = mount(() => useClaude()); pages.push(p); return p; };
const leave = (p: Mount<unknown>) => { p.unmount(); pages.splice(pages.indexOf(p as never), 1); };
const later = (ms: number) => vi.advanceTimersByTime(ms);

describe('one answer for every page (1)', () => {
  it('reads once for two pages opened together', async () => {
    const answer = deferred<ReturnType<typeof payload>>();
    getData().mockImplementation(() => answer.promise);
    const a = page();
    const b = page();
    answer.resolve(payload(2));
    await settle();
    expect(getData()).toHaveBeenCalledTimes(1);
    expect(a.result.data?.projects).toHaveLength(2);
    expect(b.result.data?.projects).toHaveLength(2);
  });

  it('reads once for a page opened after another, within a poll', async () => {
    leave(page());
    await settle();
    later(3_000);
    page();
    await settle();
    expect(getData()).toHaveBeenCalledTimes(1);
  });
});

describe('what is known shows at once (2, 3)', () => {
  it('shows the data a page read before, with no loading state, on its first render', async () => {
    leave(page());
    await settle();
    const b = page();
    expect(b.result.loading).toBe(false);
    expect(b.result.data?.projects).toHaveLength(1);
  });

  it('past a poll, shows what is known at once and reads again behind it', async () => {
    leave(page());
    await settle();
    later(70_000);
    const answer = deferred<ReturnType<typeof payload>>();
    getData().mockImplementation(() => answer.promise);
    const b = page();
    expect(b.result.loading).toBe(false);
    expect(b.result.data?.projects).toHaveLength(1);
    expect(getData()).toHaveBeenCalledTimes(2);
    answer.resolve(payload(3));
    await settle();
    expect(b.result.data?.projects).toHaveLength(3);
  });

  it('reads through readClaudeData what the pages read, once', async () => {
    const [a, b] = await Promise.all([readClaudeData(), readClaudeData()]);
    expect(a).toBe(b);
    page();
    await settle();
    expect(getData()).toHaveBeenCalledTimes(1);
  });
});

describe('one poll (4, 5)', () => {
  it('polls once every ten seconds for all the pages, and not at all with none open', async () => {
    const a = page();
    const b = page();
    await settle();
    expect(getData()).toHaveBeenCalledTimes(1);
    later(10_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
    leave(a);
    leave(b);
    later(60_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the window is hidden', async () => {
    page();
    await settle();
    visibility = 'hidden';
    later(30_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(1);
  });

  it('hands back the same data when a poll changes nothing', async () => {
    const a = page();
    await settle();
    const before = a.result.data;
    later(10_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
    expect(a.result.data).toBe(before);
  });
});

describe('failures (6)', () => {
  it('shows the error of a first read that fails', async () => {
    getData().mockImplementation(async () => { throw new Error('main is busy'); });
    const a = page();
    await settle();
    expect(a.result).toMatchObject({ data: null, loading: false, error: 'main is busy' });
  });

  it('keeps the data it has when a later read fails', async () => {
    const a = page();
    await settle();
    getData().mockImplementation(async () => { throw new Error('main is busy'); });
    later(10_000);
    await settle();
    expect(a.result.data?.projects).toHaveLength(1);
  });
});

describe('Settings does not wait for it (7)', () => {
  it("shows its settings before Claude's data arrives, and its skills when it does", async () => {
    const answer = deferred<ReturnType<typeof payload>>();
    getData().mockImplementation(() => answer.promise);
    Object.assign(g.window!.electronAPI, {
      settings: { get: vi.fn(async () => ({ includeCoAuthoredBy: true })), getInfo: vi.fn(async () => ({ claudeVersion: '2' })) },
      appSettings: { get: vi.fn(async () => ({})), onUpdated: vi.fn(() => () => {}) },
    });
    const settings = mount(() => useSettings());
    pages.push(settings as never);
    await settle();
    expect(settings.result.loading).toBe(false);
    expect(settings.result.settings).toMatchObject({ includeCoAuthoredBy: true });
    expect(settings.result.skills).toEqual([]);
    answer.resolve(payload(1));
    await settle();
    expect(settings.result.skills.map(s => s.name)).toEqual(['skill-1']);
  });

  it('asks main for its own settings first, and for Claude\'s data only once they are in', async () => {
    const order: string[] = [];
    const held = deferred<unknown>();
    getData().mockImplementation(async () => { order.push('claude:getData'); return payload(1); });
    Object.assign(g.window!.electronAPI, {
      settings: {
        get: vi.fn(async () => { order.push('settings:get'); return held.promise; }),
        getInfo: vi.fn(async () => { order.push('settings:getInfo'); return { claudeVersion: '2' }; }),
      },
      appSettings: { get: vi.fn(async () => { order.push('app:getSettings'); return {}; }), onUpdated: vi.fn(() => () => {}) },
    });
    const settings = mount(() => useSettings());
    pages.push(settings as never);
    await settle();
    expect(order).not.toContain('claude:getData');
    held.resolve({ includeCoAuthoredBy: true });
    await settle();
    expect(order.at(-1)).toBe('claude:getData');
    expect(settings.result.skills.map(s => s.name)).toEqual(['skill-1']);
  });
});
