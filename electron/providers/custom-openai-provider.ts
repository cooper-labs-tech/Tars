import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { servedPathMatches, readAppSettingsFromDisk, isValidOpenAIBaseUrl, orchestratorToolFlags, promptOperand, effortFlag, resumeFlags, shellQuote, keyProviderEnv } from './cli-provider';
import { DATA_DIR, OPENAI_BRIDGE_PORT } from '../constants';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';
import { getBridgeToken } from '../services/bridge-token';

// claude appends /v1/messages; "custom" is this provider's fixed path segment
// on Tars's shared OpenAI-compatible bridge (services/openai-bridge.ts), which
// looks the user's actual base URL up from app-settings.json per request.
const CUSTOM_BRIDGE_BASE_URL = `http://127.0.0.1:${OPENAI_BRIDGE_PORT}/custom`;

/**
 * The provider that exists so Tars does not need to ship a named provider for
 * every OpenAI-compatible vendor. The user supplies a base URL, an optional
 * key and a model; Tars translates through the same bridge Venice uses (see
 * services/openai-bridge.ts) rather than adding a bespoke shim per vendor.
 *
 * Unlike every named vendor here, there is no models.dev catalogue entry to
 * fall back on - a private or self-hosted endpoint is by definition not in a
 * public catalogue. getModels() below returns whatever the user typed into
 * Settings, or nothing, rather than a curated list; the model field is text,
 * not a picker, for the same reason.
 */
export class CustomOpenAIProvider implements CLIProvider {
  readonly id = 'custom-openai' as const;
  readonly displayName = 'Custom (OpenAI-compatible)';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    const model = readAppSettingsFromDisk().customOpenAIModel?.trim();
    return model
      ? [{ id: model, name: model, description: 'Configured in Settings > AI Providers' }]
      : [];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.claude || 'claude';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    if (params.mcpConfigPath && fs.existsSync(params.mcpConfigPath)) {
      command += ` --mcp-config '${params.mcpConfigPath.replace(/'/g, "'\\''")}'`;
    }

    if (params.systemPromptFile && fs.existsSync(params.systemPromptFile)) {
      command += ` --append-system-prompt-file '${params.systemPromptFile.replace(/'/g, "'\\''")}'`;
    }

    command += resumeFlags(params.resumeSessionId, params.forkSession);

    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/\-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    if (params.verbose) command += ' --verbose';

    if (params.permissionMode === 'auto') {
      command += ' --permission-mode auto';
    } else if (params.permissionMode === 'bypass') {
      command += ' --permission-mode bypassPermissions';
    }

    command += orchestratorToolFlags(params.orchestratorMode);

    command += effortFlag(params.effort);

    command += ` --add-dir ${shellQuote(DATA_DIR)}`;

    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}.] ${params.prompt}`;
    }

    command += promptOperand(finalPrompt);

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;
    command += ' -p';
    if (params.model && params.model !== 'default') command += ` --model ${params.model}`;
    command += ` '${params.prompt.replace(/'/g, "'\\''")}'`;
    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    const vars: Record<string, string> = {
      CLAUDE_SKILLS: (skills ?? []).join(','),
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
    };

    // Wire the bridge up only once there is somewhere valid to send it: a key
    // is optional (some self-hosted OpenAI-compatible servers take none), a
    // parseable http(s) base URL is not.
    if (appSettings?.customOpenAIEnabled && isValidOpenAIBaseUrl(appSettings?.customOpenAIBaseUrl)) {
      // NOT the vendor key, same reasoning as venice-provider.ts: this is
      // the bridge's own token (services/bridge-token.ts), which authenticates
      // the request to the bridge and opens nothing else; the bridge itself
      // reads the real key from the settings' secrets and attaches it to the
      // outbound call, so it never reaches the PTY.
      Object.assign(vars, keyProviderEnv(CUSTOM_BRIDGE_BASE_URL, getBridgeToken()));
    }

    return vars;
  }

  getEnvVarsToDelete(): string[] {
    return ['CLAUDECODE'];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'settings.json'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {}

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    addMcpServerToJson(path.join(this.configDir, 'mcp.json'), name, { command, args });
  }

  async removeMcpServer(name: string): Promise<void> {
    removeMcpServerFromJson(path.join(this.configDir, 'mcp.json'), name);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(mcpConfigPath)) return false;
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const existing = mcpConfig?.mcpServers?.[name];
      if (!existing?.args) return false;
      return servedPathMatches(existing.args[existing.args.length - 1], expectedServerPath);
    } catch { return false; }
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' { return 'flag'; }

  getSkillDirectories(): string[] {
    return [path.join(this.configDir, 'skills'), path.join(os.homedir(), '.agents', 'skills')];
  }

  getInstalledSkills(): string[] {
    const skills = new Set<string>();
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory() || e.isSymbolicLink()) skills.add(e.name); } } catch { /* ignore */ }
      }
    }
    return Array.from(skills);
  }

  supportsSkills(): boolean { return true; }
  getMemoryBasePath(): string { return path.join(this.configDir, 'projects'); }
  getAddDirFlag(): string { return '--add-dir'; }
}
