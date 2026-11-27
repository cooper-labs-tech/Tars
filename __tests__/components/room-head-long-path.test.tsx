import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mount, elements, ofType, type Mount } from './hook-runtime';
import { RoomHead } from '../../src/components/Chat/RoomHead';
import { Button } from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A room's head with a long project path (QA's recon of #165: the name cut to
 * "t...", "ori...", "aspen-m..." and "how it runs" on two lines, out of its 26 px
 * box). The frame is `Chat · A · Room head · states` in
 * design/chat-redesign-a.pen: the name keeps its width, the path gives way and
 * is cut at its end, and only when the path is gone is the name cut; the state
 * and the buttons keep their size on one line.
 *
 * The suite has no layout engine, so this pins the flex contract that decides
 * it (the in-app proof measures the widths). How it fails:
 * 1. the name and the path shrink together, each in proportion to its width,
 *    so a long path takes the name down to its first letter;
 * 2. the name cannot shrink at all, and a very long one pushes the state and
 *    the buttons out of the head;
 * 3. the path cannot shrink below its text, so it is never cut;
 * 4. a spacer beside the name and the path shares the free space with them,
 *    so the path is cut while there is room;
 * 5. the state shrinks, or a button shrinks until its label wraps;
 * 6. Hermes' head, the same component with its own button, keeps the old
 *    behaviour.
 */

type El = ReactElement<Record<string, unknown>>;
let page: Mount<unknown> | null = null;
afterEach(() => { page?.unmount(); page = null; });

const LONG = '/Volumes/Work/clients/acme-corporation/2026/websites/redesign/the-autumn-launch';
const classes = (el: El) => String(el.props.className ?? '').split(/\s+/).filter(Boolean);
const childrenOf = (el: El): unknown[] => {
  const c = el.props.children;
  return Array.isArray(c) ? c.flat(Infinity) : [c];
};

function head(props: Partial<Parameters<typeof RoomHead>[0]> = {}) {
  page = mount(() => RoomHead({
    title: 'tars',
    path: LONG,
    state: { tone: 'running', word: 'relaying', detail: 'pauses after 3 more agent messages', relaying: true },
    onStop: () => {},
    stopTitle: 'Stop this exchange.',
    ...props,
  }));
  const all = elements(page.result) as El[];
  const root = all.find(el => el.props['data-room-head'] !== undefined)!;
  const textEl = (text: string) => all.find(el => typeof el.type === 'string' && el.props.children === text)!;
  const title = textEl(props.title ?? 'tars');
  const path = textEl(props.path ?? LONG);
  const parentOf = (child: El) => all.find(el => childrenOf(el).includes(child));
  return { root, title, path, parentOf, all };
}

describe("a room's head with a long path", () => {
  it('keeps the name whole: it does not shrink, and is cut only past the width of its group (1, 2)', () => {
    const { title } = head();
    expect(classes(title)).toEqual(expect.arrayContaining(['shrink-0', 'max-w-full', 'truncate']));
  });

  it('cuts the path first: it can shrink to nothing and ends in an ellipsis (3)', () => {
    const { path } = head();
    expect(classes(path)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(classes(path)).not.toContain('shrink-0');
  });

  it('holds the name and the path in one group that takes the free space, with no spacer beside it (4)', () => {
    const { title, path, parentOf, root } = head();
    const group = parentOf(title)!;
    expect(parentOf(path)).toBe(group);
    expect(group).not.toBe(root);
    expect(classes(group)).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'flex-1']));
    const spacers = childrenOf(root).filter((c): c is El => !!c && typeof c === 'object' && (c as El).props !== undefined && classes(c as El).includes('flex-1') && c !== group);
    expect(spacers).toEqual([]);
  });

  it('never shrinks the state, and keeps every button on one line at its size (5)', () => {
    const { all } = head();
    const status = all.find(el => el.props.role === 'status')!;
    expect(classes(status)).toContain('shrink-0');
    const buttons = ofType(page!.result, Button) as El[];
    expect(buttons.length).toBe(2);
    for (const button of buttons) expect(classes(button)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
  });

  it("holds for Hermes' head and its own button too (6)", () => {
    const { title, path } = head({ title: 'Hermes', path: 'overseer', rules: false, onStop: undefined, action: { label: 'pause', onClick: () => {} } });
    expect(classes(title)).toContain('shrink-0');
    expect(classes(path)).toContain('min-w-0');
    const buttons = ofType(page!.result, Button) as El[];
    expect(buttons.length).toBe(1);
    expect(classes(buttons[0])).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
  });
});
