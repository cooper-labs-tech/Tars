import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execCliSync, cliFailureText, CliNotRunnableError } from './cli-exec';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { orchestratorToolFlags, promptOperand, effortFlag, resumeFlags, shellQuote } from './cli-provider';
import { DATA_DIR } from '../constants';
import { handedSecondaryFolder } from '../utils/handed-folder';
import { updateSharedJsonSync } from '../utils/shared-file';
import { addMcpServerToJson, removeMcpServerFromJson } from '../utils/mcp-json';
import { isTarsBundleEntry } from '../services/mcp-roles';
import { usesNodeHooks, mergeNodeHooks, legacyShCommand } from '../utils/hook-command';

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

    // Secondary project, never ~/.tars-private (utils/handed-folder.ts)
    const secondary = handedSecondaryFolder(params.secondaryProjectPath);
    if (secondary) {
      command += ` --add-dir ${shellQuote(secondary)}`;
    }

    // The template's folders: added to what the CLI may reach, with whatever
    // the agent's permission mode allows there, reading and writing alike.
    if (params.obsidianVaultPaths) {
      for (const vp of params.obsidianVaultPaths) {
        // Read back from agents.json or templates.json, which any agent can write: never ~/.tars-private.
        if (handedSecondaryFolder(vp) && fs.existsSync(vp)) {
          command += ` --add-dir ${shellQuote(vp)}`;
        }
      }
    }

    // Tars's CLAUDE.md via ~/.tars
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

  async configureHooks(hooksDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
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

      // Windows: the Node runner, not the .sh, which cannot run there (see hook-command.ts).
      if (usesNodeHooks(platform)) {
        const specs = hookFiles.map(({ type, file, matcher }) => ({
          type, matcher, event: file.replace(/\.sh$/, ''), isLegacy: legacyShCommand(file, this.configDir, hooksDir),
        }));
        return mergeNodeHooks(settings.hooks, specs, hooksDir, 30) ? settings : undefined;
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

  /**
   * Into Tars's own file only, `~/.claude/mcp.json`, which an agent gets through --mcp-config by its role
   * (services/mcp-roles.ts, 2.0.5): Claude Code loads its user scope (`~/.claude.json`) for every session
   * whatever --mcp-config says, so a server registered there (`claude mcp add -s user`, until 2.0.5) reached
   * every worker. One Tars left there (isTarsBundleEntry: one of the seven, running its Tars bundle) is taken
   * out, through the CLI, which owns that file and rewrites it all the time. Nothing else in it is touched: a
   * server of the owner's under a name Tars registers stays, and that is said once.
   */
  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    const theirs = this.userScopeEntry(name);
    if (theirs !== undefined && !isTarsBundleEntry(name, theirs) && !this.ownersSaid.has(name)) {
      this.ownersSaid.add(name);
      console.log(`[claude] ${name} in Claude Code's user scope is not Tars's own (it runs something else): left there, and Tars's copy goes in ${path.join(this.configDir, 'mcp.json')}`);
    }
    if (this.tarsInUserScope(name)) {
      try {
        // argv, never a shell (execCliSync): a name never reaches one.
        execCliSync('claude', ['mcp', 'remove', '-s', 'user', name], { encoding: 'utf-8', stdio: 'pipe' });
        console.log(`[claude] ${name} taken out of Claude Code's user scope: agents get it by their role`);
      } catch (err) {
        console.warn(`[claude] ${name} could not be taken out of Claude Code's user scope (${cliFailureText(err)}): every session still loads it there`);
      }
    }
    // Through addMcpServerToJson, which every writer of this file shares: it
    // fails on a file that is not JSON rather than replacing it.
    addMcpServerToJson(path.join(this.configDir, 'mcp.json'), name, { command, args });
    console.log(`[claude] Registered MCP server ${name} in ${path.join(this.configDir, 'mcp.json')}`);
  }

  /** The servers of the owner's under a name Tars registers, said once each. */
  private readonly ownersSaid = new Set<string>();

  /** This server's entry in Claude Code's user scope (`~/.claude.json`), or undefined. */
  private userScopeEntry(name: string): unknown {
    try {
      const servers = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'))?.mcpServers;
      return servers && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether Claude Code's user scope holds Tars's own entry for this server (isTarsBundleEntry). */
  private tarsInUserScope(name: string): boolean {
    return isTarsBundleEntry(name, this.userScopeEntry(name));
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

  /**
   * In Tars's own file with this path, and Tars's own entry no longer in Claude Code's user scope: one still there
   * reaches every session, and registering again takes it out (registerMcpServer). A server of the owner's there
   * under the same name does not count: it is never taken out, so it must not keep Tars registering.
   */
  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    if (this.tarsInUserScope(name)) return false;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(this.configDir, 'mcp.json'), 'utf-8'))?.mcpServers?.[name];
      return !!existing?.args?.length && existing.args[existing.args.length - 1] === expectedServerPath;
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
}
