/**
 * Frontend provider registry: single source of truth for all AI providers.
 *
 * Adding a new provider: add one entry here. NewChatModal and Settings
 * Default Provider both import from this file.
 */

import type { AgentProvider } from '@/types/electron';
import { secretIsSet, type SecretsSet } from '@/lib/secret-settings';

export type ProviderIconDef =
  | { type: 'image'; src: string }
  | { type: 'svg-gemini' }
  | { type: 'svg-grok' }
  | { type: 'svg-openrouter' }
  | { type: 'svg-deepseek' }
  | { type: 'svg-moonshot' }
  | { type: 'svg-mimo' }
  | { type: 'svg-qwen' }
  | { type: 'svg-zai' }
  | { type: 'svg-minimax' }
  | { type: 'svg-nvidia' }
  | { type: 'svg-nous' }
  | { type: 'svg-ollama' }
  | { type: 'svg-venice' }
  | { type: 'text'; content: string }
  | { type: 'cpu' };

/** id === 'ollama-cloud' reuses the `svg-ollama` icon type above: same mark,
 *  the label ("Ollama Cloud" vs "Ollama") is what tells the two apart, so a
 *  second icon variant would be a distinction with no visual difference. */

export interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

export interface ProviderDef {
  id: AgentProvider;
  label: string;
  icon: ProviderIconDef;
  /** Tailwind color fragment, e.g. 'primary', 'amber-500' */
  accent: string;
  /**
   * Full Tailwind class string for a small badge (bg + text).
   * Used wherever a coloured pill badge shows the provider name.
   */
  /**
   * True for providers that ship as a CLI binary and can be "not installed".
   * Checked via cliPaths.detect() for claude/codex/gemini; others default to available.
   */
  requiresCli?: boolean;
  models: ProviderModel[];
  defaultModel: string;
}

export const PROVIDER_REGISTRY: ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude',
    icon: { type: 'image', src: '/claude-ai-icon.webp' },
    accent: 'blue-500',
    requiresCli: true,
    models: [
      { id: 'default', name: 'Default', description: 'Recommended' },
      { id: 'fable', name: 'Fable', description: 'Most intelligent (Claude 5)' },
      { id: 'sonnet', name: 'Sonnet', description: 'Daily coding' },
      { id: 'opus', name: 'Opus', description: 'Complex reasoning' },
      { id: 'haiku', name: 'Haiku', description: 'Fast & efficient' },
      { id: 'sonnet[1m]', name: 'Sonnet 1M', description: '1M context window' },
      { id: 'opusplan', name: 'Opus Plan', description: 'Extended thinking' },
    ],
    defaultModel: 'default',
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: { type: 'image', src: '/chatgpt-icon.webp' },
    accent: 'accent-green',
    requiresCli: true,
    // The floor until codex has written the account's own list, which
    // models:list reads first (electron/providers/codex-cli.ts): a ChatGPT
    // account's models as codex 0.163 listed them on 2026-10-18.
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.' },
      { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
      { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Previous generation workhorse model.' },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Older generation workhorse model.' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' },
    ],
    defaultModel: 'gpt-6.1-sol',
  },
  {
    // Qwen Code, the CLI `qwen` (2.0.4, #461). Its models are the user's own, read from the CLI
    // (models.ofCli('qwen-code'), its settings.json modelProviders), never a list kept here.
    id: 'qwen-code',
    label: 'Qwen Code',
    icon: { type: 'svg-qwen' },
    accent: 'primary',
    requiresCli: true,
    models: [],
    defaultModel: '',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    icon: { type: 'svg-gemini' },
    accent: 'purple-500',
    requiresCli: true,
    models: [
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', description: 'Most capable' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', description: 'Fast & capable' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Stable' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Balanced' },
    ],
    defaultModel: 'gemini-3-flash',
  },
  {
    id: 'grok',
    label: 'Grok',
    icon: { type: 'svg-grok' },
    accent: 'foreground',
    requiresCli: true,
    models: [
      { id: 'grok-composer-2.5-fast', name: 'Grok Composer 2.5 Fast', description: 'Recommended (default)' },
      { id: 'grok-build', name: 'Grok Build', description: 'Agentic coding' },
    ],
    defaultModel: 'grok-composer-2.5-fast',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    icon: { type: 'text', content: 'OC' },
    accent: 'teal-500',
    requiresCli: true,
    models: [
      { id: 'default', name: 'Default', description: 'Use configured default' },
    ],
    defaultModel: 'default',
  },
  {
    id: 'amp',
    label: 'Amp',
    // No vector mark in the tree, so the same lettered badge OpenCode and
    // Custom (OpenAI) use. Teal is what the registry gives a CLI with no brand
    // colour of its own; the four that have one keep it.
    icon: { type: 'text', content: 'AMP' },
    accent: 'teal-500',
    requiresCli: true,
    // Amp takes no model flag: it picks its own mix of open and frontier
    // models per request, so there is one row here and it says so.
    models: [
      { id: 'default', name: 'Default', description: 'Use configured default' },
    ],
    defaultModel: 'default',
  },
  {
    // Hermes Agent (Nous Research), #654: on an inference endpoint only, so no model of its own (they are the
    // endpoint's), and no plan mode (plan-mode.ts gives plan to claude and qwen-code only). Its mark is Nous's, as
    // Nous Portal's, the label telling the two apart. Frame: `Providers · Hermes Agent, the entry (PR 1)`.
    id: 'hermes',
    label: 'Hermes Agent',
    icon: { type: 'svg-nous' },
    accent: 'teal-500',
    requiresCli: true,
    models: [],
    defaultModel: '',
  },
  {
    id: 'pi',
    label: 'Pi',
    icon: { type: 'cpu' },
    accent: 'teal-500',
    requiresCli: true,
    models: [
      { id: 'default', name: 'Default', description: 'Use configured model' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet', description: 'Anthropic' },
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus', description: 'Anthropic' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google' },
    ],
    defaultModel: 'default',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: { type: 'svg-openrouter' },
    accent: 'amber-500',
    models: [
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', description: 'Reasoning' },
      { id: 'moonshotai/kimi-k2', name: 'Kimi K2', description: 'Agentic' },
      { id: 'xiaomi/mimo-v2-pro', name: 'MiMo V2 Pro', description: 'Code' },
      { id: 'qwen/qwq-32b', name: 'QwQ 32B', description: 'Math & code' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', description: 'OpenAI' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google' },
    ],
    defaultModel: 'deepseek/deepseek-r1',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    icon: { type: 'svg-deepseek' },
    accent: 'sky-500',
    models: [
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', description: 'Reasoning' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', description: 'Flagship chat' },
      { id: 'deepseek/deepseek-r1-distill-llama-70b', name: 'R1 Distill 70B', description: 'Fast' },
    ],
    defaultModel: 'deepseek/deepseek-r1',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    icon: { type: 'svg-moonshot' },
    accent: 'violet-500',
    models: [
      { id: 'moonshotai/kimi-k2', name: 'Kimi K2', description: 'Agentic flagship' },
      { id: 'moonshotai/moonlight-16k', name: 'Moonlight 16K', description: 'Fast' },
      { id: 'moonshotai/kimi-vl-a3b-thinking', name: 'Kimi VL', description: 'Vision' },
    ],
    defaultModel: 'moonshotai/kimi-k2',
  },
  {
    id: 'mimo',
    label: 'MiMo',
    icon: { type: 'svg-mimo' },
    accent: 'orange-500',
    models: [
      { id: 'xiaomi/mimo-v2-pro', name: 'MiMo V2 Pro', description: 'Flagship' },
      { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash', description: 'Fast' },
      { id: 'xiaomi/mimo-v2-omni', name: 'MiMo V2 Omni', description: 'Multimodal' },
    ],
    defaultModel: 'xiaomi/mimo-v2-pro',
  },
  {
    id: 'qwen',
    // The Qwen API, through the claude binary: not Qwen Code, the CLI below.
    label: 'Qwen API',
    icon: { type: 'svg-qwen' },
    accent: 'blue-500',
    models: [
      { id: 'qwen/qwq-32b', name: 'QwQ 32B', description: 'Reasoning' },
      { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', description: 'Flagship' },
      { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', description: 'Balanced' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen Coder', description: 'Code' },
    ],
    defaultModel: 'qwen/qwq-32b',
  },
  {
    id: 'zhipu',
    label: 'Zai',
    icon: { type: 'svg-zai' },
    accent: 'indigo-500',
    models: [
      { id: 'zhipuai/glm-4.6', name: 'GLM-4.6', description: 'Flagship' },
      { id: 'zhipuai/glm-4.5', name: 'GLM-4.5', description: 'Stable' },
      { id: 'zhipuai/glm-4-plus', name: 'GLM-4 Plus', description: 'Balanced' },
      { id: 'zhipuai/glm-4-air', name: 'GLM-4 Air', description: 'Fast' },
      { id: 'zhipuai/glm-4-flash', name: 'GLM-4 Flash', description: 'Economy' },
    ],
    defaultModel: 'zhipuai/glm-4.6',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    icon: { type: 'svg-minimax' },
    accent: 'rose-500',
    models: [
      { id: 'minimax/minimax-m2', name: 'MiniMax M2', description: 'Agentic flagship' },
      { id: 'minimax/minimax-m1', name: 'MiniMax M1', description: 'Long-context reasoning' },
      { id: 'minimax/minimax-01', name: 'MiniMax Text-01', description: 'Fast' },
    ],
    defaultModel: 'minimax/minimax-m2',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    icon: { type: 'svg-nvidia' },
    accent: 'green-500',
    models: [
      { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B', description: 'Flagship reasoning' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', description: 'Balanced' },
      { id: 'nvidia/llama-3.1-nemotron-51b-instruct', name: 'Nemotron 51B', description: 'Fast' },
      { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', description: 'Meta via NIM' },
    ],
    defaultModel: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  },
  {
    id: 'nous-portal',
    label: 'Nous Portal',
    icon: { type: 'svg-nous' },
    accent: 'teal-500',
    models: [
      { id: 'nous/hermes-3-llama-3.1-405b', name: 'Hermes 3 405B', description: 'Flagship agentic' },
      { id: 'nous/hermes-3-llama-3.1-70b', name: 'Hermes 3 70B', description: 'Balanced' },
      { id: 'nous/hermes-2-pro-llama-3-8b', name: 'Hermes 2 Pro 8B', description: 'Fast & efficient' },
    ],
    defaultModel: 'nous/hermes-3-llama-3.1-405b',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    icon: { type: 'svg-ollama' },
    accent: 'foreground',
    // Not a CLI binary, but "not installed" is exactly the right word for
    // "the local server isn't answering" - see computeProviderAvailability.
    requiresCli: true,
    models: [
      { id: 'llama3.3', name: 'Llama 3.3', description: 'Meta, locally hosted' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', description: 'Code-focused' },
      { id: 'deepseek-r1', name: 'DeepSeek R1', description: 'Reasoning' },
      { id: 'gpt-oss', name: 'GPT-OSS', description: 'OpenAI open weights' },
    ],
    defaultModel: 'llama3.3',
  },
  {
    id: 'venice',
    label: 'Venice AI',
    icon: { type: 'svg-venice' },
    accent: 'pink-500',
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', description: 'Meta, balanced' },
      { id: 'venice-uncensored-1-2', name: 'Venice Uncensored', description: 'Unfiltered' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', description: 'Flagship chat' },
      { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B', description: 'Large MoE' },
      { id: 'hermes-3-llama-3.1-405b', name: 'Hermes 3 405B', description: 'Agentic' },
      { id: 'mistral-small-3-2-24b-instruct', name: 'Mistral Small', description: 'Fast' },
    ],
    defaultModel: 'llama-3.3-70b',
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    icon: { type: 'svg-ollama' },
    accent: 'foreground',
    // Curated floor; models:list prefers the live models.dev 'ollama-cloud'
    // catalogue entry, see model-catalog.ts.
    models: [
      { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', description: 'OpenAI open weights, flagship' },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', description: 'OpenAI open weights, fast' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Zhipu, flagship' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', description: 'Moonshot, code-focused' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Flagship reasoning' },
      { id: 'minimax-m3', name: 'MiniMax M3', description: 'Agentic' },
    ],
    defaultModel: 'gpt-oss:120b',
  },
  {
    id: 'custom-openai',
    label: 'Custom (OpenAI)',
    icon: { type: 'text', content: 'API' },
    accent: 'foreground',
    // No catalogue, no curated floor: a private endpoint has exactly one
    // model, whatever was typed into Settings. This placeholder id is never
    // actually reachable - computeProviderAvailability below keeps the
    // provider disabled until customOpenAIModel is set, at which point
    // models:list (ipc-handlers.ts) returns that real model instead.
    models: [
      { id: 'not-configured', name: 'Set a model in Settings', description: 'Settings > AI Providers > Custom OpenAI-compatible' },
    ],
    defaultModel: 'not-configured',
  },
];


/**
 * Minimal shape of the app settings needed to compute provider availability. Whether a key is set is what
 * `secretsSet` says (2.0.4, #466): the window is never handed a key, only a mask for one that is set.
 */
interface ProviderAvailabilitySettings {
  openRouterEnabled?: boolean;
  deepSeekEnabled?: boolean;
  moonshotEnabled?: boolean;
  zhipuEnabled?: boolean;
  minimaxEnabled?: boolean;
  veniceEnabled?: boolean;
  ollamaCloudEnabled?: boolean;
  customOpenAIEnabled?: boolean;
  customOpenAIBaseUrl?: string;
  customOpenAIModel?: string;
  secretsSet?: SecretsSet;
}

/**
 * Single source of truth for "can this provider be selected?": used by
 * NewChatModal and Settings so the two can't diverge again.
 *
 * Semantics mirror the electron providers: deepseek/moonshot/zhipu/minimax
 * have documented Anthropic-compatible direct endpoints (own key or OpenRouter
 * fallback); qwen/mimo/nvidia/nous-portal have none and are reachable ONLY
 * through OpenRouter. Venice has no Anthropic-compatible endpoint AND is not
 * on OpenRouter, so it needs its own key with no fallback (it goes through
 * Tars's own translation bridge, see electron/services/openai-bridge.ts). Ollama
 * is a local server: availability is "did the last reachability check
 * answer", passed in by the caller rather than derived here, since that check
 * is async and this function is not. Ollama Cloud is a hosted vendor like any
 * other: enabled + key. Custom (OpenAI-compatible) additionally needs a model,
 * since without one there is nothing to put in the request's `model` field -
 * see custom-openai-provider.ts.
 */
export function computeProviderAvailability(
  paths: Record<string, string | undefined> | null | undefined,
  settings: ProviderAvailabilitySettings | null | undefined,
  ollamaReachable?: boolean,
): Record<string, boolean> {
  const keyed = (enabled: boolean | undefined, field: string) => !!enabled && secretIsSet(settings, field);
  const viaOpenRouter = keyed(settings?.openRouterEnabled, 'openRouterApiKey');
  return {
    claude: !!paths?.claude,
    codex: !!paths?.codex,
    gemini: !!paths?.gemini,
    grok: !!paths?.grok,
    qwencode: !!paths?.qwencode,
    opencode: !!paths?.opencode,
    amp: !!paths?.amp,
    pi: !!paths?.pi,
    // Not ready until Tars can run a Hermes Agent: setting it up is #654's PR 2, which reports it here. Listed
    // false, not left out, or a team's member table (which keeps all but false) would offer it.
    hermes: false,
    local: true,
    openrouter: viaOpenRouter,
    deepseek: keyed(settings?.deepSeekEnabled, 'deepSeekApiKey') || viaOpenRouter,
    moonshot: keyed(settings?.moonshotEnabled, 'moonshotApiKey') || viaOpenRouter,
    zhipu: keyed(settings?.zhipuEnabled, 'zhipuApiKey') || viaOpenRouter,
    minimax: keyed(settings?.minimaxEnabled, 'minimaxApiKey') || viaOpenRouter,
    qwen: viaOpenRouter,
    mimo: viaOpenRouter,
    nvidia: viaOpenRouter,
    'nous-portal': viaOpenRouter,
    venice: keyed(settings?.veniceEnabled, 'veniceApiKey'),
    ollama: ollamaReachable ?? false,
    'ollama-cloud': keyed(settings?.ollamaCloudEnabled, 'ollamaCloudApiKey'),
    'custom-openai': !!(settings?.customOpenAIEnabled && settings?.customOpenAIBaseUrl && settings?.customOpenAIModel),
  };
}

/** Look up a provider definition by ID. */
export function getProviderDef(id: string): ProviderDef | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}

/** Ids that are not a word a reader knows, and the words their cards write instead. */
const PROVIDER_WORDS: Record<string, string> = { 'qwen-code': 'Qwen Code' };

/**
 * The word an agent's card, its detail panel and its window's header write for its provider: the provider's own id,
 * as the frames write it ("claude · fable 5 · main"), except Qwen Code's `qwen-code`, which reads Qwen Code, apart
 * from the Qwen API's `qwen`. An agent with no provider is Claude's; an id not known yet reads as itself.
 */
export function providerWord(provider?: string | null): string {
  if (!provider) return 'claude';
  return PROVIDER_WORDS[provider] ?? provider;
}
