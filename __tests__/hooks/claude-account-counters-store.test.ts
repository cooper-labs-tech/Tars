import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from '../components/hook-runtime';
import { useClaude, forgetClaudeData } from '../../src/hooks/useClaude';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../components/hook-runtime')).hooks,
}));

/**
 * Each Claude account's counters reaching the Usage page through useClaude
 * (#277's `accountRateLimits`). Written before the code. How it can fail:
 * 1. useClaude drops the field: the page never sees an account's windows;
 * 2. a poll whose only change is an account's counters is taken for "nothing
 *    changed", so the bars keep the first figures they saw, the defect class
 *    rateLimits once had;
 * 3. over-correction: a poll with the same counters hands the page a new object.
 */

const counters = (pct: number) => [
  { accountId: 'default', label: 'Personal', fiveHour: { usedPercentage: pct, resetsAt: 1_790_900_000 }, sevenDay: null, updatedAt: 1_790_890_000_000 },
  { accountId: 'acct-2', label: 'Team B', fiveHour: null, sevenDay: { usedPercentage: 8, resetsAt: 1_791_000_000 }, updatedAt: 1_790_890_000_000 },
];
const payload = (pct: number) => ({
  settings: null, stats: null, projects: [], plugins: [], skills: [], history: [], activeSessions: [],
  rateLimits: null, tokenStats: null, accountRateLimits: counters(pct),
});

type Api = { claude: { getData: ReturnType<typeof vi.fn> } };
const g = globalThis as unknown as { window?: { electronAPI: Api }; document?: unknown };
let hook: Mount<ReturnType<typeof useClaude>> | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  g.document = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };
  g.window = { electronAPI: { claude: { getData: vi.fn(async () => payload(62)) } } };
  // The window's one store keeps what it read across mounts (#233): each test
  // starts from nothing, as a window does.
  forgetClaudeData();
});
afterEach(() => {
  hook?.unmount();
  hook = null;
  delete g.window;
  delete g.document;
  vi.useRealTimers();
});

describe('useClaude and the accounts\' counters', () => {
  it('hands the page every account\'s counters (1)', async () => {
    hook = mount(() => useClaude());
    await settle();
    expect(hook.result.data?.accountRateLimits).toEqual(counters(62));
  });

  it('passes on a poll whose only change is an account\'s counters (2)', async () => {
    hook = mount(() => useClaude());
    await settle();
    g.window!.electronAPI.claude.getData.mockImplementation(async () => payload(70));
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(hook.result.data?.accountRateLimits?.[0].fiveHour?.usedPercentage).toBe(70);
  });

  it('keeps the same data when the counters have not moved (3)', async () => {
    hook = mount(() => useClaude());
    await settle();
    const before = hook.result.data;
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(g.window!.electronAPI.claude.getData).toHaveBeenCalledTimes(2);
    expect(hook.result.data).toBe(before);
  });
});
