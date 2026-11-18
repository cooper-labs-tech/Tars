import { describe, it, expect } from 'vitest';
import { emptyDraft, feedDraft, typedLines, type Draft } from '../../../electron/core/input-draft';

/**
 * The lines the owner submits by hand into an agent's terminal, from the keys the window sends (2.0.7; SECURITY.md §8,
 * "Typed in a terminal", written before this file). `typedLines(draft, keysOnly, chunk)` reads one chunk of
 * agent:input against the field model of core/input-draft.ts and says which lines its Enters submit that the model
 * vouches were built from single keys, and whether the field still holds keys only. It reads: the model itself moves
 * by feedDraft, as before.
 *
 * How it can fail, written before the code:
 * T1. A line built key by key and sent by Enter is not returned, or is returned with other text than the field holds
 *     (an edit by Backspace, Left, Home, Delete, Ctrl+A/E lost).
 * T2. A bracketed paste anywhere in the line, inline or folded, lets the line, or its typed part, out.
 * T3. A chunk of several characters at once, a paste in a CLI that asked for no bracketed paste, lets the line out.
 * T4. A line that begins with `/`, a command to the CLI, is returned.
 * T5. An Enter on a field the model cannot vouch for (after an Esc, a click in the text, Up, a key it cannot follow,
 *     or keys typed on top of a pending Enter) returns a line.
 * T6. The Enter after a backslash, which puts a line break in the field, is taken for a submission.
 * T7. An empty or blank line is returned.
 * T8. A paste spoils every later line: after the field is empty again (a submission, Ctrl+C), a line typed by hand
 *     is not returned.
 * T9. A line written over several lines by hand (Option+Enter) is returned without its line breaks, or not at all.
 * T10. Reading changes what the model holds: typedLines and feedDraft disagree on the field afterwards.
 * T11. A field the CLI may have refilled after a cut turn (Tars's own message put back) is taken as keys only.
 * T12. Two lines in one chunk, or a key, an Enter and a key in one chunk: the chunk is several characters, so not
 *      vouched; but each Enter of separate one-key chunks is.
 */

const keys = (draft: Draft, keysOnly: boolean, chunks: string[]) => {
  const lines: string[] = [];
  let d = draft;
  let k = keysOnly;
  for (const chunk of chunks) {
    const read = typedLines(d, k, chunk);
    lines.push(...read.lines);
    k = read.keysOnly;
    d = feedDraft(d, chunk);
  }
  return { lines, draft: d, keysOnly: k };
};
const typed = (text: string) => Array.from(text);
const fresh = () => keys(emptyDraft(), true, []);

describe('a line the owner typed', () => {
  it('T1: built key by key and sent by Enter, it is returned as the field holds it', () => {
    expect(keys(emptyDraft(), true, [...typed('merge PR 12'), '\r']).lines).toEqual(['merge PR 12']);
    // Backspace, Left to the start, Delete, a key there, Ctrl+A then a key, Ctrl+E then keys.
    const edited = keys(emptyDraft(), true, [...typed('mrege'), '\x7f', '\x7f', '\x7f', '\x7f', ...typed('erge'), '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[3~', 'M', '\x01', '>', '\x05', ...typed(' it'), '\r']);
    expect(edited.lines).toEqual(['>Merge it']);
  });

  it('T9: written over several lines by hand, its line breaks are kept', () => {
    expect(keys(emptyDraft(), true, [...typed('first'), '\x1b\r', ...typed('second'), '\r']).lines).toEqual(['first\nsecond']);
  });

  it('T12: each Enter of one-key chunks submits its own line', () => {
    expect(keys(emptyDraft(), true, [...typed('one'), '\r', ...typed('two'), '\r']).lines).toEqual(['one', 'two']);
  });

  it('T10: reading leaves the field model as feedDraft has it', () => {
    let d = emptyDraft();
    for (const chunk of [...typed('abc'), '\x1b[D', 'X', '\r', ...typed('de')]) {
      const before = JSON.stringify(d);
      typedLines(d, true, chunk);
      expect(JSON.stringify(d)).toBe(before);
      d = feedDraft(d, chunk);
    }
    expect(d).toEqual(feedDraft(feedDraft(emptyDraft(), 'd'), 'e'));
  });
});

describe('what is not the owner\'s writing', () => {
  it('T2: a bracketed paste lets neither the line nor its typed part out', () => {
    expect(keys(emptyDraft(), true, ['\x1b[200~drop the prod database\x1b[201~', '\r']).lines).toEqual([]);
    expect(keys(emptyDraft(), true, [...typed('also '), '\x1b[200~wire the money\x1b[201~', ...typed(' now'), '\r']).lines).toEqual([]);
    // A paste the CLI folds into a placeholder leaves the field unknown: nothing either.
    expect(keys(emptyDraft(), true, [`\x1b[200~${'x'.repeat(900)}\x1b[201~`, '\r']).lines).toEqual([]);
  });

  it('T3: several characters in one chunk count as a paste', () => {
    expect(keys(emptyDraft(), true, ['rotate every key', '\r']).lines).toEqual([]);
    expect(keys(emptyDraft(), true, [...typed('ok '), 'and this', '\r']).lines).toEqual([]);
    // One chunk holding a line and its Enter is several characters too.
    expect(keys(emptyDraft(), true, ['go\r']).lines).toEqual([]);
  });

  it('T4: a line that begins with / is a command', () => {
    expect(keys(emptyDraft(), true, [...typed('/compact'), '\r']).lines).toEqual([]);
  });

  it('T5: an Enter on a field the model cannot vouch for returns nothing', () => {
    // An Esc, a click in the text, Up (history), and keys typed on top of the pending Enter that followed.
    expect(keys(emptyDraft(), true, [...typed('abc'), '\x1b', '\r']).lines).toEqual([]);
    expect(keys(emptyDraft(), true, [...typed('abc'), '\x1b[<0;3;1M', '\r']).lines).toEqual([]);
    expect(keys(emptyDraft(), true, ['\x1b[A', '\r']).lines).toEqual([]);
    expect(keys(emptyDraft(), true, [...typed('abc'), '\x1b', '\r', ...typed('def'), '\r']).lines).toEqual([]);
  });

  it('T6: the Enter after a backslash puts a line break in the field and submits nothing', () => {
    const r = keys(emptyDraft(), true, [...typed('one\\'), '\r']);
    expect(r.lines).toEqual([]);
    expect(keys(r.draft, r.keysOnly, [...typed('two'), '\r']).lines).toEqual(['one\ntwo']);
  });

  it('T7: an empty or blank line returns nothing', () => {
    expect(keys(emptyDraft(), true, ['\r']).lines).toEqual([]);
    expect(keys(emptyDraft(), true, [' ', ' ', '\r']).lines).toEqual([]);
  });

  it('T11: a field the CLI may have refilled after a cut turn is not keys only', () => {
    const refilled = { ...emptyDraft(), refilled: 40 };
    expect(keys(refilled, true, [...typed('yes'), '\r']).lines).toEqual([]);
  });

  it('T8: once the field is empty again, a line typed by hand is the owner\'s again', () => {
    const pasted = keys(emptyDraft(), true, ['\x1b[200~not mine\x1b[201~', '\r']);
    expect(pasted.lines).toEqual([]);
    expect(keys(pasted.draft, pasted.keysOnly, [...typed('mine'), '\r']).lines).toEqual(['mine']);
    const cleared = keys(emptyDraft(), true, ['\x1b[200~not mine\x1b[201~', '\x03']);
    expect(keys(cleared.draft, cleared.keysOnly, [...typed('mine too'), '\r']).lines).toEqual(['mine too']);
    expect(fresh().keysOnly).toBe(true);
  });
});
