/**
 * The text with every character that does not show written out as `[U+202E]`,
 * as the template import review writes it (src/lib/template-review.ts, which
 * the main process cannot import): a name or a skill quoted in a refusal of
 * main's must read as the review reads it, and a U+202E in one would turn the
 * refusal's own text around (the Audit's gate of #208).
 * reveal-parity.test.ts holds the two to the same answer.
 */

const FORMAT = /\p{Cf}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
const KEYCAP_BASE = /^[#*0-9]$/;

/**
 * Bidi and zero width controls, tag characters and the other format
 * characters, C0 and C1 controls (a tab and a newline aside), the line and
 * paragraph separators, variation selectors, and the blank fillers. A model
 * reads every one of them; a person reading the prompt sees none.
 */
function hiddenCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a) return false;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x2028 || cp === 0x2029) return true;
  if (cp === 0x034f || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) return true;
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return FORMAT.test(String.fromCodePoint(cp));
}

/** Whether `chars[i]` closes an emoji: a pictograph, then maybe its variation selector or a skin tone. */
function closesEmoji(chars: string[], i: number): boolean {
  let j = i;
  while (j >= 0 && (chars[j] === '\u{FE0F}' || SKIN_TONE.test(chars[j]))) j -= 1;
  return j >= 0 && PICTOGRAPH.test(chars[j]);
}

/** The two that belong to an emoji: a variation selector after a pictograph or a keycap, a joiner between two pictographs. */
function partOfEmoji(chars: string[], i: number, cp: number): boolean {
  if (cp === 0xfe0e || cp === 0xfe0f) {
    const before = chars[i - 1];
    return before !== undefined && (PICTOGRAPH.test(before) || KEYCAP_BASE.test(before));
  }
  if (cp === 0x200d) {
    const after = chars[i + 1];
    return after !== undefined && PICTOGRAPH.test(after) && closesEmoji(chars, i - 1);
  }
  return false;
}

/**
 * The text with every character that does not show written out as `[U+202E]`,
 * and how many there were. A Windows line end reads as the newline it is.
 */
export function reveal(input: string): { text: string; hidden: number } {
  const chars = Array.from(input.replace(/\r\n/g, '\n'));
  let hidden = 0;
  const text = chars.map((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (!hiddenCodePoint(cp) || partOfEmoji(chars, i, cp)) return ch;
    hidden += 1;
    return `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
  }).join('');
  return { text, hidden };
}

const QUOTE_LIMIT = 60;

/**
 * A value in a refusal or a log line: written out as reveal() writes it, quoted,
 * and cut, since it only has to name it. On one line too: the newline and the
 * tab reveal() leaves as they are (a prompt keeps its lines) are written out
 * here, or a skill with a newline would start a line of its own in the log.
 */
export function quoted(value: unknown): string {
  const oneLine = (s: string) => s.replace(/\n/g, '[U+000A]').replace(/\t/g, '[U+0009]');
  const cut = (s: string) => {
    const chars = Array.from(s);
    return chars.length > QUOTE_LIMIT ? `${chars.slice(0, QUOTE_LIMIT).join('')}...` : s;
  };
  if (typeof value === 'string') return `"${cut(oneLine(reveal(value).text))}"`;
  return cut(JSON.stringify(value) ?? String(value));
}
