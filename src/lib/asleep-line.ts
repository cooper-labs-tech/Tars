import type { AgentStatus } from '@/types/electron';
import { caller, when } from '@/lib/stop-line';

/**
 * The line an asleep agent reads, and the one it reads while it wakes, where
 * an error gives its reason: in place of the task on its card, of the branch
 * in its pane's header, of the path in its window, under its name in an
 * orchestrator's rail. Since #322 an agent with no turn for 30 minutes is put
 * to sleep, and whatever wakes it is named until its session is up. Frame:
 * `Agent asleep · and how it wakes` in design/tars-redesign.pen. Their
 * failures are listed, and pinned, in __tests__/lib/asleep-line.test.ts.
 */

/** "Asleep since 14:02: no turn for 30 minutes", or null for an agent that is not asleep. */
export function asleepLine(agent: Pick<AgentStatus, 'status' | 'asleepSince'>, now = new Date()): string | null {
  if (agent.status !== 'asleep') return null;
  const at = when(agent.asleepSince, now);
  return `Asleep${at ? ` since ${at.replace(/^(at|on) /, '')}` : ''}: no turn for 30 minutes`;
}

/** How each way of waking reads, after "Waking: ". */
const VIA: Record<string, (by: string) => string> = {
  message: by => `a message from ${by}`,
  chat: by => `a chat message from ${by}`,
  wake: by => `woken by ${by}`,
  key: by => `a key typed by ${by}`,
  start: by => `started by ${by}`,
};

/**
 * "Waking: a message from Orchestrator", or null when no wake is on its way.
 * Only while it is coming up: main sets `waking` with the status `idle`, or
 * `running` for a message or a dispatch, whose task is the message, and clears
 * it once the session is up; a copy that kept it on an agent waiting, done,
 * failed, stopped or asleep again is no wake.
 */
export function wakingLine(agent: Pick<AgentStatus, 'status' | 'waking'>): string | null {
  if (!agent.waking || (agent.status !== 'idle' && agent.status !== 'running')) return null;
  const by = caller(agent.waking.by) || 'Tars';
  const how = VIA[agent.waking.via] ?? VIA.wake;
  return `Waking: ${how(by)}`;
}

/**
 * What an asleep agent's terminal says under the screen it slept on, or the
 * one coming back says while its CLI starts; null otherwise. `name` is given
 * where the agent's name is not already beside it (the window).
 */
export function asleepHint(agent: Pick<AgentStatus, 'status' | 'asleepSince' | 'waking'>, name?: string, now = new Date()): string | null {
  if (wakingLine(agent)) return 'Claude Code starts again on its conversation…';
  const line = asleepLine(agent, now);
  if (!line) return null;
  const who = name ? `${caller(name)} is asleep` : line.replace(/: no turn for 30 minutes$/, '');
  return `○ ${who}. A key typed here wakes it on its conversation.`;
}

