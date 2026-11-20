import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred, type Mount } from '../components/hook-runtime';
import { useClaude, forgetClaudeData } from '../../src/hooks/useClaude';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../components/hook-runtime')).hooks,
}));

/**
 * Claude's data store after a change a page made itself: a skill or a plugin
 * installed from Extensions, whose SkillsTab asks for a refresh once the
 * install's terminal closes. The Audit's and QA's gates of this PR found both
 * defects; QA's check (its scratchpad, r191q/r233) is the first two cases.
 * Written before the fix, as the ways it can fail:
 * 8. a change that only touches the skills, the plugins or Claude's settings
 *    never reaches a page: the store keeps the data it had from one page to
 *    the next, and the comparison that spares an idle poll a render looked at
 *    neither, where the old hook started from nothing on every mount;
 * 9. a refresh asked for while a poll's read is in flight is handed that read,
 *    which may have been answered before the change;
 * 10. over-correction: an idle poll, whose answer is always new objects, hands
 *    the pages a new object anyway; or refreshes asked for during one read
 *    each make a read of their own;
 * 11. a project continued in a session it already had never shows its new
 *    date: the comparison counted each project's sessions and read neither
 *    the project's lastAccessed nor the sessions' times (the Audit's re-gate
 *    of this PR; on main, reopening the Projects page showed it); and an active
 *    session swapped for another at the same count is missed the same way.
 * 12. a time with a fraction, as APFS gives one (a file's mtimeMs read
 *    1790820026452.6458 on this disk), compared raw with the whole
 *    milliseconds a Date keeps, never matches: every idle poll hands the pages
 *    a new object again, which is 10 back (the Audit's second re-gate).
 */

type Api = { claude: { getData: ReturnType<typeof vi.fn> } };
const g = globalThis as unknown as { window?: { electronAPI: Api & Record<string, unknown> }; document?: unknown };
const pages: Mount<ReturnType<typeof useClaude>>[] = [];
type Payload = ReturnType<typeof payload>;
const payload = (skill: string, over: Partial<Record<'plugins' | 'settings' | 'projects', unknown>> = {}) => ({
  settings: null as unknown, stats: null, plugins: [] as unknown[], history: [], activeSessions: [], rateLimits: null, tokenStats: null,
  projects: [] as unknown[],
  skills: [{ name: skill, source: 'user', path: `/skills/${skill}` }],
  ...over,
});
const T1 = new Date(2026, 8, 30, 9, 0, 0).getTime();
const T2 = new Date(2026, 8, 30, 11, 30, 0).getTime();
const project = (sessionAt: number, accessedAt: number) => ({ id: 'p1', path: '/p/one', name: 'one', sessions: [{ id: 's1', timestamp: sessionAt }], lastAccessed: accessedAt });
const plugin = (enabled: boolean) => ({ name: 'review', marketplace: 'tars', fullName: 'review@tars', enabled, installPath: '/p/review', version: '1.0.0', installedAt: '2026-09-28', lastUpdated: '2026-09-28' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0));
  g.document = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };
  g.window = { electronAPI: { claude: { getData: vi.fn(async () => payload('before')) } } };
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

describe('a change that touches only skills, plugins or settings (8)', () => {
  it('shows a skill installed since the last read, on a plain refresh', async () => {
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('after'));
    await p.result.refresh();
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
    expect(p.result.data?.skills[0]?.name).toBe('after');
  });

  it('shows a plugin installed, then turned off, and a change of Claude\'s settings', async () => {
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('before', { plugins: [plugin(true)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.plugins.map(x => x.enabled)).toEqual([true]);
    getData().mockImplementation(async () => payload('before', { plugins: [plugin(false)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.plugins.map(x => x.enabled)).toEqual([false]);
    getData().mockImplementation(async () => payload('before', { plugins: [plugin(false)], settings: { enabledPlugins: { 'review@tars': false } } }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.settings).toEqual({ enabledPlugins: { 'review@tars': false } });
  });
});

describe('a refresh while a read is in flight (9)', () => {
  it('reads again once the read in flight is answered, and shows what the change made', async () => {
    const p = page();
    await settle();
    const inFlight = deferred<Payload>();
    getData().mockImplementationOnce(() => inFlight.promise).mockImplementation(async () => ({ ...payload('after'), projects: [{ id: 'p0', name: 'p0', path: '/p0', sessions: [], lastAccessed: 0 }] }));
    vi.advanceTimersByTime(10_000); // the poll's tick starts a read, which stays in flight
    expect(getData()).toHaveBeenCalledTimes(2);
    const refreshed = p.result.refresh(); // the change happens now, and the page asks for a refresh
    inFlight.resolve(payload('before')); // answered from before the change
    await refreshed;
    await settle();
    expect(p.result.data?.skills[0]?.name).toBe('after');
    expect(getData()).toHaveBeenCalledTimes(3);
  });
});

describe('no more work than the change needs (10)', () => {
  it('hands back the same data when an idle poll finds the same skills, plugins and settings', async () => {
    getData().mockImplementation(async () => payload('same', { plugins: [plugin(true)], settings: { enabledPlugins: { 'review@tars': true } } }));
    const p = page();
    await settle();
    const before = p.result.data;
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
    expect(p.result.data).toBe(before);
  });

  it('makes one read more for refreshes asked during one read, and one read for a refresh with none in flight', async () => {
    const p = page();
    await settle();
    const inFlight = deferred<Payload>();
    getData().mockImplementationOnce(() => inFlight.promise).mockImplementation(async () => payload('after'));
    vi.advanceTimersByTime(10_000);
    const both = [p.result.refresh(), p.result.refresh()];
    inFlight.resolve(payload('before'));
    await Promise.all(both);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(3);
    await p.result.refresh();
    await settle();
    expect(getData()).toHaveBeenCalledTimes(4);
  });
});

describe('a project continued in a session it already had (11)', () => {
  it('shows the project\'s new date and the session\'s new time', async () => {
    getData().mockImplementation(async () => payload('same', { projects: [project(T1, T1)] }));
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('same', { projects: [project(T2, T2)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.projects[0].lastActivity.getTime()).toBe(T2);
    expect(p.result.data?.projects[0].sessions[0].lastActivity.getTime()).toBe(T2);
  });

  it('shows a session\'s new time when only the session moved', async () => {
    getData().mockImplementation(async () => payload('same', { projects: [project(T1, T2)] }));
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('same', { projects: [project(T2, T2)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.projects[0].sessions[0].lastActivity.getTime()).toBe(T2);
  });

  // Added after the fix, from its mutants: the date of the project alone had no case.
  it('shows the project\'s new date when only the project\'s date moved', async () => {
    getData().mockImplementation(async () => payload('same', { projects: [project(T1, T1)] }));
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('same', { projects: [project(T1, T2)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.projects[0].lastActivity.getTime()).toBe(T2);
  });

  it('shows an active session swapped for another at the same count', async () => {
    getData().mockImplementation(async () => ({ ...payload('same'), activeSessions: ['s1'] }));
    const p = page();
    await settle();
    getData().mockImplementation(async () => ({ ...payload('same'), activeSessions: ['s2'] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.activeSessions).toEqual(['s2']);
  });

  it('hands back the same data when an idle poll finds the same projects at the same dates (10)', async () => {
    getData().mockImplementation(async () => ({ ...payload('same', { projects: [project(T1, T2)] }), activeSessions: ['s1'] }));
    const p = page();
    await settle();
    const before = p.result.data;
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
    expect(p.result.data).toBe(before);
  });
});

describe('times with a fraction, as APFS gives them (12)', () => {
  // Above and below a half, so rounding where a Date truncates shows too.
  const F1 = T1 + 0.6458;
  const F2 = T2 + 0.2917;

  it('hands back the same data when an idle poll finds the same fractional times', async () => {
    getData().mockImplementation(async () => payload('same', { projects: [project(F1, F2)] }));
    const p = page();
    await settle();
    const before = p.result.data;
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(getData()).toHaveBeenCalledTimes(2);
    expect(p.result.data).toBe(before);
  });

  it('still shows a project\'s date that alone moved by a whole millisecond', async () => {
    getData().mockImplementation(async () => payload('same', { projects: [project(F1, F1)] }));
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('same', { projects: [project(F1, F1 + 1)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.projects[0].lastActivity.getTime()).toBe(T1 + 1);
  });

  it('still shows a session\'s time that alone moved by a whole millisecond', async () => {
    getData().mockImplementation(async () => payload('same', { projects: [project(F1, F2)] }));
    const p = page();
    await settle();
    getData().mockImplementation(async () => payload('same', { projects: [project(F1 + 1, F2)] }));
    await p.result.refresh();
    await settle();
    expect(p.result.data?.projects[0].sessions[0].lastActivity.getTime()).toBe(T1 + 1);
  });
});
