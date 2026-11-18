import { agents } from '../core/agent-manager';
import { hasOrchestratorPowers } from '../core/agent-role';
import { chatNameOf } from '../core/chat-inbox';
import { onOwnerLine, ptyProcesses } from '../core/pty-manager';
import { dialogShown } from '../core/agent-launch';
import type { AgentStatus } from '../types';
import { ownerWords, typedAtRest } from './owner-words';

/**
 * The owner's words typed by hand into an orchestrator's terminal (2.0.7; SECURITY.md §8, "Typed in a terminal").
 *
 * A line the window's keys submit (core/pty-manager.ts, the one path a person's keys take) waits in owner-words.ts
 * until the agent's CLI says it took that line as a prompt (hooks-routes.ts, UserPromptSubmit); then it is the
 * owner's words, via the terminal, for the agent's project and, for a chat's runner, its chat. Only an agent with an
 * orchestrator's powers: the project's orchestrator or a chat's runner, those who could relay them. A worker's
 * terminal is the worker's work, and no worker relays. And only a line submitted with the CLI at rest at its prompt
 * (typedAtRest), confirmed within a minute.
 */
function noteTyped(agentId: string, line: string): void {
  const agent = agents.get(agentId);
  if (!agent || !agent.projectPath || !hasOrchestratorPowers(agent)) return;
  // Typed at rest only: the hook that confirms it carries the agent's own token (the Audit's L1 on #594).
  if (!typedAtRest(agent, dialogShown(agent, agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined))) return;
  const chatId = chatNameOf(agent)?.id;
  ownerWords.typed(agent.id, line, { projectPath: agent.projectPath, ...(chatId ? { chatId } : {}) });
}

/** Called once, with the app's other watches (main.ts). */
export function startOwnerTypedWatch(): void {
  onOwnerLine(noteTyped);
}

/** The agent's CLI took this prompt, from its current session (hooks-routes.ts): a line it confirms is recorded. */
export function confirmOwnerTyped(agent: Pick<AgentStatus, 'id'>, prompt: string | undefined): void {
  const words = ownerWords.confirmTyped(agent.id, prompt);
  if (words) console.log(`[owner-words] ${words.id}: a line the owner typed into ${agent.id}'s terminal, recorded`);
}
