import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type Mount } from './hook-runtime';
import { useQuickTerminal, persistentTerminals } from '../../src/components/AgentWorld/useQuickTerminal';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

// The theme hook watches document.documentElement; the buffer does not care.
vi.mock('@/lib/terminal-theme', () => ({
  useTerminalTheme: () => ({}),
  createXtermTheme: () => ({}),
  getTerminalFontFamily: () => 'monospace',
}));

/**
 * A quick shell reopened after a lot of output keeps the modes its program
 * asked for (1.7.4).
 *
 * The agent window's quick shell buffers what its PTY writes so the terminal
 * can be rebuilt when the window reopens. It kept the last 1000 writes and
 * dropped the oldest whole, and a full-screen program asks for its modes once:
 * after 1000 more writes the alternate screen, the mouse and the bracketed
 * paste were gone from the replay, so the wheel sent nothing and a paste went
 * out as typed lines. Trimmed writes now leave behind the state they set.
 *
 * Asserted on the buffer the reopened terminal replays, fed through the hook's
 * own PTY subscription, with explicit expected sequences rather than the modes
 * model the trim itself uses.
 */

const AGENT = 'agent-quick';
const PTY = 'pty-quick';

const ALT_SCREEN = '\x1b[?1049h';
const MOUSE = '\x1b[?1000h';
const SGR = '\x1b[?1006h';
const PASTE = '\x1b[?2004h';

type OnData = (event: { id: string; data: string }) => void;
const g = globalThis as unknown as { window?: unknown };

describe('the quick shell buffer past 1000 writes', () => {
  let write: OnData;
  let hook: Mount<ReturnType<typeof useQuickTerminal>>;

  beforeEach(() => {
    g.window = {
      electronAPI: {
        pty: {
          onData: (cb: OnData) => { write = cb; return () => {}; },
        },
      },
    };
    persistentTerminals.set(AGENT, { ptyId: PTY, outputBuffer: [] });
    hook = mount(() => useQuickTerminal({
      agentId: AGENT,
      projectPath: '/tmp/project',
      open: true,
      expandedPanels: new Set(),
      onCollapseTerminal: () => {},
    }));
    expect(write, 'the hook subscribes to the PTY output').toBeTypeOf('function');
  });

  afterEach(() => {
    hook.unmount();
    persistentTerminals.delete(AGENT);
    delete g.window;
  });

  const buffer = () => persistentTerminals.get(AGENT)!.outputBuffer;
  const lines = (from: number, to: number) => {
    for (let i = from; i < to; i++) write({ id: PTY, data: `line ${i}\r\n` });
  };

  it('keeps every write, as written, up to 1000', () => {
    write({ id: PTY, data: ALT_SCREEN + MOUSE + SGR + PASTE });
    lines(0, 999);
    expect(buffer()).toHaveLength(1000);
    expect(buffer()[0]).toBe(ALT_SCREEN + MOUSE + SGR + PASTE);
    expect(buffer()[999]).toBe('line 998\r\n');
  });

  it('puts the modes still set in front of the last 1000 writes once the write that set them is dropped', () => {
    write({ id: PTY, data: ALT_SCREEN + MOUSE + SGR + PASTE });
    lines(0, 2500);
    const kept = buffer();
    expect(kept).toHaveLength(1001);
    expect(kept[0]).toBe(ALT_SCREEN + MOUSE + SGR + PASTE);
    expect(kept[1]).toBe('line 1500\r\n');
    expect(kept[1000]).toBe('line 2499\r\n');
  });

  it('does not bring back a mode the program turned off before its write was dropped', () => {
    write({ id: PTY, data: ALT_SCREEN + MOUSE + SGR + PASTE });
    write({ id: PTY, data: '\x1b[?1000l\x1b[?1006l\x1b[?2004l' });
    lines(0, 2500);
    const kept = buffer();
    expect(kept[0]).toBe(ALT_SCREEN);
    expect(kept.join('')).not.toContain(MOUSE);
    expect(kept.join('')).not.toContain(SGR);
    expect(kept.join('')).not.toContain(PASTE);
  });

  it('carries nothing once every mode is off, and keeps exactly the last 1000 writes', () => {
    write({ id: PTY, data: ALT_SCREEN + MOUSE + SGR + PASTE });
    write({ id: PTY, data: '\x1b[?1049l\x1b[?1000l\x1b[?1006l\x1b[?2004l' });
    lines(0, 2500);
    const kept = buffer();
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toBe('line 1500\r\n');
  });

  it('follows the program when it asks again later: the last request is what a reopened shell starts in', () => {
    write({ id: PTY, data: ALT_SCREEN + MOUSE + SGR });
    lines(0, 600);
    write({ id: PTY, data: '\x1b[?1000l\x1b[?1003h' + PASTE });
    lines(600, 2500);
    expect(buffer()[0]).toBe(ALT_SCREEN + '\x1b[?1003h' + SGR + PASTE);
    expect(buffer()).toHaveLength(1001);
  });

  it('ignores another PTY\'s output', () => {
    write({ id: 'someone-else', data: 'not mine' });
    expect(buffer()).toEqual([]);
  });
});
