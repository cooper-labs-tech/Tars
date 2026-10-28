import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CLIProvider } from '../providers/cli-provider';
import { writeAtomicSync } from '../utils/secret-file';

/**
 * The MCP servers each agent gets, by its role (2.0.5, the owner's lot 3 of 28/10: "un exécutant ne reçoit plus
 * Telegram ni X"). A worker keeps the orchestrator, memory, kanban, vault and socialdata servers; an agent with
 * the orchestrator's powers (the project's orchestrator, a chat's runner) keeps all seven. Each server is a
 * process of its own per session: measured on 28/10 over 14 sessions, the orchestrator's 19 MB and every other
 * 9 MB (median RSS), so a worker gives back two processes and about 24 MB.
 *
 * How each CLI is told:
 * - Claude Code and the providers that run its binary (strategy 'flag'): `--mcp-config` names a file per role,
 *   `~/.claude/mcp.json` for an orchestrator and `~/.claude/mcp-worker.json`, the same minus the two, for a
 *   worker. That holds only because no Tars server is in Claude Code's user scope (`~/.claude.json`), which
 *   every session loads whatever --mcp-config says (claude-provider.ts registers into the file only).
 * - codex: `-c mcp_servers.<name>.enabled=false` (0.163), Qwen Code: `--disable-mcp-server <name>` (0.25.2),
 *   gemini: `--allowed-mcp-server-names`, its other servers (codex-provider.ts, qwen-code-provider.ts,
 *   gemini-provider.ts).
 * - opencode, amp, grok and pi read their servers from their own config with no per-run switch Tars could
 *   verify (none is installed where this was written): a worker of theirs keeps all seven.
 */

export const ORCHESTRATOR_ONLY_MCP: readonly string[] = ['claude-mgr-telegram', 'dorothy-x'];

/** Each of Tars's seven servers, and the directory its bundle ships in (`<resources>/mcp-<dir>/dist/bundle.js`). */
const TARS_BUNDLE_DIRS: Readonly<Record<string, string>> = {
  'claude-mgr-orchestrator': 'mcp-orchestrator',
  'tars-memory': 'mcp-memory',
  'claude-mgr-telegram': 'mcp-telegram',
  'claude-mgr-kanban': 'mcp-kanban',
  'claude-mgr-vault': 'mcp-vault',
  'dorothy-socialdata': 'mcp-socialdata',
  'dorothy-x': 'mcp-x',
};

/**
 * Whether an entry of Claude Code's user scope is Tars's own: one of the seven, whose command runs that server's
 * Tars bundle, as an install of Tars (or of Dorothy before it) registered it there until 2.0.5. Only such an entry is
 * taken out of `~/.claude.json`: a server of the owner's that shares a name Tars registers (`google-workspace`,
 * `tasmania`, or one of the seven running something else) is the owner's, and stays (the Audit's M1 on #525).
 */
export function isTarsBundleEntry(name: string, entry: unknown): boolean {
  const dir = Object.prototype.hasOwnProperty.call(TARS_BUNDLE_DIRS, name) ? TARS_BUNDLE_DIRS[name] : undefined;
  if (!dir || !entry || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const words = [command, ...(Array.isArray(args) ? args : [])].filter((w): w is string => typeof w === 'string');
  return words.some(word => word.split(/[\\/]/).slice(-3).join('/') === `${dir}/dist/bundle.js`);
}

const ORCHESTRATOR_FILE = 'mcp.json';
const WORKER_FILE = 'mcp-worker.json';

/**
 * The `--mcp-config` file of an agent of this role, for a CLI that takes one; undefined for one that does not,
 * or when there is no `~/.claude/mcp.json`. The worker's file is written from the orchestrator's at each call,
 * so a server added there (Settings, the user) reaches workers too, and only when it changed.
 */
export function mcpConfigPathFor(
  provider: Pick<CLIProvider, 'getMcpConfigStrategy'>, orchestrator: boolean, home: string = os.homedir(),
): string | undefined {
  if (provider.getMcpConfigStrategy() !== 'flag') return undefined;
  const full = path.join(home, '.claude', ORCHESTRATOR_FILE);
  if (!fs.existsSync(full)) return undefined;
  if (orchestrator) return full;
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown };
  try {
    config = JSON.parse(fs.readFileSync(full, 'utf-8'));
  } catch (err) {
    // Not JSON: Claude Code would refuse it anyway; the worker gets what the orchestrator gets, and it is said.
    console.warn(`[mcp-roles] ${full} is not JSON, so a worker is handed it whole:`, err instanceof Error ? err.message : err);
    return full;
  }
  const servers = { ...(config.mcpServers ?? {}) };
  for (const name of ORCHESTRATOR_ONLY_MCP) delete servers[name];
  const text = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
  const worker = path.join(home, '.claude', WORKER_FILE);
  let current: string | undefined;
  try { current = fs.readFileSync(worker, 'utf-8'); } catch { /* none yet */ }
  if (current !== text) writeAtomicSync(worker, text);
  return worker;
}

/** codex: the two switched off for a worker, for this run (0.163 takes `-c` after `resume` too). */
export function codexRoleArgs(orchestrator: boolean): string[] {
  return orchestrator ? [] : ORCHESTRATOR_ONLY_MCP.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]);
}

/** Qwen Code: the two disabled for a worker, for this invocation (0.25.2). */
export function qwenRoleArgs(orchestrator: boolean): string[] {
  return orchestrator ? [] : ORCHESTRATOR_ONLY_MCP.flatMap(name => ['--disable-mcp-server', name]);
}

/**
 * gemini: a worker limited to every server of its settings but the two (`--allowed-mcp-server-names`). Nothing when
 * the settings cannot be read or name no server: an empty allow-list would take every server away, Tars's own too.
 */
export function geminiRoleArgs(orchestrator: boolean, settingsFile: string): string[] {
  if (orchestrator) return [];
  let names: string[];
  try {
    names = Object.keys(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))?.mcpServers ?? {});
  } catch {
    return [];
  }
  const allowed = names.filter(name => !ORCHESTRATOR_ONLY_MCP.includes(name));
  if (allowed.length === 0 || allowed.length === names.length) return [];
  return ['--allowed-mcp-server-names', ...allowed];
}
