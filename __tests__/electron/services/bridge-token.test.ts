import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The agents on Tars's OpenAI bridge (Venice, a custom
 * endpoint) present a token that opens the bridge and nothing else (the
 * Audit's L3 on #466, 2.0.4). They were handed Tars's shared token, the one
 * every other path keeps from the agents since 2.0.4: an agent on Venice, in
 * bypass, could read it in its own environment and call every route of
 * Tars's API that the shared token opens.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  B1. A bridge agent's terminal is handed the shared token, or no token, or
 *      the vendor's key.
 *  B3. The bridge takes the shared token, or refuses its own, as a Bearer or
 *      as x-api-key.
 *  B4. The bridge's token is not kept: a new one at each start leaves every
 *      running agent with one the bridge refuses. Or
 *      it is the shared token under another name, or a short one, or kept
 *      where an agent reads it (~/.tars), or not 0600.
 *  B5. Tars's API takes the bridge's token for its own.
 */

import { getProvider } from '../../../electron/providers';
import { getBridgeToken, bridgeAuthorized } from '../../../electron/services/bridge-token';
import { getApiToken, resolveCaller } from '../../../electron/services/api-server';
import { PRIVATE_DIR, DATA_DIR } from '../../../electron/constants';
import type { AppSettings } from '../../../electron/types';

const file = path.join(PRIVATE_DIR, 'bridge-token');

beforeEach(() => {
  fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
});

describe('the bridge\'s own token', () => {
  it('B4. is kept in the private folder, 0600, the same from one read to the next, and is not the shared token', () => {
    const token = getBridgeToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(file, 'utf-8').trim()).toBe(token);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(getBridgeToken()).toBe(token);
    expect(token).not.toBe(getApiToken());
    expect(fs.existsSync(path.join(DATA_DIR, 'bridge-token'))).toBe(false);
  });

  it('B3. opens the bridge, as a Bearer or as x-api-key, where the shared token does not', () => {
    const token = getBridgeToken();
    expect(bridgeAuthorized({ authorization: `Bearer ${token}` })).toBe(true);
    expect(bridgeAuthorized({ 'x-api-key': token })).toBe(true);
    expect(bridgeAuthorized({ authorization: `Bearer ${getApiToken()}` })).toBe(false);
    expect(bridgeAuthorized({ 'x-api-key': getApiToken() })).toBe(false);
    expect(bridgeAuthorized({})).toBe(false);
  });

  it('B5. opens nothing of Tars\'s API', () => {
    const r = resolveCaller({ authorization: `Bearer ${getBridgeToken()}` }, '/api/agents');
    expect(r.ok).toBe(false);
  });
});

describe('the agents and the tasks on the bridge', () => {
  const settings = { veniceApiKey: 'venice-vendor-key', customOpenAIEnabled: true, customOpenAIBaseUrl: 'https://llm.example.com/v1', customOpenAIApiKey: 'custom-vendor-key' } as unknown as AppSettings;

  it('B1. a bridge agent\'s terminal is handed the bridge\'s token, never the shared one nor the vendor\'s key', () => {
    for (const id of ['venice', 'custom-openai'] as const) {
      const env = getProvider(id).getPtyEnvVars('a1', '/tmp/p', [], settings);
      expect(env.ANTHROPIC_AUTH_TOKEN, id).toBe(getBridgeToken());
      expect(JSON.stringify(env), id).not.toContain(getApiToken());
      expect(JSON.stringify(env), id).not.toContain('vendor-key');
    }
  });
});
