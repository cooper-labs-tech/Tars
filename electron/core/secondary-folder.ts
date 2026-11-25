import type { AgentStatus } from '../types';

/**
 * When a secondary folder set from the agent's window (agent:setSecondaryProject) reaches its CLI. Nothing is typed
 * into any CLI for it: the folder goes on the CLI's launch line at its next start, or never, for a CLI whose line
 * hands none (the Audit's point on #636 at 6970bc906, then its M1 and L1 at f68f7901c).
 *
 * No live command is typed, measured in each binary or bundle on 25/11:
 * - Claude Code 2.1.332 registers `/add-dir` twice. The `local` one, which adds the folder asking nothing, is enabled
 *   only in a session that is not interactive (`ge()`, in its chunk-bhankhfx.js:
 *   `return!n().host.launchOptions.isInteractive()`). An agent's terminal, interactive, gets the `local-jsx` one, which
 *   shows the folder's trust question if it needs one, else "Yes, for this session" / "Yes, and remember this
 *   directory" / "No", and adds nothing until it is answered: that question would hold every message and delegation.
 * - gemini 0.70.0's `/directory add` opens its trust dialog for a folder set after its start; Qwen Code 0.28.4's writes
 *   the folder into the project's own settings; grok 1.0.92 and codex 0.163.0 have none.
 *
 * Which launch lines hand the folder, read in each provider's buildInteractiveCommand: claude's and codex's
 * (--add-dir), gemini's and Qwen Code's (--include-directories). grok's says it does not; OpenCode's, Pi's and Amp's
 * name none; the API-key providers on the claude binary hand ~/.tars only.
 */

/** When the folder reaches the agent's CLI, as the window says it. */
export type FolderAppliesAt = 'next-start' | 'not-handed';

/** The providers whose launch line hands the agent its secondary folder ('local' runs claude). */
const HANDS_THE_FOLDER: ReadonlySet<string> = new Set(['claude', 'local', 'codex', 'gemini', 'qwen-code']);

/** When `folder`, just set for an agent on `provider`, reaches its CLI. A cleared folder leaves its line at the next start. */
export function folderAppliesAt(provider: AgentStatus['provider'], folder: string | null): FolderAppliesAt {
  if (!folder) return 'next-start';
  return HANDS_THE_FOLDER.has(provider ?? 'claude') ? 'next-start' : 'not-handed';
}
