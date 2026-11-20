import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forgetClaudeData, readClaudeData } from '../../src/hooks/useClaude';
import { hoverEnd, hoverStart, HOVER_MS } from '../../src/lib/prefetch-on-hover';

/**
 * The same, through the real store: a rest on an entry reads Claude's data at
 * most once, and never what the store already holds or is already reading
 * (failure 3 of prefetch-on-hover.test.ts).
 */

const g = globalThis as unknown as { window?: unknown };
let getData: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  getData = vi.fn(async () => ({ projects: [], skills: [], plugins: [], history: [], activeSessions: [] }));
  g.window = { electronAPI: { claude: { getData } } };
  forgetClaudeData();
});
afterEach(() => {
  hoverEnd();
  delete g.window;
  vi.useRealTimers();
});

describe('never a second copy (3)', () => {
  it('reads once for a rest, and not again for a rest while the data is fresh', async () => {
    hoverStart('/usage');
    await vi.advanceTimersByTimeAsync(HOVER_MS);
    expect(getData).toHaveBeenCalledTimes(1);
    hoverStart('/projects');
    await vi.advanceTimersByTimeAsync(HOVER_MS);
    expect(getData).toHaveBeenCalledTimes(1);
  });

  it('shares the read a page started, rather than starting another', async () => {
    const page = readClaudeData();
    hoverStart('/skills');
    await vi.advanceTimersByTimeAsync(HOVER_MS);
    await page;
    expect(getData).toHaveBeenCalledTimes(1);
  });
});
