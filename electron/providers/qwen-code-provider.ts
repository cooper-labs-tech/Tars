import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import { DATA_DIR } from '../constants';
import { handedSecondaryFolder } from '../utils/handed-folder';
import { keyEnvFor } from '../services/cli-keys';
import {
  QWEN_MODEL_ID, QWEN_ORCHESTRATOR_EXCLUDED, qwenApprovalMode, qwenMcpServers, qwenModels, saveQwenHooks,
  setQwenMcpServer, writeQwenAgentSettings,
} from '../services/qwen-code';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
  PtyLaunch,
} from './cli-provider';
import { servedPathMatches, shellQuote } from './cli-provider';

/**
 * Qwen Code (2.0.4): the CLI `qwen`, a Gemini CLI fork, as a CLI of Tars's
 * with everything a claude agent has: a session kept after its first prompt,
 * the user's own models, its effort, permission modes, Tars's MCP servers
 * with the agent's identity, its key, its turns heard through Claude Code's
 * hooks, its answer and tokens read from its transcript, its approvals, its
 * resume. Not the provider `qwen`, which is the Qwen API through the claude
 * binary. What was measured, and how, is in services/qwen-code.ts.
 */
export class QwenCodeProvider implements CLIProvider {
  readonly id = 'qwen-code' as const;
  readonly displayName = 'Qwen Code';
  readonly binaryName = 'qwen';
  readonly configDir = path.join(os.homedir(), '.qwen');

  /** The user's own models (~/.qwen/settings.json modelProviders), read, never written. */
  getModels(): ProviderModel[] {
    return qwenModels();
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.qwencode || 'qwen';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    // Its settings file of Tars's, again for this launch: the effort it runs
    // on now, and the hooks and MCP servers as they are now. The terminal's
    // environment names the file (getPtyEnvVars).
    if (params.agentId) writeQwenAgentSettings(params.agentId, { effort: params.effort });
    let command = shellQuote(params.binaryPath);
    if (params.model) {
      if (!QWEN_MODEL_ID.test(params.model)) throw new Error('Invalid model name');
      command += ` -m ${shellQuote(params.model)}`;
    }
    command += ` --approval-mode ${qwenApprovalMode(params.permissionMode)}`;
    // An orchestrator delegates: its tools that write and its sub-agents are not there.
    if (params.orchestratorMode) command += ` --exclude-tools ${QWEN_ORCHESTRATOR_EXCLUDED.join(' ')}`;
    // The conversation to continue, already checked against its transcript (resume-session.ts).
    if (params.resumeSessionId && /^[0-9a-fA-F-]{36}$/.test(params.resumeSessionId)) {
      command += ` --resume ${shellQuote(params.resumeSessionId)}`;
      if (params.forkSession) command += ' --fork-session';
    }
    // Never ~/.tars-private (utils/handed-folder.ts).
    const secondary = handedSecondaryFolder(params.secondaryProjectPath);
    if (secondary) command += ` --include-directories ${shellQuote(secondary)}`;
    for (const vp of params.obsidianVaultPaths ?? []) {
      if (handedSecondaryFolder(vp) && fs.existsSync(vp)) command += ` --include-directories ${shellQuote(vp)}`;
    }
    command += ` --include-directories ${shellQuote(DATA_DIR)}`;

    // No task, no prompt: a launch without one opens at its prompt.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    // -i/--prompt-interactive: the task, then the session stays (0.25.2). A
    // positional prompt runs one-shot and exits.
    if (finalPrompt) command += ` -i ${shellQuote(finalPrompt)}`;
    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = shellQuote(params.binaryPath);
    if (params.model) {
      if (!QWEN_MODEL_ID.test(params.model)) throw new Error('Invalid model name');
      command += ` -m ${shellQuote(params.model)}`;
    }
    return `${command} ${shellQuote(params.prompt)}`;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings, launch: PtyLaunch = {}): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      // The hooks and the MCP servers read the CLAUDE_ names; qwen hands its
      // whole environment to both (measured), so this is the agent's identity there.
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      // Its API key from Settings, under its model's envKey (services/cli-keys.ts).
      ...keyEnvFor('qwen-code', appSettings, { model: launch.model }),
      // Its settings file of Tars's: hooks, MCP servers, effort, no updater.
      QWEN_CODE_SYSTEM_SETTINGS_PATH: writeQwenAgentSettings(agentId, { effort: launch.effort }),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: true,
      configDir: this.configDir,
      // The hooks live in Tars's settings file for each agent, never in ~/.qwen.
      settingsFile: path.join(DATA_DIR, 'qwen-code', 'hooks.json'),
    };
  }

  async configureHooks(hooksDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
    saveQwenHooks(hooksDir, platform);
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    setQwenMcpServer(name, { command, args });
  }

  async removeMcpServer(name: string): Promise<void> {
    setQwenMcpServer(name, null);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const server = qwenMcpServers()[name];
    return !!server && servedPathMatches(server.args[server.args.length - 1], expectedServerPath);
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  getSkillDirectories(): string[] {
    return [path.join(this.configDir, 'skills')];
  }

  getInstalledSkills(): string[] {
    const skills: string[] = [];
    for (const dir of this.getSkillDirectories()) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) skills.push(entry.name);
        }
      } catch {
        // None.
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
    return '--include-directories';
  }
}
