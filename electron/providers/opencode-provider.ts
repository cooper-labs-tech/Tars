import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import { keyEnvFor } from '../services/cli-keys';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { lineEnvPrefix, safeEffort, updateCheckOffEnv } from './cli-provider';
import { updateSharedJsonSync } from '../utils/shared-file';

/**
 * Where opencode reads its MCP servers (opencode 1.19.3, read in its compiled
 * bundle on 19/10): `opencode.json` of its config folder,
 * `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, the file its own
 * `opencode mcp add` writes; it merges `config.json` and `opencode.jsonc` there
 * too. Each server is `mcp.<name>`, and a local one is started with opencode's
 * whole environment, the agent's token in it.
 */
function mcpConfigFile(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json');
}

/** Where Tars wrote them until 2.0.4, which opencode never reads. */
const legacyMcpFile = (): string => path.join(os.homedir(), '.opencode', 'config.json');

type OpencodeConfig = { mcp?: Record<string, unknown>; [key: string]: unknown };
type LegacyConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/** A server Tars wrote in the old place: taken out, the rest of that file left as it is. */
function dropLegacy(name: string): void {
  updateSharedJsonSync<LegacyConfig>(legacyMcpFile(), current => {
    const servers = current?.mcpServers;
    if (!servers || typeof servers !== 'object' || !(name in servers)) return undefined;
    delete servers[name];
    return current;
  });
}

export class OpenCodeProvider implements CLIProvider {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly binaryName = 'opencode';
  readonly configDir = path.join(os.homedir(), '.opencode');

  getModels(): ProviderModel[] {
    return [
      { id: 'default', name: 'Default', description: 'Use configured default' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet', description: 'Anthropic' },
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus', description: 'Anthropic' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.opencode || 'opencode';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    // Its own update check off (cli-provider.ts updateCheckOffEnv), on the line where a shell runs it.
    let command = lineEnvPrefix(updateCheckOffEnv(this.binaryName));
    command += `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // OpenCode CLI:
    //   opencode [project]:       start TUI (default, interactive)
    //   opencode run [message..]: run non-interactively, and exit
    //   --prompt <text>:          the TUI's starting prompt (1.19.3 --help)
    //   --model provider/model:   model to use
    //
    // Always the TUI: the agent's permanent session (2.0.4). `run` did the
    // task and exited, and the agent was gone with it.

    // Model (format: provider/model)
    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/\-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    // Reasoning effort is --variant on opencode (provider-specific values
    // like high/max/minimal), and permissions are --auto.
    if (safeEffort(params.effort)) {
      command += ` --variant '${safeEffort(params.effort)}'`;
    }
    if (params.permissionMode === 'auto' || params.permissionMode === 'bypass') {
      command += ' --auto';
    }

    // A delegated task arrives as params.prompt. Dropping it launched a bare
    // TUI and reported success while the task went nowhere.
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    if (finalPrompt) {
      command += ` --prompt '${finalPrompt.replace(/'/g, "'\\''")}'`;
    }

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    if (params.model && params.model !== 'default') {
      command += ` --model ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` run '${escaped}'`;

    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      // The orchestrator MCP and the hooks both read the CLAUDE_ names. Without
      // them the agent has no identity, so whoami fails and list_agents falls
      // back to every project's agents instead of its own.
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      // Its API key from Settings, under the variable it reads (services/cli-keys.ts).
      ...keyEnvFor('opencode', appSettings),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.json'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    console.log('OpenCode: hooks not supported, using exit-code based status detection');
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    const file = mcpConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const outcome = updateSharedJsonSync<OpencodeConfig>(file, current => {
      const config: OpencodeConfig = current ?? { $schema: 'https://opencode.ai/config.json' };
      const servers = config.mcp && typeof config.mcp === 'object' ? config.mcp : {};
      config.mcp = { ...servers, [name]: { type: 'local', command: [command, ...args], enabled: true } };
      return config;
    }, { createMode: 0o644 });
    // A file Tars cannot read (opencode takes JSONC, comments and all) is the user's, and left as it is.
    if (outcome === 'unreadable') console.warn(`[opencode] MCP server ${name} not registered: ${file} is not plain JSON, left untouched`);
    else if (outcome === 'busy') console.warn(`[opencode] MCP server ${name} not registered: ${file} changed under every attempt, tried again at the next start`);
    else console.log(`[opencode] Registered MCP server ${name} in ${file}`);
    dropLegacy(name);
  }

  async removeMcpServer(name: string): Promise<void> {
    updateSharedJsonSync<OpencodeConfig>(mcpConfigFile(), current => {
      const servers = current?.mcp;
      if (!servers || typeof servers !== 'object' || !(name in servers)) return undefined;
      delete servers[name];
      return current;
    });
    dropLegacy(name);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    try {
      const config = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf-8')) as OpencodeConfig;
      const server = config.mcp && typeof config.mcp === 'object' ? config.mcp[name] : undefined;
      if (!server) return false;
      // The path as JSON writes it too: a Windows path has every backslash
      // doubled there, never matched, and was registered again at every launch.
      const entry = JSON.stringify(server);
      return entry.includes(expectedServerPath) || entry.includes(JSON.stringify(expectedServerPath).slice(1, -1));
    } catch {
      return false;
    }
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  getSkillDirectories(): string[] {
    return [path.join(os.homedir(), '.agents', 'skills')];
  }

  getInstalledSkills(): string[] {
    const skills: string[] = [];
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              skills.push(entry.name);
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }
    return skills;
  }

  supportsSkills(): boolean {
    return true;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '--cwd';
  }
}
