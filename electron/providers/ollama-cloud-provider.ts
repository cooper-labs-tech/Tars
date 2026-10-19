import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ScheduledCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { orchestratorToolFlags, promptOperand, effortFlag, resumeFlags, shellQuote, keyProviderEnv, scheduledKeyExports } from './cli-provider';
import { DATA_DIR } from '../constants';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';

export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'; // claude appends /v1/messages

/**
 * Ollama Cloud is a different product from local Ollama (ollama-provider.ts):
 * a hosted vendor at ollama.com, billed separately, with its own API key and
 * its own model set (the ":cloud"-tagged models on ollama.com/search?c=cloud -
 * plain tags, not ":cloud"-suffixed, when talking to the hosted API directly
 * rather than proxying through a local server). Do not point this provider's
 * requests at the local-Ollama code path: they are not interchangeable.
 *
 * It DOES speak the Anthropic Messages wire format natively at
 * https://ollama.com/v1/messages, same as local Ollama v0.14+ - so, like
 * local Ollama, this needs no translation bridge. What differs is auth: its
 * endpoint requires `Authorization: Bearer <key>` and rejects `x-api-key`
 * outright (confirmed against ollama/ollama#16922, open as of this writing,
 * and docs.ollama.com/cloud's own example: `Authorization: Bearer
 * $OLLAMA_API_KEY`). The claude binary's `ANTHROPIC_API_KEY` env var is
 * always sent as `x-api-key`; the header it sends as `Authorization: Bearer`
 * is `ANTHROPIC_AUTH_TOKEN` (documented for exactly this kind of
 * gateway/proxy auth - see code.claude.com/docs/en/authentication). So this
 * is a direct provider with a header difference, not a shim: set
 * ANTHROPIC_AUTH_TOKEN instead of ANTHROPIC_API_KEY.
 */
export class OllamaCloudProvider implements CLIProvider {
  readonly id = 'ollama-cloud' as const;
  readonly displayName = 'Ollama Cloud';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    // Curated, not exhaustive - models:list (ipc-handlers.ts) prefers the
    // live models.dev catalogue, which does carry an 'ollama-cloud' entry
    // (see model-catalog.ts PROVIDER_KEYS); this is only the floor shown
    // before that loads or if it is unreachable.
    return [
      { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', description: 'OpenAI open weights, flagship' },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', description: 'OpenAI open weights, fast' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Zhipu, flagship' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', description: 'Moonshot, code-focused' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Flagship reasoning' },
      { id: 'minimax-m3', name: 'MiniMax M3', description: 'Agentic' },
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

  buildScheduledCommand(params: ScheduledCommandParams): string {
    let command = shellQuote(params.binaryPath);
    if (params.autonomous) command += ' --dangerously-skip-permissions';
    if (params.outputFormat) command += ` --output-format ${params.outputFormat}`;
    if (params.verbose) command += ' --verbose';
    if (params.mcpConfigPath) command += ` --mcp-config ${shellQuote(params.mcpConfigPath)}`;
    command += ` --add-dir ${shellQuote(DATA_DIR)}`;
    command += ` -p '${params.prompt.replace(/'/g, "'\\''")}'`;
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

    if (appSettings?.ollamaCloudApiKey) {
      // See the file header: ollama.com's Anthropic-compatible endpoint wants
      // the key as a Bearer token, not as x-api-key, as every key provider
      // hands it over now (keyProviderEnv).
      Object.assign(vars, keyProviderEnv(OLLAMA_CLOUD_BASE_URL, appSettings.ollamaCloudApiKey));
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
      return existing.args[existing.args.length - 1] === expectedServerPath;
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

  buildScheduledScript(params: {
    binaryPath: string; binaryDir: string; projectPath: string; prompt: string;
    autonomous: boolean; mcpConfigPath: string; logPath: string; homeDir: string;
    skills?: string[];
  }): string {
    const flags = params.autonomous ? '--dangerously-skip-permissions' : '';
    const promptWithSkills = (params.skills && params.skills.length > 0)
      ? `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`
      : params.prompt;
    // Scheduled tasks run as their own process later, so the key is read from
    // disk at run time rather than baked in at generation time (same pattern
    // as ollama-provider.ts's base-url read).
    return `#!/bin/bash
export HOME=${shellQuote(params.homeDir)}
if [ -s ${shellQuote(params.homeDir)}/.nvm/nvm.sh ]; then source ${shellQuote(params.homeDir)}/.nvm/nvm.sh 2>/dev/null || true; fi
if [ -f ${shellQuote(params.homeDir)}/.zshrc ]; then source ${shellQuote(params.homeDir)}/.zshrc 2>/dev/null || true; fi
export PATH=${shellQuote(params.binaryDir)}:"$PATH"
cd ${shellQuote(params.projectPath)}
echo "=== Task started at $(date) ===" >> ${shellQuote(params.logPath)}
unset CLAUDECODE
export CLAUDE_PROVIDER="ollama-cloud"
${scheduledKeyExports(OLLAMA_CLOUD_BASE_URL, 'ollamaCloudApiKey', params.logPath)}${shellQuote(params.binaryPath)} ${flags} --output-format stream-json --verbose --mcp-config ${shellQuote(params.mcpConfigPath)} --add-dir ${shellQuote(DATA_DIR)} -p ${shellQuote(promptWithSkills)} >> ${shellQuote(params.logPath)} 2>&1
echo "=== Task completed at $(date) ===" >> ${shellQuote(params.logPath)}
`;
  }
}
