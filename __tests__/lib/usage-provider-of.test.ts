import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { providerOf } from '../../src/lib/usage-window';

/**
 * providerOf (src/lib/usage-window.ts): which provider a model's spend is
 * filed under on the Usage page. #275's contract: the provider its sessions
 * ran under, as the status line wrote it in token-stats.json
 * (`stats.providerByModel`), and the model's name only for a model no session
 * speaks for. Before, the page guessed from the name alone, so a model served
 * through OpenRouter or Ollama was filed under Claude. Written before the code.
 * How it can fail:
 * 1. the name wins over the session: an OpenRouter-served claude-sonnet-5 is
 *    filed under Claude;
 * 2. a model no session names gets no provider, or the wrong one, where its
 *    name says;
 * 3. a key that reaches Object.prototype ("constructor", "toString") hands a
 *    function back as the provider: the map crossed IPC as a plain object, and
 *    a transcript can name its model anything;
 * 4. an empty or non-string value is taken for a provider.
 */

describe('providerOf', () => {
  it('takes the provider the sessions ran under over the model\'s name (1)', () => {
    expect(providerOf('claude-sonnet-5', { 'claude-sonnet-5': 'openrouter' })).toBe('openrouter');
    expect(providerOf('qwen3-coder', { 'qwen3-coder': 'ollama' })).toBe('ollama');
  });

  it('falls back to the name for a model no session names (2)', () => {
    expect(providerOf('gpt-5.3-codex', { 'claude-sonnet-5': 'openrouter' })).toBe('codex');
    expect(providerOf('claude-opus-5', undefined)).toBe('claude');
    expect(providerOf('gemini-3-pro', {})).toBe('gemini');
  });

  it('never takes a prototype key for a provider (3)', () => {
    const map = JSON.parse('{"claude-sonnet-5":"openrouter"}') as Record<string, string>;
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const provider = providerOf(name, map);
      expect(typeof provider, name).toBe('string');
      expect(provider, name).toBe('claude');
    }
  });

  it('ignores a value that is not a provider name (4)', () => {
    const odd = { a: '', b: 42, c: null } as unknown as Record<string, string>;
    expect(providerOf('a', odd)).toBe('claude');
    expect(providerOf('b', odd)).toBe('claude');
    expect(providerOf('c', odd)).toBe('claude');
  });
});
