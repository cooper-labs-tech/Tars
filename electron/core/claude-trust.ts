import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentStatus } from '../types';
import { DATA_DIR } from '../constants';
import { getProvider } from '../providers';
import { claudeAddedFolders } from '../utils/handed-folder';
import { trustsTooMuch } from '../utils/trust-too-much';
import { updateSharedJsonSync } from '../utils/shared-file';
import { DEFAULT_ACCOUNT_ID, readAccountsSettings } from '../services/claude-accounts/registry';
import { accountDirProblem } from '../services/claude-accounts/provision';

/**
 * Claude Code's workspace trust, written before an agent's CLI starts, for every folder it is handed.
 *
 * BUG 6: `--dangerously-skip-permissions` skips the *runtime* permission prompts, not Claude Code's workspace trust
 * dialog, which `projects[<absolute-path>].hasTrustDialogAccepted` in the .claude.json it reads decides, for the folder
 * or one above it (up to its git root). Measured on 2.1.332 (27/11, bench-b4/add-dir-trust): the dialog also opens for
 * each folder handed with --add-dir that no entry trusts, "Adding a new directory: <folder> ... Is this a directory you
 * created or one you trust?", "No, exit" preselected, before the first turn. Tars wrote the agent's own folder alone,
 * so on a home Claude Code had never trusted every claude agent stopped on ~/.tars, which each of them is handed.
 *
 * What an entry opens is what answering Yes there opens: the folder and everything below it, where Claude Code reads,
 * edits and runs files, loads its skills, commands and agents, and lets its repository's git settings run. Written for
 * exactly the folders the agent's line hands and nothing wider: its own folder, as before, and for the claude binary
 * the folders of its --add-dir (utils/handed-folder.ts claudeAddedFolders for claude, ~/.tars for the thirteen API-key
 * providers), each refused when it would trust the home, the root or a folder above the home (utils/trust-too-much.ts).
 * Each under its spelling and its real path, the one Claude Code reads. In ~/.claude.json, and in the .claude.json of
 * the Claude account the agent runs on, which is the one its CLI reads there (CLAUDE_CONFIG_DIR; measured).
 *
 * Every live Claude Code reads and rewrites these files, so they are changed through updateSharedJsonSync: never in
 * place, never when every entry is already there, with their 0600 mode kept. See that function for the risk that
 * remains. Safe to call repeatedly and idempotent.
 */

type TrustedAgent = Pick<AgentStatus, 'provider' | 'secondaryProjectPath' | 'obsidianVaultPaths' | 'claudeAccountId'>;

type ClaudeConfig = {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; projectOnboardingSeenCount?: number; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** The folders Claude Code must find trusted when this agent's CLI starts in `cwd`: `cwd` alone for any other CLI. */
export function claudeTrustFolders(cwd: string, agent?: TrustedAgent): string[] {
  if (!agent) return [cwd];
  const provider = getProvider(agent.provider);
  if (provider.binaryName !== 'claude') return [cwd];
  return [cwd, ...(provider.id === 'claude' ? claudeAddedFolders(agent) : [DATA_DIR])];
}

/**
 * The folder of the Claude account the agent last started on, when it is one of Tars's own after the first: the
 * accounts on, the agent on claude, the folder there and Tars's (accountDirProblem). Never one created or claimed here.
 */
function accountConfigDir(agent?: TrustedAgent): string | undefined {
  const id = agent?.claudeAccountId;
  if (!agent || !id || id === DEFAULT_ACCOUNT_ID || (agent.provider && agent.provider !== 'claude')) return undefined;
  const settings = readAccountsSettings();
  if (!settings.enabled) return undefined;
  const dir = settings.accounts.find(a => a.id === id)?.configDir;
  return dir && fs.existsSync(dir) && !accountDirProblem(dir) ? dir : undefined;
}

/**
 * A folder as written and as the system names it: Claude Code reads the flag under the real path, and a project reached
 * through a link (anything under macOS's /var or /tmp, a checkout linked elsewhere) trusted under the saved spelling
 * alone still showed the dialog, the agent's first task answering it. trustsTooMuch has judged both.
 */
function spellings(folder: string): string[] {
  try {
    const real = fs.realpathSync.native(folder);
    return real === folder ? [folder] : [folder, real];
  } catch {
    // Not there yet: the spelling is all there is.
    return [folder];
  }
}

function writeTrust(file: string, keys: string[]): void {
  try {
    const outcome = updateSharedJsonSync<ClaudeConfig>(file, config => {
      // An entry already trusted is left exactly as it is: only the missing ones are written.
      const missing = keys.filter(key => config?.projects?.[key]?.hasTrustDialogAccepted !== true);
      if (!missing.length) return undefined;
      const projects = { ...config?.projects };
      for (const key of missing) {
        const existing = projects[key] ?? {};
        projects[key] = { ...existing, hasTrustDialogAccepted: true, projectOnboardingSeenCount: existing.projectOnboardingSeenCount ?? 1 };
      }
      return { ...config, projects };
    });
    if (outcome === 'written') {
      console.log(`ensureProjectTrusted: marked ${keys.join(', ')} trusted in ${file}`);
    } else if (outcome === 'unreadable') {
      console.warn(`ensureProjectTrusted: ${file} is not valid JSON, left untouched`);
    } else if (outcome === 'busy') {
      console.warn(`ensureProjectTrusted: ${file} kept changing, trust for ${keys.join(', ')} not written`);
    }
  } catch (err) {
    console.warn(`ensureProjectTrusted: failed to update ${file}:`, err);
  }
}

/**
 * Trust the folders the agent's CLI is handed, `cwd` first, before it starts there. With no agent (a terminal opened
 * before the agent exists), `cwd` alone. `configDir`: the Claude account the launch has just chosen, written as well.
 */
export function ensureProjectTrusted(cwd: string, agent?: TrustedAgent, opts: { configDir?: string } = {}): void {
  if (!cwd) return;
  const folders = claudeTrustFolders(cwd, agent).filter(folder => {
    if (!trustsTooMuch(folder)) return true;
    console.warn(`ensureProjectTrusted: ${folder} would trust every folder below it, left for Claude Code to ask`);
    return false;
  });
  const keys = [...new Set(folders.flatMap(spellings))];
  if (!keys.length) return;
  writeTrust(path.join(os.homedir(), '.claude.json'), keys);
  const account = opts.configDir ?? accountConfigDir(agent);
  if (account) writeTrust(path.join(account, '.claude.json'), keys);
}
