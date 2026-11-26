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
 * `wire_api = "chat"` at load), Qwen Code 0.25.2, Pi 1.5.2 and opencode 1.19.6 (chat completions); Hermes Agent 0.23.4
 * on 27/11 (chat completions), which takes it all from the agent's profile (`profile`).
 */

export const ENDPOINT_TOKEN_VAR = 'TARS_ENDPOINT_TOKEN';
export const ENDPOINT_PROVIDER_ID = 'tars-endpoint';

export interface EndpointLaunch {
  args: string[];
  env: Record<string, string>;
  tokenVars: string[];
  modelArg?: string;
  files?: string[];
  /**
   * Hermes only: the endpoint for the agent's own profile, its token there too (services/hermes-home.ts), and nothing
   * in its terminal. One gateway per Hermes home runs every Hermes agent's sessions with the environment of the
   * terminal that started it, and hands a session no credential of the terminal that typed its task (0.23.4, 27/11).
   */
  profile?: { baseUrl: string; model: string };
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
    case 'opencode':
      return {
        args: [],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
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
    case 'hermes':
      return { args: [], env: {}, tokenVars: [], profile: { baseUrl: o.proxyBase, model: o.model } };
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
