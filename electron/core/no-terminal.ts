import type { AgentStatus } from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { NoTerminalLeft } from './pty-pool';

/**
 * An agent the machine had no terminal for (core/pty-pool.ts) says why, whatever started it: the window's start, a
 * wake, a bot, the API's start, dispatch, message and delegate (initAgentPty and spawnAgentSession call this). As the
 * missing folder does (handlers/ipc-handlers.ts): 'error' with the reason, saved, the window told. Its failures:
 * __tests__/electron/core/no-terminal.test.ts.
 *
 * 'error' breaks neither the next start (a start from 'error' is the usual restart, and the next turn clears
 * `error`) nor the one-task queue (it reads 'running' and 'waiting' only), and agent-watch then tells whoever handed
 * the agent work that it failed. An asleep agent stays asleep: the wake that clears its mark and its slept-in session
 * runs only once a terminal opened (core/agent-asleep.ts wakeFromSleep), so 'error' would leave it reading asleep for
 * good; its next message or key retries the wake, and `error` keeps the reason.
 */
export function markNoTerminal(
  agent: AgentStatus,
  err: unknown,
  save: () => void,
  announce: (agent: AgentStatus) => void = announceStatus,
): boolean {
  if (!(err instanceof NoTerminalLeft)) return false;
  agent.error = err.message;
  if (agent.status !== 'asleep') agent.status = 'error';
  agent.lastActivity = new Date().toISOString();
  save();
  announce(agent);
  return true;
}

function announceStatus(agent: AgentStatus): void {
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: agent.lastActivity });
  scheduleTick();
}

/** The window's start answered instead of rejected: the reason and its code; undefined for any other failure. */
export function noTerminalAnswer(err: unknown): { success: false; error: string; code: 'no_terminal' } | undefined {
  return err instanceof NoTerminalLeft ? { success: false, error: err.message, code: err.code } : undefined;
}
