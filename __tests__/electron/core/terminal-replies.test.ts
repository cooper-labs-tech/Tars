import { describe, it, expect, vi, afterEach } from 'vitest';
import { emptyDraft, feedDraft, isKeystroke } from '../../../electron/core/input-draft';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

/**
 * A terminal's reply is never a key (bug-held-forever-05-10.md, 05/10). A CLI asks the terminal something (its
 * background colour, its cursor, what it is), the panel's xterm answers, and the panel passes the answer on to the main
 * process with what is typed. Read as keys, the answer to Claude Code's `ESC ] 11 ; ?` (`ESC ] 11 ; rgb:.... ST`) made
 * the field's draft unknown, so every message after it waited for a person to send or clear a field that was empty:
 * three agents deaf for 2 h 20 to 2 h 40 (measured in the app on 05/10, e2e/held-behind-reply.spec.ts).
 *
 * How it can fail, written before the code:
 * 1. An OSC colour report (10, 11, 12, 4;n), ended by ST or by BEL, turns the draft unknown, or its body is taken as
 *    typed text.
 * 2. A DCS reply (XTVERSION, DECRQSS) does the same.
 * 3. A CSI reply does the same: DA1, DA2, the cursor position (CPR), the status (DSR), a mode report (DECRPM), a window
 *    report.
 * 4. A reply sent with typed keys in the same chunk takes the keys with it, or the keys are lost.
 * 5. A reply counts as a keystroke: it arms the typing pause, and holds the next message for nothing.
 * 6. A sequence that only starts like a reply (an OSC with no end in the chunk) is taken as one, and the draft claims a
 *    field it did not follow.
 * 7. A message written right after a reply is held instead of going in.
 */

const typed = (text: string) => [...text].reduce((d, ch) => feedDraft(d, ch), emptyDraft());

const REPLIES: Array<[string, string]> = [
  ['OSC 11, ST', '\x1b]11;rgb:0f0f/0f0f/0f0f\x1b\\'],
  ['OSC 11, BEL', '\x1b]11;rgb:1212/1212/1212\x07'],
  ['OSC 10', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
  ['OSC 12', '\x1b]12;rgb:ffff/8080/0000\x07'],
  ['OSC 4', '\x1b]4;1;rgb:cdcd/0000/0000\x1b\\'],
  ['DCS XTVERSION', '\x1bP>|xterm.js(5.3.0)\x1b\\'],
  ['DCS DECRQSS', '\x1bP1$r0;1m\x1b\\'],
  ['DA1', '\x1b[?1;2c'],
  ['DA2', '\x1b[>0;276;0c'],
  ['CPR', '\x1b[24;80R'],
  ['DSR', '\x1b[0n'],
  ['DECRPM private', '\x1b[?2004;1$y'],
  ['DECRPM ANSI', '\x1b[4;2$y'],
  ['window size', '\x1b[8;24;80t'],
  ['window pixels', '\x1b[4;600;800t'],
];

describe("a terminal's reply", () => {
  it.each(REPLIES)('1, 2, 3, 5. %s is no key, and leaves a known draft as it was', (_name, reply) => {
    expect(isKeystroke(reply)).toBe(false);
    expect(feedDraft(typed('abc'), reply)).toEqual({ text: 'abc', cursor: 3, state: 'known' });
    expect(feedDraft(emptyDraft(), reply)).toEqual(emptyDraft());
  });

  it('4. sent with typed keys in one chunk, leaves the keys and only them', () => {
    const d = feedDraft(emptyDraft(), `a\x1b]11;rgb:0f0f/0f0f/0f0f\x1b\\b\x1b[?1;2cc`);
    expect(d).toEqual({ text: 'abc', cursor: 3, state: 'known' });
    expect(isKeystroke(`a\x1b]11;rgb:0f0f/0f0f/0f0f\x1b\\`)).toBe(true);
  });

  it('6. an OSC with no end in the chunk is not followed', () => {
    expect(feedDraft(typed('abc'), '\x1b]11;rgb:0f0f/0f0f').state).toBe('unknown');
  });

  it('a key is still a key: an arrow, Delete, Shift+Tab', () => {
    expect(isKeystroke('\x1b[A')).toBe(true);
    expect(feedDraft(typed('abc'), '\x1b[3~').state).toBe('known');
    expect(feedDraft(typed('abc'), '\x1b[Z').state).toBe('unknown');
  });
});

describe('the writer, after a reply', () => {
  let pm: typeof import('../../../electron/core/pty-manager');
  let term: { write: (d: string) => void; written: string[] } | undefined;

  afterEach(() => {
    if (pm && term) pm.resetTerminalInput(term as never);
    vi.useRealTimers();
  });

  it.each(REPLIES.slice(0, 2))('5, 7. a message written just after %s goes in at once', async (_name, reply) => {
    vi.resetModules();
    pm = await import('../../../electron/core/pty-manager');
    const written: string[] = [];
    term = { write: (d: string) => { written.push(d); }, written };

    pm.writeHumanInput(term as never, reply);
    const outcome = pm.writeProgrammaticInput(term as never, 'run the gate', true);

    expect(outcome).toBe('written');
    expect(written.join('')).toContain('run the gate');
  });
});
