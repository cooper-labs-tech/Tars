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
import { servedPathMatches, orchestratorToolFlags, promptOperand, effortFlag, resumeFlags, shellQuote, keyProviderEnv } from './cli-provider';
import { DATA_DIR, OPENAI_BRIDGE_PORT } from '../constants';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';
import { getBridgeToken } from '../services/bridge-token';

// claude appends /v1/messages; "venice" is this vendor's path segment on
// Tars's shared OpenAI-compatible bridge (see services/openai-bridge.ts for
// why a path segment, not a port or a header, is how the bridge is addressed).
const VENICE_BRIDGE_BASE_URL = `http://127.0.0.1:${OPENAI_BRIDGE_PORT}/venice`;

/**
 * Venice AI has no Anthropic-compatible endpoint (confirmed against
 * docs.venice.ai: /chat/completions, /embeddings, /images/*, /audio/*,
 * /video/*, /models - OpenAI-compatible only, no /v1/messages). Unlike every
 * other alt provider here, the claude binary cannot reach it directly. It is
 * routed through Tars's own local translation bridge instead - see
 * services/openai-bridge.ts for the wire-format translation and, importantly,
 * for why the key below is the bridge's own token (services/bridge-token.ts)
 * and NOT the user's Venice key.
 */
export class VeniceProvider implements CLIProvider {
  readonly id = 'venice' as const;
  readonly displayName = 'Venice AI';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    return [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', description: 'Meta, balanced' },
      { id: 'venice-uncensored-1-2', name: 'Venice Uncensored', description: 'Unfiltered, Venice-tuned' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', description: 'Flagship chat' },
      { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B', description: 'Large MoE' },
      { id: 'hermes-3-llama-3.1-405b', name: 'Hermes 3 405B', description: 'Agentic' },
      { id: 'mistral-small-3-2-24b-instruct', name: 'Mistral Small', description: 'Fast' },
    ];
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

    // Only wire the bridge once a Venice key exists to forward - same gate
    // DeepSeek/Moonshot/etc. use for their own key, just with no OpenRouter
    // fallback (Venice is not on OpenRouter, see the design note).
    if (appSettings?.veniceApiKey) {
      // NOT the Venice key. The claude binary sends this as a Bearer
      // (keyProviderEnv) to whatever ANTHROPIC_BASE_URL points at; here that's
      // Tars's own bridge on 127.0.0.1, which authenticates the request with
      // a token of its own, which opens nothing else (services/bridge-token.ts),
      // and only then reads the real Venice key from the settings' secrets to
      // attach to the outbound call. See services/openai-bridge.ts.
      Object.assign(vars, keyProviderEnv(VENICE_BRIDGE_BASE_URL, getBridgeToken()));
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
