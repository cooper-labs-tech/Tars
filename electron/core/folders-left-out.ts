import * as fs from 'fs';
import type * as pty from 'node-pty';
import type { AgentStatus } from '../types';
import { getProvider } from '../providers';
import { handedFolderProblem } from '../utils/handed-folder';
import { broadcastToAllWindows } from '../utils/broadcast';
import { writeTerminalMirror } from './terminal-mirror';

/**
 * The folders an agent was saved with that its launch line leaves out, each as the one line Tars says in the agent's
 * own terminal before its CLI starts (sayFoldersLeftOut, below; the Audit's M1 on #666).
 *
 * A secondary folder or a template folder saved before a rule refused it (a folder where credentials are kept, a CLI's
 * content folder, ~/.tars-private) is left off the line by handedSecondaryFolder, as every launch path asks it. That
 * was said only in the main process's log: the agent modal does not send these folders on save, the agent dialog still
 * shows the folder as the agent's, and the CLI simply did not have it.
 */

/**
 * The providers whose launch line hands the agent its secondary folder and its template's folders (read in each
 * buildInteractiveCommand), by the id of the provider Tars runs: claude's and codex's --add-dir, gemini's and Qwen
 * Code's --include-directories, and Kimi Code's --add-dir (its provider comes with the harness adapters). The thirteen
 * API-key providers on the claude binary hand ~/.tars alone; grok, opencode, pi and amp hand none.
 */
const HANDS_FOLDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'qwen-code', 'kimi-code']);

type SavedFolders = Pick<AgentStatus, 'provider' | 'secondaryProjectPath' | 'obsidianVaultPaths'>;

/** Whether the line of an agent on `provider` hands it a secondary folder and its template's folders. */
export function handsFolders(provider: AgentStatus['provider']): boolean {
  return HANDS_FOLDERS.has(getProvider(provider).id);
}

/** One plain line per folder the line leaves out: the folder, why, and where to change it. Empty when none. */
export function foldersLeftOut(agent: SavedFolders): string[] {
  if (!handsFolders(agent.provider)) return [];
  const lines: string[] = [];
  if (agent.secondaryProjectPath) {
    const why = handedFolderProblem(agent.secondaryProjectPath);
    if (why) lines.push(`[Tars] Left out of this start: ${why}. Change the agent's secondary folder in its settings.`);
  }
  // As the line reads them: a template folder that does not exist is left out for that, and is no refusal.
  for (const folder of agent.obsidianVaultPaths ?? []) {
    if (typeof folder !== 'string' || !fs.existsSync(folder)) continue;
    const why = handedFolderProblem(folder);
    if (why) lines.push(`[Tars] Left out of this start: ${why}. Change the folders of the template the agent was made from.`);
  }
  return lines;
}

/**
 * Where a line said in an agent's terminal is kept with the rest of its output: core/agent-manager.ts sets its
 * appendAgentOutput (the cap, the save) as it loads; until then, the agent's own array.
 */
let keepOutput: (agent: AgentStatus, data: string) => void = (agent, data) => { (agent.output ??= []).push(data); };

export function setKeptOutput(keep: (agent: AgentStatus, data: string) => void): void {
  keepOutput = keep;
}

/**
 * Say in the agent's own terminal, before its CLI starts, each folder it was saved with that its line leaves out:
 * into the terminal's mirror, which a panel opened later replays, its kept output and the window's open panels, as the
 * terminal's own output reaches them (core/agent-manager.ts attachAgentTerminal). Called where a line is typed into a
 * shell (launchIntoTerminal, before the typing) and right after a CLI is spawned as the terminal itself (the window's
 * start on Windows, the API's start everywhere), before its first byte arrives.
 */
export function sayFoldersLeftOut(agent: AgentStatus, ptyProcess: pty.IPty, ptyId: string | undefined): void {
  const lines = foldersLeftOut(agent);
  if (lines.length === 0) return;
  const data = `\r\n${lines.join('\r\n')}\r\n`;
  writeTerminalMirror(ptyProcess, data);
  keepOutput(agent, data);
  broadcastToAllWindows('agent:output', { type: 'output', agentId: agent.id, ptyId, data, timestamp: new Date().toISOString() });
}
