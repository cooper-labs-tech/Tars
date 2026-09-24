import { app, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AppSettings } from '../types';
import { getAllProviders } from '../providers';
import { updateSharedJsonSync } from '../utils/shared-file';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';

/** The bundled MCP servers, registered with every provider's CLI, and the memory backends with claude. */

// ============== Helper Functions ==============

/**
 * Where each bundled server is: under process.resourcesPath, where
 * extraResources puts it. Packaged only: an unpackaged app has no server there.
 */
export function getMcpOrchestratorPath(): string {
  return path.join(process.resourcesPath, 'mcp-orchestrator', 'dist', 'bundle.js');
}

export function getMcpTelegramPath(): string {
  return path.join(process.resourcesPath, 'mcp-telegram', 'dist', 'bundle.js');
}

export function getMcpKanbanPath(): string {
  return path.join(process.resourcesPath, 'mcp-kanban', 'dist', 'bundle.js');
}

export function getMcpVaultPath(): string {
  return path.join(process.resourcesPath, 'mcp-vault', 'dist', 'bundle.js');
}

export function getMcpSocialDataPath(): string {
  return path.join(process.resourcesPath, 'mcp-socialdata', 'dist', 'bundle.js');
}

/** The X server posts tweets. */
export function getMcpXPath(): string {
  return path.join(process.resourcesPath, 'mcp-x', 'dist', 'bundle.js');
}

/** The memory server makes memory provider-agnostic: every CLI gets it. */
export function getMcpMemoryPath(): string {
  return path.join(process.resourcesPath, 'mcp-memory', 'dist', 'bundle.js');
}

/**
 * Auto-setup MCP servers on app start for ALL providers.
 * Registers bundled MCP servers (orchestrator, telegram, kanban, etc.)
 * with each provider's configuration system.
 */
export async function setupMcpOrchestrator(appSettings?: AppSettings): Promise<void> {
  try {
    // Build the list of MCP servers to register
    const mcpServers: Array<{ name: string; serverPath: string }> = [
      { name: 'claude-mgr-orchestrator', serverPath: getMcpOrchestratorPath() },
      { name: 'tars-memory', serverPath: getMcpMemoryPath() },
      { name: 'claude-mgr-telegram', serverPath: getMcpTelegramPath() },
      { name: 'claude-mgr-kanban', serverPath: getMcpKanbanPath() },
      { name: 'claude-mgr-vault', serverPath: getMcpVaultPath() },
      { name: 'dorothy-socialdata', serverPath: getMcpSocialDataPath() },
      { name: 'dorothy-x', serverPath: getMcpXPath() },
    ];

    // Add Tasmania if enabled
    if (appSettings?.tasmaniaEnabled && appSettings.tasmaniaServerPath) {
      if (fs.existsSync(appSettings.tasmaniaServerPath)) {
        mcpServers.push({ name: 'tasmania', serverPath: appSettings.tasmaniaServerPath });
      } else {
        console.log('Tasmania MCP server not found at', appSettings.tasmaniaServerPath);
      }
    }

    const providers = getAllProviders();

    // For each server × each provider: register if not already present
    for (const { name, serverPath } of mcpServers) {
      if (!fs.existsSync(serverPath)) {
        console.log(`MCP server ${name} not found at ${serverPath}`);
        continue;
      }

      const isTypeScript = serverPath.endsWith('.ts');
      const command = isTypeScript ? 'npx' : 'node';
      const args = isTypeScript ? ['tsx', serverPath] : [serverPath];

      for (const provider of providers) {
        try {
          if (!provider.isMcpServerRegistered(name, serverPath)) {
            // Registering spawns a CLI, and this is the main thread, the one
            // that paints the window and pumps every PTY. Yield between each
            // so the app stays answerable while it catches up.
            await new Promise(resolve => setImmediate(resolve));
            await provider.registerMcpServer(name, command, args);
          }
        } catch (err) {
          console.error(`[${provider.id}] Failed to register ${name}:`, err);
        }
      }
    }

    // Install bundled skills to ~/.claude/skills/ (Claude-only)
    await installBundledSkills();
  } catch (err) {
    console.error('Failed to auto-setup MCP servers:', err);
  }
}

/**
 * Install bundled skills to all providers' skill directories.
 * Skills bundled in the app's skills/ directory are copied to each
 * provider's first skill directory so they're available to all agents.
 */
async function installBundledSkills(): Promise<void> {
  // world-builder was removed along with the dorothy-world MCP server.
  // Its tools no longer exist, so it must not ship to agents anymore.
  const bundledSkills: string[] = [];
  const providers = getAllProviders();

  // Older Tars versions copied world-builder into every provider's skill
  // dir; agents still list it although its MCP tools are gone. Remove those
  // copies, but only when the content is recognizably ours.
  for (const provider of providers) {
    for (const dir of provider.getSkillDirectories()) {
      const staleFile = path.join(dir, 'world-builder', 'SKILL.md');
      try {
        if (fs.existsSync(staleFile)) {
          const content = fs.readFileSync(staleFile, 'utf-8');
          if (/dorothy-world|create_zone|PokAImon/i.test(content)) {
            fs.rmSync(path.join(dir, 'world-builder'), { recursive: true, force: true });
            console.log(`[${provider.id}] removed stale world-builder skill from ${dir}`);
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  for (const skillName of bundledSkills) {
    try {
      const sourceDir = path.join(app.getAppPath(), 'skills', skillName);
      const sourceFile = path.join(sourceDir, 'SKILL.md');

      if (!fs.existsSync(sourceFile)) {
        console.log(`Bundled skill ${skillName} not found at ${sourceFile}`);
        continue;
      }

      const sourceContent = fs.readFileSync(sourceFile, 'utf-8');

      for (const provider of providers) {
        const skillDirs = provider.getSkillDirectories();
        if (!skillDirs.length) continue;

        const targetDir = path.join(skillDirs[0], skillName);
        const targetFile = path.join(targetDir, 'SKILL.md');

        // Check if already installed with same content
        if (fs.existsSync(targetFile)) {
          try {
            const targetContent = fs.readFileSync(targetFile, 'utf-8');
            if (sourceContent === targetContent) {
              continue;
            }
            console.log(`[${provider.id}] Skill ${skillName} outdated, updating...`);
          } catch {
            // File exists but unreadable, overwrite
          }
        }

        // Install the skill
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(sourceFile, targetFile);
        console.log(`[${provider.id}] Installed skill ${skillName} to ${targetDir}`);
      }
    } catch (err) {
      console.error(`Failed to install skill ${skillName}:`, err);
    }
  }
}

// ============== Shared memory backends (remote MCP) ==============

/**
 * Register or unregister the user's shared memory backends (gbrain, Honcho) as
 * remote HTTP MCP servers in the claude CLI's user scope, so every
 * claude-binary agent gets the memory tools Hermes and claude.ai use. Writes
 * ~/.claude.json directly (no claude needed on the packaged app's PATH, no CLI
 * boot on the main process), and removes only entries whose URL matches Tars's
 * own settings. The native CLIs (codex, gemini, grok, opencode, pi) keep their
 * own MCP configs.
 */
export function setupMemoryBackends(appSettings?: AppSettings): void {
  // Honcho refuses a call whose workspace it cannot infer, and gives an agent no
  // way to find one (list_workspaces answers 502; workspace_id is in none of its
  // 31 tool schemas): the header binds it, as Honcho's own error says. An empty
  // setting sends nothing.
  const honchoWorkspaceId = appSettings?.memoryHonchoWorkspaceId?.trim();
  const backends = [
    {
      name: 'gbrain',
      enabled: !!(appSettings?.memoryGbrainEnabled && appSettings?.memoryGbrainMcpUrl?.trim()),
      url: appSettings?.memoryGbrainMcpUrl?.trim() || '',
      bearerToken: appSettings?.memoryGbrainAuthToken?.trim() || undefined,
      extraHeaders: undefined as Record<string, string> | undefined,
    },
    {
      name: 'honcho',
      enabled: !!(appSettings?.memoryHonchoEnabled && appSettings?.memoryHonchoMcpUrl?.trim()),
      url: appSettings?.memoryHonchoMcpUrl?.trim() || '',
      bearerToken: appSettings?.memoryHonchoApiKey?.trim() || undefined,
      extraHeaders: honchoWorkspaceId ? { 'X-Honcho-Workspace-ID': honchoWorkspaceId } : undefined,
    },
  ];

  // Every live Claude Code reads and rewrites this file, so it is changed as
  // ensureProjectTrusted changes it, through updateSharedJsonSync: never in
  // place, with its 0600 mode kept, and never over a config it cannot parse.
  // The change is worked out again if Claude Code writes the file meanwhile,
  // so what it says is only logged once it is written.
  const configPath = path.join(os.homedir(), '.claude.json');
  type McpServers = Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
  let notes: string[] = [];
  try {
    const outcome = updateSharedJsonSync<{ mcpServers?: McpServers; [key: string]: unknown }>(configPath, current => {
      notes = [];
      const cfg = current ?? {};
      if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};

      let changed = false;
      for (const b of backends) {
        const cur = cfg.mcpServers[b.name];
        // Built in a fixed order, because the comparison below is a string
        // compare of the serialised object: the same headers in another order
        // would read as a change and rewrite the config on every start.
        const headerPairs: Record<string, string> = {};
        if (b.bearerToken) headerPairs.Authorization = `Bearer ${b.bearerToken}`;
        if (b.extraHeaders) Object.assign(headerPairs, b.extraHeaders);
        const desiredHeaders = Object.keys(headerPairs).length > 0 ? headerPairs : undefined;

        if (b.enabled) {
          const matches = cur
            && cur.type === 'http'
            && cur.url === b.url
            && JSON.stringify(cur.headers ?? null) === JSON.stringify(desiredHeaders ?? null);
          if (matches) continue;
          cfg.mcpServers[b.name] = { type: 'http', url: b.url, ...(desiredHeaders ? { headers: desiredHeaders } : {}) };
          changed = true;
          notes.push(`[memory] registered ${b.name} MCP backend (${b.url})`);
        } else if (cur && b.url && cur.url === b.url) {
          delete cfg.mcpServers[b.name];
          changed = true;
          notes.push(`[memory] removed ${b.name} MCP backend`);
        }
      }

      return changed ? cfg : undefined;
    });
    if (outcome === 'written') for (const note of notes) console.log(note);
    if (outcome === 'unreadable') console.error('[memory] cannot read ~/.claude.json, leaving MCP backends untouched');
    if (outcome === 'busy') console.error('[memory] ~/.claude.json kept changing, MCP backends not written');
  } catch (err) {
    console.error('[memory] failed to write ~/.claude.json:', err);
  }
}

// ============== IPC Handlers ==============

/**
 * Get the current status of the MCP orchestrator
 * Checks both claude mcp list output and mcp.json configuration
 */
export function setupOrchestratorStatusHandler(): void {
  ipcMain.handle('orchestrator:getStatus', async () => {
    try {
      const orchestratorPath = getMcpOrchestratorPath();
      const orchestratorExists = fs.existsSync(orchestratorPath);

      // Check mcp.json directly: fast, no child process spawn
      const mcpConfigPath = path.join(os.homedir(), '.claude', 'mcp.json');
      let mcpJsonConfigured = false;
      if (fs.existsSync(mcpConfigPath)) {
        try {
          const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
          mcpJsonConfigured = mcpConfig?.mcpServers?.['claude-mgr-orchestrator'] !== undefined;
        } catch {
          // Ignore parse errors
        }
      }

      // Only run the slow `claude mcp list` if mcp.json check didn't find it
      let mcpListConfigured = false;
      if (!mcpJsonConfigured) {
        try {
          const { execFile: execFileAsync } = await import('child_process');
          const { promisify } = await import('util');
          const execFilePromise = promisify(execFileAsync);
          const { stdout } = await execFilePromise('claude', ['mcp', 'list'], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          mcpListConfigured = stdout.includes('claude-mgr-orchestrator');
        } catch {
          mcpListConfigured = false;
        }
      }

      return {
        configured: mcpJsonConfigured || mcpListConfigured,
        orchestratorPath,
        orchestratorExists,
        mcpListConfigured,
        mcpJsonConfigured,
      };
    } catch (err) {
      console.error('Failed to get orchestrator status:', err);
      return { configured: false, error: String(err) };
    }
  });
}

/**
 * `claude` with an argv, never a shell string: the orchestrator's path went
 * into the add command inside double quotes, where a `"` or a `$(...)` in it
 * was shell. Asynchronous as well, so a slow `claude` does not hold the main
 * process, and bounded, as the status check's `claude mcp list` is.
 */
// SIGKILL at the timeout: the default SIGTERM leaves a child that ignores it
// running, and the setup waiting on it for good (the gate of #128).
const runClaude = (args: string[]) => promisify(execFile)('claude', args, { encoding: 'utf-8', timeout: 15_000, killSignal: 'SIGKILL' });

/**
 * Setup the MCP orchestrator using claude mcp add command
 * This handler allows manual configuration from the renderer process
 */
export function setupOrchestratorSetupHandler(): void {
  ipcMain.handle('orchestrator:setup', async () => {
    try {
      const orchestratorPath = getMcpOrchestratorPath();

      // Check if orchestrator exists
      if (!fs.existsSync(orchestratorPath)) {
        return {
          success: false,
          error: `MCP orchestrator not found at ${orchestratorPath}. Try reinstalling the app.`
        };
      }

      // First try to remove any existing config to avoid duplicates (from both user and project scope)
      try {
        await runClaude(['mcp', 'remove', '-s', 'user', 'claude-mgr-orchestrator']);
      } catch {
        // Ignore errors if it doesn't exist
      }
      try {
        await runClaude(['mcp', 'remove', 'claude-mgr-orchestrator']);
      } catch {
        // Ignore errors if it doesn't exist in project scope
      }

      // Add the MCP server using claude mcp add with -s user for global scope
      const addArgs = ['mcp', 'add', '-s', 'user', 'claude-mgr-orchestrator', 'node', orchestratorPath];
      console.log('Running: claude', addArgs.join(' '));

      try {
        await runClaude(addArgs);
        console.log('MCP orchestrator configured globally via claude mcp add -s user');
        return { success: true, method: 'claude-mcp-add-global' };
      } catch (addErr) {
        console.error('Failed to add MCP server via claude mcp add -s user:', addErr);

        // Fallback: write to mcp.json, through addMcpServerToJson, which fails
        // on a file that is not JSON rather than replacing it.
        const mcpConfigPath = path.join(os.homedir(), '.claude', 'mcp.json');
        addMcpServerToJson(mcpConfigPath, 'claude-mgr-orchestrator', { command: 'node', args: [orchestratorPath] });
        console.log('MCP orchestrator configured via mcp.json fallback');
        return { success: true, path: mcpConfigPath, method: 'mcp-json-fallback' };
      }
    } catch (err) {
      console.error('Failed to setup orchestrator:', err);
      return { success: false, error: String(err) };
    }
  });
}

/**
 * Remove orchestrator from Claude's global configuration
 * This handler allows uninstalling the MCP orchestrator
 */
export function setupOrchestratorRemoveHandler(): void {
  ipcMain.handle('orchestrator:remove', async () => {
    try {
      // Remove from global user scope
      try {
        await runClaude(['mcp', 'remove', '-s', 'user', 'claude-mgr-orchestrator']);
      } catch {
        // Ignore errors if it doesn't exist
      }

      // Also clean up mcp.json fallback if it exists
      try {
        removeMcpServerFromJson(path.join(os.homedir(), '.claude', 'mcp.json'), 'claude-mgr-orchestrator');
      } catch (err) {
        console.warn('claude-mgr-orchestrator not removed from mcp.json:', err);
      }

      return { success: true };
    } catch (err) {
      console.error('Failed to remove orchestrator:', err);
      return { success: false, error: String(err) };
    }
  });
}

/**
 * Register all MCP orchestrator IPC handlers
 * Call this during app initialization to set up all handlers
 */
export function registerMcpOrchestratorHandlers(): void {
  setupOrchestratorStatusHandler();
  setupOrchestratorSetupHandler();
  setupOrchestratorRemoveHandler();
}
