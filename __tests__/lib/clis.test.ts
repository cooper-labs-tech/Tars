import { describe, it, expect } from 'vitest';
import { CLIS, cliById, cliForProvider } from '../../src/lib/clis';
import { PROVIDER_REGISTRY } from '../../src/lib/providers';

/**
 * One list of the command-line agents Tars runs (2.0.4, the maintainer's request of 18/10), read by Settings >
 * Providers, Settings > CLI Paths and New agent alike.
 *
 * Written before src/lib/clis.ts. The ways it can fail:
 * 1. A page keeps its own list and a CLI goes missing from it: Grok was in CLI Paths and not in Providers.
 * 2. A CLI is listed under the wrong command: Qwen Code showed as `qwen-code`, its command is `qwen`.
 * 3. A CLI the provider registry drives (New agent's list) is not in this one, or this one names a provider the
 *    registry does not have.
 * 4. A CLI listed as to come (oh-my-pi, Cline CLI, Kilo CLI) claims a provider, so New agent offers what Tars
 *    cannot drive yet.
 * 5. Two CLIs share an id, a command or a key, so a key set for one reaches the other's agents.
 * 6. Looking a CLI up by its provider finds the wrong one, or one for a provider that is not a CLI.
 */

describe('one list of CLIs (1, 2, 3)', () => {
  // 2.0.7 (#618, #619): Goose, the CLI `goose`, is driven, under one name: "Goose".
  it('names the nine CLIs Tars drives or will, then the three to come, each under its own command', () => {
    expect(CLIS.map((c) => [c.name, c.command, !!c.soon])).toEqual([
      ['Claude Code', 'claude', false], ['Codex', 'codex', false], ['Qwen Code', 'qwen', false], ['Gemini CLI', 'gemini', false],
      ['Grok CLI', 'grok', false], ['OpenCode', 'opencode', false], ['Pi', 'pi', false], ['Amp', 'amp', false],
      ['Goose', 'goose', false],
      ['oh-my-pi', 'omp', true], ['Cline CLI', 'cline', true], ['Kilo CLI', 'kilo', true],
    ]);
  });
  it('holds every CLI the provider registry drives, and names no provider the registry lacks', () => {
    const driven = PROVIDER_REGISTRY.filter((p) => p.requiresCli && ['claude', 'codex', 'qwen-code', 'gemini', 'grok', 'opencode', 'pi', 'amp', 'goose'].includes(p.id)).map((p) => p.id).sort();
    expect(CLIS.filter((c) => c.provider).map((c) => c.provider).sort()).toEqual(driven);
    for (const c of CLIS) if (c.provider) expect(PROVIDER_REGISTRY.some((p) => p.id === c.provider)).toBe(true);
  });
});

describe('what is to come drives nothing (4)', () => {
  it('gives no provider to a CLI to come', () => {
    expect(CLIS.filter((c) => c.soon).every((c) => c.provider === null)).toBe(true);
  });
});

describe('nothing shared (5)', () => {
  it('has one id, one command and one key per CLI', () => {
    const unique = (xs: Array<string | null>) => new Set(xs.filter(Boolean)).size === xs.filter(Boolean).length;
    expect(unique(CLIS.map((c) => c.id))).toBe(true);
    expect(unique(CLIS.map((c) => c.command))).toBe(true);
    expect(unique(CLIS.map((c) => c.keyId))).toBe(true);
    expect(cliById('claude')?.keyId).toBeNull();
  });
});

describe('lookups (6)', () => {
  it('finds a CLI by its id and by its provider, and nothing for a provider that is not a CLI', () => {
    expect(cliById('qwen-code')?.command).toBe('qwen');
    expect(cliForProvider('grok')?.name).toBe('Grok CLI');
    // Goose's path is its own setting (CLIPaths.goose, #618), and it has no key in Settings: its provider is set in
    // its own config.
    expect(cliForProvider('goose')).toMatchObject({ id: 'goose', name: 'Goose', command: 'goose', provider: 'goose', keyId: null, pathKey: 'goose' });
    expect(cliForProvider('openrouter')).toBeUndefined();
    expect(cliById('nope')).toBeUndefined();
  });
});
