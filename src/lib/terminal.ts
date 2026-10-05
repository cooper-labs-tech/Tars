import type { Terminal } from 'xterm';

/**
 * Strip Ink/ANSI cursor movement sequences that break during output replay.
 */
export function stripCursorSequences(data: string): string {
  return data
    .replace(/\x1b\[\d*[ABCDEFGH]/g, '')
    .replace(/\x1b\[\d*;\d*[Hf]/g, '')
    .replace(/\x1b\[\d*K/g, '')
    .replace(/\x1b\[\d*J/g, '')
    .replace(/\x1b\[?[su78]/g, '')
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[\?1049[hl]/g, '');
}

/**
 * Replies xterm sends to the PTY on its own, in answer to a query from the
 * program running there. They reach `onData` exactly like a keystroke, so every
 * terminal that forwards `onData` has to drop them.
 *
 * Every alternative matches a COMPLETE sequence, from the ESC to its final
 * byte. That is the whole point: the previous filter knew `\x1b[?...c` (DA1)
 * but not `\x1b[>...c` (DA2), and carried an unanchored `\d+;\d+c` rule meant
 * to mop up stray fragments. On xterm's DA2 reply `\x1b[>0;276;0c` that rule
 * matched `276;0c` in the middle and left the head `\x1b[>0;` behind, which was
 * then typed into the PTY as a truncated escape sequence. A rule that can match
 * part of a sequence manufactures fragments instead of removing them.
 *
 * Mouse reports are here too. `suppressMouseTracking` refuses the tracking
 * modes in the parser, but it passes mixed mode sets through on purpose, so a
 * report can still be produced; these panels never forward one.
 */
const TERMINAL_REPLIES = new RegExp([
  '\\x1b\\[\\?[0-9;]*c',        // DA1: \x1b[?1;2c
  '\\x1b\\[>[0-9;]*c',          // DA2: \x1b[>0;276;0c
  '\\x1b\\[\\??[0-9;]*\\$y',    // DECRPM, private and ANSI modes: \x1b[?1;2$y, \x1b[4;2$y
  '\\x1b\\[[0-9;]*R',           // CPR: \x1b[24;80R
  '\\x1b\\[[0-9;]*n',           // DSR: \x1b[0n
  '\\x1b\\[[0-9;]*t',           // window reports: \x1b[8;24;80t, \x1b[4;600;800t
  '\\x1b\\[[IO]',               // focus in / focus out
  '\\x1b\\[<[0-9;]*[Mm]',       // SGR mouse report: \x1b[<35;48;1M
  '\\x1b\\[M[\\s\\S]{3}',       // X10 mouse report: \x1b[M + 3 bytes
  // OSC reply, ended by BEL or ST: the colours (4, 10, 11, 12), as
  // \x1b]11;rgb:0f0f/0f0f/0f0f\x1b\\. Claude Code asks for the background
  // (#314), and the answer typed in as keys held a message for ever.
  '\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)',
  '\\x1bP[\\s\\S]*?(?:\\x07|\\x1b\\\\)', // DCS reply (XTVERSION, DECRQSS), ended by BEL or ST
].join('|'), 'g');

/**
 * Remove the terminal's own replies from a chunk of `onData`, leaving whatever
 * the user actually typed. Returns '' when the chunk was nothing but replies.
 */
export function stripTerminalReplies(data: string): string {
  return data.replace(TERMINAL_REPLIES, '');
}

/**
 * DEC private modes a full-screen app sets to take the mouse over: 9 (X10),
 * 1000/1001/1002/1003 (tracking protocols) and 1005/1006/1015/1016 (report
 * encodings).
 */
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

/**
 * The mouse a program asked for and `suppressMouseTracking` kept from xterm,
 * recorded the way xterm 5.3 applies those modes: 9, 1000, 1002 and 1003 set
 * the tracking protocol and resetting any of them turns tracking off; 1006 and
 * 1016 set the report encoding and resetting either restores the default; RIS
 * clears both. xterm 5.3 ignores 1001, 1005 and 1015, and so does this.
 */
interface MouseRequest {
  protocol: 0 | 9 | 1000 | 1002 | 1003;
  encoding: 0 | 1006 | 1016;
}

const mouseRequests = new WeakMap<Terminal, MouseRequest>();

/**
 * Refuse the mouse-tracking DEC private modes.
 *
 * The failure: no panel in the board could scroll and no text could be
 * selected. Claude Code re-arms mouse tracking on nearly every redraw, so its
 * output is riddled with `\x1b[?1002h` / `\x1b[?1006h` and (because the tail is
 * all that survives) never with the matching `l` disables. Two ways in:
 * live output, and the stored transcript replayed when a panel mounts, which
 * armed mouse tracking on sessions that had exited long ago.
 *
 * Once xterm honours those, it calls `selectionService.disable()` and takes the
 * wheel over to encode it as a mouse report - so the viewport never scrolls,
 * nothing is selectable, and the reports go out to the pty as stray
 * `\x1b[<35;48;1M` text. These panels are a monitoring board, not a full
 * emulator: scrollback and selection are worth more here than app-side mouse
 * support, so the modes are swallowed in the parser.
 *
 * Registered handlers run before the built-in one and `true` stops the
 * sequence, so the mode is never set. Mixed sets that also carry an unrelated
 * mode are passed through rather than dropped wholesale.
 *
 * What was refused is still recorded, with the resets, for
 * `passWheelToProgram`: a program that asked for wheel reports gets those, and
 * nothing else of the mouse.
 */
export function suppressMouseTracking(term: Terminal): void {
  const request: MouseRequest = { protocol: 0, encoding: 0 };
  mouseRequests.set(term, request);
  const record = (params: (number | number[])[], set: boolean) => {
    for (const p of params) {
      if (p === 9 || p === 1000 || p === 1002 || p === 1003) request.protocol = set ? p : 0;
      else if (p === 1006 || p === 1016) request.encoding = set ? p : 0;
    }
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
    const mouse = params.length > 0 &&
      params.every(p => typeof p === 'number' && MOUSE_TRACKING_MODES.has(p));
    if (mouse) record(params, true);
    return mouse;
  });
  // `false` on both: xterm still applies resets and RIS itself.
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
    record(params, false);
    return false;
  });
  term.parser.registerEscHandler({ final: 'c' }, () => {
    request.protocol = 0;
    request.encoding = 0;
    return false;
  });
}

/**
 * xterm's own condition for turning the wheel into arrow keys: the active
 * buffer keeps no history. The alternate screen never does; a normal buffer
 * only with scrollback 0 (1000 is xterm's default when the option was never
 * set).
 */
function wheelTypesArrows(term: Terminal): boolean {
  return term.buffer.active.type === 'alternate' || (term.options.scrollback ?? 1000) <= 0;
}

/**
 * Keep the wheel from typing into the program on the other end.
 *
 * On a buffer with no history, which is the alternate screen every full-screen
 * CLI holds, xterm 5.3 turns wheel travel into arrow keys: one `ESC [ A` or
 * `ESC [ B` (`ESC O A` / `ESC O B` in application cursor mode) per line
 * scrolled, sent through `onData` exactly like a keystroke. It is the `wheel`
 * listener xterm registers on its own element. A mouse protocol would have
 * made it a mouse report instead, but `suppressMouseTracking` refuses those, so
 * arrows are what went out. At Claude Code's prompt an arrow walks back through
 * the messages already sent: scrolling to read the conversation put an old
 * message in the box, one Enter away from being sent again. Measured on a
 * Dashboard panel: six notches of a mouse wheel wrote 120 bytes, forty arrows,
 * and one trackpad swipe sixteen.
 *
 * `stripTerminalReplies` cannot catch it, because those bytes are exactly what
 * the arrow keys send. The only place the two still differ is before xterm,
 * while the event is a wheel. A capture listener on the terminal's element runs
 * ahead of xterm's own, which sits on that element in the bubble phase, and
 * stopping the event there leaves xterm nothing to convert. The mouse and the
 * trackpad are the same event: a trackpad sends small pixel deltas that xterm
 * adds up into lines, so dropping every event also drops the sum, inertia
 * included. The main buffer is left alone, since there the wheel scrolls the
 * history, which is what it is for.
 *
 * Call it right after `term.open()`, which creates the element.
 */
export function stopWheelTyping(term: Terminal): void {
  term.element?.addEventListener('wheel', event => {
    if (!wheelTypesArrows(term)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, passive: false });
}

/**
 * Scroll a full-screen CLI with the wheel, the one part of the mouse it gets.
 *
 * Claude Code with `"tui": "fullscreen"` in its settings keeps the conversation
 * itself and draws it on the alternate screen, where xterm has no history to
 * scroll: once `stopWheelTyping` stopped the wheel typing arrows there, the
 * wheel did nothing at all. Claude Code scrolls its conversation on wheel
 * reports, and asks for them as it starts, on every resize and again when
 * input reaches it (`?1000h ?1002h ?1003h ?1006h`). `suppressMouseTracking`
 * still keeps the mouse from xterm, so clicks, drags, selection and
 * Option+click stay here; only the wheel goes to the program, encoded as xterm
 * would have encoded it: SGR, button 64 up and 65 down, the cell under the
 * pointer, Alt and Ctrl added.
 *
 * One report per line of travel, measured the way xterm measures its own
 * scroll: pixels over the row height, the remainder carried to the next event.
 * Claude Code moves one line per report here. It moves three for xterm.js, but
 * it recognises xterm.js by the reply to XTVERSION, which xterm 5.3 never
 * sends, and one report per event moved a mouse notch a single line.
 *
 * Only when the program asked for tracking with SGR reports, and xterm is not
 * tracking the mouse itself (a mixed mode set it let through). Otherwise the
 * wheel is `stopWheelTyping`'s: stopped where it would type arrows, left to
 * xterm where there is history to scroll. Use it instead of `stopWheelTyping`
 * on a terminal that forwards to a CLI, after `suppressMouseTracking`, right
 * after `term.open()`.
 *
 * The request is read from the output this terminal parsed. A panel rebuilt
 * from stored output that no longer reaches back to it (a long turn with no
 * input fills the stored chunks) forwards nothing until Claude Code asks again,
 * at the next key or resize.
 *
 * Measured with Claude Code 2.1.273, in a Dashboard panel and in fullscreen:
 * the conversation scrolls back to its first line, no line is cut or
 * overlapped on any screen, and a round trip through fullscreen keeps it so.
 */
export function passWheelToProgram(term: Terminal, send: (data: string) => void): void {
  let travel = 0;
  term.element?.addEventListener('wheel', event => {
    const request = mouseRequests.get(term);
    const wanted = request !== undefined && request.protocol >= 1000 && request.encoding === 1006 &&
      term.modes.mouseTrackingMode === 'none';
    if (!wanted && !wheelTypesArrows(term)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // xterm scrolls nothing for a horizontal or shifted wheel either.
    if (!wanted || event.deltaY === 0 || event.shiftKey) return;
    const box = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const rowHeight = box.height / term.rows;
    // deltaMode 0 is pixels, 1 lines, 2 pages (WheelEvent.DOM_DELTA_*, written
    // out so this runs where WheelEvent is not defined, as in the unit tests).
    travel += event.deltaMode === 0 ? event.deltaY / rowHeight
      : event.deltaMode === 2 ? event.deltaY * term.rows
        : event.deltaY;
    const lines = Math.trunc(travel);
    travel -= lines;
    if (lines === 0) return;
    const col = Math.min(Math.max(Math.floor((event.clientX - box.left) / (box.width / term.cols)), 0), term.cols - 1) + 1;
    const row = Math.min(Math.max(Math.floor((event.clientY - box.top) / rowHeight), 0), term.rows - 1) + 1;
    const button = (lines < 0 ? 64 : 65) | (event.altKey ? 8 : 0) | (event.ctrlKey ? 16 : 0);
    send(`\x1b[<${button};${col};${row}M`.repeat(Math.abs(lines)));
  }, { capture: true, passive: false });
}

/**
 * Install the terminal's custom key handler. xterm keeps exactly one, so every
 * key this app claims has to live here:
 *
 * - Shift+Enter inserts a literal newline (bracketed paste) instead of
 *   submitting the current line.
 * - Cmd/Ctrl+C copies the selection. There was no copy path at all: xterm
 *   paints its selection itself rather than making a DOM Selection, so the
 *   native copy had nothing to take and Cmd+C left the clipboard untouched.
 *   With no selection it falls through, which keeps Ctrl+C as interrupt.
 *
 * @param term     - The xterm Terminal instance
 * @param sendFn   - Callback that forwards the escape sequence to the PTY/agent
 */
export function attachShiftEnterHandler(
  term: Terminal,
  sendFn: (data: string) => void,
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    if (event.key === 'Enter' && event.shiftKey) {
      // Use bracket paste mode to insert a literal newline without submitting
      sendFn('\x1b[200~\n\x1b[201~');
      return false;
    }

    const copyChord = event.metaKey || (event.ctrlKey && event.shiftKey);
    if (copyChord && (event.key === 'c' || event.key === 'C') && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      return false;
    }

    return true;
  });
}

/**
 * Dispose a terminal without racing the frame xterm scheduled for it.
 *
 * `term.open()` constructs the Viewport, and that constructor ends with
 * `requestAnimationFrame(() => this.syncScrollArea())` while keeping no handle
 * for it. Nothing can cancel that frame, `dispose()` included, so a terminal
 * disposed inside the window leaves the callback to read a render service that
 * is already gone: `Cannot read properties of undefined (reading 'dimensions')`.
 *
 * Measured on the plugin install dialog: closing it 1500, 400 or 120 ms after
 * opening threw nothing, closing it after 30 ms threw. The window is one frame
 * wide, and the only thing our own code can do about a handle it cannot reach
 * is stop disposing inside it. A timer rather than a frame on purpose: an
 * animation frame does not run in a window that is in the background, and a
 * terminal that is never disposed would be the worse bug.
 *
 * Callers should drop their own reference first, so nothing writes to a
 * terminal that is on its way out.
 *
 * 40 ms is a threshold, not a guarantee: a frame can run late on a loaded main
 * thread, and in a backgrounded window it does not run until the window comes
 * back, which is after this timer. Those cases fall back to the old behaviour
 * for that one terminal, a console error and nothing else. Covering them for
 * real would mean a handle on the frame, which only xterm can give.
 */
export function disposeTerminalSafely(term: Pick<Terminal, 'dispose'>): void {
  setTimeout(() => term.dispose(), 40);
}

/** What a terminal says when keys typed into it reach no terminal in main. */
export const NOT_RUNNING_LINE = '\r\n\x1b[90m(Not running: start this agent to type here.)\x1b[0m\r\n';

/**
 * Sends the keys a person types to an agent's terminal, and says so in `term`
 * when they reach none. Since #164 an idle agent has no terminal until it is
 * started, and agent:input answers `{ success: false }` for it; the panels,
 * the agent dialog and the tray dropped that answer, so an idle panel took
 * keys and nothing happened. Said once for a run of refused keys, not per key;
 * a key that lands starts the count again. The wheel does not come through
 * here: scrolling an idle panel is not typing into it.
 */
export function keySender(
  term: Pick<Terminal, 'write'>,
  send: (input: string) => Promise<{ success: boolean } | undefined>,
): (input: string) => void {
  let said = false;
  const refused = () => {
    if (said) return;
    said = true;
    term.write(NOT_RUNNING_LINE);
  };
  return (input: string) => {
    send(input).then(
      result => {
        if (result?.success) said = false;
        else refused();
      },
      refused,
    );
  };
}

/** The agent dialog's first line: connected only to an agent that has a terminal. */
export function connectionLine(name: string, live: boolean): string {
  return live
    ? `\x1b[36m● Connected to ${name}\x1b[0m`
    : `\x1b[90m○ ${name} is not running. Start it to type here.\x1b[0m`;
}
