import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';
import { updateSharedTextSync, writeSharedJsonSync } from '../utils/shared-file';
import { removeTomlTable } from '../utils/toml-tables';
import { parse as parseToml } from 'smol-toml';

// Tars-managed MCP servers, hidden from the Custom MCP UI
const DOROTHY_MANAGED_MCPS = new Set([
  'claude-mgr-orchestrator',
  'claude-mgr-telegram',
  'claude-mgr-kanban',
  'claude-mgr-vault',
  'dorothy-socialdata',
  'dorothy-x',
  'google-workspace',
  'tasmania',
]);

interface McpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

// ── Provider config file paths ──────────────────────────────────────

function getConfigPath(provider: string): string {
  switch (provider) {
    case 'claude':
      return path.join(os.homedir(), '.claude', 'mcp.json');
    case 'codex':
      return path.join(os.homedir(), '.codex', 'config.toml');
    case 'gemini':
      return path.join(os.homedir(), '.gemini', 'settings.json');
    case 'grok':
      return path.join(os.homedir(), '.grok', 'config.toml');
    case 'opencode':
      return path.join(os.homedir(), '.opencode', 'mcp.json');
    case 'pi':
      return path.join(os.homedir(), '.pi', 'mcp.json');
    case 'minimax':
    case 'nvidia':
    case 'nous-portal':
    case 'ollama':
    case 'venice':
    case 'ollama-cloud':
    case 'custom-openai':
      return path.join(os.homedir(), '.claude', 'mcp.json');
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Claude: JSON { mcpServers: { name: { command, args, env } } } ───

function readClaudeMcp(): McpServer[] {
  const configPath = getConfigPath('claude');
  if (!fs.existsSync(configPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const servers = data.mcpServers || {};
    return Object.entries(servers)
      .filter(([name]) => !DOROTHY_MANAGED_MCPS.has(name))
      .map(([name, raw]) => {
        const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          name,
          command: typeof cfg.command === 'string' ? cfg.command : '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: (cfg.env && typeof cfg.env === 'object') ? cfg.env as Record<string, string> : {},
        };
      });
  } catch (err) {
    console.error('Failed to read Claude MCP config:', err);
    return [];
  }
}

/**
 * A CLI's MCP config file. Tars owns `mcpServers` and nothing else: every other
 * key belongs to that CLI and is read back and written out untouched, which is
 * why the rest of the shape stays `unknown` rather than being modelled.
 */
interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Gemini: JSON { mcpServers: { name: { command, args } }, ...other } ──

function readGeminiMcp(): McpServer[] {
  const configPath = getConfigPath('gemini');
  if (!fs.existsSync(configPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const servers = data.mcpServers || {};
    return Object.entries(servers)
      .filter(([name]) => !DOROTHY_MANAGED_MCPS.has(name))
      .map(([name, raw]) => {
        const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          name,
          command: typeof cfg.command === 'string' ? cfg.command : '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: (cfg.env && typeof cfg.env === 'object') ? cfg.env as Record<string, string> : {},
        };
      });
  } catch (err) {
    console.error('Failed to read Gemini MCP config:', err);
    return [];
  }
}

function writeGeminiMcp(action: 'update' | 'delete', server?: McpServer, deleteName?: string): void {
  const configPath = getConfigPath('gemini');
  let data: McpConfigFile = {};
  if (fs.existsSync(configPath)) {
    try {
      data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      data = {};
    }
  }
  const servers = (data.mcpServers ??= {});

  if (action === 'update' && server) {
    servers[server.name] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  } else if (action === 'delete' && deleteName) {
    delete servers[deleteName];
  }

  // Written whole beside it, with its final newline, and parsed again (utils/shared-file.ts).
  writeSharedJsonSync(configPath, data);
}

// ── Generic JSON MCP: { mcpServers: { name: { command, args, env } } }
// Claude's format, also used by OpenCode, Pi and Qwen Code

function readJsonMcp(provider: string): McpServer[] {
  const configPath = getConfigPath(provider);
  if (!fs.existsSync(configPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const servers = data.mcpServers || {};
    return Object.entries(servers)
      .filter(([name]) => !DOROTHY_MANAGED_MCPS.has(name))
      .map(([name, raw]) => {
        const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          name,
          command: typeof cfg.command === 'string' ? cfg.command : '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: (cfg.env && typeof cfg.env === 'object') ? cfg.env as Record<string, string> : {},
        };
      });
  } catch (err) {
    console.error(`Failed to read ${provider} MCP config:`, err);
    return [];
  }
}

function writeJsonMcp(provider: string, action: 'update' | 'delete', server?: McpServer, deleteName?: string): void {
  // For Claude and every provider that runs its binary this is
  // ~/.claude/mcp.json, which every session Tars starts reads. The file was
  // rewritten in place, and one that did not parse was read as empty, so a
  // save replaced every other server. Now through the writer they all share.
  const configPath = getConfigPath(provider);
  if (action === 'update' && server) {
    addMcpServerToJson(configPath, server.name, {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    });
  } else if (action === 'delete' && deleteName) {
    removeMcpServerFromJson(configPath, deleteName);
  }
}

// ── Codex: TOML [mcp_servers.name] sections ─────────────────────────

// Codex and Grok share the same TOML schema (config.toml with
// [mcp_servers.<name>] sections), so these helpers take a provider id.
function readCodexMcp(provider: string = 'codex'): McpServer[] {
  const configPath = getConfigPath(provider);
  if (!fs.existsSync(configPath)) return [];
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return parseTomlMcpServers(content);
  } catch (err) {
    console.error(`Failed to read ${provider} MCP config:`, err);
    return [];
  }
}

/**
 * Parse [mcp_servers.X] sections from TOML content.
 * Uses regex-based parsing (same approach as codex-provider.ts).
 */
function parseTomlMcpServers(content: string): McpServer[] {
  const servers: McpServer[] = [];
  // Match each [mcp_servers.NAME] section
  const sectionRegex = /\[mcp_servers\.([^\]]+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(content)) !== null) {
    const rawName = match[1].replace(/^"|"$/g, ''); // strip TOML quotes
    if (DOROTHY_MANAGED_MCPS.has(rawName)) continue;

    // Extract content until next section header or EOF
    const startIdx = match.index + match[0].length;
    const nextSection = content.indexOf('\n[', startIdx);
    const sectionContent = nextSection === -1
      ? content.slice(startIdx)
      : content.slice(startIdx, nextSection);

    const command = extractTomlString(sectionContent, 'command');
    const args = extractTomlArray(sectionContent, 'args');
    const env = extractTomlTable(sectionContent, 'env');

    servers.push({ name: rawName, command, args, env });
  }

  return servers;
}

function extractTomlString(section: string, key: string): string {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : '';
}

function extractTomlArray(section: string, key: string): string[] {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!match) return [];
  return match[1]
    .split(',')
    .map(s => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function extractTomlTable(section: string, key: string): Record<string, string> {
  // Look for inline table: env = { KEY = "val", ... }
  const match = section.match(new RegExp(`^${key}\\s*=\\s*\\{([^}]*)\\}`, 'm'));
  if (!match) return {};
  const result: Record<string, string> = {};
  const pairs = match[1].split(',');
  for (const pair of pairs) {
    const kv = pair.match(/\s*(\w+)\s*=\s*"([^"]*)"/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

/** A TOML basic string: JSON's escapes are TOML's, DEL aside (as codex-provider.ts writes them). */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
}

function escapeTomlKey(key: string): string {
  if (/[^a-zA-Z0-9_-]/.test(key)) return tomlString(key);
  return key;
}

/**
 * Codex's and grok's config.toml from the page: the server's table taken out (utils/toml-tables.ts), the new one
 * added at the end, every value escaped (a quote or a Windows path written raw broke the file), and the whole file
 * written beside itself and parsed again: one that would not parse is not written, and the save says so.
 */
function writeCodexMcp(action: 'update' | 'delete', server?: McpServer, deleteName?: string, provider: string = 'codex'): void {
  const configPath = getConfigPath(provider);
  const targetName = action === 'delete' ? deleteName! : server!.name;
  const outcome = updateSharedTextSync(configPath, current => {
    let content = removeTomlTable(current ?? '', `mcp_servers.${escapeTomlKey(targetName)}`);
    if (action === 'update' && server) {
      let section = `\n[mcp_servers.${escapeTomlKey(server.name)}]\ncommand = ${tomlString(server.command)}\nargs = [${server.args.map(tomlString).join(', ')}]\n`;
      if (Object.keys(server.env).length > 0) {
        section += `env = { ${Object.entries(server.env).map(([k, v]) => `${escapeTomlKey(k)} = ${tomlString(v)}`).join(', ')} }\n`;
      }
      content = content.trimEnd() + '\n' + section;
    }
    return current === undefined && action === 'delete' ? undefined : content;
  }, { parse: parseToml });
  if (outcome === 'refused') throw new Error(`${configPath} would not parse with this change (or did not already): left as it was`);
  if (outcome === 'busy') throw new Error(`${configPath} kept changing while saving: nothing written`);
}

// ── Dispatch by provider ────────────────────────────────────────────

/**
 * Qwen Code's servers are not this page's (the Audit's L3 on #461): it wrote
 * them to ~/.qwen-code/mcp.json, which qwen never reads. qwen reads the user's
 * own ~/.qwen/settings.json, and Tars's agents a settings file of Tars's
 * (services/qwen-code.ts), so saying so replaces a save that went nowhere.
 */
const QWEN_IDS = new Set(['qwencode', 'qwen-code']);
function refuseQwen(provider: string): void {
  if (QWEN_IDS.has(provider)) {
    throw new Error("Settings > MCP does not manage Qwen Code's servers: qwen reads its own ~/.qwen/settings.json (mcpServers), and Tars's agents get Tars's servers by themselves");
  }
}

function listServers(provider: string): McpServer[] {
  refuseQwen(provider);
  switch (provider) {
    case 'claude': return readClaudeMcp();
    case 'codex': return readCodexMcp();
    case 'gemini': return readGeminiMcp();
    case 'grok': return readCodexMcp('grok');
    case 'opencode':
    case 'pi': return readJsonMcp(provider);
    case 'minimax':
    case 'nvidia':
    case 'nous-portal':
    case 'ollama':
    case 'venice':
    case 'ollama-cloud':
    case 'custom-openai': return readClaudeMcp();
    default: return [];
  }
}

function updateServer(provider: string, server: McpServer): void {
  refuseQwen(provider);
  switch (provider) {
    case 'claude': writeJsonMcp('claude', 'update', server); break;
    case 'codex': writeCodexMcp('update', server); break;
    case 'gemini': writeGeminiMcp('update', server); break;
    case 'grok': writeCodexMcp('update', server, undefined, 'grok'); break;
    case 'opencode':
    case 'pi': writeJsonMcp(provider, 'update', server); break;
    case 'minimax':
    case 'nvidia':
    case 'nous-portal':
    case 'ollama':
    case 'venice':
    case 'ollama-cloud':
    case 'custom-openai': writeJsonMcp('claude', 'update', server); break;
  }
}

function deleteServer(provider: string, name: string): void {
  refuseQwen(provider);
  switch (provider) {
    case 'claude': writeJsonMcp('claude', 'delete', undefined, name); break;
    case 'codex': writeCodexMcp('delete', undefined, name); break;
    case 'gemini': writeGeminiMcp('delete', undefined, name); break;
    case 'grok': writeCodexMcp('delete', undefined, name, 'grok'); break;
    case 'opencode':
    case 'pi': writeJsonMcp(provider, 'delete', undefined, name); break;
    case 'minimax':
    case 'nvidia':
    case 'nous-portal':
    case 'ollama':
    case 'venice':
    case 'ollama-cloud':
    case 'custom-openai': writeJsonMcp('claude', 'delete', undefined, name); break;
  }
}

// ── IPC Registration ────────────────────────────────────────────────

export function registerMcpConfigHandlers(): void {
  ipcMain.handle('mcp:list', async (_event, params: { provider: string }) => {
    try {
      const servers = listServers(params.provider);
      return { servers };
    } catch (err) {
      console.error(`Failed to list MCP servers for ${params.provider}:`, err);
      return { servers: [], error: String(err) };
    }
  });

  ipcMain.handle('mcp:update', async (_event, params: {
    provider: string;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }) => {
    try {
      updateServer(params.provider, {
        name: params.name,
        command: params.command,
        args: params.args,
        env: params.env,
      });
      return { success: true };
    } catch (err) {
      console.error(`Failed to update MCP server:`, err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('mcp:delete', async (_event, params: { provider: string; name: string }) => {
    try {
      deleteServer(params.provider, params.name);
      return { success: true };
    } catch (err) {
      console.error(`Failed to delete MCP server:`, err);
      return { success: false, error: String(err) };
    }
  });
}
