import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { providerWord } from '../../src/lib/providers';

/**
 * The word an agent's card, its detail panel and its window's header write for its provider (2.0.4, #462). The
 * frames write it as a plain lowercase word: "claude · fable 5 · main", "codex · gpt-5.3 · feat/backend".
 *
 * Written before the code. The ways it can fail:
 * 1. Qwen Code's agents read as the raw id `qwen-code`, a word no reader knows: the card did, and the E2E of
 *    #462 went red on it (18/10 20:46).
 * 2. Qwen Code reads as the Qwen API's `qwen`, so the two cannot be told apart on a card.
 * 3. The frames' plain words are lost: claude, codex, gemini and the rest turn into labels the frames do not write.
 * 4. An agent with no provider (Claude's, as every agent from before providers) reads as nothing.
 * 5. An id the window does not know yet, from a provider added later, reads as nothing or throws.
 */

describe('providerWord', () => {
  it('names Qwen Code in words (1)', () => {
    expect(providerWord('qwen-code')).toBe('Qwen Code');
  });

  it('keeps Qwen Code apart from the Qwen API (2)', () => {
    expect(providerWord('qwen')).toBe('qwen');
    expect(providerWord('qwen')).not.toBe(providerWord('qwen-code'));
  });

  it('keeps the plain words the frames write (3)', () => {
    for (const id of ['claude', 'codex', 'gemini', 'grok', 'opencode', 'pi', 'amp', 'local']) {
      expect(providerWord(id)).toBe(id);
    }
  });

  it("reads an agent with no provider as Claude's (4)", () => {
    expect(providerWord(undefined)).toBe('claude');
    expect(providerWord(null)).toBe('claude');
    expect(providerWord('')).toBe('claude');
  });

  it('reads an id it does not know as that id (5)', () => {
    expect(providerWord('kilo')).toBe('kilo');
  });
});
