import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import { kimiHome, KIMI_SESSION_ID } from './kimi-cli';
import { handedSecondaryFolder } from '../utils/handed-folder';
import { updateSharedJsonSync } from '../utils/shared-file';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { shellQuote } from './cli-provider';
import { endpointLaunchForAgent } from '../services/traces-runtime';

/**
 * Kimi Code CLI, the binary `kimi` (MoonshotAI/kimi-code, MIT), measured on 2.6.3 (19/11/2026) in a PTY against a
 * loopback endpoint:
 * - its TUI takes no task on its command line (`kimi [options]`; `-p` is one-shot), so a launch types the task in
 *   once it runs (taskTypedAfterLaunch, core/typed-task.ts), with a bracketed paste and Enter like every CLI;
 * - `--auto` is its Never Ask mode, `--plan` its plan mode; without either it asks (manual);
 * - its first start in a folder asks "Trust this folder?": KIMI_CODE_TRUST_WORKSPACE=1 trusts it for that process
 *   only, writing nothing;
 * - its MCP servers are read from `$KIMI_CODE_HOME/mcp.json` (`mcpServers`), each started with kimi's whole
 *   environment, the agent's token in it (measured: the probe's variables reached the server);
 * - `--session <id>` resumes a session, with its history (measured);
 * - its turns, its answer and its sessions are read from its session log (services/kimi-sessions.ts): it runs no
 *   hook Tars installs, and the user's own Kimi home (its login, its providers) is the one it runs on.
 * Its model is the user's own (`default_model` in its config.toml), or the endpoint Tars hands it
 * (services/endpoint-harness.ts): no model of any family is assumed here.
 */

/** A model alias of the user's config (`-m`), letters, digits and `. _ : / -` only: it reaches a command line. */
const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,200}$/;

const mcpConfigFile = (): string => path.join(kimiHome(), 'mcp.json');
type McpServersFile = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

export class KimiCodeProvider implements CLIProvider {
  readonly id = 'kimi-code' as const;
  readonly displayName = 'Kimi Code';
  readonly binaryName = 'kimi';
  get configDir(): string { return kimiHome(); }

  getModels(): ProviderModel[] {
    return [{ id: 'default', name: 'Default', description: 'The model set in Kimi Code' }];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.kimi || 'kimi';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = shellQuote(params.binaryPath);
    if (params.permissionMode === 'auto' || params.permissionMode === 'bypass') command += ' --auto';
    else if (params.permissionMode === 'plan') command += ' --plan';
    if (params.model && params.model !== 'default') {
      if (!SAFE_MODEL.test(params.model)) throw new Error('Invalid model name');
      command += ` -m ${shellQuote(params.model)}`;
    }
    if (params.resumeSessionId && KIMI_SESSION_ID.test(params.resumeSessionId)) command += ` --session ${shellQuote(params.resumeSessionId)}`;
    const secondary = handedSecondaryFolder(params.secondaryProjectPath);
    if (secondary) command += ` --add-dir ${shellQuote(secondary)}`;
    for (const vp of params.obsidianVaultPaths ?? []) {
      if (handedSecondaryFolder(vp) && fs.existsSync(vp)) command += ` --add-dir ${shellQuote(vp)}`;
    }
    return command;
  }

  readonly taskTypedAfterLaunch = true;

  /** Measured on 2.6.3: a note typed with Enter during a slow tool call went out as its own next turn. */
  readonly noteDuringTurn = 'after-the-turn' as const;

  /** What a launch types into the TUI: the task, with the skills line before it. No task, nothing. */
  typedTask(params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>): string {
    if (!params.prompt?.trim()) return '';
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      return `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    return params.prompt;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = shellQuote(params.binaryPath);
    if (params.model && params.model !== 'default' && SAFE_MODEL.test(params.model)) command += ` -m ${shellQuote(params.model)}`;
    return `${command} -p ${shellQuote(params.prompt)}`;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      // The folder trusted for this process, nothing written (measured on 2.6.3).
      KIMI_CODE_TRUST_WORKSPACE: '1',
      // On an inference endpoint, its model from the launch (services/endpoint-harness.ts); the proxy token's
      // variable is filled at the spawn (core/agent-pty.ts), never here.
      ...(endpointLaunchForAgent(agentId, 'kimi-code')?.env ?? {}),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      // Its turns are read from its session log and posted as the hooks would (services/kimi-sessions.ts).
      turnsReported: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.toml'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    // Nothing to install: its session log is read instead.
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
      config.mcpServers = { ...servers, [name]: { command, args } };
      return config;
    }, { createMode: 0o600 });
    if (outcome === 'unreadable') console.warn(`[kimi-code] MCP server ${name} not registered: ${file} is not JSON, left untouched`);
    else if (outcome === 'busy') console.warn(`[kimi-code] MCP server ${name} not registered: ${file} changed under every attempt`);
  }

  async removeMcpServer(name: string): Promise<void> {
    updateSharedJsonSync<McpServersFile>(mcpConfigFile(), current => {
      const servers = current?.mcpServers;
      if (!servers || typeof servers !== 'object' || !(name in servers)) return undefined;
      delete servers[name];
      return current;
    });
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    try {
      const config = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf-8')) as McpServersFile;
      const server = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers[name] : undefined;
      if (!server) return false;
      const entry = JSON.stringify(server);
      return entry.includes(expectedServerPath) || entry.includes(JSON.stringify(expectedServerPath).slice(1, -1));
    } catch {
      return false;
    }
  }

  getSkillDirectories(): string[] {
    return [path.join(this.configDir, 'skills')];
  }

  getInstalledSkills(): string[] {
    const dir = this.getSkillDirectories()[0];
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  supportsSkills(): boolean {
    return false;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '--add-dir';
  }
}
