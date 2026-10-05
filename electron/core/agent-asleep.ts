import type { AgentStatus, AgentWakeVia, AgentWaking } from '../types';
import { resumeOnNextStart } from '../utils/resume-session';
import { launchAgent, sessionStarting } from './agent-launch';

/**
 * An agent asleep, and how it wakes (JeanBrasse's choices 5 and 6 of 2026-10-05;
 * services/agent-sleep.ts decides who sleeps, and ends the CLI).
 *
 * Asleep: `status` is `asleep` from `asleepSince`, no terminal, its
 * conversation kept for the next start, which resumes it whatever started the
 * agent earlier in this run. The last screen of the CLI it slept in is kept
 * here, in memory, for its pane: the terminal and its mirror are gone, and the
 * screen is what a person reads to know where it was.
 *
 * Woken: every way an agent gets a terminal again (initAgentPty for the window,
 * the bots and the launches of the main process; spawnAgentSession for the
 * API) calls `wakeFromSleep`, so no sender can wake it without it reading
 * `waking`, with who woke it and how, until its CLI's session is up. The
 * sender says who it is with `noteWaker` before it starts the agent; one that
 * says nothing wakes it as Tars.
 */

const screens = new Map<string, string>();
const wakers = new Map<string, { by: string; via: AgentWakeVia }>();

/**
 * Asleep from `now`: its terminal, task and wait gone, and its session a
 * tombstone, since that session's hooks outlive the kill (core/agent-stop.ts).
 * The caller ends the terminal's tree.
 */
export function fallAsleep(agent: AgentStatus, screen: string | undefined, now: number): void {
  agent.status = 'asleep';
  agent.asleepSince = new Date(now).toISOString();
  agent.waking = undefined;
  agent.ptyId = undefined;
  agent.currentTask = undefined;
  agent.waitingReason = undefined;
  if (agent.currentSessionId) agent.lastKilledSessionId = agent.currentSessionId;
  agent.currentSessionId = undefined;
  if (screen) screens.set(agent.id, screen);
  else screens.delete(agent.id);
  resumeOnNextStart(agent.id);
}

/** The last screen of the CLI it slept in, while it is asleep. */
export function screenWhileAsleep(agent: AgentStatus): string | undefined {
  if (agent.status !== 'asleep') {
    screens.delete(agent.id);
    return undefined;
  }
  return screens.get(agent.id);
}

/** Who is about to start this agent, and how: read by the wake that start causes, once. */
export function noteWaker(agentId: string, by: string, via: AgentWakeVia): void {
  wakers.set(agentId, { by, via });
}

/**
 * Where an agent gets a terminal again: an asleep one is waking from now on.
 * Its conversation resumes under the session id it slept in (`--resume` keeps
 * it), so that session is not a tombstone any more: its hooks are the woken
 * session's own. Nothing for an agent that was not asleep.
 */
export function wakeFromSleep(agent: AgentStatus): void {
  const waker = wakers.get(agent.id);
  wakers.delete(agent.id);
  if (agent.status !== 'asleep') return;
  agent.status = 'idle';
  agent.asleepSince = undefined;
  agent.waking = { by: waker?.by ?? 'Tars', via: waker?.via ?? 'start', since: new Date().toISOString() };
  if (agent.lastKilledSessionId && agent.lastKilledSessionId === agent.resumableSessionId) agent.lastKilledSessionId = undefined;
  screens.delete(agent.id);
}

/**
 * `waking` as the window and the API show it: while its launch is on its way
 * (`starting`, sessionStarting in core/agent-launch.ts). Once the session is
 * up, or the launch given up, it is gone, and not shown again.
 */
export function publishedWaking(agent: AgentStatus, starting: boolean): AgentWaking | undefined {
  if (!agent.waking) return undefined;
  if (starting) return agent.waking;
  agent.waking = undefined;
  return undefined;
}

export type WakeAnswer = { success: true; alreadyWaking?: true } | { success: false; error: string };

/**
 * The wake call: the agent's CLI started on its own conversation with nothing
 * typed. For the window's `wake` and a key typed into its pane; a message
 * wakes it by being sent (spawnAgentSession starts it with the message).
 */
export async function wakeAgent(agent: AgentStatus, by: string, via: AgentWakeVia): Promise<WakeAnswer> {
  const name = agent.name || agent.id;
  if (agent.status !== 'asleep') return { success: false, error: `${name} is not asleep.` };
  // A wake already on its way: the one launch is enough.
  if (sessionStarting(agent)) return { success: true, alreadyWaking: true };
  noteWaker(agent.id, by, via);
  try {
    const result = await launchAgent(agent.id, '');
    if (result.success) return { success: true };
    wakers.delete(agent.id);
    return { success: false, error: result.error };
  } catch (err) {
    wakers.delete(agent.id);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
