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
import { servedPathMatches, readAppSettingsFromDisk, orchestratorToolFlags, promptOperand, effortFlag, resumeFlags, shellQuote, keyProviderEnv } from './cli-provider';
import { DATA_DIR } from '../constants';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';

const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'; // Anthropic-compatible endpoint
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'; // claude appends /v1/messages

const DIRECT_MODEL_MAP: Record<string, string> = {};

export class ZhipuProvider implements CLIProvider {
  readonly id = 'zhipu' as const;
  readonly displayName = 'ZhipuAI (GLM)';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  /** OpenRouter-style ids ('vendor/model') are only valid via OpenRouter.
   *  On the vendor's direct Anthropic-compatible endpoint, translate to the
   *  native id (mapping table, else strip the vendor prefix). */
  private mapModelForEndpoint(model: string): string {
    const direct = !!readAppSettingsFromDisk().zhipuApiKey;
    if (!direct) return model;
    return DIRECT_MODEL_MAP[model] ?? model.replace(/^[^/]+\//, '');
  }

  getModels(): ProviderModel[] {
    return [
      { id: 'zhipuai/glm-4.6', name: 'GLM-4.6', description: 'Flagship • ZhipuAI' },
      { id: 'zhipuai/glm-4.5', name: 'GLM-4.5', description: 'General • ZhipuAI' },
      { id: 'zhipuai/glm-4-plus', name: 'GLM-4 Plus', description: 'Advanced • ZhipuAI' },
      { id: 'zhipuai/glm-4-air', name: 'GLM-4 Air', description: 'Fast & efficient' },
      { id: 'zhipuai/glm-4-flash', name: 'GLM-4 Flash', description: 'Ultra-fast' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.claude || 'claude';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;
    if (params.mcpConfigPath && fs.existsSync(params.mcpConfigPath)) command += ` --mcp-config '${params.mcpConfigPath.replace(/'/g, "'\\''")}'`;
    if (params.systemPromptFile && fs.existsSync(params.systemPromptFile)) command += ` --append-system-prompt-file '${params.systemPromptFile.replace(/'/g, "'\\''")}'`;
    command += resumeFlags(params.resumeSessionId, params.forkSession);
    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/\-]+$/.test(params.model)) throw new Error('Invalid model name');
      command += ` --model '${this.mapModelForEndpoint(params.model)}'`;
    }
    if (params.verbose) command += ' --verbose';
    if (params.permissionMode === 'auto') command += ' --permission-mode auto';
    else if (params.permissionMode === 'bypass') command += ' --permission-mode bypassPermissions';
    command += orchestratorToolFlags(params.orchestratorMode);
    command += effortFlag(params.effort);
    command += ` --add-dir ${shellQuote(DATA_DIR)}`;
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills: ${params.skills.join(', ')}.] ${params.prompt}`;
    }
    command += promptOperand(finalPrompt);
    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;
    command += ' -p';
    if (params.model && params.model !== 'default') command += ` --model ${this.mapModelForEndpoint(params.model)}`;
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
    if (appSettings?.zhipuApiKey) {
      Object.assign(vars, keyProviderEnv(ZHIPU_BASE_URL, appSettings.zhipuApiKey));
    } else if (appSettings?.openRouterApiKey) {
      Object.assign(vars, keyProviderEnv(OPENROUTER_BASE_URL, appSettings.openRouterApiKey));
    }
    return vars;
  }

  getEnvVarsToDelete(): string[] { return ['CLAUDECODE']; }

  getHookConfig(): HookConfig {
    return { supportsNativeHooks: true, configDir: this.configDir, settingsFile: path.join(this.configDir, 'settings.json') };
  }

  async configureHooks(_hooksDir: string): Promise<void> {}

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    addMcpServerToJson(path.join(this.configDir, 'mcp.json'), name, { command, args });
  }

  async removeMcpServer(name: string): Promise<void> {
    removeMcpServerFromJson(path.join(this.configDir, 'mcp.json'), name);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const p = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(p)) return false;
    try { const c = JSON.parse(fs.readFileSync(p, 'utf-8')); const e = c?.mcpServers?.[name]; if (!e?.args) return false; return servedPathMatches(e.args[e.args.length - 1], expectedServerPath); } catch { return false; }
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' { return 'flag'; }
  getSkillDirectories(): string[] { return [path.join(this.configDir, 'skills'), path.join(os.homedir(), '.agents', 'skills')]; }

  getInstalledSkills(): string[] {
    const skills = new Set<string>();
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory() || e.isSymbolicLink()) skills.add(e.name); } } catch { /* ignore */ } }
    }
    return Array.from(skills);
  }

  supportsSkills(): boolean { return true; }
  getMemoryBasePath(): string { return path.join(this.configDir, 'projects'); }
  getAddDirFlag(): string { return '--add-dir'; }
}
