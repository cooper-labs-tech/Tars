import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { nodeHookCommand, usesNodeHooks } from '../utils/hook-command';
import { safeEffort } from '../providers/cli-provider';
import type { AgentPermissionMode } from '../types';
import { writeSharedJsonSync } from '../utils/shared-file';

/**
 * Qwen Code, as Tars runs it (2.0.4). Measured with qwen 0.25.2 (a Gemini CLI
 * fork) on 2026-10-18:
 * - QWEN_CODE_SYSTEM_SETTINGS_PATH names a settings file read above the
 *   user's ~/.qwen/settings.json, its hooks concatenated with theirs. Tars
 *   writes one per agent under ~/.tars/qwen-code/ (its hooks, its MCP
 *   servers, its effort, qwen's own updater off) and never writes the user's.
 * - It fires Claude Code's hooks with Claude Code's fields: SessionStart,
 *   UserPromptSubmit (the prompt, the sender line included), Stop
 *   (last_assistant_message), StopFailure, Notification (idle_prompt,
 *   permission_prompt), PermissionRequest (tool_name, tool_input). Tars's own
 *   hook scripts run as they are. SessionStart's additionalContext is not
 *   read: how Tars works goes in the first prompt, as for every CLI without
 *   Claude's bootstrap.
 * - An MCP server gets qwen's whole environment, its own internal tokens
 *   removed (sanitizeChildEnv), then its own `env`: the agent's identity
 *   reaches Tars's servers through the terminal's environment, never a file.
 * - Its effort is the setting model.reasoningEffort (no flag); the status bar
 *   read "deepseek-v4-flash low" with it set to low in this file.
 * - Its transcripts: ~/.qwen/projects/<cwd, every character that is not a
 *   letter or a digit a dash, lower-cased on win32>/chats/<session>.jsonl.
 */

export const QWEN_PROVIDER_ID = 'qwen-code';

/** The folder Tars keeps Qwen Code's files in: the hooks table, the MCP servers, each agent's settings. */
export function qwenDataDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'qwen-code');
}

/** Qwen Code's folder name for a project (sanitizeCwd in 0.25.2). */
export function qwenProjectDir(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function qwenTranscriptPath(projectPath: string, sessionId: string, homeDir = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  return path.join(homeDir, '.qwen', 'projects', qwenProjectDir(projectPath, platform), 'chats', `${sessionId}.jsonl`);
}

/** A model id that may reach a command line. */
export const QWEN_MODEL_ID = /^[a-zA-Z0-9._:/-]+$/;

/**
 * A model's address as the window may show it: its scheme, host, port and
 * path, without the user, password, query or fragment a URL can carry a key
 * in (the Audit's L1 on #462). Undefined for what is not a URL.
 */
function shownBaseUrl(baseUrl: string): string | undefined {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return undefined;
  }
}

/** The models in the user's ~/.qwen/settings.json modelProviders, every provider's, read only; none when it cannot be read. */
export function qwenModels(homeDir = os.homedir()): Array<{ id: string; name: string; description: string }> {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(homeDir, '.qwen', 'settings.json'), 'utf8')) as { modelProviders?: unknown };
    if (!s.modelProviders || typeof s.modelProviders !== 'object') return [];
    const out: Array<{ id: string; name: string; description: string }> = [];
    for (const [kind, list] of Object.entries(s.modelProviders as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const m of list as Array<{ id?: unknown; name?: unknown; baseUrl?: unknown }>) {
        if (!m || typeof m.id !== 'string' || !QWEN_MODEL_ID.test(m.id) || out.some((o) => o.id === m.id)) continue;
        out.push({
          id: m.id, name: typeof m.name === 'string' ? m.name : m.id,
          description: typeof m.baseUrl === 'string' && shownBaseUrl(m.baseUrl) ? `${kind}, ${shownBaseUrl(m.baseUrl)}` : kind,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** A permission mode onto Qwen Code's --approval-mode: normal asks, bypass does not. */
export function qwenApprovalMode(mode: AgentPermissionMode | undefined): 'plan' | 'default' | 'auto-edit' | 'yolo' {
  if (mode === 'plan') return 'plan';
  if (mode === 'auto') return 'auto-edit';
  if (mode === 'bypass') return 'yolo';
  return 'default';
}

/** What an orchestrator on Qwen Code may not use: its edit, write and sub-agent tools (ToolNames in 0.25.2). */
export const QWEN_ORCHESTRATOR_EXCLUDED = ['edit', 'write_file', 'agent'] as const;

type HookTable = Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>>;

/** Each event Tars hears, and the script of Tars's that hears it: Claude Code's own, fed the same fields. */
const HOOKS: Array<{ event: string; file: string; matcher?: string }> = [
  { event: 'SessionStart', file: 'session-start.sh', matcher: '*' },
  { event: 'UserPromptSubmit', file: 'user-prompt-submit.sh' },
  { event: 'Stop', file: 'on-stop.sh' },
  { event: 'StopFailure', file: 'stop-failure.sh' },
  { event: 'Notification', file: 'notification.sh', matcher: '*' },
  { event: 'PermissionRequest', file: 'permission-request.sh' },
  { event: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
  { event: 'PostToolUse', file: 'post-tool-use.sh', matcher: '*' },
];

/** The hooks section, the .sh scripts on darwin and linux, the Node runner on win32 (hook-command.ts). */
export function qwenHookTable(hooksDir: string, platform: NodeJS.Platform = process.platform): HookTable {
  const table: HookTable = {};
  for (const { event, file, matcher } of HOOKS) {
    const command = usesNodeHooks(platform)
      ? nodeHookCommand(path.join(hooksDir, 'tars-hook.mjs'), file.replace(/\.sh$/, ''))
      : `'${path.join(hooksDir, file).replace(/'/g, "'\\''")}'`;
    table[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }];
  }
  return table;
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSharedJsonSync(file, value);
};

const hooksFile = (dataDir?: string) => path.join(qwenDataDir(dataDir), 'hooks.json');
const mcpFile = (dataDir?: string) => path.join(qwenDataDir(dataDir), 'mcp-servers.json');

/** Kept at each start of Tars (hooks-manager.ts): the hooks every Qwen Code agent's settings carry. */
export function saveQwenHooks(hooksDir: string, platform: NodeJS.Platform = process.platform, dataDir?: string): void {
  writeJson(hooksFile(dataDir), qwenHookTable(hooksDir, platform));
}

type McpServers = Record<string, { command: string; args: string[] }>;

/** Tars's MCP servers for Qwen Code, kept by Tars: never in ~/.qwen. */
export function qwenMcpServers(dataDir?: string): McpServers {
  return readJson<McpServers>(mcpFile(dataDir), {});
}
export function setQwenMcpServer(name: string, server: { command: string; args: string[] } | null, dataDir?: string): void {
  const all = qwenMcpServers(dataDir);
  if (server) all[name] = { command: server.command, args: [...server.args] }; else delete all[name];
  writeJson(mcpFile(dataDir), all);
}

/** An agent id as a file name: the ids Tars makes, and nothing that climbs out of the folder. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Where qwen looks for its system settings, the file through which an
 * administrator enforces controls over the user's and the project's settings
 * (qwen 0.25.2's docs/configuration/settings.md): the platform's default, or
 * the one QWEN_CODE_SYSTEM_SETTINGS_PATH names in the environment Tars was
 * started with, unless that is one of Tars's own agent files (a Tars started
 * from a Qwen Code agent's terminal inherits its path).
 */
export function qwenSystemSettingsFile(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, dataDir?: string): string {
  const named = env.QWEN_CODE_SYSTEM_SETTINGS_PATH?.trim();
  const own = path.join(qwenDataDir(dataDir), 'agents') + path.sep;
  if (named && !path.resolve(named).startsWith(own)) return named;
  if (platform === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  if (platform === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  return '/etc/qwen-code/settings.json';
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Tars's settings with the administrator's over them: the administrator's
 * value wins wherever both set one; an object is merged key by key, an MCP
 * server of the administrator's is theirs whole, whatever Tars names the
 * same, and a list is theirs alone, except a hook's: both run, theirs first.
 * Joining every list would widen an allowlist (tools.allowed, tools.core,
 * mcp.allowed) the day Tars writes the same key (the Audit's re-check of #461).
 */
export function underAdministrator(tars: unknown, admin: unknown, where: string[] = []): unknown {
  if (Array.isArray(tars) && Array.isArray(admin) && where[0] === 'hooks') {
    const seen = new Set(admin.map((a) => JSON.stringify(a)));
    return [...admin, ...tars.filter((t) => !seen.has(JSON.stringify(t)))];
  }
  if (isPlain(tars) && isPlain(admin) && !(where.length === 2 && where[0] === 'mcpServers')) {
    const out: Record<string, unknown> = { ...tars };
    for (const [k, v] of Object.entries(admin)) out[k] = k in tars ? underAdministrator(tars[k], v, [...where, k]) : v;
    return out;
  }
  return admin;
}

/** The administrator's settings, null when there are none; throws, saying why, when they cannot be read. */
function administratorSettings(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error(`Qwen Code's system settings file ${file} cannot be read (${(err as NodeJS.ErrnoException)?.code ?? 'error'}): its administrator's controls would be lost, so Tars does not start a Qwen Code agent`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isPlain(parsed)) {
    throw new Error(`Qwen Code's system settings file ${file} is not a JSON object: its administrator's controls would be lost, so Tars does not start a Qwen Code agent`);
  }
  return parsed;
}

/**
 * The settings file of Tars's one agent runs with, its path for
 * QWEN_CODE_SYSTEM_SETTINGS_PATH: the hooks, Tars's MCP servers, the agent's
 * effort, and qwen's own updater off (Tars updates it once for the fleet,
 * cli-updater.ts). No token and no key: the identity and the key are in the
 * terminal's environment.
 *
 * That variable names qwen's system settings slot, which an administrator's
 * file fills (the Audit's M1 on #461): pointed at Tars's file, the
 * administrator's controls were dropped without a word. So their file, read
 * again at each launch, goes over Tars's, their keys winning
 * (underAdministrator); one that cannot be read stops the agent from starting,
 * and says why. qwen 0.25.2 docs. `systemFile` is for tests.
 */
export function writeQwenAgentSettings(agentId: string, opts: { effort?: string; systemFile?: string } = {}, dataDir?: string): string {
  const name = SAFE_ID.test(agentId) ? agentId : agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'agent';
  const file = path.join(qwenDataDir(dataDir), 'agents', `${name}.json`);
  const admin = administratorSettings(opts.systemFile ?? qwenSystemSettingsFile(process.platform, process.env, dataDir));
  const effort = safeEffort(opts.effort);
  const tars = {
    hooks: readJson<HookTable>(hooksFile(dataDir), {}),
    mcpServers: qwenMcpServers(dataDir),
    ...(effort ? { model: { reasoningEffort: effort } } : {}),
    general: { enableAutoUpdate: false },
  };
  writeJson(file, admin ? underAdministrator(tars, admin) : tars);
  return file;
}
