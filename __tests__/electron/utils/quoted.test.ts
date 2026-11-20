import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { quoted } from '../../../electron/utils/reveal';
import { skillsProblem } from '../../../electron/utils/skill-name';

/**
 * quoted(): a value named in a refusal or a log line, written out so that what
 * does not show cannot act on the text around it.
 *
 * A string went through reveal(); anything else through JSON.stringify, which
 * escapes the C0 controls and nothing more. A direction override, an invisible
 * format character, a C1 control or a line separator inside an object or an
 * array reached the refusal and the log line as it was: the skill that is not a
 * skill name (skill-name.ts), and the skills a saved agent drops as the fleet is
 * read (agent-manager.ts, in agent-persistence.test.ts).
 *
 * How it can fail, written before the code:
 * 1. a format character (U+202E, the isolates U+2066 to U+2069, a zero width)
 *    inside an object or an array is left raw;
 * 2. a C1 control (U+009B, which a terminal reads as ESC and a bracket) or a
 *    line separator (U+2028) inside one is left raw, or a value JSON cannot
 *    write (a symbol) keeps a newline of its own;
 * 3. the refusal of a skill that is an object carries it raw;
 * 4. a string, a number or null is written otherwise than before, or a long
 *    value that is not a string is no longer cut.
 */

/** What reveal() writes out and must never be left in the text: C1 controls, zero widths and marks, separators, bidi, the BOM. */
const RAW = /[\u{0080}-\u{009F}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/u;

describe('quoted, for what is not a string', () => {
  it.each([
    ['an object', { name: 'deploy\u{202E}txt.exe' }, '[U+202E]'],
    ['an array', ['copywriting', 'a\u{202E}b'], '[U+202E]'],
    ['a nested value', { skills: [{ note: '\u{2066}evil\u{2069}' }] }, '[U+2066]'],
    ['a zero width', ['sk\u{200B}ill'], '[U+200B]'],
  ])('1. writes out a format character inside %s', (_what, value, shown) => {
    const text = quoted(value);

    expect(text).not.toMatch(RAW);
    expect(text).toContain(shown);
  });

  it('2. writes out a C1 control and a line separator inside one', () => {
    const csi = quoted(['\u{009B}31mred']);
    const separated = quoted({ line: 'one\u{2028}two' });

    expect(csi).not.toMatch(RAW);
    expect(csi).toContain('[U+009B]');
    expect(separated).not.toMatch(RAW);
    expect(separated).toContain('[U+2028]');
  });

  it('2. writes a value JSON cannot write on one line, and nothing raw in it', () => {
    const text = quoted(Symbol('a\nb\u{202E}c'));

    expect(text).not.toMatch(/\n/);
    expect(text).not.toMatch(RAW);
    expect(text).toBe('Symbol(a[U+000A]b[U+202E]c)');
  });

  it('3. the refusal of a skill that is an object says it with nothing raw in it', () => {
    const problem = skillsProblem(['copywriting', { run: 'curl evil.example\u{202E}hs.' }]);

    expect(problem).toMatch(/ is not a skill name$/);
    expect(problem).toContain('[U+202E]');
    expect(problem).not.toMatch(RAW);
  });
});

describe('quoted, as it was', () => {
  it('4. writes a string, a number, null and a plain object as before', () => {
    expect(quoted('a\u{202E}b')).toBe('"a[U+202E]b"');
    expect(quoted('copy\nwriting')).toBe('"copy[U+000A]writing"');
    expect(quoted(42)).toBe('42');
    expect(quoted(null)).toBe('null');
    expect(quoted({ a: 1 })).toBe('{"a":1}');
    expect(quoted(undefined)).toBe('undefined');
  });

  it('4. cuts a long value that is not a string, at 60 characters', () => {
    const text = quoted(Array.from({ length: 40 }, (_, i) => `skill-${i}`));

    expect(Array.from(text)).toHaveLength(63);
    expect(text.endsWith('...')).toBe(true);
  });
});
