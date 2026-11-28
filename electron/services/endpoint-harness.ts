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
 *
 * And the endpoint's real limits, its context window and its output cap (trace feature C2), through each harness's own
 * knob, with `given` saying what it got: codex `-c model_context_window` and `-c model_max_output_tokens`, Qwen Code
 * its settings file's `generationConfig` (both measured, fenced, on 27/11), pi its models.json entry and opencode its
 * model's `limit` (from their docs).
 */

export const ENDPOINT_TOKEN_VAR = 'TARS_ENDPOINT_TOKEN';
export const ENDPOINT_PROVIDER_ID = 'tars-endpoint';

/**
 * What the harness was given of the endpoint's limits, and whether it compacts its history on its own (trace feature
 * C2): null where it was given nothing, or where that is not measured.
 */
export interface GivenContext {
  contextWindow: number | null;
  outputCap: number | null;
  autoCompaction: 'on' | 'off' | null;
}

export interface EndpointLaunch {
  args: string[];
  env: Record<string, string>;
  tokenVars: string[];
  modelArg?: string;
  files?: string[];
  given: GivenContext;
}

/** A model id safe in a TOML string, a JSON string and a shell word alike: letters, digits and . _ : / - only. */
const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,200}$/;

/** The bounds an endpoint's context window is taken within, in tokens; its output cap is 1 up to the window. */
export const MIN_CONTEXT_WINDOW = 1024;
export const MAX_CONTEXT_WINDOW = 10_000_000;

/**
 * An endpoint's limits as a harness may take them: a whole window within the bounds, a whole cap from 1 up to the
 * window (up to the largest window when there is none). Anything else is null and is never passed on: a settings file
 * edited by hand cannot hand a harness a value it would refuse, or one that makes no sense.
 */
export function usableLimits(contextWindow: unknown, maxOutputTokens: unknown): { contextWindow: number | null; outputCap: number | null } {
  const cw = typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow >= MIN_CONTEXT_WINDOW && contextWindow <= MAX_CONTEXT_WINDOW
    ? contextWindow : null;
  const ceiling = cw ?? MAX_CONTEXT_WINDOW;
  const out = typeof maxOutputTokens === 'number' && Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1 && maxOutputTokens <= ceiling
    ? maxOutputTokens : null;
  return { contextWindow: cw, outputCap: out };
}

/** Why the owner's window or cap cannot be saved, or null (each may be absent, or null to clear it). */
export function limitsError(contextWindow: unknown, maxOutputTokens: unknown): string | null {
  const set = (v: unknown) => v !== undefined && v !== null;
  const usable = usableLimits(contextWindow, maxOutputTokens);
  if (set(contextWindow) && usable.contextWindow === null) {
    return `The context window is a whole number of tokens from ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} to ${MAX_CONTEXT_WINDOW.toLocaleString('en-US')}.`;
  }
  if (set(maxOutputTokens) && usable.outputCap === null) {
    return 'The output cap is a whole number of tokens, at least 1 and no more than the context window.';
  }
  return null;
}

export function endpointLaunchFor(harness: string, o: { proxyBase: string; model: string; contextWindow?: number; maxOutputTokens?: number }): EndpointLaunch | null {
  if (!SAFE_MODEL.test(o.model ?? '')) return null;
  const p = ENDPOINT_PROVIDER_ID;
  const { contextWindow: cw, outputCap: out } = usableLimits(o.contextWindow, o.maxOutputTokens);
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
          // The endpoint's real limits (measured on 0.163, 27/11): without a window codex takes 258,400 tokens for a
          // model it does not know; with one it compacts on its own near it. Its cap stays its own: no
          // max_output_tokens goes on the wire.
          ...(cw !== null ? ['-c', `model_context_window=${cw}`] : []),
          ...(out !== null ? ['-c', `model_max_output_tokens=${out}`] : []),
        ],
        env: {},
        tokenVars: [ENDPOINT_TOKEN_VAR],
        given: { contextWindow: cw, outputCap: out, autoCompaction: 'on' },
      };
    case 'qwen-code':
      // The limits go into its settings file (qwen-code.ts writeQwenAgentSettings, `given`): measured on 0.25.2,
      // without them it takes 200,000 tokens; it always compacts on its own (85 % of the window by default).
      return {
        args: ['--auth-type', 'openai'],
        env: { OPENAI_BASE_URL: o.proxyBase, OPENAI_MODEL: o.model },
        tokenVars: ['OPENAI_API_KEY'],
        given: { contextWindow: cw, outputCap: out, autoCompaction: 'on' },
      };
    case 'pi':
      // The limits go into its models.json (piModelsWithEndpoint, from pi's docs); its compaction is not measured.
      return { args: ['--provider', p], env: {}, tokenVars: [ENDPOINT_TOKEN_VAR], given: { contextWindow: cw, outputCap: out, autoCompaction: null } };
    case 'opencode': {
      // A model's `limit` takes both its context and its output (from opencode's docs): one without the other is not
      // passed. Its compaction is not measured.
      const limit = cw !== null && out !== null ? { limit: { context: cw, output: out } } : {};
      return {
        args: [],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              [p]: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Tars endpoint',
                options: { baseURL: o.proxyBase, apiKey: `{env:${ENDPOINT_TOKEN_VAR}}` },
                models: { [o.model]: { name: o.model, tool_call: true, ...limit } },
              },
            },
          }),
        },
        tokenVars: [ENDPOINT_TOKEN_VAR],
        modelArg: `${p}/${o.model}`,
        given: { contextWindow: 'limit' in limit ? cw : null, outputCap: 'limit' in limit ? out : null, autoCompaction: null },
      };
    }
    default:
      return null;
  }
}

/**
 * Pi's models.json with Tars's provider set to the proxy and the endpoints' models, the user's own left as they are.
 * `limits`: the launching model's, from its endpoint (`contextWindow`, `maxTokens` in pi's models.json, from its docs);
 * the other models keep none, since one model id may be served by two endpoints with other limits.
 */
export function piModelsWithEndpoint(current: unknown, proxyBase: string, models: string[], limits?: { model: string; contextWindow: number | null; outputCap: number | null }): Record<string, unknown> {
  const file = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  const providers = file.providers && typeof file.providers === 'object' && !Array.isArray(file.providers)
    ? { ...(file.providers as Record<string, unknown>) } : {};
  providers[ENDPOINT_PROVIDER_ID] = {
    baseUrl: proxyBase,
    api: 'openai-completions',
    apiKey: `$${ENDPOINT_TOKEN_VAR}`,
    models: [...new Set(models.filter(m => SAFE_MODEL.test(m)))].map(id => ({
      id,
      ...(limits && limits.model === id && limits.contextWindow !== null ? { contextWindow: limits.contextWindow } : {}),
      ...(limits && limits.model === id && limits.outputCap !== null ? { maxTokens: limits.outputCap } : {}),
    })),
  };
  file.providers = providers;
  return file;
}
