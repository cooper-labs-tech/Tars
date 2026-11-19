import { endpointLaunchForAgent } from '../services/traces-runtime';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import { keyEnvFor } from '../services/cli-keys';
import { DATA_DIR } from '../constants';
import { piSessionDir } from '../services/pi-sessions';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { updateSharedJsonSync } from '../utils/shared-file';

/**
 * Where pi reads its MCP servers (`@earendil-works/pi-coding-agent` 1.3.0,
 * docs/mcp.md and docs/configuration.md, read on 19/10): `mcp.json` of its
 * agent folder, `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, under `mcpServers`,
 * each started with pi's whole environment (pi-mcp 1.3.0, transports/stdio.js),
 * the agent's token in it. `@mariozechner/pi-coding-agent`, its former name,
 * has no MCP at all.
 */
function mcpConfigFile(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'mcp.json');
}

/** Where Tars wrote them until 2.0.4, which pi never reads. */
const legacyMcpFile = (): string => path.join(os.homedir(), '.pi', 'config.json');

type McpServersFile = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/** The server out of `file`'s `mcpServers`, the rest of the file left as it is. */
function dropServer(file: string, name: string): void {
  updateSharedJsonSync<McpServersFile>(file, current => {
    const servers = current?.mcpServers;
    if (!servers || typeof servers !== 'object' || !(name in servers)) return undefined;
    delete servers[name];
    return current;
  });
}

export class PiProvider implements CLIProvider {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi Terminal';
  readonly binaryName = 'pi';
  readonly configDir = path.join(os.homedir(), '.pi');

  getModels(): ProviderModel[] {
    return [
      { id: 'default', name: 'Default', description: 'Use configured model' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet', description: 'Anthropic' },
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus', description: 'Anthropic' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.pi || 'pi';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // On an inference endpoint: Tars's provider in pi's models.json, on the endpoint proxy (services/endpoint-harness.ts).
    for (const arg of endpointLaunchForAgent(params.agentId, 'pi')?.args ?? []) command += ` '${arg.replace(/'/g, "'\\''")}'`;

    // For interactive PTY sessions, launch the TUI (no subcommand).
    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    // A delegated task arrives as params.prompt. Dropping it launched a bare
    // TUI and reported success while the task went nowhere.
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    if (finalPrompt) {
      command += ` '${finalPrompt.replace(/'/g, "'\\''")}'`;
    }

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    command += ' -p';

    if (params.model) {
      command += ` --model ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` '${escaped}'`;

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
      ...keyEnvFor('pi', appSettings),
      // Its sessions in a folder of its own, which pi ranks above its own setting:
      // every file there is this agent's, read for its turns (services/pi-sessions.ts).
      PI_CODING_AGENT_SESSION_DIR: piSessionDir(DATA_DIR, agentId),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      // Its turns are read from its session file and posted as the hooks would (services/pi-sessions.ts).
      turnsReported: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.json'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    // Pi uses extensions for hooks, no native hook configuration needed
    console.log('Pi Terminal: hooks configured via extensions, skipping native hook setup');
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    const file = mcpConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const outcome = updateSharedJsonSync<McpServersFile>(file, current => {
      const config: McpServersFile = current ?? {};
      const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
      // Declared to the model like a built-in tool: pi 1.5.2's default exposure, `codemode`, leaves a server's tools
      // callable from its code tool alone, and an agent on pi never saw send_message or delegate_task (measured 19/11).
      config.mcpServers = { ...servers, [name]: { command, args, exposure: 'direct' } };
      return config;
    }, { createMode: 0o644 });
    if (outcome === 'unreadable') console.warn(`[pi] MCP server ${name} not registered: ${file} is not JSON, left untouched`);
    else if (outcome === 'busy') console.warn(`[pi] MCP server ${name} not registered: ${file} changed under every attempt, tried again at the next start`);
    else console.log(`[pi] Registered MCP server ${name} in ${file}`);
    dropServer(legacyMcpFile(), name);
  }

  async removeMcpServer(name: string): Promise<void> {
    dropServer(mcpConfigFile(), name);
    dropServer(legacyMcpFile(), name);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    try {
      const config = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf-8')) as McpServersFile;
      const server = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers[name] : undefined;
      if (!server) return false;
      // The path as JSON writes it too: a Windows path has every backslash
      // doubled there, never matched, and was registered again at every launch.
      const entry = JSON.stringify(server);
      return entry.includes(expectedServerPath) || entry.includes(JSON.stringify(expectedServerPath).slice(1, -1));
    } catch {
      return false;
    }
  }

  /** Registered, and with its tools declared to the model: a server an older Tars wrote without that is written again. */
  isMcpServerCurrent(name: string, expectedServerPath: string): boolean {
    if (!this.isMcpServerRegistered(name, expectedServerPath)) return false;
    try {
      const config = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf-8')) as McpServersFile;
      const server = config.mcpServers?.[name] as { exposure?: unknown } | undefined;
      return server?.exposure === 'direct';
    } catch {
      return false;
    }
  }

  getSkillDirectories(): string[] {
    // Pi uses extensions/packages rather than skills directories
    return [path.join(os.homedir(), '.pi', 'packages')];
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
    return false;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '';
  }
}
