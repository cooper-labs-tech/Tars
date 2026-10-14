import type { AgentProvider } from '../types';
import { getProvider } from './index';

/**
 * Whether a provider runs Claude Code's plan mode, as the window decides it
 * (src/lib/plan-mode.ts, hasPlanMode; #373): Claude Code itself, which is also
 * what no provider, local and an unknown id fall back to. Never another CLI
 * (codex maps only auto and bypass, so plan runs as normal there and edits once
 * it has asked), nor Claude Code through an API key.
 */
export function hasPlanMode(provider: string | null | undefined): boolean {
  return getProvider((provider ?? undefined) as AgentProvider | undefined).id === 'claude';
}

/**
 * The window's reason for plan on a provider that has none, or null (the
 * Audit's Low 2 on #407): refused at creation, by the API and the window's
 * channel, and by an update, rather than stored and run as normal.
 */
export function planModeRefusal(provider: string | null | undefined, permissionMode: string | null | undefined): string | null {
  if (permissionMode !== 'plan' || hasPlanMode(provider)) return null;
  return `${getProvider(provider as AgentProvider).displayName} has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.`;
}
