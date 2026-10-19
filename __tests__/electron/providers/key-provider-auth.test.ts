import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * How a key provider's key reaches Claude Code, for every key provider in the registry (2.0.4).
 *
 * Each of these was measured on claude 2.1.302, the version Tars runs, in a throwaway HOME against a stand-in of the
 * vendor that logs which credential each request carries (dbe-key-providers-1810/measure-2.1.302). The ways it fails:
 *
 * 1. The key handed over as ANTHROPIC_API_KEY. An interactive Claude Code asks before it uses an API key it finds in
 *    its environment ("Detected a custom API key in your environment. Do you want to use this API key?", No
 *    preselected), and nothing answers that in an agent's terminal: no key-provider agent ever started by itself
 *    (17/10). The first Enter typed into that terminal, Tars's own included, answers No, and the key is then refused
 *    for good in that folder's .claude.json. With a subscription signed in, the session went on with its OAuth
 *    token, sent to the vendor's URL.
 * 2. ANTHROPIC_API_KEY left to what Tars inherited while the key goes elsewhere: an Anthropic key the user's shell
 *    exports brings the question back, about itself, and would go out as `x-api-key` to a vendor it has nothing to
 *    do with.
 * 3. One provider forgotten as the registry grows, or one of a provider's two paths (its own key, or the OpenRouter
 *    fallback) left on the old variable.
 * 4. The question made to go away by approving the key in .claude.json: Claude Code keeps the key's last 20
 *    characters there, and in every backup it makes of the file. ANTHROPIC_AUTH_TOKEN is never asked about and
 *    leaves nothing on disk (measured: no file of the HOME holds the key, or its end).
 * 5. A provider that goes through Tars's bridge (Venice, a custom OpenAI endpoint) on the old variable, or its
 *    Bearer refused by the bridge (openai-bridge.test.ts). Their getPtyEnvVars load the API server lazily, which
 *    vitest cannot load, so the last case reads their source.
 */

import { getAllProviders } from '../../../electron/providers';
import type { AppSettings } from '../../../electron/types';

const KEYS = {
  deepSeekApiKey: 'sk-deepseek-0000000000000000000001',
  moonshotApiKey: 'sk-moonshot-000000000000000000002',
  zhipuApiKey: 'zhipu.0000000000000000000000000003',
  minimaxApiKey: 'eyJminimax.00000000000000000000004',
  ollamaCloudApiKey: 'ollama-cloud-0000000000000000005',
  openRouterApiKey: 'sk-or-v1-000000000000000000000006',
};
const SHELL_KEY = 'sk-ant-api03-from-the-users-shell-0000';

/** Which key each provider must hand over when every key is set: its own, or OpenRouter's when it has none. */
const OWN_KEY: Record<string, string> = {
  deepseek: KEYS.deepSeekApiKey,
  moonshot: KEYS.moonshotApiKey,
  zhipu: KEYS.zhipuApiKey,
  minimax: KEYS.minimaxApiKey,
  'ollama-cloud': KEYS.ollamaCloudApiKey,
  openrouter: KEYS.openRouterApiKey,
  mimo: KEYS.openRouterApiKey,
  qwen: KEYS.openRouterApiKey,
  nvidia: KEYS.openRouterApiKey,
  'nous-portal': KEYS.openRouterApiKey,
  // A local server that wants the header and reads nothing in it (docs.ollama.com, Claude Code).
  ollama: 'ollama-local',
};
/** Through Tars's bridge: Tars's own token, read from the API server (the source guard below). */
const BRIDGED = ['venice', 'custom-openai'];
/** Providers with a key of their own and the OpenRouter fallback. */
const FALLS_BACK = ['deepseek', 'moonshot', 'zhipu', 'minimax'];

/** Every provider that runs the claude binary against another vendor: what the registry holds today, and tomorrow. */
const keyProviders = () => getAllProviders().filter(p => p.binaryName === 'claude' && p.id !== 'claude');

/** What a key provider's CLI starts with: what Tars inherited, then what the provider sets (agent-manager.ts). */
const launchEnv = (vars: Record<string, string>) => ({ ANTHROPIC_API_KEY: SHELL_KEY, ...vars });

describe('a key provider hands its key to Claude Code', () => {
  it('as ANTHROPIC_AUTH_TOKEN, with ANTHROPIC_API_KEY blank, on every key provider of the registry', () => {
    const providers = keyProviders();
    expect(providers.length, 'the registry lost its key providers').toBeGreaterThanOrEqual(13);
    for (const provider of providers.filter(p => !BRIDGED.includes(p.id))) {
      expect(OWN_KEY[provider.id], `no expectation for "${provider.id}": say which key it hands over`).toBeDefined();
      const env = launchEnv(provider.getPtyEnvVars('a1', '/tmp/project', [], { ...KEYS } as AppSettings));
      expect(env.ANTHROPIC_BASE_URL, `${provider.id} points the CLI nowhere`).toBeTruthy();
      expect(env.ANTHROPIC_AUTH_TOKEN, `${provider.id} does not hand its key over as the auth token`).toBe(OWN_KEY[provider.id]);
      expect(env.ANTHROPIC_API_KEY, `${provider.id} leaves an API key for Claude Code to ask about`).toBe('');
    }
  });

  it('on the OpenRouter fallback too', () => {
    for (const id of FALLS_BACK) {
      const provider = keyProviders().find(p => p.id === id)!;
      const env = launchEnv(provider.getPtyEnvVars('a1', '/tmp/project', [], { openRouterApiKey: KEYS.openRouterApiKey } as AppSettings));
      expect(env.ANTHROPIC_BASE_URL, id).toContain('openrouter.ai');
      expect(env.ANTHROPIC_AUTH_TOKEN, id).toBe(KEYS.openRouterApiKey);
      expect(env.ANTHROPIC_API_KEY, id).toBe('');
    }
  });

  it('never as ANTHROPIC_API_KEY, the providers of the bridge included', () => {
    const dir = path.resolve(__dirname, '../../../electron/providers');
    for (const id of [...BRIDGED, ...Object.keys(OWN_KEY)]) {
      const source = fs.readFileSync(path.join(dir, `${id}-provider.ts`), 'utf8');
      const start = source.indexOf('getPtyEnvVars(');
      expect(start, `${id}-provider.ts has no getPtyEnvVars`).toBeGreaterThan(0);
      const body = source.slice(start, source.indexOf('\n  }\n', start));
      expect(body, `${id}-provider.ts hands its CLI an API key to ask about`).not.toMatch(/ANTHROPIC_API_KEY\s*[=:]\s*(?!'')/);
      expect(body, `${id}-provider.ts sets the vendor's variables itself, not through keyProviderEnv`).toContain('keyProviderEnv(');
    }
  });
});
