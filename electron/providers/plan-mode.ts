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
  // Claude Code's --permission-mode plan; Qwen Code's --approval-mode plan (0.25.2).
  const id = getProvider((provider ?? undefined) as AgentProvider | undefined).id;
  return id === 'claude' || id === 'qwen-code';
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

/**
 * Plan refused at a launch, with planModeRefusal's reason, for a CLI that would start in a mode it cannot keep: Kimi
 * Code, whose --plan runs commands after dialogs nobody answers (measured, the Audit's I3 on #601), and Goose, whose
 * chat mode still asked to run a command (1.60.1, measured), so its builder refuses plan too. Every other
 * provider saved in plan launches as before (the Audit's L3): main moves plan to normal nowhere on load, and each CLI's
 * builder decides what plan is for it. Asked by every launch before anything is killed or spent.
 */
export function launchPlanRefusal(provider: string | null | undefined, permissionMode: string | null | undefined): string | null {
  const id = getProvider((provider ?? undefined) as AgentProvider | undefined).id;
  if (id !== 'kimi-code' && id !== 'goose') return null;
  return planModeRefusal(provider, permissionMode);
}
