import '../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import type { Terminal } from 'xterm';

import { terminalKeyAction, pageShortcutDigit, panelShortcutIndex, type KeyLike } from '@/lib/terminal-keys';
import { attachShiftEnterHandler } from '@/lib/terminal';

/**
 * Who a key belongs to: the page, the terminal panels, the terminal's own
 * clipboard, or the program in the terminal.
 *
 * How it fails, written before the code (2026-09-26):
 * 1. darwin/linux: any answer differs from what the three handlers decide
 *    today (Sidebar: Cmd or Ctrl + digit outside a field; the Dashboard:
 *    Ctrl + 1..9 even with Alt or Cmd held; xterm: Shift+Enter a newline,
 *    Cmd+C or Ctrl+Shift+C with a selection a copy, everything else the
 *    program's), so a Mac user's keys move.
 * 2. win32: Ctrl+digit both navigates and focuses a panel, or never
 *    navigates from inside a terminal, or reaches the program (Ctrl+2 is NUL).
 * 3. win32: Alt+digit does not focus panel N, reaches the program as Meta+N,
 *    or fires with Ctrl held too (AltGr is Ctrl+Alt: AltGr+0 types @ on a
 *    French keyboard and must stay a character).
 * 4. win32: the digit is read from `key`, so on AZERTY (where the unshifted
 *    row types & é " ' ...) no page shortcut ever fires.
 * 5. win32: Ctrl+C with a selection sends ^C instead of copying;
 *    Ctrl+C with no selection copies nothing and swallows the interrupt;
 *    Ctrl+V sends ^V (0x16) instead of pasting; Ctrl+Shift+C / Ctrl+Shift+V
 *    stop working.
 * 6. A page shortcut fires while the user types in a real text field (an
 *    input, a textarea that is not xterm's, a select, contentEditable).
 * 7. win32: Alt+digit is taken from the program when no panel answers it (a
 *    terminal outside the Dashboard, or a digit past the last panel), so the
 *    key is lost: a program's Meta+N never arrives and nothing is focused.
 */

type Target = { tagName: string; isContentEditable?: boolean; className?: string } | null;

function key(k: string, mods: Partial<KeyLike> = {}, code?: string): KeyLike {
  return {
    key: k,
    code: code ?? (/^[0-9]$/.test(k) ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k),
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    ...mods,
  };
}

const XTERM: Target = { tagName: 'TEXTAREA', className: 'xterm-helper-textarea' };
const BODY: Target = { tagName: 'BODY' };
const FIELDS: Target[] = [
  { tagName: 'INPUT' }, { tagName: 'TEXTAREA', className: 'composer' }, { tagName: 'SELECT' },
  { tagName: 'DIV', isContentEditable: true },
];

describe('darwin and linux: exactly today\'s rules', () => {
  for (const p of ['darwin', 'linux']) {
    it(`${p}: terminal keys`, () => {
      expect(terminalKeyAction(key('Enter', { shiftKey: true }), p, false)).toBe('newline');
      expect(terminalKeyAction(key('c', { metaKey: true }), p, true)).toBe('copy');
      expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), p, true)).toBe('copy');
      expect(terminalKeyAction(key('c', { ctrlKey: true }), p, true)).toBe('program');
      expect(terminalKeyAction(key('c', { metaKey: true }), p, false)).toBe('program');
      expect(terminalKeyAction(key('v', { ctrlKey: true }), p, false)).toBe('program');
      expect(terminalKeyAction(key('2', { ctrlKey: true }), p, false)).toBe('program');
      expect(terminalKeyAction(key('2', { altKey: true }), p, false)).toBe('program');
    });

    it(`${p}: page shortcuts`, () => {
      expect(pageShortcutDigit(key('2', { metaKey: true }), p, BODY)).toBe('2');
      expect(pageShortcutDigit(key('2', { ctrlKey: true }), p, BODY)).toBe('2');
      expect(pageShortcutDigit(key('2', { ctrlKey: true, altKey: true }), p, BODY)).toBeNull();
      expect(pageShortcutDigit(key('2', { ctrlKey: true, shiftKey: true }), p, BODY)).toBeNull();
      expect(pageShortcutDigit(key('2', { metaKey: true }), p, XTERM)).toBeNull();
      expect(pageShortcutDigit(key('2'), p, BODY)).toBeNull();
      expect(pageShortcutDigit(key('a', { metaKey: true }), p, BODY)).toBeNull();
      for (const f of FIELDS) expect(pageShortcutDigit(key('2', { metaKey: true }), p, f)).toBeNull();
    });

    it(`${p}: panel shortcuts`, () => {
      expect(panelShortcutIndex(key('1', { ctrlKey: true }), p)).toBe(0);
      expect(panelShortcutIndex(key('9', { ctrlKey: true, altKey: true }), p)).toBe(8);
      expect(panelShortcutIndex(key('9', { ctrlKey: true, metaKey: true }), p)).toBe(8);
      expect(panelShortcutIndex(key('0', { ctrlKey: true }), p)).toBeNull();
      expect(panelShortcutIndex(key('1', { ctrlKey: true, shiftKey: true }), p)).toBeNull();
      expect(panelShortcutIndex(key('1', { altKey: true }), p)).toBeNull();
      expect(panelShortcutIndex(key('1', { metaKey: true }), p)).toBeNull();
    });
  }
});

describe('win32', () => {
  const W = 'win32';

  it('Ctrl+digit is a page, everywhere but a real field, and never the program', () => {
    for (const d of ['1', '2', '0']) {
      expect(pageShortcutDigit(key(d, { ctrlKey: true }), W, BODY)).toBe(d);
      expect(pageShortcutDigit(key(d, { ctrlKey: true }), W, XTERM)).toBe(d);
      expect(terminalKeyAction(key(d, { ctrlKey: true }), W, false)).toBe('page');
      expect(panelShortcutIndex(key(d, { ctrlKey: true }), W)).toBeNull();
    }
    for (const f of FIELDS) expect(pageShortcutDigit(key('2', { ctrlKey: true }), W, f)).toBeNull();
    expect(pageShortcutDigit(key('2', { ctrlKey: true, shiftKey: true }), W, BODY)).toBeNull();
    expect(pageShortcutDigit(key('2', { ctrlKey: true, altKey: true }), W, BODY)).toBeNull();
    expect(pageShortcutDigit(key('2', { metaKey: true }), W, BODY)).toBeNull();
  });

  it('reads the digit from the key position, so AZERTY works', () => {
    expect(pageShortcutDigit(key('é', { ctrlKey: true }, 'Digit2'), W, BODY)).toBe('2');
    expect(pageShortcutDigit(key('à', { ctrlKey: true }, 'Digit0'), W, XTERM)).toBe('0');
    expect(terminalKeyAction(key('é', { ctrlKey: true }, 'Digit2'), W, false)).toBe('page');
    expect(panelShortcutIndex(key('&', { altKey: true }, 'Digit1'), W)).toBe(0);
    expect(pageShortcutDigit(key('2', { ctrlKey: true }, 'Numpad2'), W, BODY)).toBeNull();
  });

  it('Alt+1..9 focuses a panel and never reaches the program; AltGr stays a character', () => {
    expect(panelShortcutIndex(key('1', { altKey: true }), W)).toBe(0);
    expect(panelShortcutIndex(key('9', { altKey: true }), W)).toBe(8);
    expect(panelShortcutIndex(key('0', { altKey: true }), W)).toBeNull();
    expect(terminalKeyAction(key('3', { altKey: true }), W, false, () => true)).toBe('panel');
    // AltGr: Ctrl+Alt.
    expect(panelShortcutIndex(key('@', { altKey: true, ctrlKey: true }, 'Digit0'), W)).toBeNull();
    expect(panelShortcutIndex(key('~', { altKey: true, ctrlKey: true }, 'Digit2'), W)).toBeNull();
    expect(terminalKeyAction(key('~', { altKey: true, ctrlKey: true }, 'Digit2'), W, false)).toBe('program');
    expect(terminalKeyAction(key('@', { altKey: true, ctrlKey: true }, 'Digit0'), W, false)).toBe('program');
    expect(pageShortcutDigit(key('@', { altKey: true, ctrlKey: true }, 'Digit0'), W, XTERM)).toBeNull();
    expect(panelShortcutIndex(key('1', { altKey: true, shiftKey: true }), W)).toBeNull();
  });

  it('7. Alt+digit is a panel only where a panel answers it, the program\'s key everywhere else', () => {
    const twoPanels = (index: number) => index < 2;
    expect(terminalKeyAction(key('2', { altKey: true }), W, false, twoPanels)).toBe('panel');
    expect(terminalKeyAction(key('3', { altKey: true }), W, false, twoPanels)).toBe('program');
    expect(terminalKeyAction(key('9', { altKey: true }), W, false, twoPanels)).toBe('program');
    // A terminal with no panels behind it: the agent window, the quick terminal, the tray's.
    expect(terminalKeyAction(key('1', { altKey: true }), W, false)).toBe('program');
    // darwin and linux never hand a panel key past xterm, panels or not.
    for (const p of ['darwin', 'linux']) expect(terminalKeyAction(key('1', { altKey: true }), p, false, () => true)).toBe('program');
  });

  it('Ctrl+C copies a selection and interrupts without one', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), W, true)).toBe('copy');
    expect(terminalKeyAction(key('c', { ctrlKey: true }), W, false)).toBe('program');
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), W, true)).toBe('copy');
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), W, false)).toBe('program');
  });

  it('Ctrl+V and Ctrl+Shift+V paste', () => {
    expect(terminalKeyAction(key('v', { ctrlKey: true }), W, false)).toBe('paste');
    expect(terminalKeyAction(key('V', { ctrlKey: true, shiftKey: true }), W, true)).toBe('paste');
    expect(terminalKeyAction(key('v', { ctrlKey: true, altKey: true }), W, false)).toBe('program');
  });

  it('keeps Shift+Enter, and leaves the rest to the program', () => {
    expect(terminalKeyAction(key('Enter', { shiftKey: true }), W, false)).toBe('newline');
    for (const k of [key('r', { ctrlKey: true }), key('w', { ctrlKey: true }), key('z', { ctrlKey: true }), key('a'), key('Tab', { ctrlKey: true })]) {
      expect(terminalKeyAction(k, W, false)).toBe('program');
    }
  });
});

describe('the terminal\'s key handler (attachShiftEnterHandler)', () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete g.window; });

  /** xterm's answer for a keydown: true lets xterm send it to the program. */
  function handlerOn(platform: string, hasPanel?: (index: number) => boolean) {
    g.window = { electronAPI: { platform } };
    let handler: ((e: KeyboardEvent) => boolean) | undefined;
    const term = {
      attachCustomKeyEventHandler: (fn: (e: KeyboardEvent) => boolean) => { handler = fn; },
      hasSelection: () => false,
      getSelection: () => '',
      clearSelection: () => {},
    };
    attachShiftEnterHandler(term as unknown as Terminal, () => {}, hasPanel);
    return (k: KeyLike) => handler!({ ...k, type: 'keydown' } as unknown as KeyboardEvent);
  }

  it('7. on win32, keeps Alt+digit from the program only for a panel that answers it', () => {
    expect(handlerOn('win32')(key('1', { altKey: true }))).toBe(true);
    expect(handlerOn('win32', (i) => i < 2)(key('2', { altKey: true }))).toBe(false);
    expect(handlerOn('win32', (i) => i < 2)(key('3', { altKey: true }))).toBe(true);
    expect(handlerOn('darwin', () => true)(key('1', { altKey: true }))).toBe(true);
  });
});
