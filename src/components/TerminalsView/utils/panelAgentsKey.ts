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
 * last move by Tars, which its account control names and tells. A permission
 * question Tars holds and the call it is about, which the panel's line names
 * and answers: ask in terminal takes the question away and moves nothing else.
 * Since when it is asleep and who is waking it, which the header's line says
 * (#322). The line the agent last wrote about itself and when, which the header's second line shows (#513). What its
 * CLI says of itself over OSC 7501, the blocked line under the header (#510).
 */
export function panelAgentsKey(agents: AgentStatus[]): string {
  return agents.map(a => `${a.id}\u0000${a.status}\u0000${a.currentTask}\u0000${a.lastActivity}\u0000${a.error}\u0000${a.cliRunning}\u0000${a.leftFullscreen}\u0000${a.ptyId}\u0000${a.name}\u0000${a.role}\u0000${a.claudeAccountId}\u0000${a.claudeAccountPin}\u0000${a.claudeAccountMove?.at}\u0000${a.permissionAsk?.askedAt}\u0000${a.waitingOn?.text}\u0000${a.asleepSince}\u0000${a.waking?.by}\u0000${a.waking?.via}\u0000${a.waking?.since}\u0000${a.checkpoint?.at}\u0000${a.checkpoint?.line}\u0000${a.programStatus?.state}\u0000${a.programStatus?.kind}\u0000${a.programStatus?.msg}`).join('\u0000');
}
