import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InterruptKeys, interruptKeyOf, ESC_WAIT_MS } from '../../electron/core/interrupt-keys';

/**
 * An Esc or a Ctrl-C a person types from the window into an agent's terminal (trace feature B3, 27/11): what Tars
 * counts as an interruption of a turn, and as the cause of a harness hanging up on its request. Every key the window
 * sends passes Tars's own input path (agent:input) as xterm sends it, one onData chunk per key or per sequence, the
 * same bytes on macOS, Linux and Windows: Tars reads them before node-pty writes them to the terminal, ConPTY's
 * included.
 *
 * How it fails, written before the code:
 * 1. A lone Esc, or a lone Ctrl-C, is not seen.
 * 2. The start of an arrow key or another escape sequence is taken for an Esc: an arrow in either cursor mode
 *    (ESC [ A, ESC O A), a modified key (ESC [ 1 ; 5 C), a function key (ESC [ 1 5 ~), a mouse report, a focus
 *    report, a terminal's reply (OSC 11), Alt with a key (ESC x), Alt with Esc (ESC ESC), a bracketed paste, even
 *    one holding an ESC or a Ctrl-C.
 * 3. A sequence cut across two chunks (ESC, then [A within the wait) is taken for an Esc.
 * 4. An Esc followed by a key after the wait is lost: it was an Esc, then a key.
 * 5. A Ctrl-C inside a paste or a line of text is taken for one.
 * 6. Its time is the end of the wait, not the moment the key came.
 * 7. Two agents' keys mix: one agent's chunk takes back another's waiting Esc.
 * 8. A waiting Esc outlives its agent's terminal (a timer left behind).
 */

let seen: Array<{ agentId: string; key: string; at: number }>;
let keys: InterruptKeys;

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  keys = new InterruptKeys((agentId, key, at) => { seen.push({ agentId, key, at }); });
});
afterEach(() => {
  keys.dispose();
  vi.useRealTimers();
});

describe('what a key is', () => {
  it('1 and 2: a lone Esc or Ctrl-C is one; no sequence, report, reply or paste is', () => {
    expect(interruptKeyOf('\x1b')).toBe('esc');
    expect(interruptKeyOf('\x03')).toBe('ctrl_c');
    for (const chunk of ['\x1b[A', '\x1bOA', '\x1b[1;5C', '\x1b[15~', '\x1b[<0;10;5M', '\x1b[I', '\x1b[O', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07',
      '\x1bx', '\x1b\x1b', '\x1b[200~ab\x1bcd\x03\x1b[201~', 'stop\x03', 'a', '\r', '']) {
      expect(interruptKeyOf(chunk), JSON.stringify(chunk)).toBeNull();
    }
  });
});

describe('a person\'s keys, per agent', () => {
  it('1 and 6: a lone Esc is told once the wait passes, at the time it came; a Ctrl-C at once', () => {
    keys.feed('a', '\x1b', 1000);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(ESC_WAIT_MS);
    expect(seen).toEqual([{ agentId: 'a', key: 'esc', at: 1000 }]);
    keys.feed('a', '\x03', 2000);
    expect(seen[1]).toEqual({ agentId: 'a', key: 'ctrl_c', at: 2000 });
  });

  it('3: an Esc whose sequence comes in the next chunk, within the wait, is no Esc', () => {
    keys.feed('a', '\x1b', 1000);
    vi.advanceTimersByTime(ESC_WAIT_MS - 10);
    keys.feed('a', '[A', 1000 + ESC_WAIT_MS - 10);
    vi.advanceTimersByTime(ESC_WAIT_MS * 2);
    expect(seen).toEqual([]);
  });

  it('4: an Esc and then, after the wait, a key: the Esc was one', () => {
    keys.feed('a', '\x1b', 1000);
    vi.advanceTimersByTime(ESC_WAIT_MS + 5);
    keys.feed('a', 'x', 1000 + ESC_WAIT_MS + 5);
    expect(seen).toEqual([{ agentId: 'a', key: 'esc', at: 1000 }]);
  });

  it('5: a Ctrl-C inside a paste or text is none', () => {
    keys.feed('a', '\x1b[200~ab\x03cd\x1b[201~', 1000);
    keys.feed('a', 'stop\x03', 1001);
    vi.advanceTimersByTime(ESC_WAIT_MS * 2);
    expect(seen).toEqual([]);
  });

  it('7: one agent\'s chunk does not take back another\'s Esc', () => {
    keys.feed('a', '\x1b', 1000);
    keys.feed('b', '[A', 1001);
    vi.advanceTimersByTime(ESC_WAIT_MS);
    expect(seen).toEqual([{ agentId: 'a', key: 'esc', at: 1000 }]);
  });

  it('8: a waiting Esc goes with its agent\'s terminal', () => {
    keys.feed('a', '\x1b', 1000);
    keys.forget('a');
    vi.advanceTimersByTime(ESC_WAIT_MS * 2);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
