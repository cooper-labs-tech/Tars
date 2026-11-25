import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mount, type Mount } from './hook-runtime';
import Terminal from '../../src/components/Terminal';

/**
 * A project's terminal (src/components/Terminal.tsx) and what its shell writes
 * before the terminal is drawn. Since ff2e97ab (16/09) its xterm is made one
 * task after the mount, so that an xterm opened and disposed in one tick leaves
 * no frame behind; the terminal listens to the PTY from the mount, but wrote a
 * chunk only once the xterm existed, and what came in between, the shell's
 * banner or its first prompt, was dropped (the QA's WHEEL-QA.md, 05/10: a
 * terminal opened empty, and the intermittent red of terminal-wheel.spec).
 * Written before the code. How it can fail:
 * 1. a chunk heard before the xterm exists is dropped, where it must be
 *    written once the xterm is made;
 * 2. kept, it is written out of order, after a chunk heard later, or twice;
 * 3. another PTY's chunk is written;
 * 4. what the page heard before the terminal listened at all (`backlog`: from
 *    pty:create's answer to the mount, a dynamic import away) is lost, or
 *    written after what the terminal heard itself;
 * 5. a terminal gone before its xterm was made still makes one, or still
 *    listens.
 */

const xterm = vi.hoisted(() => ({ made: [] as Array<{ written: string[] }> }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));
vi.mock('xterm/css/xterm.css', () => ({}));
vi.mock('@/lib/terminal-theme', () => ({ useTerminalTheme: () => ({}), createXtermOptions: () => ({}), TERMINAL_SURFACE_CLASS: '' }));
vi.mock('@/lib/terminal', () => ({
  disposeTerminalSafely: () => {},
  stopWheelTyping: () => {},
  stripTerminalReplies: (s: string) => s,
}));
vi.mock('xterm', () => {
  class Terminal {
    written: string[] = [];
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    constructor() { xterm.made.push(this); }
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write(data: string) { this.written.push(data); }
    dispose() {}
  }
  return { Terminal };
});
vi.mock('xterm-addon-fit', () => ({ FitAddon: class { fit() {} } }));

type Chunk = { id: string; data: string };
const g = globalThis as unknown as { window?: unknown; ResizeObserver?: unknown };
let listeners: Set<(chunk: Chunk) => void>;
let view: Mount<unknown> | null = null;

/** What main sends on pty:data. */
const send = (id: string, data: string) => { for (const cb of [...listeners]) cb({ id, data }); };
/** React hands the terminal its element, as it does once the div is in the page. */
const attach = (v: Mount<unknown>) => {
  ((v.result as ReactElement<{ ref: { current: unknown } }>).props.ref).current = { style: {} };
};
/** The task that makes the xterm. */
const nextTask = () => vi.advanceTimersByTimeAsync(0);
const shown = () => xterm.made.map(t => t.written.join(''));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  listeners = new Set();
  g.window = {
    electronAPI: {
      pty: {
        onData: (cb: (chunk: Chunk) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        write: vi.fn(async () => ({ success: true })),
        resize: vi.fn(async () => ({ success: true })),
      },
    },
  };
  g.ResizeObserver = class { observe() {} disconnect() {} };
  xterm.made.length = 0;
});
afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
  delete g.window;
  delete g.ResizeObserver;
});

describe('what the shell writes before its terminal is drawn', () => {
  it('is written once the xterm is made (1)', async () => {
    view = mount(() => Terminal({ ptyId: 'p1' }));
    attach(view);
    send('p1', 'the recorder holds the alternate screen\r\n');
    await nextTask();
    expect(shown()).toEqual(['the recorder holds the alternate screen\r\n']);
  });

  it('in the order it came, once, before what comes after (2)', async () => {
    view = mount(() => Terminal({ ptyId: 'p1' }));
    attach(view);
    send('p1', 'Last login: Mon Oct  5 21:40\r\n');
    send('p1', '% ');
    await nextTask();
    send('p1', 'ls\r\n');
    expect(shown()).toEqual(['Last login: Mon Oct  5 21:40\r\n% ls\r\n']);
  });

  it('only from its own PTY (3)', async () => {
    view = mount(() => Terminal({ ptyId: 'p1' }));
    attach(view);
    send('other', 'an agent\'s shell\r\n');
    send('p1', 'mine\r\n');
    await nextTask();
    send('other', 'more of it\r\n');
    expect(shown()).toEqual(['mine\r\n']);
  });

  it('starts with what the page heard before the terminal listened (4)', async () => {
    const heard = ['Last login: Mon Oct  5 21:40\r\n', 'the recorder holds the alternate screen\r\n'];
    const backlog = { take: (id: string) => (id === 'p1' ? heard.splice(0) : []) };
    view = mount(() => Terminal({ ptyId: 'p1', backlog }));
    attach(view);
    send('p1', '% ');
    await nextTask();
    expect(shown()).toEqual(['Last login: Mon Oct  5 21:40\r\nthe recorder holds the alternate screen\r\n% ']);
  });

  it('makes nothing, and no longer listens, once it is gone (5)', async () => {
    view = mount(() => Terminal({ ptyId: 'p1' }));
    attach(view);
    send('p1', 'banner\r\n');
    view.unmount();
    view = null;
    await nextTask();
    expect(xterm.made).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });
});
