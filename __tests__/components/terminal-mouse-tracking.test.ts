import '../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Terminal } from 'xterm';
import { suppressMouseTracking, attachShiftEnterHandler, stripTerminalReplies } from '@/lib/terminal';

/**
 * The board's panels could not scroll and could not be selected because the
 * replayed Claude Code transcript is full of `\x1b[?1002h` / `\x1b[?1006h` and
 * carries no matching disables. xterm honours those, disables its selection
 * service and swallows the wheel to encode it as a mouse report.
 *
 * These tests drive the two pieces of the fix through a stub terminal, since
 * vitest runs in a node environment and xterm needs a document.
 */

type CsiId = { prefix?: string; final: string };
type CsiHandler = (params: (number | number[])[]) => boolean | Promise<boolean>;
type EscId = { intermediates?: string; final: string };
type EscHandler = () => boolean | Promise<boolean>;

function stubTerminal() {
  const csi: Array<{ id: CsiId; handler: CsiHandler }> = [];
  const esc: Array<{ id: EscId; handler: EscHandler }> = [];
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  const term = {
    parser: {
      registerCsiHandler: (id: CsiId, handler: CsiHandler) => {
        csi.push({ id, handler });
        return { dispose: () => {} };
      },
      registerEscHandler: (id: EscId, handler: EscHandler) => {
        esc.push({ id, handler });
        return { dispose: () => {} };
      },
    },
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => { keyHandler = h; },
    hasSelection: () => true,
    getSelection: () => 'selected text',
  };
  /** The one handler registered for this final byte, found by what it is registered for rather than by order. */
  const csiFor = (final: string) => {
    const found = csi.filter(h => h.id.prefix === '?' && h.id.final === final);
    expect(found, `handlers for CSI ? ${final}`).toHaveLength(1);
    return found[0].handler;
  };
  return {
    term: term as unknown as Terminal,
    csi,
    esc,
    csiFor,
    key: (e: Partial<KeyboardEvent>) => keyHandler!({ type: 'keydown', ...e } as KeyboardEvent),
  };
}

describe('suppressMouseTracking', () => {
  it('registers on DEC private mode set and reset, and on RIS, and on nothing else', () => {
    // Set is where the modes are refused. Reset and RIS are only watched, so the
    // request passWheelToProgram reads is withdrawn when the program withdraws it.
    const { term, csi, esc } = stubTerminal();
    suppressMouseTracking(term);
    expect(csi.map(h => h.id)).toEqual(expect.arrayContaining([{ prefix: '?', final: 'h' }, { prefix: '?', final: 'l' }]));
    expect(csi).toHaveLength(2);
    expect(esc.map(h => h.id)).toEqual([{ final: 'c' }]);
  });

  it('swallows the modes that kill scrollback and selection', () => {
    const { term, csiFor } = stubTerminal();
    suppressMouseTracking(term);
    const handled = csiFor('h');

    // Every protocol and encoding Claude Code sets.
    for (const mode of [9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]) {
      expect(handled([mode])).toBe(true);
    }
    // Combined set, still all mouse modes.
    expect(handled([1002, 1006])).toBe(true);
  });

  it('lets every unrelated private mode through', () => {
    const { term, csiFor } = stubTerminal();
    suppressMouseTracking(term);
    const handled = csiFor('h');

    // Cursor visibility, alt screen, bracketed paste, focus reporting,
    // application cursor keys, wraparound.
    for (const mode of [1, 7, 25, 1004, 1049, 2004]) {
      expect(handled([mode])).toBe(false);
    }
    // A mixed set keeps its unrelated mode rather than being dropped wholesale.
    expect(handled([1002, 25])).toBe(false);
    expect(handled([])).toBe(false);
  });

  it('lets every reset through to xterm, the mouse modes included', () => {
    // Swallowing a reset would leave xterm holding a mode the program has
    // turned off: leaving the alternate screen, among others.
    const { term, csiFor } = stubTerminal();
    suppressMouseTracking(term);
    const reset = csiFor('l');

    for (const mode of [9, 1000, 1002, 1003, 1006, 1016, 1, 25, 1049, 2004]) {
      expect(reset([mode])).toBe(false);
    }
    expect(reset([1000, 1002, 1003, 1006])).toBe(false);
    expect(reset([])).toBe(false);
  });

  it('lets RIS through to xterm', () => {
    const { term, esc } = stubTerminal();
    suppressMouseTracking(term);

    expect(esc[0].handler()).toBe(false);
  });
});

describe('terminal key handler', () => {
  it('copies the selection on Cmd+C instead of sending it to the pty', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { term, key } = stubTerminal();
    const send = vi.fn();
    attachShiftEnterHandler(term, send);

    expect(key({ key: 'c', metaKey: true })).toBe(false);
    expect(writeText).toHaveBeenCalledWith('selected text');
    expect(send).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('leaves Ctrl+C alone so it still interrupts', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { term, key } = stubTerminal();
    attachShiftEnterHandler(term, vi.fn());

    expect(key({ key: 'c', ctrlKey: true })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('still inserts a newline on Shift+Enter', () => {
    const { term, key } = stubTerminal();
    const send = vi.fn();
    attachShiftEnterHandler(term, send);

    expect(key({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(send).toHaveBeenCalledWith('\x1b[200~\n\x1b[201~');
  });
});

/**
 * The terminal's own replies, which are not keystrokes.
 *
 * xterm answers the CLI's queries through onData exactly like typing, so every
 * panel that forwards onData has to drop them. What made this worth a shared
 * function is the shape of the old filter rather than a missing pattern: it
 * knew DA1 and not DA2, and its unanchored `\d+;\d+c` rule then matched
 * `276;0c` inside the DA2 reply and left the head behind. A rule that can match
 * part of a sequence manufactures fragments instead of removing them.
 */
const DA1 = '\x1b[?1;2c';
const DA2 = '\x1b[>0;276;0c';
const DSR = '\x1b[0n';
const CPR = '\x1b[24;80R';
const DECRPM = '\x1b[?1;2$y';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
const MOUSE_SGR = '\x1b[<35;48;1M';
const MOUSE_X10 = '\x1b[M' + String.fromCharCode(32, 33, 34);
const DCS = '\x1bP>|xterm 5.3\x1b\\';

describe('stripTerminalReplies', () => {
  it('removes the DA2 reply whole, which is the one that used to be cut in half', () => {
    expect(stripTerminalReplies(DA2)).toBe('');
  });

  it.each([
    ['DA1', DA1], ['DA2', DA2], ['DSR', DSR], ['CPR', CPR], ['DECRPM', DECRPM],
    ['focus in', FOCUS_IN], ['focus out', FOCUS_OUT],
    ['SGR mouse report', MOUSE_SGR], ['X10 mouse report', MOUSE_X10], ['DCS reply', DCS],
  ])('leaves nothing behind for a %s reply', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });

  it('removes a burst of replies that arrived in one chunk', () => {
    // What a panel really receives when a CLI queries everything at startup.
    expect(stripTerminalReplies(DA1 + DA2 + DSR + FOCUS_IN)).toBe('');
  });

  it('keeps the keystroke that shared a chunk with a reply', () => {
    // The reply and the first thing typed after it can arrive together, and
    // dropping the whole chunk would swallow real input.
    expect(stripTerminalReplies(DA2 + 'ls -la\r')).toBe('ls -la\r');
    expect(stripTerminalReplies('ls' + DSR + ' -la\r')).toBe('ls -la\r');
  });
});

/**
 * The control. Without it this file would only describe the code as it is now,
 * and a filter that never loses a prompt proves nothing about one that did.
 */
describe('the filter as it was written before, kept here as the control', () => {
  /** Verbatim from the four copies that 0652c15 replaced. */
  function oldFilter(data: string): string {
    if (/^(\x1b\[\?[\d;]*c|\d+;\d+c)+$/.test(data)) return '';
    return data
      .replace(/\x1b\[\?[\d;]*c/g, '')
      .replace(/\x1b\[\d+;\d+R/g, '')
      .replace(/\x1b\[(?:I|O)/g, '')
      .replace(/\d+;\d+c/g, '');
  }

  it('cut the DA2 reply in half and typed the head into the pty', () => {
    // The defect, exactly: `276;0c` matched in the middle, `\x1b[>0;` left over.
    expect(oldFilter(DA2)).toBe('\x1b[>0;');
    expect(stripTerminalReplies(DA2)).toBe('');
  });

  it('sent the DSR reply through whole, which nobody had noticed', () => {
    expect(oldFilter(DSR)).toBe(DSR);
    expect(stripTerminalReplies(DSR)).toBe('');
  });

  it('ate a number pair out of something a person typed', () => {
    // The other half of an unanchored rule: it also bites real text.
    const typed = 'grep -n "276;0c" notes.txt\r';
    expect(oldFilter(typed)).not.toBe(typed);
    expect(stripTerminalReplies(typed)).toBe(typed);
  });
});

describe('what a person types reaches the pty untouched', () => {
  it.each([
    ['a command and its newline', 'ls -la\r'],
    ['quotes, colons and semicolons', 'git commit -m "fix: drop 1;2c from the notes"\r'],
    ['an arrow key', '\x1b[A'],
    ['control C', '\x03'],
    ['a bracketed paste over two lines', '\x1b[200~first line\nsecond line\x1b[201~'],
    ['accents and an emoji', 'echo "resume termine, 100% ok"\r'],
    ['a tab completion request', 'npm run e\t'],
    ['a backspace', '\x7f'],
  ])('%s', (_name, typed) => {
    expect(stripTerminalReplies(typed)).toBe(typed);
  });
});

/**
 * The class, not the site, and counted rather than listed.
 *
 * This block used to name four files. That is exactly how the class stayed
 * half open: PluginsTab.tsx held raw NUL bytes, so grep, ripgrep and the ugrep
 * our agents run all treated it as binary and skipped it without a word. The
 * count for this class read four while it was nine, and a hand-written list of
 * four checked precisely the four already fixed. A list cannot notice the site
 * nobody remembered.
 *
 * So the sites are discovered from the sources here, and the file that hides
 * from a text tool is the one this is built to catch.
 */
describe('every terminal that forwards input goes through the one filter', () => {
  const SRC = path.join(process.cwd(), 'src');

  /**
   * Bytes in, string out, with nothing asked about whether the file "looks"
   * textual. A scan that steps over a file and calls itself satisfied is the
   * habit this whole block exists to refuse.
   */
  const readText = (file: string) => fs.readFileSync(file).toString('utf-8');

  function sources(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
      }
    };
    walk(root);
    return out.sort();
  }

  /**
   * The end of the call whose opening bracket is at `open`, stepping over
   * strings, template literals and comments so a bracket inside one does not
   * close it early. A shape it cannot parse returns -1 and fails the case
   * rather than quietly returning a short body.
   */
  function endOfCall(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        for (i++; i < text.length; i++) {
          if (text[i] === '\\') { i++; continue; }
          if (text[i] === quote) break;
        }
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        i = text.indexOf('\n', i);
        if (i === -1) return -1;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        i = text.indexOf('*/', i);
        if (i === -1) return -1;
        i += 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  }

  interface Forwarder { file: string; param: string; body: string }

  /**
   * Every xterm onData subscription under a tree.
   *
   * The other direction is not one of these: `electronAPI.pty.onData` is the
   * pty pushing its output at the renderer, and nothing it carries was ever
   * typed by anyone.
   */
  function forwarders(root: string): Forwarder[] {
    const found: Forwarder[] = [];
    for (const file of sources(root)) {
      const text = readText(file);
      for (let at = text.indexOf('.onData('); at !== -1; at = text.indexOf('.onData(', at + 1)) {
        if (text.slice(Math.max(0, at - 40), at).includes('electronAPI')) continue;
        const open = at + '.onData'.length;
        const close = endOfCall(text, open);
        const callback = close === -1 ? '' : text.slice(open + 1, close);
        const arrow = callback.indexOf('=>');
        found.push({
          file: path.relative(process.cwd(), file),
          param: arrow === -1 ? '' : callback.slice(0, arrow).replace(/async/, '').replace(/[()\s]/g, ''),
          body: arrow === -1 ? '' : callback.slice(arrow + 2),
        });
      }
    }
    return found;
  }

  const HANDLERS = forwarders(SRC);

  it('finds ten of them, and an eleventh is meant to land here first', () => {
    // Not a list of which ten: that is the mistake this replaced. A count, so
    // a site added tomorrow stops someone here long enough to confirm it
    // belongs to the class, and the cases below then hold it to the invariant.
    // The tenth, confirmed on 2026-09-28: the terminal where a Claude
    // account's own sign-in runs (Settings > Claude accounts).
    expect(HANDLERS.length, HANDLERS.map(h => h.file).join('\n')).toBe(10);
  });

  it.each(HANDLERS)('$file filters what it forwards', ({ param, body }: Forwarder) => {
    expect(param).toMatch(/^[A-Za-z_$][\w$]*$/);
    expect(body).toContain(`stripTerminalReplies(${param})`);

    // And forwards the result rather than the chunk it came in on. A site that
    // filters into a variable and then writes the raw data anyway reads like a
    // fix and is none, so the raw parameter may not survive the filter call.
    // An object key of the same name is not a use of it: `data: cleaned`.
    const afterFilter = body.replace(`stripTerminalReplies(${param})`, '');
    expect(new RegExp(String.raw`\b${param}\b(?!\s*:)`).test(afterFilter)).toBe(false);
  });

  /** The shapes the four copies carried. None may survive in a forwarder. */
  const OLD_COPY = [
    String.raw`\d+;\d+c`,
    String.raw`\d+;\d+R`,
    String.raw`(?:I|O)`,
    String.raw`[\d;]*c`,
  ];

  it.each(HANDLERS)('$file keeps no filter of its own', ({ file }: Forwarder) => {
    const source = readText(path.join(process.cwd(), file));
    for (const shape of OLD_COPY) expect(source).not.toContain(shape);
  });

  it('and the unanchored rule exists nowhere in src but the note explaining it', () => {
    const offenders = sources(SRC).filter(f => readText(f).includes(String.raw`\d+;\d+c`));
    // terminal.ts names the old rule in the comment that explains why it went.
    expect(offenders.map(f => path.basename(f))).toEqual(['terminal.ts']);
  });

  /**
   * The control for the scan itself, which is the only part of this that could
   * fail silently. Plant a forwarder that filters nothing in a file carrying
   * NUL bytes, exactly the shape that hid a site for weeks, and fail if the
   * walk goes past it.
   */
  it('reads a source with NUL bytes in it rather than stepping over it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-forwarder-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'Planted.tsx'),
        `const marker = '\x00\x00\x00';\nterm.onData((data) => { send(data); });\n`,
      );
      const planted = forwarders(dir);

      expect(fs.readFileSync(path.join(dir, 'Planted.tsx')).includes(0x00)).toBe(true);
      expect(planted).toHaveLength(1);
      expect(planted[0].body).not.toContain('stripTerminalReplies');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
