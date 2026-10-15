import type { IPty } from 'node-pty';
import type { Terminal } from 'xterm-headless';
import type { SerializeAddon } from 'xterm-addon-serialize';

/**
 * xterm-headless 5.3 and its serialize addon tell Node from a browser by
 * `typeof navigator`, and Node has had a `navigator` since 21: Electron 43's
 * main process runs Node 24.18 and has one. Taken for a browser, both read a
 * browser global while they load, `window` in the terminal and `document` in
 * the addon, and throw. Measured on Node 22: `ReferenceError: window is not
 * defined`, then `document is not defined`. Those two reads are guarded by that
 * one test and nothing else in either bundle reads a browser global.
 *
 * So the two modules are loaded with `navigator` out of sight, and it is put
 * back, with the very descriptor it had, before anything else runs. And if
 * they cannot be loaded at all, the app starts without mirrors rather than not
 * at all: every panel then replays agent.output, as it did before them.
 */
function loadAsNode(): { Terminal: typeof Terminal; SerializeAddon: typeof SerializeAddon } | undefined {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const hidden = navigator?.configurable === true && delete (globalThis as { navigator?: unknown }).navigator;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return {
      Terminal: (require('xterm-headless') as typeof import('xterm-headless')).Terminal,
      SerializeAddon: (require('xterm-addon-serialize') as typeof import('xterm-addon-serialize')).SerializeAddon,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch (err) {
    console.error('[terminal-mirror] xterm-headless could not be loaded: panels replay the kept output instead', err);
    return undefined;
  } finally {
    if (hidden && navigator) Object.defineProperty(globalThis, 'navigator', navigator);
  }
}

const xterm = loadAsNode();

/**
 * A headless copy of every agent terminal, fed each byte its PTY emits, so a
 * panel that comes back is handed the screen itself.
 *
 * The panels used to be rebuilt from `agent.output`, the last 400 to 600 chunks
 * of the stream. Claude Code in fullscreen paints its frame once and then sends
 * only the cells that change: a spinner tick is a cursor move and one digit.
 * After about three minutes of a turn with no input, the kept chunks held no
 * frame at all, only those changes, and a panel mounted then (back from
 * another page, or from another project's tab) showed the timer and the spinner
 * line on a blank screen. Measured by the Audit on 2026-09-23 in a sandbox with
 * the real Claude Code 2.1.280, four minutes into a turn: 856 visible
 * characters in the panel before leaving the Dashboard, 37 after coming back.
 * Nothing healed it but a change of size, and a panel that comes back at the
 * size it left sends the program no SIGWINCH.
 *
 * So the screen is kept rather than the stream. This is the same emulator as
 * the renderer's, xterm 5.3, with the Dashboard's line handling
 * (`convertEol`), so what it holds is what a panel that never unmounted would
 * show: both screens with the alternate one active or not, the cursor, the
 * modes a replay depends on, and the last MIRROR_SCROLLBACK lines of history.
 * It works for every CLI and sends the program nothing.
 *
 * One per PTY, not per agent. A PTY that replaces another is a new terminal,
 * and what the old one left behind, an alternate screen that was never left or
 * a mouse request that was never withdrawn, is not part of the new one.
 */

/** Lines of history kept above the screen, which a panel that comes back is
 *  handed: 2,500, JeanBrasse's choice of 05/10 for the main process (the panel's own
 *  xterm keeps 5,000, #313). It kept 1,000. */
export const MIRROR_SCROLLBACK = 2500;

/**
 * The parts of xterm 5.3 a snapshot needs and the public API does not give.
 * The versions are pinned exactly in package.json, and the serialize addon of
 * the same release reads xterm's internals the same way: an upgrade that moves
 * any of these fails the mirror's tests rather than the screen.
 *
 * - `writeSync`: parse a chunk now. `write` queues it for a later task, and a
 *   snapshot taken in between would miss chunks the panel has already been
 *   sent, which the RIS at the head of the snapshot then wipes from the panel.
 * - the mouse encoding and the hidden cursor: the addon writes the tracking
 *   protocol but neither of these, and the wheel is only forwarded to a CLI
 *   that asked for SGR reports (passWheelToProgram, src/lib/terminal.ts).
 * - the scroll region and origin mode, which the addon leaves out too.
 * - the alternate screen's lines, for resizeTerminalMirror.
 */
interface XtermInternals {
  writeSync(data: string): void;
  coreMouseService: { activeEncoding: string };
  coreService: { isCursorHidden: boolean; decPrivateModes: { origin: boolean } };
  buffer: { scrollTop: number; scrollBottom: number };
  buffers: {
    alt: {
      lines: { length: number; get(index: number): { length: number; resize(cols: number, fill: unknown): boolean } | undefined };
      getNullCell(): unknown;
    };
  };
}

interface Mirror {
  term: Terminal;
  core: XtermInternals;
  serializer: SerializeAddon;
  repaint?: RepaintWatch;
  /** The last snapshot, until the next write or resize. A full mirror
   *  serializes on the main process in about 24 ms at rest at 2,500 lines (100
   *  to 230 ms at 5,000 under load, the Audit's gate of #319), and agent:get asks
   *  for it on every call, the Kanban and the tray included: an agent at rest
   *  writes nothing, and its snapshot is not made again. */
  snapshot?: string;
}

const mirrors = new WeakMap<IPty, Mirror>();

/**
 * Keep a mirror of `pty` from its first byte.
 *
 * Called by spawnAgentPty, the one function that starts an agent's terminal,
 * right after the spawn: its data listener is registered before any caller's,
 * so the mirror has parsed a chunk before that chunk is broadcast to a panel.
 * A snapshot therefore always contains everything a panel was sent before the
 * reply that carries it.
 *
 * `watchRepaint` turns on the left-fullscreen watch below, for the CLIs whose
 * rendering it was measured on.
 */
export function attachTerminalMirror(
  pty: IPty,
  opts: { cols: number; rows: number; watchRepaint: boolean; label: string },
): void {
  if (!xterm) return;
  const term = new xterm.Terminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: MIRROR_SCROLLBACK,
    convertEol: true,
    allowProposedApi: true,
    // writeSync warns once that it is deprecated; errors still show.
    logLevel: 'error',
  });
  const serializer = new xterm.SerializeAddon();
  term.loadAddon(serializer);
  const mirror: Mirror = {
    term,
    core: (term as unknown as { _core: XtermInternals })._core,
    serializer,
    repaint: opts.watchRepaint ? new RepaintWatch(term, opts.label) : undefined,
  };
  mirrors.set(pty, mirror);

  pty.onData(data => {
    if (mirrors.get(pty) !== mirror) return;
    try {
      mirror.snapshot = undefined;
      mirror.core.writeSync(data);
      mirror.repaint?.endChunk();
    } catch (err) {
      // node-pty calls its data listeners in a loop with nothing around them,
      // so a throw here would cost the chunk to every listener after this one:
      // the panel and agent.output. Without its mirror the agent's panels fall
      // back to replaying agent.output, which is what they did before.
      console.error(`[terminal-mirror] ${opts.label}: dropped after a parse failure`, err);
      forget(pty, mirror);
    }
  });
  pty.onExit(() => forget(pty, mirror));
}

function forget(pty: IPty, mirror: Mirror): void {
  if (mirrors.get(pty) === mirror) mirrors.delete(pty);
  mirror.term.dispose();
}

/**
 * Follow the PTY to its new size. Called wherever the PTY is resized: a
 * program repaints for the size it is told, and a mirror at another size
 * would lay that repaint out differently from the panel.
 */
export function resizeTerminalMirror(pty: IPty | undefined, cols: number, rows: number): void {
  const mirror = pty && mirrors.get(pty);
  if (!mirror || !isTerminalSize(cols, rows)) return;
  mirror.snapshot = undefined;
  mirror.term.resize(cols, rows);
  // xterm reflows the normal screen into the new width, and leaves each line
  // of the alternate one at its old length, drawn only up to the edge. The
  // serialize addon writes those hidden cells too, so the fresh terminal
  // wrapped them onto the next row and every row below moved down. Measured on
  // a recording that shrinks a real Claude Code from 110 to 36 columns: 7
  // cells in 162 matched. Cut here, as xterm cuts the normal screen, and a
  // line that grows back again grows back blank until the program repaints it,
  // which it does for the resize that caused it.
  const alt = mirror.core.buffers.alt;
  for (let index = 0; index < alt.lines.length; index++) {
    const line = alt.lines.get(index);
    if (line && line.length > cols) line.resize(cols, alt.getNullCell());
  }
}

/**
 * The screen of `pty` as one chunk to write into a fresh terminal, or
 * undefined when it has no mirror.
 *
 * It opens with RIS because a panel is not always fresh when it writes this:
 * the Dashboard subscribes to live output before it asks for the screen, and
 * the tray terminal replays 400 ms after subscribing, so a chunk can land
 * first. Everything such a chunk did is already in the mirror, and wiped here
 * rather than drawn twice.
 */
export function terminalSnapshot(pty: IPty | undefined): string | undefined {
  const mirror = pty && mirrors.get(pty);
  if (!mirror) return undefined;
  if (mirror.snapshot !== undefined) return mirror.snapshot;
  const { term, core, serializer } = mirror;
  let screen = '\x1bc' + serializer.serialize();
  // The addon ends the normal screen on the program's current colours and
  // starts the alternate one as if from the defaults, so the alternate
  // screen's first cells took the colour the normal one ended on: a table's
  // borders drawn yellow, in a recording of the real Claude Code. No cell can
  // hold an escape, so the first switch in the text is the addon's own.
  if (term.buffer.active.type === 'alternate') {
    screen = screen.replace('\x1b[?1049h\x1b[H', '\x1b[0m\x1b[?1049h\x1b[H');
  }

  const encoding = core.coreMouseService.activeEncoding;
  if (encoding === 'SGR') screen += '\x1b[?1006h';
  else if (encoding === 'SGR_PIXELS') screen += '\x1b[?1016h';
  // Both ways: RIS in xterm 5.3 leaves a hidden cursor hidden.
  screen += core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h';

  // A scroll region, which the addon leaves out, and which homes the cursor.
  const { scrollTop, scrollBottom } = core.buffer;
  if (scrollTop !== 0 || scrollBottom !== term.rows - 1) {
    screen += `\x1b[${scrollTop + 1};${scrollBottom + 1}r`;
  }
  // The cursor, put back absolutely and last. The addon moves it back relative
  // to where its own writing stopped, and after a row written to its last
  // column xterm waits to wrap, so that move landed a column short; origin
  // mode, which it writes after the cursor, sends it to the region's first
  // line. A cursor that was itself waiting to wrap comes back on the last
  // column: no move reaches past it.
  const buffer = term.buffer.active;
  const row = buffer.cursorY - (core.coreService.decPrivateModes.origin ? scrollTop : 0);
  screen += `\x1b[${row + 1};${Math.min(buffer.cursorX, term.cols - 1) + 1}H`;
  mirror.snapshot = screen;
  return screen;
}

/**
 * True when the screen of `pty` ends on a dialog's footer: "Esc to cancel" in
 * one of its last three non-blank rows. Both dialogs measured with claude
 * 2.1.280 end on it: "Enter to select · ↑/↓ to navigate · Esc to cancel" (an
 * AskUserQuestion) and " Esc to cancel · Tab to amend" (a permission); so do
 * its pickers, which read keys the same way. A running turn ends on "esc to
 * interrupt", and the input box on its own footer, so a sentence in the
 * conversation above is never among those rows. Read from the cells, where a
 * word drawn by a cursor move after the one before it still has its space.
 *
 * Only ever a reason to hold a message (the PermissionRequest hook came 3 to
 * 648 ms after the dialog was drawn, in this PR's in-app proof), never a
 * reason to type: a dialog the hook reported stays one whatever this says.
 */
export function dialogOnScreen(pty: IPty | undefined): boolean {
  const mirror = pty && mirrors.get(pty);
  if (!mirror) return false;
  const buffer = mirror.term.buffer.active;
  const rows: string[] = [];
  for (let y = buffer.viewportY + mirror.term.rows - 1; y >= buffer.viewportY && rows.length < 3; y--) {
    const text = buffer.getLine(y)?.translateToString(true).trim() ?? '';
    if (text) rows.push(text);
  }
  return rows.some(row => /\bEsc\s+to\s+cancel\b/.test(row));
}

/**
 * The text a terminal shows, one entry per row, for reading rather than
 * drawing: the normal screen's history and screen, then the alternate screen
 * while it is the one shown. A row wrapped onto the next is joined to it, the
 * blanks at a row's end are dropped, and so are empty rows.
 *
 * Read from the cells, so a space a program drew as a cursor move is there,
 * and a row it rewrote after a carriage return (a spinner, a countdown) is the
 * row as it ended. The Logs page split the raw stream on line breaks instead,
 * and Claude Code, which draws with cursor moves, read as one run of glued
 * words (JeanBrasse, 2026-10-01). Claude Code 2.1.286 draws on the alternate screen
 * by default, where the normal one stays empty.
 */
function textOf(term: Terminal): string[] {
  const rows: string[] = [];
  const read = (buffer: Terminal['buffer']['normal']) => {
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text;
      else rows.push(text);
    }
  };
  read(term.buffer.normal);
  if (term.buffer.active.type === 'alternate') read(term.buffer.alternate);
  return rows.map(row => row.trimEnd()).filter(row => row.trim().length > 0);
}

/** The text of `pty`'s screen and history (see textOf), or undefined when it has no mirror. */
export function terminalText(pty: IPty | undefined): string[] | undefined {
  const mirror = pty && mirrors.get(pty);
  return mirror ? textOf(mirror.term) : undefined;
}

/**
 * The text the kept output of a terminal that is gone would show, replayed
 * into a fresh headless one of that size (see textOf), or undefined when
 * xterm-headless could not be loaded. 97 ms for the 43 agents of a real fleet,
 * 4300 chunks, measured on 2026-10-01.
 */
export function replayText(chunks: readonly string[], size: { cols: number; rows: number }): string[] | undefined {
  if (!xterm || !isTerminalSize(size.cols, size.rows)) return undefined;
  const term = new xterm.Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: MIRROR_SCROLLBACK,
    convertEol: true,
    allowProposedApi: true,
    logLevel: 'error',
  });
  try {
    const core = (term as unknown as { _core: XtermInternals })._core;
    for (const chunk of chunks) core.writeSync(chunk);
    return textOf(term);
  } finally {
    term.dispose();
  }
}

/**
 * True when the program in `pty` repaints inline on an alternate screen it
 * never left. See RepaintWatch.
 */
export function leftFullscreenIn(pty: IPty | undefined): boolean {
  const mirror = pty && mirrors.get(pty);
  return mirror?.repaint?.leftFullscreen ?? false;
}

/** Chunks the watch looks back over before it decides anything. */
export const REPAINT_WINDOW = 8;
/** Relative moves in that window, with no absolute one, that make it inline. */
export const INLINE_MOVES = 4;

/**
 * Notice a CLI that left fullscreen without telling its terminal.
 *
 * Claude Code 2.1.280 was seen on 2026-09-22 drawing inline in the middle of a
 * session that had started fullscreen, twice among seventeen sessions, and
 * without sending `?1049l` or withdrawing its mouse request. Every panel still
 * held the alternate screen, which keeps no history, and still forwarded the
 * wheel as reports the inline CLI ignores: the wheel did nothing at all. The
 * trigger is upstream and unknown (QA's report of that night); what the
 * terminal can do is say so, and let a panel stop forwarding the wheel and
 * offer the history or a restart.
 *
 * The two renderers draw differently, measured by QA on whole streams of the
 * real 2.1.280. Fullscreen positions absolutely, `CSI row;col H`, 208 to 898
 * times per recording, and never moves the cursor up or back: zero `CSI A`
 * and zero `CSI D` in five recordings and two sandbox agents. Inline repaints
 * by moving back up over what it drew, `CSI A` and `CSI D`, and positions
 * absolutely at most twice. A terminal on its alternate screen that receives
 * the second kind is the state the wheel died in.
 *
 * Decided over a window of chunks rather than one sequence, with no absolute
 * move anywhere in it, so a fullscreen program that climbs with `CSI A` and
 * then homes the cursor in the next chunk is not taken for inline. Sticky:
 * once flagged it stays until absolute repaints come back with no relative
 * ones, the screen is switched (a program asking for the alternate screen is
 * a fullscreen program), the terminal is back on its normal screen (`?1049l`,
 * RIS), or the PTY is replaced, since this belongs to the mirror of one PTY.
 */
class RepaintWatch {
  leftFullscreen = false;
  private window: Array<{ absolute: number; relative: number }> = [];
  private absolute = 0;
  private relative = 0;

  constructor(private readonly term: Terminal, private readonly label: string) {
    const parser = term.parser;
    const absolute = () => { this.absolute++; return false; };
    const relative = () => { this.relative++; return false; };
    // `false` everywhere: xterm still performs what it is told, this only counts.
    parser.registerCsiHandler({ final: 'H' }, absolute);
    parser.registerCsiHandler({ final: 'f' }, absolute);
    parser.registerCsiHandler({ final: 'd' }, absolute);
    parser.registerCsiHandler({ final: 'A' }, relative);
    parser.registerCsiHandler({ final: 'D' }, relative);
    const screenSwitch = (params: (number | number[])[]) => {
      if (params.some(p => p === 47 || p === 1047 || p === 1049)) this.reset();
      return false;
    };
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, screenSwitch);
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, screenSwitch);
    // RIS needs nothing of its own: it puts xterm back on the normal screen,
    // and endChunk resets on that.
  }

  private reset(): void {
    this.window = [];
    this.absolute = 0;
    this.relative = 0;
    this.leftFullscreen = false;
  }

  /** After each chunk has been parsed. */
  endChunk(): void {
    if (this.term.buffer.active.type !== 'alternate') {
      this.reset();
      return;
    }
    this.window.push({ absolute: this.absolute, relative: this.relative });
    this.absolute = 0;
    this.relative = 0;
    if (this.window.length > REPAINT_WINDOW) this.window.shift();
    if (this.window.length < REPAINT_WINDOW) return;

    let absolute = 0;
    let relative = 0;
    for (const chunk of this.window) {
      absolute += chunk.absolute;
      relative += chunk.relative;
    }
    const was = this.leftFullscreen;
    if (absolute === 0 && relative >= INLINE_MOVES) this.leftFullscreen = true;
    else if (absolute > 0 && relative === 0) this.leftFullscreen = false;
    if (this.leftFullscreen !== was) {
      console.warn(this.leftFullscreen
        ? `[terminal-mirror] ${this.label}: repaints inline on an alternate screen it never left`
        : `[terminal-mirror] ${this.label}: repaints fullscreen again`);
    }
  }
}

function isTerminalSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0;
}

/**
 * The size each agent's panel last asked for, by agent id.
 *
 * A PTY created before its panel had sized itself kept the size it was spawned
 * with, 120x30 or 120x40: the panel's resize had arrived while the agent had
 * no PTY and was dropped, and a panel only sends its size again when that size
 * changes. Measured by the Audit: a panel at 179x41 in front of a PTY still at
 * 120x30, so Claude drew 120 columns into it and the wheel's coordinates were
 * off. Remembered here whether or not a PTY exists, and read by spawnAgentPty
 * for every new one.
 *
 * Kept for the life of the app and never pruned: one entry per agent a panel
 * has shown, and a new PTY for a deleted agent is never asked for.
 */
const panelSizes = new Map<string, { cols: number; rows: number }>();

export function rememberPanelSize(agentId: string, cols: number, rows: number): boolean {
  if (!isTerminalSize(cols, rows)) return false;
  panelSizes.set(agentId, { cols, rows });
  return true;
}

export function panelSizeOf(agentId: string | undefined): { cols: number; rows: number } | undefined {
  return agentId ? panelSizes.get(agentId) : undefined;
}
