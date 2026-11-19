import { describe, it, expect } from 'vitest';
import { endpointLaunchFor, piModelsWithEndpoint, ENDPOINT_TOKEN_VAR, ENDPOINT_PROVIDER_ID } from '../../electron/services/endpoint-harness';

/**
 * What each harness is given to run on an inference endpoint through Tars's proxy (native traces), one
 * function per harness so a new one plugs in. Measured on 19/11 against the stand-in endpoint: Codex 0.163 through
 * `-c model_providers.*` with wire_api "responses" (it refuses "chat"), Qwen Code 0.25.2 through OPENAI_* and
 * `--auth-type openai`, Pi 1.5.2 through a models.json provider, opencode 1.19.6 through OPENCODE_CONFIG_CONTENT.
 *
 * How it fails, written before the code (19/11):
 * 1. A real key appears anywhere in what a harness is given: an argument, a variable, a file. Only the name of the
 *    variable that holds the terminal's proxy token, or the variable itself, filled in at spawn.
 * 2. Codex is given wire_api "chat", which 0.163 refuses at load; or a provider with no env_key, so it sends nothing.
 * 3. The user's own config is touched for codex, qwen or opencode (all three take the endpoint from the command
 *    line or the environment); for pi, the user's other providers in models.json are changed or dropped.
 * 4. A model id with TOML, JSON or shell metacharacters reaches a config value unescaped.
 * 5. opencode is given the bare model id, which it reads as a provider of its own.
 * 6. Qwen Code keeps the key a user set for its own provider: OPENAI_API_KEY must be the proxy token, filled at spawn.
 * 7. A harness that is not one of the four gets a launch.
 */

const BASE = 'http://127.0.0.1:31417/v1';
const KEYISH = /sk-|real-key/;

describe('endpoint launches', () => {
  it('1 and 2: codex gets a provider on the proxy, Responses, the token by variable name only', () => {
    const l = endpointLaunchFor('codex', { proxyBase: BASE, model: 'open-coder-1' })!;
    const joined = l.args.join(' ');
    expect(joined).toContain(`model_providers.${ENDPOINT_PROVIDER_ID}.base_url="${BASE}"`);
    expect(joined).toContain(`model_providers.${ENDPOINT_PROVIDER_ID}.wire_api="responses"`);
    expect(joined).toContain(`model_providers.${ENDPOINT_PROVIDER_ID}.env_key="${ENDPOINT_TOKEN_VAR}"`);
    expect(joined).toContain(`model_provider="${ENDPOINT_PROVIDER_ID}"`);
    expect(joined).not.toContain('"chat"');
    expect(l.tokenVars).toEqual([ENDPOINT_TOKEN_VAR]);
    expect(JSON.stringify(l)).not.toMatch(KEYISH);
  });

  it('3 and 6: qwen-code takes the endpoint from its environment, the token in OPENAI_API_KEY', () => {
    const l = endpointLaunchFor('qwen-code', { proxyBase: BASE, model: 'GLM' })!;
    expect(l.env).toEqual({ OPENAI_BASE_URL: BASE, OPENAI_MODEL: 'GLM' });
    expect(l.tokenVars).toEqual(['OPENAI_API_KEY']);
    expect(l.args).toEqual(['--auth-type', 'openai']);
    expect(l.files ?? []).toEqual([]);
  });

  it('3 and 5: opencode gets an inline provider and its model as provider/model', () => {
    const l = endpointLaunchFor('opencode', { proxyBase: BASE, model: 'GLM' })!;
    const config = JSON.parse(l.env.OPENCODE_CONFIG_CONTENT);
    const provider = config.provider[ENDPOINT_PROVIDER_ID];
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider.options).toEqual({ baseURL: BASE, apiKey: `{env:${ENDPOINT_TOKEN_VAR}}` });
    expect(provider.models.GLM).toMatchObject({ tool_call: true });
    expect(l.modelArg).toBe(`${ENDPOINT_PROVIDER_ID}/GLM`);
    expect(l.tokenVars).toEqual([ENDPOINT_TOKEN_VAR]);
  });

  it('3: pi gets a provider of Tars in its models.json, and the user\'s own providers stay as they were', () => {
    const l = endpointLaunchFor('pi', { proxyBase: BASE, model: 'GLM' })!;
    expect(l.args).toEqual(['--provider', ENDPOINT_PROVIDER_ID]);
    const mine = { providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'ollama', models: [{ id: 'q' }] } }, other: 1 };
    const next = piModelsWithEndpoint(mine, BASE, ['GLM', 'Qwen']) as typeof mine & { providers: Record<string, unknown> };
    expect(next.providers.ollama).toEqual(mine.providers.ollama);
    expect(next.other).toBe(1);
    expect(next.providers[ENDPOINT_PROVIDER_ID]).toEqual({
      baseUrl: BASE, api: 'openai-completions', apiKey: `$${ENDPOINT_TOKEN_VAR}`, models: [{ id: 'GLM' }, { id: 'Qwen' }],
    });
    expect(piModelsWithEndpoint(undefined, BASE, ['GLM'])).toMatchObject({ providers: { [ENDPOINT_PROVIDER_ID]: { models: [{ id: 'GLM' }] } } });
  });

  it('4: a model id with metacharacters is refused rather than escaped into a config', () => {
    for (const model of ['a"b', "a'b", 'a b', 'a\nb', 'a$b', 'a`b', 'a\\b', '']) {
      for (const h of ['codex', 'qwen-code', 'pi', 'opencode'] as const) {
        expect(endpointLaunchFor(h, { proxyBase: BASE, model }), `${h} ${JSON.stringify(model)}`).toBeNull();
      }
    }
    expect(endpointLaunchFor('codex', { proxyBase: BASE, model: 'org/Model-1.5:fp8_x' })).not.toBeNull();
  });

  it('7: only the four harnesses', () => {
    for (const h of ['claude', 'gemini', 'custom-openai', 'grok']) {
      expect(endpointLaunchFor(h, { proxyBase: BASE, model: 'GLM' }), h).toBeNull();
    }
  });
});
