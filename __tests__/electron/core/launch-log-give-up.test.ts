import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The rows a launch given up at CLI_UP_MS is said to have drawn, read from the real terminal mirror (the Audit's L1 on
 * #641 at e62832c58): case 9 of session-up-on-screen.test.ts mocks the mirror, so it cannot see the mirror's own clock.
 *
 * How it fails, written before the code (25/11):
 * 1. The launch log is let go by a timer of its own, 180 s after markCliLaunch, while the launch is given up at the
 *    first check 180 s after launchBegins: on a restart, markCliLaunch comes about 0.6 s after launchBegins, and the
 *    launch poll (utils/agents-tick.ts) checks once a second. A check that lands after the log's own timer says
 *    "no rows" where rows were drawn, the very rows the line is there to describe.
 * 2. The log outlives its launch: kept until a timer, though no reader is left once the launch is up or given up.
 *    It goes with the launch instead, which the launch poll ends within a second of its window.
 * 3. A launch abandoned (launchAbandoned, its start failed or its CLI left) keeps its log: the launch is gone, and the
 *    log stays until the next launch, the terminal's end or its 1 MiB, never read again (the Audit's I-1 at 984fc5eeb).
 *    It goes with the abandoned launch too.
 */

type FakePty = { pid: number; onData: (l: (d: string) => void) => { dispose(): void }; onExit: () => { dispose(): void }; emit(d: string): void };
// Made before the mocks, which vitest hoists above everything else in the file.
const { pty } = vi.hoisted(() => {
  const listeners: Array<(d: string) => void> = [];
  const fake: FakePty = {
    pid: 1,
    onData: (l) => { listeners.push(l); return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    emit: (d) => { for (const l of listeners) l(d); },
  };
  return { pty: fake };
});

vi.mock('../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map([['p1', pty]]) }));
vi.mock('../../../electron/core/agent-pty', () => ({ cliRunningIn: () => true }));
vi.mock('../../../electron/services/agent-truth', () => ({ lastInterruptAt: () => undefined }));

import { attachTerminalMirror, markCliLaunch, rowsSinceLaunch } from '../../../electron/core/terminal-mirror';
import { launchAbandoned, launchBegins, sessionStarting, resetLaunches, CLI_UP_MS } from '../../../electron/core/agent-launch';

const LOADING = '  Gemini CLI v0.70.0\r\n  Loading the workspace...\r\n';
const FIELD = ' >   Type your message or @path/to/file\r\n';

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-25T10:00:00.000Z') });
  resetLaunches();
  attachTerminalMirror(pty as never, { cols: 80, rows: 12, watchRepaint: false, label: 'g', logLaunch: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a launch's log lives as long as the launch", () => {
  it('1: a restart given up at the poll tick after its window says the rows it drew, not "no rows"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const agent = { id: 'g1', ptyId: 'p1', provider: 'gemini' as const };
    launchBegins('g1');
    vi.advanceTimersByTime(600); // a restart: the kill, then the new CLI's line
    markCliLaunch(pty as never, true);
    pty.emit(LOADING);
    expect(sessionStarting(agent)).toBe(true);
    vi.advanceTimersByTime(CLI_UP_MS - 600 + 800); // the launch poll's tick after the window, past the log's own 180 s
    expect(sessionStarting(agent)).toBe(false);
    const said = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('g1'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/\b2 rows\b/);
    expect(said[0]).not.toMatch(/no rows/);
  });

  it('2: the log goes with its launch, once given up or once up', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const given = { id: 'g2', ptyId: 'p1', provider: 'gemini' as const };
    launchBegins('g2');
    markCliLaunch(pty as never, true);
    pty.emit(LOADING);
    vi.advanceTimersByTime(CLI_UP_MS - 1000);
    expect(sessionStarting(given)).toBe(true);
    expect(rowsSinceLaunch(pty as never)?.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(1000);
    expect(sessionStarting(given)).toBe(false);
    expect(rowsSinceLaunch(pty as never)).toEqual([]);

    const up = { id: 'g3', ptyId: 'p1', provider: 'gemini' as const };
    launchBegins('g3');
    markCliLaunch(pty as never, true);
    pty.emit(LOADING + FIELD);
    expect(sessionStarting(up)).toBe(false);
    expect(rowsSinceLaunch(pty as never)).toEqual([]);
  });

  it('3: an abandoned launch takes its log with it', () => {
    const agent = { id: 'g4', ptyId: 'p1', provider: 'gemini' as const };
    const launch = launchBegins('g4');
    markCliLaunch(pty as never, true);
    pty.emit(LOADING);
    expect(rowsSinceLaunch(pty as never)?.length).toBeGreaterThan(0);
    launchAbandoned(agent as never, launch);
    expect(sessionStarting(agent)).toBe(false);
    expect(rowsSinceLaunch(pty as never)).toEqual([]);
  });
});
