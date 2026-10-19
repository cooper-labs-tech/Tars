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
import { DATA_DIR, GITHUB_REPO } from '../constants';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'; // claude appends /v1/messages

export class OpenRouterProvider implements CLIProvider {
  readonly id = 'openrouter' as const;
  readonly displayName = 'OpenRouter';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    return [
      // DeepSeek
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', description: 'Reasoning • DeepSeek' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', description: 'Chat • DeepSeek' },
      // Moonshot / Kimi
      { id: 'moonshotai/kimi-k2', name: 'Kimi K2', description: 'Agentic • MoonshotAI' },
      // Xiaomi MiMo
      { id: 'xiaomi/mimo-v2-pro', name: 'MiMo V2 Pro', description: 'Agentic • Xiaomi' },
      // Alibaba Qwen
      { id: 'qwen/qwq-32b', name: 'QwQ 32B', description: 'Reasoning • Alibaba' },
      { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', description: 'Instruct • Alibaba' },
      // OpenAI
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', description: 'Flagship • OpenAI' },
      { id: 'openai/o4-mini', name: 'o4 mini', description: 'Reasoning • OpenAI' },
      // Google
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Flagship • Google' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast • Google' },
      // Meta
      { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', description: 'Open • Meta' },
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

    if (params.verbose) {
      command += ' --verbose';
    }

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
      const skillsList = params.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }

    command += promptOperand(finalPrompt);

    return command;
  }

  buildScheduledCommand(params: ScheduledCommandParams): string {
    let command = shellQuote(params.binaryPath);

    if (params.autonomous) {
      command += ' --dangerously-skip-permissions';
    }

    if (params.outputFormat) {
      command += ` --output-format ${params.outputFormat}`;
    }

    if (params.verbose) {
      command += ' --verbose';
    }

    if (params.mcpConfigPath) {
      command += ` --mcp-config ${shellQuote(params.mcpConfigPath)}`;
    }

    command += ` --add-dir ${shellQuote(DATA_DIR)}`;

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` -p '${escaped}'`;

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    command += ' -p';

    if (params.model && params.model !== 'default') {
      command += ` --model ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` '${escaped}'`;

    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    const vars: Record<string, string> = {
      CLAUDE_SKILLS: (skills ?? []).join(','),
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
    };

    const apiKey = appSettings?.openRouterApiKey;
    if (apiKey) {
      Object.assign(vars, keyProviderEnv(OPENROUTER_BASE_URL, apiKey));
      // OpenRouter HTTP-Referer header (optional but recommended). The
      // repository, which the project owns: it said https://tars.app, a domain
      // it does not, and OpenRouter credits traffic to that name.
      vars.OR_SITE_URL = `https://github.com/${GITHUB_REPO}`;
      vars.OR_APP_NAME = 'Tars';
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

  async configureHooks(_hooksDir: string): Promise<void> {
    // OpenRouter uses the same Claude CLI, so hooks work normally
  }

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
    } catch {
      return false;
    }
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'flag';
  }

  getSkillDirectories(): string[] {
    return [
      path.join(this.configDir, 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ];
  }

  getInstalledSkills(): string[] {
    const skills = new Set<string>();
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              skills.add(entry.name);
            }
          }
        } catch { /* ignore */ }
      }
    }
    return Array.from(skills);
  }

  supportsSkills(): boolean {
    return true;
  }

  getMemoryBasePath(): string {
    return path.join(this.configDir, 'projects');
  }

  getAddDirFlag(): string {
    return '--add-dir';
  }

  buildScheduledScript(params: {
    binaryPath: string;
    binaryDir: string;
    projectPath: string;
    prompt: string;
    autonomous: boolean;
    mcpConfigPath: string;
    logPath: string;
    homeDir: string;
    skills?: string[];
  }): string {
    const flags = params.autonomous ? '--dangerously-skip-permissions' : '';
    const promptWithSkills = (params.skills && params.skills.length > 0)
      ? `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`
      : params.prompt;

    return `#!/bin/bash

export HOME=${shellQuote(params.homeDir)}

if [ -s ${shellQuote(params.homeDir)}/.nvm/nvm.sh ]; then
  source ${shellQuote(params.homeDir)}/.nvm/nvm.sh 2>/dev/null || true
fi

if [ -f ${shellQuote(params.homeDir)}/.zshrc ]; then
  source ${shellQuote(params.homeDir)}/.zshrc 2>/dev/null || true
elif [ -f ${shellQuote(params.homeDir)}/.bash_profile ]; then
  source ${shellQuote(params.homeDir)}/.bash_profile 2>/dev/null || true
fi

export PATH=${shellQuote(params.binaryDir)}:"$PATH"
cd ${shellQuote(params.projectPath)}
echo "=== Task started at $(date) ===" >> ${shellQuote(params.logPath)}
unset CLAUDECODE
export CLAUDE_PROVIDER="openrouter"
${scheduledKeyExports('https://openrouter.ai/api', 'openRouterApiKey', params.logPath)}${shellQuote(params.binaryPath)} ${flags} --output-format stream-json --verbose --mcp-config ${shellQuote(params.mcpConfigPath)} --add-dir ${shellQuote(DATA_DIR)} -p ${shellQuote(promptWithSkills)} >> ${shellQuote(params.logPath)} 2>&1
echo "=== Task completed at $(date) ===" >> ${shellQuote(params.logPath)}
`;
  }
}
