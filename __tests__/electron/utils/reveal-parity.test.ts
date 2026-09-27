import { describe, it, expect } from 'vitest';
import { reveal as revealInMain } from '../../../electron/utils/reveal';
import { reveal as revealInReview } from '../../../src/lib/template-review';

/**
 * The main process writes out what does not show as the import review does
 * (the Audit's gate of #208). The review's reveal() lives in the renderer,
 * which main cannot import, so main has its own; this holds the two to the
 * same answer, character for character, so a refusal and the review never
 * disagree about what a name holds.
 *
 * How it fails: main's copy drifts from the review's, on a bidi control, a
 * zero width or tag character, a control, a variation selector or joiner that
 * belongs to an emoji and one that does not, a Windows line end, or a tab.
 */
const CORPUS = [
  'plain', 'Helper\u202Egnp.exe', 'a\u200Bb\u200Cc\u200Dd\u2060e', 'tag\u{E0041}\u{E007F}', 'bell\u0007 c1\u0085',
  'line\u2028para\u2029', 'fill\u3164er\u115F', 'var\uFE0Fsel', '❤\uFE0F ok', '#\uFE0F⃣', '👩\u200D💻 dev', 'x\u200D💻',
  'win\r\nline', 'tab\there\nnewline', 'soft\u00ADhyphen', 'bom\uFEFF', 'mongol\u180E', '👍🏽\u200D🔥', '',
];

describe('reveal, in main and in the review', () => {
  it.each(CORPUS.map(s => [JSON.stringify(s), s]))('gives the same answer for %s', (_shown, input) => {
    expect(revealInMain(input)).toEqual(revealInReview(input));
  });
});
