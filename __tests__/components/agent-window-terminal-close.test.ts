import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useAgentDialogTerminal } from '../../src/components/AgentWorld/useAgentDialogTerminal';
import type { AgentStatus } from '../../src/types/electron';

/**
 * An agent window closed while its terminal is still loading
 * (useAgentDialogTerminal). The hook waits 150 ms, checks that the window is
 * open and its element there, then imports xterm and its fit addon, which
 * under next dev, or on a first open, takes a while; it then opened the
 * terminal on whatever the ref held. Seen by #281's e2e on 01/10: "Failed to
 * initialize terminal: Error: Terminal requires a parent element." Written
 * before the fix. How it can fail:
 * 1. the window closes during the imports, and the terminal is built and
 *    opened on the element the window no longer has, and throws;
 * 2. the same, and the error is logged where a closed window should leave
 *    nothing;
 * 3. over-correction: a window that stays open no longer gets its terminal.
 */

// The import of xterm is held until a test lets it through. Only the first
// import can be held: after it the module is cached and resolves at once.
const xterm = vi.hoisted(() => {
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  return { loaded, release: () => release(), built: 0, opened: [] as unknown[] };
});

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));
vi.mock('@/lib/terminal-theme', () => ({ useTerminalTheme: () => ({}), createXtermOptions: () => ({}) }));
vi.mock('@/lib/terminal', () => ({
  attachShiftEnterHandler: () => {},
  connectionLine: () => '',
  disposeTerminalSafely: () => {},
  keySender: () => () => {},
  noteUserMoves: () => ({ moved: () => false, stop: () => {} }),
  passWheelToProgram: () => {},
  stripCursorSequences: (s: string) => s,
  stripTerminalReplies: (s: string) => s,
  suppressMouseTracking: () => {},
}));
vi.mock('xterm', async () => {
  await xterm.loaded;
  class Terminal {
    options: Record<string, unknown> = {};
    rows = 24;
    cols = 80;
    buffer = { active: { length: 0, viewportY: 0 } };
    constructor() { xterm.built += 1; }
    loadAddon() {}
    // xterm's own refusal, word for word.
    open(parent: unknown) {
      if (!parent) throw new Error('Terminal requires a parent element.');
      xterm.opened.push(parent);
    }
    onScroll() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    write() {}
    writeln() {}
    focus() {}
    scrollToBottom() {}
    dispose() {}
  }
  return { Terminal };
});
vi.mock('xterm-addon-fit', () => ({ FitAddon: class { fit() {} } }));

const g = globalThis as unknown as { window?: unknown; ResizeObserver?: unknown };
const agent = { id: 'a1', name: 'Frontend Engineer', provider: 'claude', status: 'idle', output: [] } as unknown as AgentStatus;
const element = () => ({ getBoundingClientRect: () => ({ width: 800, height: 600 }) });

let hook: Mount<ReturnType<typeof useAgentDialogTerminal>> | null = null;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  g.window = { electronAPI: { agent: { get: vi.fn(async () => null), resize: vi.fn(async () => ({})), onOutput: vi.fn(() => () => {}) } } };
  g.ResizeObserver = class { observe() {} disconnect() {} };
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  xterm.built = 0;
  xterm.opened.length = 0;
});
afterEach(() => {
  hook?.unmount();
  hook = null;
  errors.mockRestore();
  vi.useRealTimers();
  delete g.window;
  delete g.ResizeObserver;
});

describe('an agent window closed while its terminal loads', () => {
  it('builds no terminal and logs nothing (1, 2)', async () => {
    let open = true;
    hook = mount(() => useAgentDialogTerminal({ open, agent, isFullscreen: false, skipHistoricalOutput: false }));
    hook.result.terminalRef.current = element() as unknown as HTMLDivElement;
    await vi.advanceTimersByTimeAsync(150); // the hook's wait; its import of xterm is now held
    // The window closes: React lets go of the element, and the effect is cleaned up.
    hook.result.terminalRef.current = null;
    open = false;
    hook.rerender();
    xterm.release();
    await settle();
    expect(xterm.built).toBe(0);
    expect(xterm.opened).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('still gets its terminal when the window stays open (3)', async () => {
    xterm.release();
    hook = mount(() => useAgentDialogTerminal({ open: true, agent, isFullscreen: false, skipHistoricalOutput: false }));
    const el = element();
    hook.result.terminalRef.current = el as unknown as HTMLDivElement;
    await vi.advanceTimersByTimeAsync(150);
    await settle();
    expect(xterm.opened).toEqual([el]);
    expect(hook.result.terminalReady).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });
});
