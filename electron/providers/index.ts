import type { AgentProvider } from '../types';
import type { CLIProvider } from './cli-provider';
import { AmpProvider } from './amp-provider';
import { ClaudeProvider } from './claude-provider';
import { CodexProvider } from './codex-provider';
import { GeminiProvider } from './gemini-provider';
import { GrokProvider } from './grok-provider';
import { OpenCodeProvider } from './opencode-provider';
import { PiProvider } from './pi-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { DeepSeekProvider } from './deepseek-provider';
import { MiMoProvider } from './mimo-provider';
import { MoonshotProvider } from './moonshot-provider';
import { QwenProvider } from './qwen-provider';
import { QwenCodeProvider } from './qwen-code-provider';
import { KimiCodeProvider } from './kimi-code-provider';
import { KiloProvider } from './kilo-provider';
import { ZhipuProvider } from './zhipu-provider';
import { MiniMaxProvider } from './minimax-provider';
import { NvidiaProvider } from './nvidia-provider';
import { NousPortalProvider } from './nous-portal-provider';
import { OllamaProvider } from './ollama-provider';
import { VeniceProvider } from './venice-provider';
import { OllamaCloudProvider } from './ollama-cloud-provider';
import { CustomOpenAIProvider } from './custom-openai-provider';

export type { CLIProvider } from './cli-provider';
export type {
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
  PtyLaunch,
} from './cli-provider';

const providers: Record<string, CLIProvider> = {
  amp: new AmpProvider(),
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  gemini: new GeminiProvider(),
  grok: new GrokProvider(),
  opencode: new OpenCodeProvider(),
  pi: new PiProvider(),
  openrouter: new OpenRouterProvider(),
  deepseek: new DeepSeekProvider(),
  mimo: new MiMoProvider(),
  moonshot: new MoonshotProvider(),
  qwen: new QwenProvider(),
  // Qwen Code, the CLI qwen: not the Qwen API above, which runs the claude binary.
  'qwen-code': new QwenCodeProvider(),
  // Kimi Code CLI, the binary kimi: not moonshot above, which runs the claude binary on Moonshot's API.
  'kimi-code': new KimiCodeProvider(),
  // Kilo CLI, the binary kilo: a build of opencode with its own config and database (kilo-provider.ts).
  kilo: new KiloProvider(),
  zhipu: new ZhipuProvider(),
  minimax: new MiniMaxProvider(),
  nvidia: new NvidiaProvider(),
  'nous-portal': new NousPortalProvider(),
  ollama: new OllamaProvider(),
  venice: new VeniceProvider(),
  'ollama-cloud': new OllamaCloudProvider(),
  'custom-openai': new CustomOpenAIProvider(),
};

/**
 * Get a CLI provider by its ID.
 * Falls back to Claude for unknown providers (including 'local' which is a Claude sub-mode).
 */
export function getProvider(id?: AgentProvider): CLIProvider {
  if (!id || id === 'local') {
    return providers.claude;
  }
  return providers[id] || providers.claude;
}

/**
 * Get all registered providers (excluding 'local' which is a Claude sub-mode).
 */
export function getAllProviders(): CLIProvider[] {
  return Object.values(providers);
}

/**
 * Check if a provider ID is valid.
 */
export function isValidProvider(id: string): id is AgentProvider {
  return id === 'local' || id in providers;
}
