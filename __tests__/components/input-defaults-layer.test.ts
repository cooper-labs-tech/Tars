import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The look every input, textarea and select falls back on lives in the base
 * layer, where a field's own utilities win over it. Unlayered, it beat every
 * Tailwind utility whatever its specificity (#130): every `ui/Input` was 14px
 * against DESIGN's 12 and sat on `--input` whatever its `bg-*` said.
 *
 * Added at the QA gate of #130. Two unlayered rules on fields are left as they
 * were, and outside this check: `border-radius: 2px` and `transition: all`.
 */

const css = readFileSync(join(__dirname, '../../src/app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every style rule: its selector, its declarations, and the at-rules around it. */
function rules(text: string): { selector: string; body: string; within: string[] }[] {
  const out: { selector: string; body: string; within: string[] }[] = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      // A statement such as @import ends with ';' and is not part of the selector after it.
      stack.push(buf.split(';').pop()!.replace(/\s+/g, ' ').trim());
      buf = '';
    } else if (ch === '}') {
      const head = stack.pop() ?? '';
      if (!head.startsWith('@')) out.push({ selector: head, body: buf.replace(/\s+/g, ' ').trim(), within: stack.filter(h => h.startsWith('@')) });
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

const all = rules(css);
const layered = (r: { within: string[] }) => r.within.some(h => h.startsWith('@layer'));
const onFields = (r: { selector: string }) => r.selector.split(',').some(s => /^(input|textarea|select)\b/.test(s.trim()));

describe('the defaults of a field', () => {
  it('parses the stylesheet into its rules', () => {
    // The witness for the walker: without rules, every check below would pass on nothing.
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter(onFields).length).toBeGreaterThan(0);
  });

  it('sits in the base layer, unchanged: --input, 14px, and the accent border on focus', () => {
    const inBase = all.filter(r => r.within.includes('@layer base') && onFields(r));
    const defaults = inBase.find(r => r.selector === 'input, textarea, select' && /font-size: 14px/.test(r.body));
    expect(defaults?.body).toMatch(/background: var\(--input\)/);
    expect(defaults?.body).toMatch(/border: 1px solid var\(--border\)/);
    const focus = inBase.find(r => r.selector === 'input:focus, textarea:focus, select:focus');
    expect(focus?.body).toMatch(/border-color: var\(--primary\)/);
    expect(inBase.some(r => r.selector === 'input::placeholder, textarea::placeholder')).toBe(true);
  });

  it('leaves no unlayered rule that sets the background, border, size or colour of a field', () => {
    const look = /(^|;)\s*(background(-color)?|border(-color)?|font-size|color)\s*:/;
    expect(all.filter(r => onFields(r) && !layered(r) && look.test(r.body)).map(r => r.selector)).toEqual([]);
  });
});
