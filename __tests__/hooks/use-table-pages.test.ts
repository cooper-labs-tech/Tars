import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '../components/hook-runtime';
import { useTablePages } from '../../src/hooks/useTablePages';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../components/hook-runtime')).hooks,
}));

/**
 * useTablePages: the page and the rows a page of one of Usage's three tables (#467, the Audit's L2). Frames:
 * `Usage · pages · notes`. Its callers put the timeframe, the project, the agent picked and the sort in the reset key
 * (TaskCosts.tsx), and the By task / By agent switch unmounts the agents table.
 *
 * Every way it can fail, written down first and each seen red on a mutant of the hook (the PR's bench):
 * 1. the rows choice kept for the card is not read once mounted, so a card kept at ten opens at five;
 * 2. a remembered value that is not one of the four, or a storage that refuses, gives anything but five, or throws;
 * 3. a rows choice is not kept for its card, is kept for another card, or leaves the table on the page it was on;
 * 4. a new sort, project, timeframe or agent picked (the reset key) leaves the table on the page it was on;
 * 5. the By task / By agent switch, which remounts the table, comes back on the page it was on or forgets the rows;
 * 6. new figures with fewer rows leave a page past the last, or move off the page shown when it still exists;
 * 7. previous and next step from a page past the last rather than from the page shown;
 * 8. an empty table has a page other than 1 of 1.
 */

const KEY = 'usage.rows.agents';
type Props = { key: string; reset: string; total: number };

let store: Map<string, string>;
let refuse: boolean;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  store = new Map();
  refuse = false;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => { if (refuse) throw new Error('storage refused'); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (refuse) throw new Error('storage refused'); store.set(k, v); },
    },
  };
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** A table: its props, changed between renders as its caller's would be. */
function table(props: Partial<Props> & { total: number }) {
  const p: Props = { key: KEY, reset: 'r0', ...props };
  const m = mount(() => useTablePages(p.key, p.reset, p.total));
  return { p, m, get v() { return m.result; } };
}

/** The reset key as TaskCosts builds it for the agents table: timeframe, project, agent picked, then the sort. */
const resetKey = (o: { from?: number; project?: string; agent?: string; sort?: string; dir?: string } = {}) =>
  `${o.from ?? 1}|${o.project ?? ''}|${o.agent ?? ''}|${o.sort ?? ''}|${o.dir ?? ''}`;

describe('useTablePages', () => {
  it('reads the rows choice kept for its card once mounted (1)', () => {
    store.set(KEY, '10');
    const t = table({ total: 23 });
    expect(t.v.size).toBe(10);
    expect(t.v.last).toBe(3);
    expect(t.v.page).toBe(1);
  });

  it('gives five for anything else kept, and for a storage that refuses, without throwing (2)', () => {
    for (const kept of ['7', 'abc', '-5', '10.0', '']) {
      store.set(KEY, kept);
      expect(table({ total: 23 }).v.size).toBe(5);
    }
    refuse = true;
    const t = table({ total: 23 });
    expect(t.v.size).toBe(5);
    expect(() => t.v.pickSize(25)).not.toThrow();
    expect(t.v.size).toBe(25);
  });

  it('keeps a rows choice for its own card and goes back to page 1 (3)', () => {
    store.set('usage.rows.perAgent', '50');
    const t = table({ total: 23 });
    t.v.goTo(3);
    expect(t.v.page).toBe(3);
    t.v.pickSize(10);
    expect(t.v.size).toBe(10);
    expect(t.v.page).toBe(1);
    expect(t.v.last).toBe(3);
    expect(store.get(KEY)).toBe('10');
    expect(store.get('usage.rows.perAgent')).toBe('50');
  });

  it('goes back to page 1 on a new sort, project, timeframe or agent picked (4)', () => {
    const changes = [{ sort: 'tokens', dir: 'desc' }, { project: '/p/site' }, { from: 2 }, { agent: 'a03' }];
    for (const change of changes) {
      const t = table({ total: 23, reset: resetKey() });
      t.v.goTo(4);
      expect(t.v.page).toBe(4);
      t.p.reset = resetKey(change);
      t.m.rerender();
      expect(t.v.page, JSON.stringify(change)).toBe(1);
    }
  });

  it('comes back from the By task / By agent switch on page 1, with the rows its card keeps (5)', () => {
    const t = table({ total: 23 });
    t.v.pickSize(10);
    t.v.goTo(3);
    expect(t.v.page).toBe(3);
    t.m.unmount();
    const again = table({ total: 23 });
    expect(again.v.page).toBe(1);
    expect(again.v.size).toBe(10);
  });

  it('keeps the page shown when the figures change, clamped to the last when they shrink (6, 7)', () => {
    const t = table({ total: 23 });
    t.v.goTo(5);
    expect(t.v.page).toBe(5);
    t.p.total = 12;
    t.m.rerender();
    expect(t.v.page).toBe(3);
    expect(t.v.last).toBe(3);
    t.v.goTo(t.v.page - 1);
    expect(t.v.page).toBe(2);
    t.p.total = 40;
    t.m.rerender();
    expect(t.v.page).toBe(2);
  });

  it('gives an empty table page 1 of 1 (8)', () => {
    const t = table({ total: 0 });
    expect(t.v.page).toBe(1);
    expect(t.v.last).toBe(1);
    t.v.goTo(3);
    expect(t.v.page).toBe(1);
  });
});
