import type { AgentProvider } from '../types';
import { getProvider } from './index';

/**
 * Whether a provider runs a read-only plan mode: its own declaration (CLIProvider.planMode), so a provider added
 * later is decided by what it says of itself. Today Claude Code, which is also what no provider, local and an
 * unknown id fall back to, and Qwen Code. Never another CLI (codex maps only auto and bypass, so plan runs as normal
 * there and edits once it has asked), nor Claude Code through an API key. The window decides the same
 * (src/lib/plan-mode.ts, hasPlanMode; #373).
 */
export function hasPlanMode(provider: string | null | undefined): boolean {
  return getProvider((provider ?? undefined) as AgentProvider | undefined).planMode === true;
}

/**
 * The window's reason for plan on a provider that has none, or null (the Audit's Low 2 on #407): refused at
 * creation, by the API and the window's channel, and by an update, rather than stored and run as normal; and, since
 * the Audit's I-1 on #636, for a session asked in plan through /start, /dispatch or a gateway (agent-routes.ts,
 * modeRefusal; webhook-routes.ts), which ran as normal, with every write tool.
 */
export function planModeRefusal(provider: string | null | undefined, permissionMode: string | null | undefined): string | null {
  if (permissionMode !== 'plan' || hasPlanMode(provider)) return null;
  return `${getProvider(provider as AgentProvider).displayName} has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.`;
}
