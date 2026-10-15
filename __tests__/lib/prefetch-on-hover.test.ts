import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Prefetch on sidebar hover (JeanBrasse's speed list, the claude.dev takeaways): what
 * a page reads starts loading while the pointer rests on its sidebar entry, so a
 * click finds it on its way or already in. Only what a store keeps is started:
 * Claude Code's data (src/hooks/useClaude.ts, #233), read by Usage, Projects,
 * Extensions, Agents and Settings. A page without a store would read its data
 * again on mount, a second copy. Written before the code, as the ways it can
 * fail:
 * 1. passing over an entry on the way to another starts a read: the pointer
 *    must rest for the delay first;
 * 2. resting on an entry starts nothing, or starts it for a page that reads
 *    nothing of the store;
 * 3. it reads what the store already holds, or reads while the page's own read
 *    is in flight: never a second copy;
 * 4. moving from one entry to another fires the first, or both.
 */

const reads = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/hooks/useClaude', () => ({
  readClaudeData: vi.fn(async () => { reads.calls += 1; return null; }),
}));

import { readClaudeData } from '../../src/hooks/useClaude';
import { hoverEnd, hoverStart, HOVER_MS } from '../../src/lib/prefetch-on-hover';

beforeEach(() => {
  vi.useFakeTimers();
  reads.calls = 0;
  vi.mocked(readClaudeData).mockClear();
});
afterEach(() => {
  hoverEnd();
  vi.useRealTimers();
});

describe('resting on an entry (1, 2)', () => {
  it('starts nothing when the pointer only passes over it', () => {
    hoverStart('/usage');
    vi.advanceTimersByTime(HOVER_MS - 1);
    hoverEnd();
    vi.advanceTimersByTime(1_000);
    expect(readClaudeData).not.toHaveBeenCalled();
  });

  it.each(['/usage', '/projects', '/skills', '/agents', '/settings'])('starts the store read for %s once the pointer has rested', (href) => {
    hoverStart(href);
    vi.advanceTimersByTime(HOVER_MS);
    expect(readClaudeData).toHaveBeenCalledTimes(1);
  });

  it.each(['/', '/chat', '/kanban', '/crons', '/review', '/logs', '/vault', '/memory', '/whats-new'])('starts nothing for %s, whose page reads nothing of the store', (href) => {
    hoverStart(href);
    vi.advanceTimersByTime(1_000);
    expect(readClaudeData).not.toHaveBeenCalled();
  });
});

describe('one entry at a time (4)', () => {
  it('cancels the entry it leaves for another', () => {
    hoverStart('/usage');
    vi.advanceTimersByTime(HOVER_MS - 10);
    hoverStart('/kanban');
    vi.advanceTimersByTime(1_000);
    expect(readClaudeData).not.toHaveBeenCalled();
  });

  it('fires once for the entry it rests on, not again while it stays', () => {
    hoverStart('/projects');
    vi.advanceTimersByTime(10 * HOVER_MS);
    expect(readClaudeData).toHaveBeenCalledTimes(1);
  });
});
