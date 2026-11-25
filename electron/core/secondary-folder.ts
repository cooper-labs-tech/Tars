import type { AgentStatus } from '../types';
import { getProvider } from '../providers';
import { ptyProcesses, writeProgrammaticInput } from './pty-manager';
import { agentTakesTyping } from './agent-launch';

/**
 * A secondary folder set from the agent's window while its CLI runs (agent:setSecondaryProject): main types the CLI's
 * own command for it, only the one measured to take it cleanly, and only into a session that runs. Every other folder
 * goes on the CLI's line at its next start, as it always has (the Audit's point on #636 at 6970bc906: the window typed
 * `/add-dir <path>` into every CLI's terminal, and grok 1.0.92 took it as a prompt).
 *
 * Measured on 25/11, each read in its own binary or bundle:
 * - Claude Code 2.1.332: `/add-dir <path>` ("Add a working directory"), immediate when given a path, so it runs even
 *   in a turn, and answered "Added <path> as a working directory for this session", asking nothing. Every provider
 *   on the claude binary runs it.
 * - gemini 0.70.0: `/directory add <path>`, but its trust store is read once per process (loadTrustedFolders), so a
 *   folder set after its start is untrusted to it and opens its MultiFolderTrustDialog, which nobody answers in an
 *   agent's terminal. Typed none: at its next start the folder is on its line, trusted by Tars.
 * - Qwen Code 0.28.4: `/directory add <path>`, asking nothing, but it writes the folder into the project's own
 *   settings (context.includeDirectories, Workspace scope), which clearing the folder in Tars would never undo.
 *   Typed none.
 * - grok 1.0.92 and codex 0.163.0: no such command (each has `/cd <path>`, which moves the session elsewhere).
 * - OpenCode, Pi, Amp: not measured (not installed here). Typed none.
 */

/** When the folder reaches the agent's CLI, as the window says it. */
export type FolderAppliesAt = 'now' | 'next-start';

/**
 * The line the agent's running CLI takes to add `folder` to its session, or null when Tars types it none. A folder
 * holding a control character never: its newline would submit the rest of the path as a prompt.
 */
export function liveAddFolderLine(provider: AgentStatus['provider'], folder: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(folder)) return null;
  return getProvider(provider).binaryName === 'claude' ? `/add-dir ${folder}` : null;
}

/**
 * Types the folder just set into the agent's CLI when it has a line for it and may be typed into: a CLI up, no dialog
 * on its screen, no launch on its way. A turn under way takes it, the command being immediate. A cleared folder is
 * typed nothing: no CLI has a command that takes one away. Says when the folder applies.
 */
export function typeAddedFolder(agent: AgentStatus, folder: string | null): FolderAppliesAt {
  if (!folder || !agent.ptyId) return 'next-start';
  const line = liveAddFolderLine(agent.provider, folder);
  if (!line) return 'next-start';
  const terminal = ptyProcesses.get(agent.ptyId);
  const refusal = agentTakesTyping(agent, terminal);
  if (!terminal || (refusal !== null && refusal !== 'turn')) return 'next-start';
  // Held by the writer while a person's draft is in the field, it goes in once the field is free.
  return writeProgrammaticInput(terminal, line, true) === 'refused' ? 'next-start' : 'now';
}
