import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execCliSync, cliFailureText, CliNotRunnableError } from './cli-exec';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ScheduledCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { orchestratorToolFlags, promptOperand, effortFlag, resumeFlags, shellQuote } from './cli-provider';
import { DATA_DIR } from '../constants';
import { updateSharedJsonSync } from '../utils/shared-file';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';
import { mergeNodeHooks, legacyShCommand } from '../utils/hook-command';

export class ClaudeProvider implements CLIProvider {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    return [
      { id: 'default', name: 'Default', description: 'Recommended' },
      { id: 'sonnet', name: 'Sonnet', description: 'Daily coding' },
      { id: 'opus', name: 'Opus', description: 'Complex reasoning' },
      { id: 'haiku', name: 'Haiku', description: 'Fast & efficient' },
      { id: 'sonnet[1m]', name: 'Sonnet 1M', description: '1M context window' },
      { id: 'opusplan', name: 'Opus Plan', description: 'Extended thinking' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.claude || 'claude';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // MCP config
    if (params.mcpConfigPath && fs.existsSync(params.mcpConfigPath)) {
      command += ` --mcp-config '${params.mcpConfigPath.replace(/'/g, "'\\''")}'`;
    }

    // System prompt file (Super Agent instructions)
    if (params.systemPromptFile && fs.existsSync(params.systemPromptFile)) {
      command += ` --append-system-prompt-file '${params.systemPromptFile.replace(/'/g, "'\\''")}'`;
    }

    command += resumeFlags(params.resumeSessionId, params.forkSession);

    // Model
    if (params.model) {
      if (!/^[a-zA-Z0-9._:\/\[\]-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    // Verbose
    if (params.verbose) {
      command += ' --verbose';
    }

    // Permission mode
    if (params.permissionMode === 'plan') {
      command += ' --permission-mode plan';
    } else if (params.permissionMode === 'normal') {
      command += ' --permission-mode default';
    } else if (params.permissionMode === 'auto') {
      command += ' --permission-mode auto';
    } else if (params.permissionMode === 'bypass') {
      command += ' --dangerously-skip-permissions';
    }

    // Orchestrator mode. The list lives in cli-provider.ts so this and the
    // thirteen providers that re-point the same binary cannot drift apart:
    // they had, and none of them restricted anything at all.
    command += orchestratorToolFlags(params.orchestratorMode);

    // Effort level
    command += effortFlag(params.effort);

    // Chrome browser sharing (uses the user's logged-in Chrome via claude-in-chrome extension)
    if (params.chrome) {
      command += ' --chrome';
    }

    // Secondary project
    if (params.secondaryProjectPath) {
      command += ` --add-dir ${shellQuote(params.secondaryProjectPath)}`;
    }

    // The template's folders: added to what the CLI may reach, with whatever
    // the agent's permission mode allows there, reading and writing alike.
    if (params.obsidianVaultPaths) {
      for (const vp of params.obsidianVaultPaths) {
        if (fs.existsSync(vp)) {
          command += ` --add-dir ${shellQuote(vp)}`;
        }
      }
    }

    // Tars's CLAUDE.md via ~/.dorothy
    command += ` --add-dir ${shellQuote(DATA_DIR)}`;

    // Prompt with skills directive, and no operand at all without a task.
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

    if (params.model) {
      command += ` --model ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` '${escaped}'`;

    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, _appSettings?: AppSettings): Record<string, string> {
    return {
      CLAUDE_SKILLS: (skills ?? []).join(','),
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
    };
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

  async configureHooks(hooksDir: string): Promise<void> {
    const settingsPath = path.join(this.configDir, 'settings.json');

    type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };
    type Settings = { hooks?: Record<string, HookEntry[]>; [key: string]: unknown };

    const hookFiles = [
      { type: 'PostToolUse', file: 'post-tool-use.sh', matcher: '*' },
      { type: 'Stop', file: 'on-stop.sh', matcher: undefined },
      // A turn that ends on an API error fires this instead of Stop, and with no
      // listener the agent stayed `running` for good. See the script.
      { type: 'StopFailure', file: 'stop-failure.sh', matcher: undefined },
      { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
      { type: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
      { type: 'Notification', file: 'notification.sh', matcher: '*' },
      { type: 'PermissionRequest', file: 'permission-request.sh', matcher: undefined },
      { type: 'TaskCompleted', file: 'task-completed.sh', matcher: undefined },
      { type: 'UserPromptSubmit', file: 'user-prompt-submit.sh', matcher: undefined },
    ];

    // Every claude binary reads this file when it starts, and Claude Code
    // writes it too, so it is changed through updateSharedJsonSync: never in
    // place, with its mode kept, and not written when every hook is already
    // there. A file that is not JSON is left as it is. It was replaced by the
    // hooks alone, which took every other setting in it.
    const outcome = updateSharedJsonSync<Settings>(settingsPath, current => {
      const settings: Settings = current ?? {};
      if (!settings.hooks) {
        settings.hooks = {};
      }

      // The Node runner on every platform: no bash, jq or curl (see hook-command.ts).
      const specs = hookFiles.map(({ type, file, matcher }) => ({
        type, matcher, event: file.replace(/\.sh$/, ''), isLegacy: legacyShCommand(file, this.configDir, hooksDir),
      }));
      return mergeNodeHooks(settings.hooks, specs, hooksDir, 30) ? settings : undefined;
    }, { createMode: 0o644 });

    if (outcome === 'written') {
      console.log('Claude hooks configured/updated in', settingsPath);
    } else if (outcome === 'unchanged') {
      console.log('Claude hooks already configured');
    } else if (outcome === 'unreadable') {
      console.warn(`Claude hooks not configured: ${settingsPath} is not valid JSON, left untouched`);
    } else {
      console.warn(`Claude hooks not configured: ${settingsPath} kept changing`);
    }
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    // Try claude mcp add -s user first
    try {
      // execFileSync passes argv as a structured array, so name/command/args are
      // never seen by a shell. The previous form wrapped each arg in double
      // quotes and handed the whole line to execSync (/bin/sh -c), where
      // $(...) and backticks inside an argument are still expanded - and one of
      // those args is `tasmaniaServerPath` straight out of app-settings.json.
      // execCliSync resolves the name first: on Windows claude is an npm
      // claude.cmd or a claude.exe, and a bare name finds only the latter.
      execCliSync('claude', ['mcp', 'add', '-s', 'user', name, command, ...args], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`[claude] Registered MCP server ${name} via claude mcp add`);
      return;
    } catch (err) {
      // Fallback: write to mcp.json, and say why rather than swallow it.
      console.warn(`[claude] claude mcp add failed (${cliFailureText(err)}), writing mcp.json instead`);
    }

    // Through addMcpServerToJson, which every writer of this file shares: it
    // fails on a file that is not JSON rather than replacing it.
    addMcpServerToJson(path.join(this.configDir, 'mcp.json'), name, { command, args });
    console.log(`[claude] Registered MCP server ${name} via mcp.json fallback`);
  }

  async removeMcpServer(name: string): Promise<void> {
    // Try claude mcp remove -s user
    try {
      // execFileSync, for the same reason the add path above uses it: a shell
      // string here would expand $(...) and backticks inside the name. The add
      // path was fixed and its sibling a few lines below was not, which is the
      // whole shape of this bug class.
      execCliSync('claude', ['mcp', 'remove', '-s', 'user', name], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      // A server that is not registered fails here, which is fine. A claude
      // that cannot be started is said.
      if (err instanceof CliNotRunnableError) console.warn(`[claude] claude mcp remove not run: ${err.message}`);
    }

    // Also clean mcp.json. Nothing is written when the server is not there.
    try {
      removeMcpServerFromJson(path.join(this.configDir, 'mcp.json'), name);
    } catch (err) {
      console.warn(`[claude] ${name} not removed from mcp.json:`, err);
    }
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    // The happy path writes through `claude mcp add -s user`, which lands in
    // ~/.claude.json - checking only ~/.claude/mcp.json meant this always
    // answered false and every server was re-registered, by spawning the CLI,
    // once per claude-family provider on every single boot.
    const candidates = [
      path.join(os.homedir(), '.claude.json'),
      path.join(this.configDir, 'mcp.json'),
    ];

    for (const configPath of candidates) {
      if (!fs.existsSync(configPath)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const existing = config?.mcpServers?.[name];
        if (!existing?.args?.length) continue;
        if (existing.args[existing.args.length - 1] === expectedServerPath) return true;
      } catch {
        // try the next candidate
      }
    }
    return false;
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

    // Scan skill directories for subdirectory names
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              skills.add(entry.name);
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // Also read enabledPlugins keys from settings.json (skills are stored as "name@source")
    const settingsPath = path.join(this.configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.enabledPlugins) {
          for (const key of Object.keys(settings.enabledPlugins)) {
            if (settings.enabledPlugins[key]) {
              skills.add(key.split('@')[0]);
            }
          }
        }
      } catch {
        // Ignore parse errors
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

# Source shell profile for proper PATH (nvm, homebrew, etc.)
export HOME=${shellQuote(params.homeDir)}

if [ -s ${shellQuote(params.homeDir)}/.nvm/nvm.sh ]; then
  source ${shellQuote(params.homeDir)}/.nvm/nvm.sh 2>/dev/null || true
fi

if [ -f ${shellQuote(params.homeDir)}/.bashrc ]; then
  source ${shellQuote(params.homeDir)}/.bashrc 2>/dev/null || true
elif [ -f ${shellQuote(params.homeDir)}/.bash_profile ]; then
  source ${shellQuote(params.homeDir)}/.bash_profile 2>/dev/null || true
elif [ -f ${shellQuote(params.homeDir)}/.zshrc ]; then
  source ${shellQuote(params.homeDir)}/.zshrc 2>/dev/null || true
fi

export PATH=${shellQuote(params.binaryDir)}:"$PATH"
cd ${shellQuote(params.projectPath)}
echo "=== Task started at $(date) ===" >> ${shellQuote(params.logPath)}
unset CLAUDECODE
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 ${shellQuote(params.binaryPath)} ${flags} --output-format stream-json --verbose --mcp-config ${shellQuote(params.mcpConfigPath)} --add-dir ${shellQuote(DATA_DIR)} -p ${shellQuote(promptWithSkills)} >> ${shellQuote(params.logPath)} 2>&1
echo "=== Task completed at $(date) ===" >> ${shellQuote(params.logPath)}
`;
  }
}
