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
  /**
   * What the terminal was sent since the CLI now in it was launched (markCliLaunch), or since the terminal began when
   * none was: replayed into a fresh terminal, it is that CLI's screen and nothing before it (rowsSinceLaunch).
   */
  launchLog?: LaunchLog;
}

interface LaunchLog {
  chunks: string[];
  /** UTF-8 bytes kept (the Audit's L4 on #601: counted in characters, wide ones ran past the cap). */
  bytes: number;
  /** More was written than is kept: what the CLI drew cannot be known from it. */
  overflowed: boolean;
  /** The last reading, kept until a chunk comes. */
  cache?: { count: number; rows: string[] };
  /** Lets it go at the launch window's end, written to or not. */
  timer: ReturnType<typeof setTimeout>;
}

/** How much of a launch's output is kept, and for how long: the launch window (core/agent-launch.ts, CLI_UP_MS). */
const LAUNCH_LOG_BYTES = 1024 * 1024;
const LAUNCH_LOG_MS = 180_000;

/** A launch log from now, for the launch window and no longer, in place of any before it. */
function startLaunchLog(mirror: Mirror): void {
  dropLaunchLog(mirror);
  const log: LaunchLog = {
    chunks: [], bytes: 0, overflowed: false,
    timer: setTimeout(() => { if (mirror.launchLog === log) mirror.launchLog = undefined; }, LAUNCH_LOG_MS),
  };
  log.timer.unref?.();
  mirror.launchLog = log;
}

function dropLaunchLog(mirror: Mirror): void {
  if (mirror.launchLog) clearTimeout(mirror.launchLog.timer);
  mirror.launchLog = undefined;
}

function logLaunchOutput(mirror: Mirror, data: string): void {
  const log = mirror.launchLog;
  if (!log || log.overflowed) return;
  log.chunks.push(data);
  log.bytes += Buffer.byteLength(data, 'utf8');
  if (log.bytes > LAUNCH_LOG_BYTES) {
    log.overflowed = true;
    log.chunks = [];
  }
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
  opts: { cols: number; rows: number; watchRepaint: boolean; label: string; logLaunch?: boolean },
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
  // From its first byte, for a CLI that reads as up from its screen: one spawned as the terminal itself is launched with
  // it. Any other terminal keeps none (the Audit's L4 on #601).
  if (opts.logLaunch) startLaunchLog(mirror);
  mirrors.set(pty, mirror);

  pty.onData(data => {
    if (mirrors.get(pty) !== mirror) return;
    try {
      mirror.snapshot = undefined;
      mirror.core.writeSync(data);
      // After the parse, inside the guard: a chunk the mirror cannot take costs no other listener anything.
      logLaunchOutput(mirror, data);
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
  dropLaunchLog(mirror);
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
  return rows.some(row => /\bEsc\s+to\s+cancel\b/.test(row)) || codexDialogOnScreen(pty) !== undefined;
}

/**
 * codex's approval dialogs, by their titles (codex-cli 0.163.0's own strings), and the form it draws before each
 * call of an MCP server's tool in normal mode (measured: `Allow the probe MCP server to run tool "ping"?`).
 */
const CODEX_DIALOG_TITLES = [
  /Would you like to run the following command\?/,
  /Would you like to make the following edits\?/,
  /Would you like to grant these permissions\?/,
  /Do you want to approve network access to\b/,
  /Would you like to send input to terminal\b/,
  /\bMCP server to run tool ".*"\?/,
];
/** And one of its answers under the title: a sentence in the conversation is not a dialog. */
const CODEX_DIALOG_ANSWER = /\b(?:Yes, proceed|Yes, just this once|Yes, and don't ask again|No, and tell Codex what to do differently|No, continue without|Run the tool and continue|Cancel this tool call)\b/;
/** One of its options, numbered, the selected one marked: never what the dialog asks about. */
const CODEX_DIALOG_OPTION = /^(?:[›>]\s*)?\d+\.\s/;

/**
 * codex's approval dialog on the screen of `pty`, as one line (its title and what it asks about), or undefined.
 * codex asks before a command, an edit, a permission, network access or an MCP tool's call in normal mode, and
 * says so in no file: the screen is where Tars sees it (services/codex-sessions.ts), and where a writer must not
 * type, since an Enter answers it (dialogOnScreen).
 */
export function codexDialogOnScreen(pty: IPty | undefined): string | undefined {
  const mirror = pty && mirrors.get(pty);
  if (!mirror) return undefined;
  const buffer = mirror.term.buffer.active;
  // A row the terminal wrapped onto the next is read with it, as textOf does: in a terminal narrower than the
  // dialog (a worker's column in the orchestrator layout, about 52), its title runs over two rows (train 2b).
  const lines: string[] = [];
  for (let y = buffer.viewportY; y < buffer.viewportY + mirror.term.rows; y++) {
    const line = buffer.getLine(y);
    const text = line?.translateToString(false) ?? '';
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const rows = lines.map(line => line.trim());
  // A title codex laid out itself over the next rows (up to three), ending on the row it is read to.
  const titleAt = (at: number): { title: string; end: number } | undefined => {
    let title = '';
    for (let end = at; end < Math.min(rows.length, at + 3) && rows[end]; end++) {
      title = title ? `${title} ${rows[end]}` : rows[end];
      if (CODEX_DIALOG_TITLES.some(re => re.test(title))) return { title, end };
    }
    return undefined;
  };
  // The lowest title with an answer under it: a title quoted higher up, in the conversation, is not the dialog.
  for (let at = rows.length - 1; at >= 0; at--) {
    const found = titleAt(at);
    if (!found) continue;
    const below = rows.slice(found.end + 1);
    if (!below.some(row => CODEX_DIALOG_ANSWER.test(row))) continue;
    const title = found.title.replace(/^[^A-Za-z]+/, '');
    // What it asks about lies between the title and its first option: below that, a row is an option or the end
    // of one, carried onto a row of its own in a terminal narrower than the dialog.
    const options = below.findIndex(row => CODEX_DIALOG_OPTION.test(row) || CODEX_DIALOG_ANSWER.test(row));
    const subject = below.slice(0, options).find(row => row && !/\b(?:enter|esc)\b/i.test(row));
    return subject ? `${title} ${subject.replace(/^[│|]\s*/, '')}` : title;
  }
  return undefined;
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
 * A CLI is being launched into `pty` (core/agent-manager.ts, launchIntoTerminal; core/agent-restart.ts): what the
 * terminal is sent from here on is that CLI's, and rowsSinceLaunch reads only that.
 */
export function markCliLaunch(pty: IPty | undefined, log: boolean): void {
  const mirror = pty && mirrors.get(pty);
  if (!mirror) return;
  // Only for a CLI that reads as up from its screen (CLIProvider.upOnScreen); the log of an earlier CLI goes either way.
  if (log) startLaunchLog(mirror);
  else dropLaunchLog(mirror);
}

/**
 * The line each terminal's CLI was launched with (the command typed into it, or the one it runs): what a provider's
 * upOnScreen is given with the rows, since what a CLI shows once it takes keys can depend on how it was launched
 * (opencode on a session it forks draws its home view first, core/agent-launch.ts, sessionUp).
 */
const launchLines = new WeakMap<object, string>();

export function noteLaunchLine(pty: object | undefined, line: string | readonly string[] | undefined): void {
  if (!pty) return;
  const text = Array.isArray(line) ? line.join(' ') : typeof line === 'string' ? line : '';
  if (text) launchLines.set(pty, text);
  else launchLines.delete(pty);
}

export function launchLineOf(pty: object | undefined): string | undefined {
  return pty ? launchLines.get(pty) : undefined;
}

/** How many of the bottom rows a provider's upOnScreen is given: a TUI's field and its footer, never the answer above. */
const LAUNCH_ROWS = 8;

/**
 * The bottom rows the CLI launched into `pty` has drawn since its launch, empty rows left out, at most `max`: what a
 * provider's upOnScreen reads (core/agent-launch.ts, sessionUp). What the terminal was sent since markCliLaunch (since
 * the terminal began when nothing marked a launch) is replayed into a fresh terminal of its size, so nothing from
 * before the launch can be read: no earlier CLI's box in the history, below the cursor or on an alternate screen it
 * left on, whatever the output since does to the screen (a deleted line, reverse indexes); and only the bottom rows,
 * never a box quoted higher up in an answer (the Audit's L1 and L2 on #601). Read on the alternate screen when the CLI
 * entered one. Empty when it cannot be known: more was written than is kept, or the launch window is past. Undefined
 * with no mirror.
 */
export function rowsSinceLaunch(pty: IPty | undefined, max = LAUNCH_ROWS): string[] | undefined {
  const mirror = pty && mirrors.get(pty);
  if (!mirror) return undefined;
  const log = mirror.launchLog;
  if (!log || log.overflowed || !xterm) return [];
  if (log.cache && log.cache.count === log.chunks.length) return log.cache.rows.slice(-max);
  const term = new xterm.Terminal({ cols: mirror.term.cols, rows: mirror.term.rows, scrollback: 0, convertEol: true, allowProposedApi: true, logLevel: 'error' });
  try {
    const core = (term as unknown as { _core: XtermInternals })._core;
    for (const chunk of log.chunks) core.writeSync(chunk);
    const buffer = term.buffer.active;
    const rows: string[] = [];
    for (let y = buffer.length - 1; y >= 0 && rows.length < LAUNCH_ROWS; y--) {
      const text = buffer.getLine(y)?.translateToString(true) ?? '';
      if (text.trim()) rows.unshift(text);
    }
    log.cache = { count: log.chunks.length, rows };
    return rows.slice(-max);
  } finally {
    term.dispose();
  }
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
