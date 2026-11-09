import type { AgentStatus } from '../types';
import type { AgentLaunchOptions } from './agent-launch';

/**
 * An agent's first task, kept for its next start (2.0.7): the window's agent.setFirstTask, and teams.deploy's brief
 * for an orchestrator not started on deploy. From the orchestrator's task of 10/11 (Tars-Frontend's
 * role-saved-on-create.md, M1): a team deployed with "start on deploy" off lost its brief, and saving it as
 * `savedPrompt` made it the agent's role, which every start reads ("## Your role" in the bootstrap).
 *
 * Kept on the agent (`firstTask`, in agents.json, so a restart of Tars keeps it), taken once by the next fresh start
 * as that start's prompt, before the start's own prompt, never by a chat's message or a restart that continues a
 * conversation, and cleared once that launch succeeded (handlers/ipc-handlers.ts, startAgentCli). Never written as the
 * role: the launch is told so (AgentLaunchOptions.firstTask).
 */

/** Long enough for a brief, short enough for a command line. */
export const FIRST_TASK_CAP = 20_000;

/** The prompt a launch types, and whether it took the agent's first task. */
export function withFirstTask(
  agent: Pick<AgentStatus, 'firstTask'> | undefined,
  prompt: string,
  options: Pick<AgentLaunchOptions, 'message' | 'resumeSessionId'> | undefined,
): { prompt: string; took: boolean } {
  const first = agent?.firstTask?.text?.trim();
  if (!first || options?.message || typeof options?.resumeSessionId === 'string') return { prompt, took: false };
  return { prompt: prompt.trim() ? `${first}\n\n${prompt}` : first, took: true };
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
