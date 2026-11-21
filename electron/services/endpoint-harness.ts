/**
 * What each harness is given to run on an inference endpoint through Tars's proxy (native traces).
 *
 * One function per harness, so a new one plugs in as one more case. Each returns:
 * - the arguments and variables that point the harness at the proxy (`http://127.0.0.1:<port>/v1`);
 * - `tokenVars`, the variables that must hold the terminal's proxy token, filled in at spawn (core/agent-pty.ts),
 *   never the endpoint's key, which no harness ever gets;
 * - `modelArg`, when the harness names a model its own way (opencode's provider/model);
 * - nothing written into the user's own config for codex, qwen-code and opencode, which take it all from the
 *   command line or the environment. Pi reads custom providers only from its models.json, so it gets one entry of
 *   Tars's there (piModelsWithEndpoint), next to the user's own, which stay as they are.
 *
 * Measured on 19/11 against the stand-in endpoint, a tool call each: Codex 0.163 (Responses only: it refuses
 * `wire_api = "chat"` at load), Qwen Code 0.25.2, Pi 1.5.2 and opencode 1.19.6 (chat completions).
 */

export const ENDPOINT_TOKEN_VAR = 'TARS_ENDPOINT_TOKEN';
export const ENDPOINT_PROVIDER_ID = 'tars-endpoint';

export interface EndpointLaunch {
  args: string[];
  env: Record<string, string>;
  tokenVars: string[];
  modelArg?: string;
  files?: string[];
  /** The proxy's base, for a harness whose provider its own provider class writes into a file of the agent's (Cline). */
  baseUrl?: string;
}

/** A model id safe in a TOML string, a JSON string and a shell word alike: letters, digits and . _ : / - only. */
const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,200}$/;

export function endpointLaunchFor(harness: string, o: { proxyBase: string; model: string }): EndpointLaunch | null {
  if (!SAFE_MODEL.test(o.model ?? '')) return null;
  const p = ENDPOINT_PROVIDER_ID;
  switch (harness) {
    case 'codex':
      return {
        args: [
          '-c', `model_providers.${p}.name="Tars endpoint"`,
          '-c', `model_providers.${p}.base_url="${o.proxyBase}"`,
          '-c', `model_providers.${p}.env_key="${ENDPOINT_TOKEN_VAR}"`,
          '-c', `model_providers.${p}.wire_api="responses"`,
          // Above the proxy's longest hold (3600 s), so codex does not give up on a request Tars holds while the
          // endpoint pauses.
          '-c', `model_providers.${p}.stream_idle_timeout_ms=3900000`,
          '-c', `model_provider="${p}"`,
        ],
        env: {},
        tokenVars: [ENDPOINT_TOKEN_VAR],
      };
    case 'qwen-code':
      return {
        args: ['--auth-type', 'openai'],
        env: { OPENAI_BASE_URL: o.proxyBase, OPENAI_MODEL: o.model },
        tokenVars: ['OPENAI_API_KEY'],
      };
    case 'pi':
      return { args: ['--provider', p], env: {}, tokenVars: [ENDPOINT_TOKEN_VAR] };
    case 'kimi-code':
      // Kimi Code takes a whole model from its environment, KIMI_MODEL_NAME being the switch (kimi-code 2.6.3,
      // docs/en/configuration/env-vars.md): chat completions, measured with a tool call; nothing written.
      return {
        args: [],
        env: { KIMI_MODEL_NAME: o.model, KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_BASE_URL: o.proxyBase },
        tokenVars: ['KIMI_MODEL_API_KEY'],
      };
    case 'opencode':
    case 'kilo':
      // Kilo, a build of opencode, reads an inline config only in its own variable: given opencode's, it ran on its
      // own Kilo Gateway (7.8.27, measured 20/11).
      return {
        args: [],
        env: {
          [harness === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT']: JSON.stringify({
            provider: {
              [p]: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Tars endpoint',
                options: { baseURL: o.proxyBase, apiKey: `{env:${ENDPOINT_TOKEN_VAR}}` },
                models: { [o.model]: { name: o.model, tool_call: true } },
              },
            },
          }),
        },
        tokenVars: [ENDPOINT_TOKEN_VAR],
        modelArg: `${p}/${o.model}`,
      };
    case 'cline':
      // Cline's TUI reads its provider from the agent's own providers.json (providers/cline-provider.ts writes it, the
      // proxy and the model, no key) and the key from OPENAI_API_KEY (3.0.74, measured 21/11: a bearer reached the endpoint).
      return { args: [], env: {}, tokenVars: ['OPENAI_API_KEY'], modelArg: o.model, baseUrl: o.proxyBase };
    case 'goose': {
      // Goose's openai provider, named on its line, and the proxy from its environment, nothing written (1.60.1,
      // measured 20/11 with a tool call): OPENAI_HOST the origin, OPENAI_BASE_PATH the path from there, no slash first.
      const proxy = new URL(o.proxyBase);
      return {
        args: ['--provider', 'openai', '--model', o.model],
        env: { OPENAI_HOST: proxy.origin, OPENAI_BASE_PATH: `${proxy.pathname.replace(/^\/+|\/+$/g, '')}/chat/completions` },
        tokenVars: ['OPENAI_API_KEY'],
      };
    }
    default:
      return null;
  }
}

/** Pi's models.json with Tars's provider set to the proxy and the endpoints' models, the user's own left as they are. */
export function piModelsWithEndpoint(current: unknown, proxyBase: string, models: string[]): Record<string, unknown> {
  const file = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  const providers = file.providers && typeof file.providers === 'object' && !Array.isArray(file.providers)
    ? { ...(file.providers as Record<string, unknown>) } : {};
  providers[ENDPOINT_PROVIDER_ID] = {
    baseUrl: proxyBase,
    api: 'openai-completions',
    apiKey: `$${ENDPOINT_TOKEN_VAR}`,
    models: [...new Set(models.filter(m => SAFE_MODEL.test(m)))].map(id => ({ id })),
  };
  file.providers = providers;
  return file;
}
