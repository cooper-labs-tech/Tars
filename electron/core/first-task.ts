import type { AgentStatus } from '../types';
import type { AgentLaunchOptions } from './agent-launch';

/**
 * An agent's first task, kept for its next start (2.0.7): the window's agent.setFirstTask, and teams.deploy's brief
 * for an orchestrator not started on deploy. From the orchestrator's task of 10/11 (Tars-Frontend's
 * role-saved-on-create.md, M1): a team deployed with "start on deploy" off lost its brief, and saving it as
 * `savedPrompt` made it the agent's role, which every start reads ("## Your role" in the bootstrap).
 *
 * Kept on the agent (`firstTask`, in agents.json, so a restart of Tars keeps it) until whichever start comes first,
 * the window's launcher (startAgentCli in handlers/ipc-handlers.ts: Start, a team deployed, a wake, a recovery) or
 * spawnAgentSession (services/api-routes/agent-routes.ts: a delegation, /start, a bot's or Hermes's message), and
 * cleared once that launch succeeded. A start that opens a new conversation types it, before the start's own prompt;
 * one that continues a conversation, read from the conversation the launch resolves (utils/resume-session.ts
 * launchResumes), or a chat's message, types nothing of it: a task for a first conversation, it would come into one
 * under way as a new turn (the Audit's L3 on #584: a wake typed an old brief). Never written as the role: the launch
 * is told so (AgentLaunchOptions.firstTask).
 */

/** Long enough for a brief, short enough for a command line. */
export const FIRST_TASK_CAP = 20_000;

/**
 * The prompt a start types, whether it took the agent's first task, and whether this start spends it (took it, or
 * leaves it unused): the caller clears it once the launch succeeded when `spent`.
 */
export function withFirstTask(
  agent: Pick<AgentStatus, 'firstTask'> | undefined,
  prompt: string,
  start: Pick<AgentLaunchOptions, 'message'> & { resumes: boolean },
): { prompt: string; took: boolean; spent: boolean } {
  const first = agent?.firstTask?.text?.trim();
  if (!first) return { prompt, took: false, spent: false };
  if (start.message || start.resumes) return { prompt, took: false, spent: true };
  return { prompt: prompt.trim() ? `${first}\n\n${prompt}` : first, took: true, spent: true };
}

/** The first task cleared once the start that spent it launched, and said when it went unused. */
export function spendFirstTask(agent: AgentStatus | undefined, took: boolean): void {
  if (!agent?.firstTask) return;
  if (!took) console.log(`[first-task] ${agent.name || agent.id}: its first task cleared unused, its start continuing a conversation (or a chat's message)`);
  agent.firstTask = undefined;
}

/** The window's change: a task kept for the agent's next start, or none (empty or null). The caller saves. */
export function setFirstTask(agent: AgentStatus | undefined, task: unknown): { success: true } | { success: false; error: string } {
  if (!agent) return { success: false, error: 'Agent not found' };
  if (task === null || task === undefined || (typeof task === 'string' && !task.trim())) {
    agent.firstTask = undefined;
    return { success: true };
  }
  if (typeof task !== 'string') return { success: false, error: 'A first task is text' };
  if (task.length > FIRST_TASK_CAP) return { success: false, error: `A first task is at most ${FIRST_TASK_CAP.toLocaleString('en-US')} characters` };
  agent.firstTask = { text: task.trim(), setAt: new Date().toISOString() };
  return { success: true };
}
