import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * The screen a panel comes back to, and the notice that a CLI left fullscreen.
 *
 * A Dashboard panel that remounted, back from another page or from another
 * project's tab, was rebuilt from the last 400 to 600 chunks of the stream.
 * Claude Code in fullscreen paints its frame once and then only the cells that
 * change, so after a few minutes of a turn the kept chunks held no frame and
 * the panel showed a timer on a blank screen. Now every agent terminal has a
 * headless xterm 5.3 beside it, fed each byte, and a panel is handed its
 * screen. These tests replay real Claude Code 2.1.280 streams (fixtures under
 * __tests__/fixtures/terminal-streams, each saying where it comes from) into a
 * mirror and into the terminal a panel that never left would be, and compare
 * the two at every chunk.
 *
 * The history a panel comes back to: the last 2,500 lines, JeanBrasse's choice of
 * 05/10 for the main process's mirror (the panel's own xterm keeps 5,000, #313;
 * the mirror kept 1,000). How it fails: the mirror keeps another number, so a
 * panel back from another page has lost more of the conversation, or the
 * main process holds more than was chosen; or the stand-in panel here keeps
 * another number than the real one, and the comparison proves nothing. *
 * What a snapshot costs, from the Audit's gate of #319: at 5,000 lines a full
 * mirror serializes in 100 to 230 ms on the main process, and agent:get asked
 * for it on every call (the Kanban board, the Kanban sync, the tray, the
 * Dashboard), ten agents at rest costing 0.5 to 1 s at each return to the
 * Dashboard. How it fails: a mirror nothing has written to since its last
 * snapshot is serialized again; or the kept snapshot is handed after a write
 * or a resize changed what a panel must show.
 *
 * The second half is the watch for a CLI that left fullscreen without telling
 * its terminal (QA's T1): the orchestrator's Claude Code started fullscreen,
 * then repainted inline on an alternate screen it never left, and the wheel
 * reached nothing.
 */

const { navigatorBefore } = vi.hoisted(() => ({
  navigatorBefore: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
}));

type FakePty = {
  onData: (listener: (data: string) => void) => { dispose(): void };
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose(): void };
  emit(data: string): void;
  exit(): void;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  pid: number;
};

/** An IPty as far as a mirror can tell: node-pty calls its listeners in order. */
function fakePty(): FakePty {
  const data: Array<(data: string) => void> = [];
  const exit: Array<(event: { exitCode: number }) => void> = [];
  return {
    onData: listener => { data.push(listener); return { dispose() {} }; },
    onExit: listener => { exit.push(listener); return { dispose() {} }; },
    emit: chunk => { for (const listener of data) listener(chunk); },
    exit: () => { for (const listener of exit) listener({ exitCode: 0 }); },
    write: vi.fn(), kill: vi.fn(), resize: vi.fn(), pid: 1,
  };
}

const spawns: Array<{ cols: number; rows: number; pty: FakePty }> = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
    const pty = fakePty();
    spawns.push({ cols: opts.cols, rows: opts.rows, pty });
    return pty;
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));

import {
  attachTerminalMirror, terminalSnapshot, resizeTerminalMirror, leftFullscreenIn,
  rememberPanelSize, panelSizeOf, MIRROR_SCROLLBACK, REPAINT_WINDOW,
} from '../../../electron/core/terminal-mirror';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { appendAgentOutput } from '../../../electron/core/agent-manager';
import type { AgentStatus } from '../../../electron/types';

// Loaded by the mirror module first, with navigator out of sight (see
// loadAsNode): cached from there, where a plain require would throw on Node 22.
const nodeRequire = createRequire(import.meta.url);
const { Terminal } = nodeRequire('xterm-headless') as typeof import('xterm-headless');
type Term = InstanceType<typeof Terminal>;
type Core = {
  writeSync(data: string): void;
  coreMouseService: { activeEncoding: string; activeProtocol: string };
  coreService: { isCursorHidden: boolean };
  buffer: { scrollTop: number; scrollBottom: number };
};
const core = (term: Term) => (term as unknown as { _core: Core })._core;

/** A terminal as useMultiTerminal builds a Dashboard panel's (TERMINAL_CONFIG). */
function panelTerminal(cols: number, rows: number): Term {
  return new Terminal({ cols, rows, scrollback: 5000, convertEol: true, allowProposedApi: true, logLevel: 'off' });
}
/** Parsed at once, as the mirror parses: the comparison happens right after. */
const write = (term: Term, data: string) => core(term).writeSync(data);

// ---- recordings --------------------------------------------------------

type Step = { output: string } | { resize: [number, number] } | { mark: string };
interface Recording { start: [number, number]; source: string; steps: Step[] }

function recording(name: string): Recording {
  const file = path.join(__dirname, '../../fixtures/terminal-streams', name);
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  const head = lines.shift() as { start: [number, number]; source: string };
  // node-pty hands strings decoded as a stream: a character split across two
  // reads arrives whole.
  const decoder = new TextDecoder('utf-8');
  const steps: Step[] = lines.map((line: { o?: string; r?: [number, number]; m?: string }) =>
    line.o !== undefined ? { output: decoder.decode(Buffer.from(line.o, 'base64'), { stream: true }) }
      : line.r ? { resize: line.r } : { mark: line.m! });
  return { start: head.start, source: head.source, steps };
}

const FULLSCREEN_LONG_TURN = 'claude-fullscreen-long-turn.jsonl.gz';
const FLIP = 'claude-flip.jsonl.gz';
const INLINE_BOOT = 'claude-inline-boot.jsonl.gz';
const EXIT_RESTART = 'claude-fullscreen-exit-restart.jsonl.gz';

// ---- comparing two terminals ------------------------------------------

function cellKey(cell: ReturnType<Term['buffer']['active']['getNullCell']> | undefined): string {
  if (!cell) return ' ';
  return [cell.getChars() || ' ', cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(),
    cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(), cell.isInverse(),
    cell.isInvisible(), cell.isStrikethrough(), cell.isBlink()].join('|');
}

/** Every visible cell with its attributes, row by row. */
function visibleCells(term: Term): string[] {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const cells: string[] = [];
    for (let x = 0; x < term.cols; x++) cells.push(cellKey(line?.getCell(x, cell)));
    rows.push(cells.join('\u0001'));
  }
  return rows;
}

function modes(term: Term) {
  const c = core(term);
  return {
    ...term.modes,
    encoding: c.coreMouseService.activeEncoding,
    cursorHidden: c.coreService.isCursorHidden,
    scrollRegion: [c.buffer.scrollTop, c.buffer.scrollBottom],
  };
}

/** The normal screen's history as text, as far back as a mirror keeps it. */
function history(term: Term): string {
  const buffer = term.buffer.normal;
  const lines: string[] = [];
  for (let i = Math.max(0, buffer.length - (MIRROR_SCROLLBACK + term.rows)); i < buffer.length; i++) {
    lines.push(buffer.getLine(i)!.translateToString(true));
  }
  return lines.join('\n').replace(/\s+$/, '');
}

/** The visible rows as text, cheaper than every cell's attributes. Up to the
 *  right edge: a narrowed alternate screen keeps cells past it, unseen. */
function visibleText(term: Term): string[] {
  const buffer = term.buffer.active;
  return Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(false, 0, term.cols) ?? '');
}

/**
 * What a panel shows, in full: the text always, every cell's attributes when
 * asked. The cursor is compared too, with one known difference: a cursor
 * parked past the last column (xterm's pending wrap) comes back on the last
 * column, since no cursor move can reach past it. Measured on twelve
 * recordings: 2 chunks in 4269, the content identical.
 */
function expectSameScreen(live: Term, panel: Term, where: string, attributes = true) {
  expect(panel.buffer.active.type, `${where}: active screen`).toBe(live.buffer.active.type);
  expect(visibleText(panel), `${where}: text`).toEqual(visibleText(live));
  if (attributes) expect(visibleCells(panel), `${where}: cells`).toEqual(visibleCells(live));
  const liveBuffer = live.buffer.active;
  const pendingWrap = liveBuffer.cursorX === live.cols;
  expect([panel.buffer.active.cursorX, panel.buffer.active.cursorY], `${where}: cursor`)
    .toEqual([pendingWrap ? live.cols - 1 : liveBuffer.cursorX, liveBuffer.cursorY]);
  expect(modes(panel), `${where}: modes`).toEqual(modes(live));
  expect(history(panel), `${where}: history`).toBe(history(live));
}

/** Non-blank cells of the active screen that hold the same character in both. */
function matchingCells(live: Term, panel: Term): { same: number; cells: number } {
  const text = (term: Term) => {
    const buffer = term.buffer.active;
    return Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(false) ?? '');
  };
  const a = text(live), b = text(panel);
  let same = 0, cells = 0;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < live.cols; x++) {
      const ca = a[y][x] ?? ' ', cb = b[y]?.[x] ?? ' ';
      if (ca !== ' ' || cb !== ' ') { cells++; if (ca === cb) same++; }
    }
  }
  return { same, cells };
}

/** Plays a recording into a mirror and into a panel that never left. */
function play(name: string, opts: { watchRepaint?: boolean; each?: (at: { chunk: number; data: string; live: Term; pty: FakePty; cols: number; rows: number; mark?: string; resized: boolean; last: boolean }) => void } = {}) {
  const { start, steps } = recording(name);
  let [cols, rows] = start;
  const live = panelTerminal(cols, rows);
  const pty = fakePty();
  attachTerminalMirror(pty as never, { cols, rows, watchRepaint: opts.watchRepaint ?? true, label: name });
  let chunk = 0;
  let mark: string | undefined;
  let resized = false;
  const total = steps.filter(step => 'output' in step).length;
  for (const step of steps) {
    if ('mark' in step) { mark = step.mark; continue; }
    if ('resize' in step) {
      [cols, rows] = step.resize;
      live.resize(cols, rows);
      resizeTerminalMirror(pty as never, cols, rows);
      resized = true;
      continue;
    }
    write(live, step.output);
    pty.emit(step.output);
    chunk++;
    opts.each?.({ chunk, data: step.output, live, pty, cols, rows, mark, resized, last: chunk === total });
    mark = undefined;
    resized = false;
  }
  return { live, pty, chunks: chunk, cols, rows };
}

function snapshotInto(pty: FakePty, cols: number, rows: number): Term {
  const panel = panelTerminal(cols, rows);
  write(panel, terminalSnapshot(pty as never)!);
  return panel;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- the screen ---------------------------------------------------------

describe('a panel that comes back is handed the screen it left', () => {
  it.each([FULLSCREEN_LONG_TURN, FLIP, INLINE_BOOT, EXIT_RESTART])(
    '%s: after every chunk, a fresh panel written the snapshot shows what a panel that never left shows',
    (name) => {
      const { chunks } = play(name, {
        each: ({ chunk, live, pty, cols, rows, resized, last }) => {
          const panel = snapshotInto(pty, cols, rows);
          expectSameScreen(live, panel, `${name} after chunk ${chunk}`, chunk % 5 === 0 || resized || last);
          panel.dispose();
        },
      });
      expect(chunks).toBeGreaterThan(200);
    },
    // A few seconds each on an idle machine; the fleet shares this one.
    60_000,
  );

  it('the long turn is the one the kept chunks lost: the replay of agent.output falls apart, the snapshot does not', () => {
    // The negative witness: without it a recording that never loses its frame
    // would pass the test above just as well. agent.output is kept by the real
    // appendAgentOutput, trim and carried modes included.
    const agent = { output: [] as string[] } as AgentStatus;
    const replay: Array<{ chunk: number; same: number; cells: number }> = [];
    const snapshot: Array<{ chunk: number; same: number; cells: number }> = [];
    play(FULLSCREEN_LONG_TURN, {
      each: ({ chunk, data, live, pty, cols, rows }) => {
        appendAgentOutput(agent, data);
        if (chunk < 590) return;
        const old = panelTerminal(cols, rows);
        write(old, agent.output.join(''));
        replay.push({ chunk, ...matchingCells(live, old) });
        old.dispose();
        const panel = snapshotInto(pty, cols, rows);
        snapshot.push({ chunk, ...matchingCells(live, panel) });
        panel.dispose();
      },
    });
    const afterTrim = replay.filter(r => r.chunk > 600);
    const worst = afterTrim.reduce((w, r) => (r.same / r.cells < w.same / w.cells ? r : w));
    // Measured: 20 cells in 463 at chunk 601, the Audit's own count.
    expect(worst.same / worst.cells, JSON.stringify(worst)).toBeLessThan(0.1);
    expect(replay.filter(r => r.chunk <= 600).every(r => r.same === r.cells), 'before the first trim the replay was whole').toBe(true);
    expect(snapshot.every(r => r.same === r.cells && r.cells > 0)).toBe(true);
  });

  it('the history is the last 2,500 lines of what a panel that never left keeps', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 40, rows: 6, watchRepaint: false, label: 'history' });
    const live = panelTerminal(40, 6);
    const stream = Array.from({ length: 6000 }, (_, i) => `line ${i + 1}\r\n`).join('');
    write(live, stream);
    pty.emit(stream);
    const panel = snapshotInto(pty, 40, 6);
    const text = (term: Term) => Array.from({ length: term.buffer.normal.length }, (_, i) => term.buffer.normal.getLine(i)!.translateToString(true));
    expect(live.buffer.normal.length, 'the stand-in panel keeps 5,000 lines above its screen').toBe(5000 + 6);
    expect(text(panel)).toEqual(text(live).slice(-(2500 + 6)));
    panel.dispose();
  });

  it('opens with RIS, so a chunk a panel received before asking is not drawn twice', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 40, rows: 6, watchRepaint: false, label: 'early' });
    const live = panelTerminal(40, 6);
    const chunks = ['one\r\ntwo\r\n', '\x1b[?1049h\x1b[Hthree', '\x1b[3;1Hfour'];
    for (const chunk of chunks) { write(live, chunk); pty.emit(chunk); }
    // The Dashboard subscribes to live output before it asks for the screen,
    // and the tray replays 400 ms after subscribing: the last chunk is already
    // in the panel when the snapshot, which also holds it, arrives.
    const panel = panelTerminal(40, 6);
    write(panel, chunks[2]);
    write(panel, terminalSnapshot(pty as never)!);
    expect(terminalSnapshot(pty as never)!.startsWith('\x1bc')).toBe(true);
    expectSameScreen(live, panel, 'early chunk');
  });

  describe('what the serialize addon leaves out, put back', () => {
    function mirrored(chunks: string[], cols = 40, rows = 6) {
      const pty = fakePty();
      attachTerminalMirror(pty as never, { cols, rows, watchRepaint: false, label: 'addon' });
      const live = panelTerminal(cols, rows);
      for (const chunk of chunks) { write(live, chunk); pty.emit(chunk); }
      return { pty, live, panel: snapshotInto(pty, cols, rows) };
    }

    it('the SGR mouse encoding, each mode in a sequence of its own', () => {
      // passWheelToProgram forwards the wheel only to a CLI that asked for SGR
      // reports, and suppressMouseTracking swallows a request only when every
      // mode in it is a mouse mode.
      for (const [request, encoding] of [['\x1b[?1000h\x1b[?1006h', 'SGR'], ['\x1b[?1003h\x1b[?1016h', 'SGR_PIXELS']] as const) {
        const { pty, live, panel } = mirrored(['\x1b[?1049h', request, 'x']);
        expect(core(panel).coreMouseService.activeEncoding).toBe(encoding);
        expect(modes(panel)).toEqual(modes(live));
        const snapshot = terminalSnapshot(pty as never)!;
        expect(snapshot).not.toMatch(/\x1b\[\?\d+;\d+[hl]/);
      }
    });

    it('the hidden cursor, and the visible one over a panel whose cursor an early chunk hid', () => {
      const hidden = mirrored(['\x1b[?25lhidden']);
      expect(core(hidden.panel).coreService.isCursorHidden).toBe(true);

      const shown = mirrored(['\x1b[?25lhidden', '\x1b[?25hshown']);
      const panel = panelTerminal(40, 6);
      write(panel, '\x1b[?25l');
      // RIS in xterm 5.3 leaves a hidden cursor hidden.
      write(panel, terminalSnapshot(shown.pty as never)!);
      expect(core(panel).coreService.isCursorHidden).toBe(false);
    });

    it('a scroll region with origin mode, and the cursor inside it', () => {
      const { live, panel } = mirrored(['one\r\ntwo\r\nthree', '\x1b[2;5r\x1b[?6h\x1b[2;3Hin']);
      expectSameScreen(live, panel, 'scroll region');
      write(live, '\r\nnext\r\nnext\r\nnext');
      write(panel, '\r\nnext\r\nnext\r\nnext');
      expectSameScreen(live, panel, 'scroll region, scrolled');
    });

    it('the alternate screen starting from the default colours, not the normal screen\'s last one', () => {
      const { live, panel } = mirrored(['\x1b[33myellow text\x1b[0m\r\n\x1b[33m', '\x1b[?1049h\x1b[39m\x1b[H+--+ plain']);
      expectSameScreen(live, panel, 'colours');
    });

    it('an alternate screen drawn wide and then narrowed: rows stay where they were', () => {
      // xterm keeps an alternate screen's lines at their old length after a
      // shrink and the addon wrote the hidden part, which wrapped. Measured on
      // a real recording shrunk from 110 to 36 columns: 7 cells in 162.
      const pty = fakePty();
      attachTerminalMirror(pty as never, { cols: 40, rows: 6, watchRepaint: false, label: 'shrink' });
      const live = panelTerminal(40, 6);
      const chunk = '\x1b[?1049h\x1b[H' + 'a'.repeat(38) + '\x1b[2;1Hsecond row\x1b[3;1H' + 'b'.repeat(40);
      write(live, chunk); pty.emit(chunk);
      live.resize(20, 6); resizeTerminalMirror(pty as never, 20, 6);
      expectSameScreen(live, snapshotInto(pty, 20, 6), 'narrowed');
      live.resize(40, 6); resizeTerminalMirror(pty as never, 40, 6);
      const repaint = '\x1b[H' + 'c'.repeat(40) + '\x1b[3;1H' + 'd'.repeat(40);
      write(live, repaint); pty.emit(repaint);
      // Widened again: the cells a program has not repainted are blank in the
      // mirror, and hold what they held in a panel that never left.
      const panel = snapshotInto(pty, 40, 6);
      expect(panel.buffer.active.getLine(1)!.translateToString(true)).toBe('second row');
      expect(panel.buffer.active.getLine(0)!.translateToString(true)).toBe('c'.repeat(40));
    });
  });
});

// ---- the mirror itself ---------------------------------------------------

describe('a snapshot', () => {
  const { SerializeAddon } = nodeRequire('xterm-addon-serialize') as { SerializeAddon: { prototype: { serialize: () => string } } };

  it('is not serialized again while nothing has been written to the mirror', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 40, rows: 6, watchRepaint: false, label: 'cache' });
    pty.emit(Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join(''));
    const serialize = vi.spyOn(SerializeAddon.prototype, 'serialize');
    const first = terminalSnapshot(pty as never);
    const second = terminalSnapshot(pty as never);
    expect(second).toBe(first);
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('is made again after a write, and shows it', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 40, rows: 6, watchRepaint: false, label: 'cache-write' });
    pty.emit('one\r\n');
    const before = terminalSnapshot(pty as never)!;
    pty.emit('two\r\n');
    const after = terminalSnapshot(pty as never)!;
    const panel = panelTerminal(40, 6);
    write(panel, after);
    expect(after).not.toBe(before);
    expect(visibleText(panel).join('\n')).toContain('two');
    panel.dispose();
  });

  it('is made again after a resize', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 40, rows: 6, watchRepaint: false, label: 'cache-resize' });
    pty.emit('\x1b[?1049h\x1b[H' + 'x'.repeat(39));
    const before = terminalSnapshot(pty as never)!;
    resizeTerminalMirror(pty as never, 20, 6);
    expect(terminalSnapshot(pty as never)).not.toBe(before);
  });
});

describe('the mirror', () => {
  it('has parsed a chunk by the time the listener returns, before any later listener broadcasts it', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 20, rows: 3, watchRepaint: false, label: 'sync' });
    const seen: string[] = [];
    pty.onData(() => {
      const panel = snapshotInto(pty, 20, 3);
      seen.push(panel.buffer.active.getLine(0)!.translateToString(true));
    });
    pty.emit('hello');
    expect(seen).toEqual(['hello']);
  });

  it('costs the other listeners nothing when a chunk cannot be parsed, and stands aside', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 20, rows: 3, watchRepaint: false, label: 'broken' });
    const after = vi.fn();
    pty.onData(after);
    pty.emit(undefined as unknown as string);
    expect(after).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
    // Without its mirror the agent's panels replay agent.output, as before.
    expect(terminalSnapshot(pty as never)).toBeUndefined();
    pty.emit('still here');
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('is gone with its PTY', () => {
    const pty = fakePty();
    attachTerminalMirror(pty as never, { cols: 20, rows: 3, watchRepaint: false, label: 'exit' });
    pty.emit('x');
    expect(terminalSnapshot(pty as never)).toBeDefined();
    pty.exit();
    expect(terminalSnapshot(pty as never)).toBeUndefined();
    expect(terminalSnapshot(undefined)).toBeUndefined();
  });

  it('loaded xterm with navigator out of sight, and put navigator back as it was', () => {
    expect(navigatorBefore?.get, 'Node 22 has a navigator: the case this is about').toBeTypeOf('function');
    const now = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    expect(now?.get).toBe(navigatorBefore?.get);
    expect(now?.configurable).toBe(navigatorBefore?.configurable);
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
  });

  it('needs to: required plainly on a Node with a navigator, xterm-headless 5.3 throws', () => {
    // If this ever passes, xterm tells Node from a browser by itself again and
    // loadAsNode can go.
    // The error only: printed by Node itself it follows the 140 KB minified
    // line it points into, and a pipe on macOS loses it when the process exits.
    const run = spawnSync(process.execPath, ['-e',
      "try { require('xterm-headless'); console.log('loaded') } catch (e) { console.log(e.name + ': ' + e.message) }"],
    { cwd: process.cwd(), encoding: 'utf8' });
    expect(run.stdout.trim()).toBe('ReferenceError: window is not defined');
  });
});

// ---- the size a new PTY gets --------------------------------------------

describe('the size a panel asked for', () => {
  const spawn = (agentId: string | undefined, binaryName = 'claude') => {
    spawns.length = 0;
    spawnAgentPty({
      binaryName, shell: '/bin/bash', args: ['-l'], cwd: os.tmpdir(), cols: 120, rows: 30,
      env: agentId ? { CLAUDE_AGENT_ID: agentId } : {},
    });
    return spawns[0];
  };

  it('is kept for a PTY that does not exist yet, and a new PTY is spawned at it, mirror included', () => {
    expect(rememberPanelSize('agent-sized', 179, 41)).toBe(true);
    const { cols, rows, pty } = spawn('agent-sized');
    expect([cols, rows]).toEqual([179, 41]);
    pty.emit('x'.repeat(150));
    const panel = snapshotInto(pty, 179, 41);
    expect(panel.buffer.active.getLine(0)!.translateToString(true)).toBe('x'.repeat(150));
  });

  it('follows the last request, and leaves an agent no panel has sized at its caller\'s default', () => {
    rememberPanelSize('agent-twice', 100, 30);
    rememberPanelSize('agent-twice', 90, 20);
    expect(panelSizeOf('agent-twice')).toEqual({ cols: 90, rows: 20 });
    expect([spawn('agent-twice').cols, spawn('agent-twice').rows]).toEqual([90, 20]);
    const fresh = spawn('agent-never-sized');
    expect([fresh.cols, fresh.rows]).toEqual([120, 30]);
  });

  it('refuses a size no terminal can have', () => {
    for (const [cols, rows] of [[0, 10], [10, 0], [-1, 5], [80.5, 24], [Number.NaN, 24], [80, Number.POSITIVE_INFINITY]]) {
      expect(rememberPanelSize('agent-bad', cols, rows), `${cols}x${rows}`).toBe(false);
    }
    expect(panelSizeOf('agent-bad')).toBeUndefined();
  });
});

// ---- the left-fullscreen watch (QA's T1) -------------------------------

describe('a CLI that left fullscreen without telling its terminal', () => {
  it('is flagged in the recording of QA\'s R1: never before the SIGKILL, within a repaint of the inline turn', () => {
    const timeline: Array<{ chunk: number; flag: boolean; mark?: string }> = [];
    play(FLIP, { each: ({ chunk, pty, mark }) => timeline.push({ chunk, flag: leftFullscreenIn(pty as never), mark }) });
    const killedAt = timeline.findIndex(t => t.mark === 'sigkill');
    const inlineTurnAt = timeline.findIndex(t => t.mark === 'turn2');
    expect(killedAt).toBeGreaterThan(0);
    expect(inlineTurnAt).toBeGreaterThan(killedAt);
    expect(timeline.slice(0, killedAt).some(t => t.flag), 'flagged while claude was fullscreen').toBe(false);
    const firstFlag = timeline.findIndex(t => t.flag);
    // Measured: 2 chunks into the turn, 7 ms after its first repaint.
    expect(firstFlag).toBeGreaterThan(killedAt);
    expect(firstFlag - inlineTurnAt).toBeLessThanOrEqual(REPAINT_WINDOW);
    expect(timeline.slice(firstFlag).every(t => t.flag), 'flag dropped while claude still drew inline').toBe(true);
  });

  it.each([FULLSCREEN_LONG_TURN, EXIT_RESTART, INLINE_BOOT])('is never flagged in %s', (name) => {
    let flagged = 0;
    play(name, { each: ({ pty }) => { if (leftFullscreenIn(pty as never)) flagged++; } });
    expect(flagged).toBe(0);
  });

  it('is watched only for the claude binary, whose two renderers were measured', () => {
    for (const [binaryName, expected] of [['claude', true], ['codex', false]] as const) {
      spawns.length = 0;
      spawnAgentPty({
        binaryName, shell: '/bin/bash', args: ['-l'], cwd: os.tmpdir(), cols: 80, rows: 24,
        env: { CLAUDE_AGENT_ID: `agent-${binaryName}` },
      });
      const { pty } = spawns[0];
      pty.emit('\x1b[?1049h\x1b[H');
      for (let i = 0; i < REPAINT_WINDOW + 2; i++) pty.emit(inkFrame(i));
      expect(leftFullscreenIn(pty as never), binaryName).toBe(expected);
    }
  });

  describe('each part of the signature decides', () => {
    function watched(): FakePty {
      const pty = fakePty();
      attachTerminalMirror(pty as never, { cols: 80, rows: 24, watchRepaint: true, label: 'synthetic' });
      // A fullscreen CLI: the alternate screen, the mouse, absolute repaints.
      pty.emit('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J');
      for (let i = 0; i < REPAINT_WINDOW + 2; i++) pty.emit(`\x1b[H\x1b[20;1Htick ${i}\x1b[24;1Hstatus`);
      expect(leftFullscreenIn(pty as never)).toBe(false);
      return pty;
    }

    it('climbing with CSI A alone, as Ink erases its frame, is inline', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      expect(leftFullscreenIn(pty as never)).toBe(true);
    });

    it('moving back with CSI D alone, as an inline spinner redraws in place, is inline', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(`\x1b[5D${String(i).padStart(3, '0')}s  `);
      expect(leftFullscreenIn(pty as never)).toBe(true);
    });

    it('is not decided on one chunk: a fullscreen CLI that climbs, then homes the cursor in the next chunk, stays fullscreen', () => {
      const pty = watched();
      for (let i = 0; i < 3 * REPAINT_WINDOW; i++) {
        pty.emit('\x1b[2K\x1b[1A'.repeat(6));
        pty.emit(`\x1b[H\x1b[2Kframe ${i}`);
      }
      expect(leftFullscreenIn(pty as never)).toBe(false);
    });

    it('needs no ?1049l to be flagged, and a real ?1049l clears it at once', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      expect(leftFullscreenIn(pty as never)).toBe(true);
      pty.emit('\x1b[?1049l$ ');
      expect(leftFullscreenIn(pty as never)).toBe(false);
    });

    it('is cleared at once by a program asking for the alternate screen again, still on the stale one', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      expect(leftFullscreenIn(pty as never)).toBe(true);
      pty.emit('\x1b[?1049h\x1b[H\x1b[2J');
      expect(leftFullscreenIn(pty as never)).toBe(false);
    });

    it('counts CSI f and CSI d as positioning absolutely, as CSI H is', () => {
      // Added at the QA gate of #127. A fullscreen CLI that places its rows with
      // HVP (CSI row;col f) or VPA (CSI row d), climbing with CSI A in between,
      // repaints fullscreen and is not flagged.
      for (const absolute of ['\x1b[3;1f', '\x1b[3d']) {
        const pty = watched();
        for (let i = 0; i < 3 * REPAINT_WINDOW; i++) pty.emit('\x1b[1A'.repeat(4) + `${absolute}row ${i}`);
        expect(leftFullscreenIn(pty as never), JSON.stringify(absolute)).toBe(false);
      }
    });

    it('is cleared at once by a program asking for the alternate screen with ?1047 or ?47, as with ?1049', () => {
      // Added at the QA gate of #127: the older two requests for the same screen.
      for (const mode of ['1047', '47']) {
        const pty = watched();
        for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
        expect(leftFullscreenIn(pty as never)).toBe(true);
        pty.emit(`\x1b[?${mode}h\x1b[H\x1b[2J`);
        expect(leftFullscreenIn(pty as never), mode).toBe(false);
      }
    });

    it('is cleared by RIS', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      pty.emit('\x1bc');
      expect(leftFullscreenIn(pty as never)).toBe(false);
    });

    it('stays while the inline CLI prints text with no cursor move at all', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      for (let i = 0; i < 3 * REPAINT_WINDOW; i++) pty.emit(`plain line ${i}\r\n`);
      expect(leftFullscreenIn(pty as never)).toBe(true);
    });

    it('comes back down when the CLI repaints fullscreen again', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(`\x1b[H\x1b[20;1Htick ${i}`);
      expect(leftFullscreenIn(pty as never)).toBe(false);
    });

    it('belongs to one PTY: the one that replaces it starts clear (T4)', () => {
      const pty = watched();
      for (let i = 0; i < REPAINT_WINDOW; i++) pty.emit(inkFrame(i));
      expect(leftFullscreenIn(pty as never)).toBe(true);
      const next = fakePty();
      attachTerminalMirror(next as never, { cols: 80, rows: 24, watchRepaint: true, label: 'replacement' });
      expect(leftFullscreenIn(next as never)).toBe(false);
      pty.exit();
      expect(leftFullscreenIn(pty as never)).toBe(false);
    });
  });
});

/** One repaint of an inline renderer: erase its last frame bottom up, draw the next. */
function inkFrame(i: number): string {
  return '\x1b[2K\x1b[1A'.repeat(4) + '\x1b[2K\x1b[G' + `> frame ${i}\r\n  line\r\n  line\r\n  status ${i}`;
}
