import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ScheduledCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { orchestratorToolFlags, promptOperand, effortFlag, resumeFlags } from './cli-provider';
import { DATA_DIR } from '../constants';
import { updateSharedJsonSync } from '../utils/shared-file';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';

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
    if (params.permissionMode === 'normal') {
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
      const escaped = params.secondaryProjectPath.replace(/'/g, "'\\''");
      command += ` --add-dir '${escaped}'`;
    }

    // The template's folders: added to what the CLI may reach, with whatever
    // the agent's permission mode allows there, reading and writing alike.
    if (params.obsidianVaultPaths) {
      for (const vp of params.obsidianVaultPaths) {
        if (fs.existsSync(vp)) {
          const escaped = vp.replace(/'/g, "'\\''");
          command += ` --add-dir '${escaped}'`;
        }
      }
    }

    // Tars's CLAUDE.md via ~/.dorothy
    command += ` --add-dir '${DATA_DIR}'`;

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
    let command = `"${params.binaryPath}"`;

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
      command += ` --mcp-config "${params.mcpConfigPath}"`;
    }

    command += ` --add-dir "${DATA_DIR}"`;

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

      let updated = false;

      for (const { type, file, matcher } of hookFiles) {
        const commandPath = path.join(hooksDir, file);
        if (!fs.existsSync(commandPath)) continue;

        const existing: HookEntry[] = settings.hooks[type] || [];
        const entryIndex = existing.findIndex((h: HookEntry) =>
          h.hooks?.some((hh: { command?: string }) => hh.command?.includes(file))
        );

        if (entryIndex >= 0) {
          const entry: HookEntry = existing[entryIndex];
          const hookIndex = entry.hooks.findIndex((hh: { command?: string }) => hh.command?.includes(file));
          if (hookIndex >= 0 && entry.hooks[hookIndex].command !== commandPath) {
            entry.hooks[hookIndex].command = commandPath;
            updated = true;
          }
        } else {
          const hookConfig: { matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> } = {
            hooks: [{ type: 'command', command: commandPath, timeout: 30 }]
          };
          if (matcher) hookConfig.matcher = matcher;
          settings.hooks[type] = [...existing, hookConfig];
          updated = true;
        }
      }

      return updated ? settings : undefined;
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
      execFileSync('claude', ['mcp', 'add', '-s', 'user', name, command, ...args], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`[claude] Registered MCP server ${name} via claude mcp add`);
      return;
    } catch {
      // Fallback: write to mcp.json
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
      execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      // Ignore if doesn't exist
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
export HOME="${params.homeDir}"

if [ -s "${params.homeDir}/.nvm/nvm.sh" ]; then
  source "${params.homeDir}/.nvm/nvm.sh" 2>/dev/null || true
fi

if [ -f "${params.homeDir}/.bashrc" ]; then
  source "${params.homeDir}/.bashrc" 2>/dev/null || true
elif [ -f "${params.homeDir}/.bash_profile" ]; then
  source "${params.homeDir}/.bash_profile" 2>/dev/null || true
elif [ -f "${params.homeDir}/.zshrc" ]; then
  source "${params.homeDir}/.zshrc" 2>/dev/null || true
fi

export PATH="${params.binaryDir}:$PATH"
cd "${params.projectPath}"
echo "=== Task started at $(date) ===" >> "${params.logPath}"
unset CLAUDECODE
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 "${params.binaryPath}" ${flags} --output-format stream-json --verbose --mcp-config "${params.mcpConfigPath}" --add-dir "${DATA_DIR}" -p '${promptWithSkills}' >> "${params.logPath}" 2>&1
echo "=== Task completed at $(date) ===" >> "${params.logPath}"
`;
  }
}
