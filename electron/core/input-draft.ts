/**
 * What JeanBrasse has typed into an agent's input field and not sent, as far as Tars
 * can know it from the keys it relays.
 *
 * Every key typed into an agent's terminal passes through the main process
 * (`agent:input`, then `writeToPty`), so the field can be rebuilt from them:
 * this is that rebuild, and nothing else. It never reads the screen. It knows
 * a small set of keys and gives up on everything else: a draft Tars is not
 * sure of is never touched (see `writeProgrammaticInput`), so giving up is the
 * safe answer and guessing is the unsafe one.
 *
 * Every rule below was measured on Claude Code 2.1.273 in a real terminal,
 * `tui: fullscreen` as JeanBrasse runs it, keys sent the way xterm sends them, and
 * what each submission carried read from its UserPromptSubmit hook (2026-09-18):
 * - Left and Right move over the whole text, newlines included; Home, End,
 *   Ctrl+A and Ctrl+E stop at the current line; Backspace joins lines.
 * - Ctrl+C empties the field, idle or in the middle of a turn, and does not
 *   interrupt the turn.
 * - Option+Enter (ESC CR) inserts a newline, 9 times out of 9; so does a
 *   backslash before Enter, 9 out of 9, and the backslash goes.
 * - A paste of more than 800 characters, or of four lines or more, shows as
 *   `[Pasted text #N]`, numbered per session: it cannot be put back as it was.
 * - A paste that is nothing but a newline, which is what the panels send for
 *   Shift+Enter, was dropped 9 times out of 12. Whether the newline is in the
 *   field is therefore unknowable.
 * - Up and Down recall history on the first and last line, Tab completes, a
 *   lone Esc arms "Esc again to clear" or, on an empty field, the rewind
 *   dialog: none of them can be followed from the keys alone.
 * - The UserPromptSubmit hook runs 33 to 57 ms after the Enter that submits
 *   (five submissions, median 41), which is what makes it usable as proof
 *   that a field emptied.
 */

/** Pastes longer than this are folded into a placeholder. 800 stayed inline, 900 folded. */
const PASTE_FOLD_CHARS = 800;
/** Pastes of more lines than this are folded too. Three stayed inline, four folded. */
const PASTE_FOLD_LINES = 3;

export interface Draft {
  /** The field as the model has it, newlines included. */
  text: string;
  /** The caret, as an index into `text`. */
  cursor: number;
  /**
   * `known`: `text` and `cursor` are what the field holds.
   * `pending`: Enter went by on a field the model could not vouch for. It was
   * most likely a submission, which empties the field, and the keys typed
   * since are kept on top of an empty field; the UserPromptSubmit that such a
   * submission sends turns this into `known`.
   * `unknown`: a key went by that the model cannot follow.
   */
  state: 'known' | 'pending' | 'unknown';
}

export function emptyDraft(): Draft {
  return { text: '', cursor: 0, state: 'known' };
}

type Token =
  | { k: 'text'; s: string }
  | { k: 'paste'; s: string }
  | { k: 'enter' }
  | { k: 'newline' }
  | { k: 'backspace' }
  | { k: 'delete' }
  | { k: 'left' }
  | { k: 'right' }
  | { k: 'home' }
  | { k: 'end' }
  | { k: 'clear' }
  | { k: 'ignore' }
  | { k: 'other' };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** The one-byte keys the model follows. */
const CONTROL: Record<string, Token['k']> = {
  '\r': 'enter',
  '\x7f': 'backspace',
  '\x08': 'backspace',
  '\x01': 'home',
  '\x05': 'end',
  '\x03': 'clear',
};

/** The escape sequences the model follows, in both cursor-key modes. */
const SEQUENCES: Record<string, Token['k']> = {
  '\x1b\r': 'newline',
  '\x1b[D': 'left', '\x1bOD': 'left',
  '\x1b[C': 'right', '\x1bOC': 'right',
  '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home',
  '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end',
  '\x1b[3~': 'delete',
  // Not keys: focus reports. The panels strip them, the model ignores them.
  '\x1b[I': 'ignore', '\x1b[O': 'ignore',
};

/**
 * A terminal's replies, which a panel passes on with what is typed: never a
 * key. A CLI asks the terminal something and xterm answers in the input stream
 * (bug-held-forever-05-10.md: Claude Code's `ESC ] 11 ; ?`, answered with the
 * background colour, read as keys, left the draft unknown, and messages waited
 * hours for a person to clear an empty field). The panels strip most of these
 * (src/lib/terminal.ts); this is the main process's own guard.
 * - DA1 `ESC [ ? 1 ; 2 c`, DA2 `ESC [ > 0 ; 276 ; 0 c`
 * - CPR `ESC [ 24 ; 80 R` (Shift+F3 has the same bytes, and moves nothing in a field)
 * - DSR `ESC [ 0 n`, DECRPM `ESC [ ? 2004 ; 1 $ y`, window reports `ESC [ 8 ; 24 ; 80 t`
 * OSC and DCS strings are replies whatever they say, once ended (see tokenize).
 */
const CSI_REPLY = /^\x1b\[(?:\?[\d;]*c|>[\d;]*c|\d+;\d+R|\d*n|\??[\d;]*\$y|\d+;\d+;\d+t)$/;

/** Where an OSC or DCS string that starts at `i` ends (after its BEL or ST), or -1 when the chunk does not end it. */
function stringEnd(data: string, i: number): number {
  for (let j = i + 2; j < data.length; j++) {
    if (data[j] === '\x07') return j + 1;
    if (data[j] === '\x1b' && data[j + 1] === '\\') return j + 2;
  }
  return -1;
}

/** An escape sequence's length at `i`, or 0 when it is a lone ESC. */
function sequenceLength(data: string, i: number): number {
  const next = data[i + 1];
  if (next === undefined) return 1;
  if (next === '[') {
    // A mouse report in the X10 encoding carries three raw bytes after `M`.
    if (data[i + 2] === 'M') return Math.min(6, data.length - i);
    let j = i + 2;
    while (j < data.length && !/[\x40-\x7e]/.test(data[j])) j++;
    return Math.min(j + 1, data.length) - i;
  }
  if (next === 'O') return Math.min(3, data.length - i);
  return 2;
}

/** Splits one `onData` chunk into the keys it holds. */
function tokenize(data: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let run = '';
  const flush = () => { if (run) { tokens.push({ k: 'text', s: run }); run = ''; } };
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      flush();
      const end = data.indexOf(PASTE_END, i + PASTE_START.length);
      if (end < 0) { tokens.push({ k: 'other' }); break; }
      tokens.push({ k: 'paste', s: data.slice(i + PASTE_START.length, end) });
      i = end + PASTE_END.length;
      continue;
    }
    const ch = data[i];
    if (ch === '\x1b' && (data[i + 1] === ']' || data[i + 1] === 'P')) {
      // An OSC or DCS string: a reply of the terminal's, never a key. One the
      // chunk does not end is not followed: what comes after it cannot be read.
      flush();
      const end = stringEnd(data, i);
      if (end < 0) { tokens.push({ k: 'other' }); break; }
      tokens.push({ k: 'ignore' });
      i = end;
      continue;
    }
    if (ch === '\x1b') {
      flush();
      const len = sequenceLength(data, i);
      const seq = data.slice(i, i + len);
      if (/^\x1b\[<[\d;]*[Mm]$/.test(seq) || /^\x1b\[M/.test(seq) || CSI_REPLY.test(seq)) tokens.push({ k: 'ignore' });
      else tokens.push({ k: SEQUENCES[seq] ?? 'other' } as Token);
      i += len;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      flush();
      tokens.push({ k: CONTROL[ch] ?? 'other' } as Token);
      i++;
      continue;
    }
    run += ch;
    i++;
  }
  flush();
  return tokens;
}

/** Does this chunk hold anything a person typed, as opposed to a mouse or focus report, or a terminal's reply? */
export function isKeystroke(data: string): boolean {
  return tokenize(data).some(t => t.k !== 'ignore');
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf('\n', cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const i = text.indexOf('\n', cursor);
  return i < 0 ? text.length : i;
}

function insert(d: Draft, s: string): Draft {
  return { ...d, text: d.text.slice(0, d.cursor) + s + d.text.slice(d.cursor), cursor: d.cursor + s.length };
}

/**
 * What a paste leaves in the field, or undefined when it cannot be known.
 *
 * xterm turns the newlines of a pasted text into CR; the field shows them as
 * line breaks, so that is how they are kept here.
 */
function pastedText(s: string): string | undefined {
  const text = s.replace(/\r\n?/g, '\n');
  if (!text.replace(/\n/g, '')) return undefined;
  if (text.length > PASTE_FOLD_CHARS || text.split('\n').length > PASTE_FOLD_LINES) return undefined;
  return text;
}

function apply(d: Draft, t: Token): Draft {
  if (t.k === 'ignore') return d;
  // Ctrl+C empties the field whatever was in it.
  if (t.k === 'clear') return emptyDraft();
  // Enter is the other key that says something about a field this has lost
  // track of: whatever was in it, a submission empties it. Not `known`,
  // because nothing here can tell a submission from a dialog answering
  // itself, but followable again from empty, and the UserPromptSubmit hook
  // settles which it was. Without this an `unknown` field stayed unknown for
  // ever and only Ctrl+C ever got out of it, so a message held behind one
  // waited through a whole submission and a whole turn of the agent.
  if (t.k === 'enter' && d.state === 'unknown') return { text: '', cursor: 0, state: 'pending' };
  if (d.state === 'unknown') return d;

  switch (t.k) {
    case 'text':
      return insert(d, t.s);
    case 'paste': {
      const text = pastedText(t.s);
      return text === undefined ? { ...d, state: 'unknown' } : insert(d, text);
    }
    case 'newline':
      return insert(d, '\n');
    case 'enter':
      if (d.cursor === d.text.length && d.text.endsWith('\\')) {
        return { ...d, text: d.text.slice(0, -1) + '\n' };
      }
      // A slash command can open a dialog instead of emptying the field.
      if (d.state === 'known' && !d.text.startsWith('/')) return emptyDraft();
      return { text: '', cursor: 0, state: 'pending' };
    case 'backspace':
      if (d.cursor === 0) return d;
      return { ...d, text: d.text.slice(0, d.cursor - 1) + d.text.slice(d.cursor), cursor: d.cursor - 1 };
    case 'delete':
      if (d.cursor === d.text.length) return d;
      return { ...d, text: d.text.slice(0, d.cursor) + d.text.slice(d.cursor + 1) };
    case 'left':
      return { ...d, cursor: Math.max(0, d.cursor - 1) };
    case 'right':
      // At the very end they would move nothing, which is where a terminal
      // that offers an inline suggestion accepts it instead. The bench never
      // saw one (they need account feature flags a stub cannot serve), so the
      // keys that could take one are not followed where that is all they can do.
      return d.cursor === d.text.length ? { ...d, state: 'unknown' } : { ...d, cursor: d.cursor + 1 };
    case 'home':
      return { ...d, cursor: lineStart(d.text, d.cursor) };
    case 'end':
      return d.cursor === d.text.length ? { ...d, state: 'unknown' } : { ...d, cursor: lineEnd(d.text, d.cursor) };
    default:
      return { ...d, state: 'unknown' };
  }
}

/** The draft after one chunk of what the panel sent to the terminal. */
export function feedDraft(d: Draft, data: string): Draft {
  return tokenize(data).reduce(apply, d);
}

/**
 * A submission was seen (UserPromptSubmit): the field did empty.
 *
 * `pending` is the ordinary case, an Enter this could not vouch for, and the
 * keys typed since it have been followed on top of an empty field, so the flag
 * is all that changes.
 *
 * `unknown` is the backstop, for a submission that reached the CLI without an
 * Enter passing through `agent:input`. There the keys typed since were not
 * followed, so this claims an empty field it has not watched. The exposure is
 * the gap between the Enter and the hook, measured on Claude Code 2.1.273 over
 * five submissions at 33, 39, 41, 41 and 57 ms: under one character of fast
 * typing. Weighed against the alternative, which was a field nothing but
 * Ctrl+C could ever free, and a message that waited for ever behind it.
 */
export function confirmSubmitted(d: Draft): Draft {
  if (d.state === 'pending') return { ...d, state: 'known' };
  return d.state === 'unknown' ? emptyDraft() : d;
}

/**
 * Keys that empty the field, from the draft as it is.
 *
 * The caret goes to the end first, then Backspace takes every character: both
 * cross newlines. Deliberately neither Ctrl+U nor Ctrl+C. Ctrl+U stops at the
 * current line and fills the kill ring JeanBrasse may be using, and Ctrl+C on a
 * field that turned out to be empty arms "press again to exit".
 */
export function clearKeys(d: Draft): string {
  return '\x1b[C'.repeat(d.text.length - d.cursor) + '\x7f'.repeat(d.text.length);
}

/**
 * Keys that type the draft back, in writes small enough to be taken as typing.
 *
 * Not one paste: a paste of more than 800 characters would be folded into
 * `[Pasted text #N]`, and a single write of 1000 characters is folded as well,
 * markers or not. Written in pieces of 100, 1000 characters stayed inline.
 * Newlines go in as Option+Enter, the only form that always inserts one. The
 * caret is then walked back to where JeanBrasse left it.
 */
export function restoreKeys(d: Draft, piece = 100): string[] {
  const writes: string[] = [];
  d.text.split('\n').forEach((line, i) => {
    if (i > 0) writes.push('\x1b\r');
    for (let at = 0; at < line.length; at += piece) writes.push(line.slice(at, at + piece));
  });
  const back = d.text.length - d.cursor;
  if (back > 0) writes.push('\x1b[D'.repeat(back));
  return writes;
}
