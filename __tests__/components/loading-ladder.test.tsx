import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fragment } from 'react';
import { mount, elements, ofType, textOf } from './hook-runtime';
import { BrandSpinner, LoadingPanel, LoadingState, SlowOperation } from '../../src/components/ui/Loading';
import * as ui from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The loading ladder every page and panel waits on (1.7.4).
 *
 * JeanBrasse: "on several pages the loading screen was not the cube we had". The
 * ladder's middle stage defaulted to grey skeleton rows, and only Settings had
 * asked for the mark. It is the mark for everyone now, with no second look to
 * pick: nothing under 400 ms, the mark filling over a line naming the wait
 * until 3 s, then SlowOperation naming what is slow with a way out.
 * Frame: `Loading states`.
 */

const WHAT = "Still finding your agents' working trees…";
const DETAIL = 'reading the agent list';

describe('LoadingState, the ladder', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const onCancel = () => {};

  function ladder() {
    const props = { loading: true, what: WHAT, detail: DETAIL, onCancel, children: 'the page' as unknown };
    const m = mount(() => LoadingState(props as Parameters<typeof LoadingState>[0]));
    return { m, props };
  }

  it('draws nothing under 400 ms', () => {
    const { m } = ladder();
    expect(m.result).toBeNull();
    vi.advanceTimersByTime(399);
    expect(m.result).toBeNull();
  });

  it('draws the mark over the line naming the wait from 400 ms until 3 s', () => {
    const { m } = ladder();
    vi.advanceTimersByTime(400);
    expect(m.result).not.toBeNull();
    const el = m.result as unknown as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(LoadingPanel);
    expect(el.props.what).toBe(WHAT);
    vi.advanceTimersByTime(2599);
    expect((m.result as unknown as { type: unknown }).type).toBe(LoadingPanel);
  });

  it('names what is slow past 3 s, with its detail and the way out', () => {
    const { m } = ladder();
    vi.advanceTimersByTime(3000);
    const el = m.result as unknown as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(SlowOperation);
    expect(el.props).toMatchObject({ what: WHAT, detail: DETAIL, onCancel });
  });

  it('shows the content and nothing of the wait once loading is over, then starts quiet for the next wait', () => {
    const { m, props } = ladder();
    vi.advanceTimersByTime(3000);
    props.loading = false;
    m.rerender();
    const done = m.result as unknown as { type: unknown; props: { children: unknown } };
    expect(done.type).toBe(Fragment);
    expect(done.props.children).toBe('the page');

    vi.advanceTimersByTime(0);
    props.loading = true;
    m.rerender();
    expect(m.result).toBeNull();
    vi.advanceTimersByTime(399);
    expect(m.result).toBeNull();
    vi.advanceTimersByTime(1);
    expect((m.result as unknown as { type: unknown }).type).toBe(LoadingPanel);
  });
});

describe('what the ladder draws while it waits', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('the middle stage is the mark at 30 px, announced as the wait, over the same line, and no grey bar', () => {
    const tree = LoadingPanel({ what: WHAT });
    const marks = ofType(tree, BrandSpinner);
    expect(marks).toHaveLength(1);
    expect(marks[0].props).toMatchObject({ size: 30, label: WHAT });
    expect(ofType(tree, 'p').map(p => textOf(p))).toEqual([WHAT]);
    const classes = elements(tree).map(e => String(e.props.className ?? ''));
    expect(classes.some(c => c.split(/\s+/).includes('bg-secondary'))).toBe(false);
  });

  it('the mark is sixteen squares that light one after another, then start again', () => {
    vi.useFakeTimers();
    const m = mount(() => BrandSpinner({ size: 30, label: WHAT }));
    const cells = () => ofType(m.result, 'span').filter(s => String(s.props.className).includes('bg-primary'));
    const lit = () => cells().filter(c => (c.props.style as { opacity: number }).opacity === 1).length;
    expect(cells()).toHaveLength(16);
    expect(lit()).toBe(0);
    vi.advanceTimersByTime(110 * 5);
    expect(lit()).toBe(5);
    vi.advanceTimersByTime(110 * 11);
    expect(lit()).toBe(16);
    vi.advanceTimersByTime(110);
    expect(lit()).toBe(0);
    m.unmount();
  });

  it('past 3 s the mark stays, beside the line, the detail and a way out', () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    const m = mount(() => SlowOperation({ what: WHAT, detail: DETAIL, onCancel }));
    expect(ofType(m.result, BrandSpinner)).toHaveLength(1);
    const text = textOf(m.result as never);
    expect(text).toContain(WHAT);
    expect(text).toContain(DETAIL);
    const cancel = ofType(m.result, 'button').find(b => textOf(b.props.children as never) === 'Cancel');
    (cancel!.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalled();
    m.unmount();
  });

  it('offers no skeleton any more: SkeletonRows is gone from the kit, and LoadingState takes no variant or rows', () => {
    expect(Object.keys(ui)).not.toContain('SkeletonRows');
    expect(Object.keys(ui)).toEqual(expect.arrayContaining(['LoadingState', 'LoadingPanel', 'BrandSpinner', 'SlowOperation']));
    vi.useFakeTimers();
    const m = mount(() => LoadingState({ loading: true, what: WHAT, variant: 'skeleton', rows: 5 } as never));
    vi.advanceTimersByTime(400);
    expect((m.result as unknown as { type: unknown }).type).toBe(LoadingPanel);
  });
});
