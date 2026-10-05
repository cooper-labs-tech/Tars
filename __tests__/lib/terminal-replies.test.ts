import { describe, it, expect } from 'vitest';
import { stripTerminalReplies } from '../../src/lib/terminal';

/**
 * The panels' side of the held-message bug of 04/10 (#314). A CLI asks its
 * terminal a question, the mounted panel's xterm answers through onData, and
 * the answer went on to agent:input as if typed: main read `ESC ]` as an
 * unknown key and the body as text, the draft turned unknown, and a message to
 * that agent, at rest, waited for ever. Main no longer reads a reply as a key
 * (#314); the panels should not send one in the first place. Written before
 * the code. How the filter can fail:
 * 1. a colour report (OSC 4, 10, 11, 12), ended by BEL or by ST, goes through
 *    as keys: xterm 5.3 answers `ESC ] 11 ; ?` with
 *    `ESC ] 11 ; rgb:0f0f/0f0f/0f0f ST`;
 * 2. a device string (DCS) ended by BEL goes through: only the ST form was
 *    stripped;
 * 3. a mode report for an ANSI mode (DECRPM without `?`) goes through: only
 *    the private form was stripped;
 * 4. a window report (`CSI ... t`) goes through;
 * 5. a pattern matches part of a sequence, or past its end: two replies in
 *    one chunk are not both removed, or the keys typed after a reply go with
 *    it;
 * 6. a pattern bites what a person types: a `]`, a `t`, an arrow, a function
 *    key, Alt+] (`ESC ]` with nothing ending it), Ctrl+G (a lone BEL), or a
 *    paste;
 * 7. a query left unended in the chunk is swallowed with the keys after it,
 *    where only a complete reply may go.
 */

const OSC = {
  colour4BEL: '\x1b]4;1;rgb:cdcd/0000/0000\x07',
  foregroundST: '\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\',
  backgroundST: '\x1b]11;rgb:0f0f/0f0f/0f0f\x1b\\',
  backgroundBEL: '\x1b]11;rgb:0f0f/0f0f/0f0f\x07',
  cursorBEL: '\x1b]12;rgb:ffff/9e9e/4242\x07',
};

describe('the replies the panels drop', () => {
  it.each(Object.entries(OSC))('a colour report, %s (1)', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });

  it.each([
    ['XTVERSION ended by BEL', '\x1bP>|xterm.js(5.3.0)\x07'],
    ['XTVERSION ended by ST', '\x1bP>|xterm.js(5.3.0)\x1b\\'],
    ['DECRQSS ended by BEL', '\x1bP1$r0m\x07'],
  ])('a device string, %s (2)', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });

  it.each([
    ['ANSI insert mode', '\x1b[4;2$y'],
    ['ANSI newline mode', '\x1b[20;2$y'],
    ['private bracketed paste', '\x1b[?2004;1$y'],
  ])('a mode report, %s (3)', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });

  it.each([
    ['text area in characters', '\x1b[8;24;80t'],
    ['text area in pixels', '\x1b[4;600;800t'],
    ['window position', '\x1b[3;0;0t'],
    ['window state', '\x1b[1t'],
  ])('a window report, %s (4)', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });
});

describe('only whole replies go (5, 7)', () => {
  it('removes two replies in one chunk and keeps the keys typed after them', () => {
    expect(stripTerminalReplies(OSC.cursorBEL + OSC.backgroundST + 'hello\r')).toBe('hello\r');
    expect(stripTerminalReplies('ls' + OSC.backgroundBEL + ' -la\r')).toBe('ls -la\r');
  });

  it('stops each reply at its own end', () => {
    // A lazy match: the first BEL or ST ends the string, never the last one.
    expect(stripTerminalReplies(OSC.backgroundBEL + 'a\x07')).toBe('a\x07');
  });

  it('leaves a query nothing ends, and the keys after it, as they came', () => {
    const unended = '\x1b]11;?ls -la\r';
    expect(stripTerminalReplies(unended)).toBe(unended);
  });
});

describe('what a person types still goes through (6)', () => {
  it.each([
    ['a bracket', ']'],
    ['a word with a t', 'git status\r'],
    ['an arrow', '\x1b[A'],
    ['a word jump', '\x1b[1;5C'],
    ['a function key', '\x1b[15~'],
    ['Alt+b', '\x1bb'],
    ['Alt+]', '\x1b]'],
    ['Ctrl+G', '\x07'],
    ['a paste', '\x1b[200~echo 8;24;80t\x1b[201~'],
  ])('%s', (_name, typed) => {
    expect(stripTerminalReplies(typed)).toBe(typed);
  });
});
