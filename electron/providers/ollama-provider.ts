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
import { DATA_DIR } from '../constants';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Ollama v0.14 (2026-01-16) shipped a native POST /v1/messages endpoint that
 * speaks the Anthropic Messages wire format directly - same request/response
 * shape, streaming, tool calls, vision, extended thinking. That is exactly
 * what the claude binary already sends when ANTHROPIC_API_KEY is set, the same
 * mechanism every other direct-endpoint provider here uses. So unlike Venice,
 * Ollama needs no translation shim: it is wired exactly like DeepSeek, just
 * pointed at a local server instead of a hosted one, and with no key at all.
 */
function stripV1(baseUrl: string): string {
  // Claude Code appends /v1/messages itself; a base URL ending in /v1 would
  // double it up, the same trap Tasmania's local endpoint has to avoid.
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

export class OllamaProvider implements CLIProvider {
  readonly id = 'ollama' as const;
  readonly displayName = 'Ollama';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    // Ollama's real catalogue is whatever the user has pulled locally, which
    // Tars has no way to enumerate without a running server (unlike models.dev,
    // which has no generic "ollama" entry: local model lists are per-machine).
    // These are common defaults; the model field also accepts any tag typed in.
    return [
      { id: 'llama3.3', name: 'Llama 3.3', description: 'Meta, locally hosted' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', description: 'Code-focused' },
      { id: 'deepseek-r1', name: 'DeepSeek R1', description: 'Reasoning' },
      { id: 'gpt-oss', name: 'GPT-OSS', description: 'OpenAI open weights' },
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

    // No "enabled + key" gate here on purpose: Ollama isn't a hosted vendor
    // you sign up for, it's a local server that either answers or doesn't.
    // Settings > AI Providers checks reachability separately; this always
    // wires the configured (or default) address.
    // Ollama's Anthropic-compat endpoint requires a credential be present but
    // does not validate its value locally, so any non-empty string works; its
    // own instructions for Claude Code hand it as the auth token.
    Object.assign(vars, keyProviderEnv(stripV1(appSettings?.ollamaBaseUrl || OLLAMA_DEFAULT_BASE_URL), 'ollama-local'));
    // The claude binary preflights every turn with GET/POST
    // /v1/messages/count_tokens?beta=true, which Ollama does not implement
    // (404). Multiple users report that 404 then makes Ollama's own server
    // degrade into escalating 500s until it is restarted (ollama/ollama#13949,
    // open, unresolved as of this writing). Tars already sets this same flag
    // for the local Tasmania provider to suppress the identical class of
    // preflight call; do the same here rather than let the CLI find out the
    // hard way.
    vars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

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
