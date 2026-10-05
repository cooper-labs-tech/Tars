import type { AgentStatus } from '@/types/electron';

/**
 * The Dashboard's signature of the agents its panels show: the panels are
 * handed a new list only when this string changes (TerminalsView/index.tsx).
 *
 * NUL-joined, same reasoning as agentProjectPathsKey there: currentTask is
 * free text (the prompt the agent was launched with), so a visible delimiter
 * could in principle appear inside a field and fold two different agent lists
 * into the same key. NUL is the one byte none of these fields can contain.
 * `error` is in it because the panel header shows it: a field the panel reads
 * and the key leaves out is a field that can change without the panel ever
 * hearing of it. `name` and `role` for the same reason: the header draws the
 * agent's mark from both, and the Claude account it runs on, its pin and the
 * last move by Tars, which its account control names and tells. Since when it
 * is asleep and who is waking it, which the header's line says (#322).
 */
export function panelAgentsKey(agents: AgentStatus[]): string {
  return agents.map(a => `${a.id}\u0000${a.status}\u0000${a.currentTask}\u0000${a.lastActivity}\u0000${a.error}\u0000${a.cliRunning}\u0000${a.leftFullscreen}\u0000${a.ptyId}\u0000${a.name}\u0000${a.role}\u0000${a.claudeAccountId}\u0000${a.claudeAccountPin}\u0000${a.claudeAccountMove?.at}\u0000${a.asleepSince}\u0000${a.waking?.by}\u0000${a.waking?.via}\u0000${a.waking?.since}`).join('\u0000');
}
