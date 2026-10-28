import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execCliSync, cliFailureText, CliNotRunnableError } from './cli-exec';
import type { AppSettings } from '../types';
import { keyEnvFor } from '../services/cli-keys';
import { DATA_DIR } from '../constants';
import { handedSecondaryFolder } from '../utils/handed-folder';
import { legacyShCommand, usesNodeHooks } from '../utils/hook-command';
import { allowAgentToken, configureGeminiNodeHooks } from '../utils/gemini-node-hooks';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { servedPathMatches, shellQuote } from './cli-provider';
import { geminiRoleArgs } from '../services/mcp-roles';
import { writeSharedJsonSync } from '../utils/shared-file';

export class GeminiProvider implements CLIProvider {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly binaryName = 'gemini';
  readonly configDir = path.join(os.homedir(), '.gemini');

  getModels(): ProviderModel[] {
    return [
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', description: 'Most capable' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', description: 'Fast & capable' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Stable' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Balanced' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.gemini || 'gemini';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // Model (Gemini uses -m flag)
    if (params.model) {
      if (!/^[a-zA-Z0-9._:/-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` -m '${params.model}'`;
    }

    // Debug mode (Gemini equivalent of verbose)
    if (params.verbose) {
      command += ' --debug';
    }

    // A worker's gemini is limited to its servers but the orchestrator's own, Telegram and X
    // (services/mcp-roles.ts; gemini is not installed where this was written: the flag is gemini-cli's documented one).
    const [allowFlag, ...allowed] = geminiRoleArgs(params.orchestratorMode === true, path.join(this.configDir, 'settings.json'));
    if (allowFlag) command += ` ${allowFlag} ${allowed.map(shellQuote).join(' ')}`;

    // Gemini has no documented skip-permissions flag

    // Secondary project (Gemini uses --include-directories), never ~/.tars-private (utils/handed-folder.ts)
    const secondary = handedSecondaryFolder(params.secondaryProjectPath);
    if (secondary) {
      command += ` --include-directories ${shellQuote(secondary)}`;
    }

    // The template's folders: added to what the CLI may reach, with whatever
    // the agent's permission mode allows there, reading and writing alike.
    if (params.obsidianVaultPaths) {
      for (const vp of params.obsidianVaultPaths) {
        // Read back from agents.json or templates.json, which any agent can write: never ~/.tars-private.
        if (handedSecondaryFolder(vp) && fs.existsSync(vp)) {
          command += ` --include-directories ${shellQuote(vp)}`;
        }
      }
    }

    // Include Tars directory
    command += ` --include-directories ${shellQuote(DATA_DIR)}`;

    // Prompt with skills directive
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      const skillsList = params.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }

    if (finalPrompt) {
      const escaped = finalPrompt.replace(/'/g, "'\\''");
      // -i/--prompt-interactive: the task, then the session stays (0.64
      // --help). A bare query ran one-shot and exited on releases before 0.64.
      command += ` -i '${escaped}'`;
    }

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    command += ' -p';

    if (params.model) {
      command += ` -m ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` '${escaped}'`;

    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      // The orchestrator MCP and the hooks both read the CLAUDE_ names. Without
      // them the agent has no identity, so whoami fails and list_agents falls
      // back to every project's agents instead of its own.
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      // Its API key from Settings, under the variable it reads (services/cli-keys.ts).
      ...keyEnvFor('gemini', appSettings),
    };
  }

  getEnvVarsToDelete(): string[] {
    // Gemini doesn't have a known nested session env var
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'settings.json'),
    };
  }

  async configureHooks(hooksDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
    const geminiHooksDir = path.join(hooksDir, 'gemini');
    if (!fs.existsSync(geminiHooksDir)) {
      console.log('Gemini hooks directory not found at', geminiHooksDir);
      return;
    }
    // Windows: the Node runner, not the .sh, which cannot run there (see hook-command.ts).
    if (usesNodeHooks(platform)) {
      configureGeminiNodeHooks(this.configDir, hooksDir);
      return;
    }

    const settingsPath = path.join(this.configDir, 'settings.json');

    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    let settings: {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
      [key: string]: unknown;
    } = {};

    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        settings = {};
      }
    }

    if (!settings.hooks) {
      settings.hooks = {};
    }

    const hookFiles = [
      { type: 'AfterTool', file: 'post-tool-use.sh', matcher: '*' },
      { type: 'AfterAgent', file: 'on-stop.sh', matcher: undefined },
      { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
      { type: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
      { type: 'Notification', file: 'notification.sh', matcher: '*' },
      // BeforeAgent: Gemini CLI fires no UserPromptSubmit
      // (https://geminicli.com/docs/hooks/), and a Gemini agent read idle while
      // it worked. win32 had moved already (utils/gemini-node-hooks.ts).
      { type: 'BeforeAgent', file: 'user-prompt-submit.sh', matcher: undefined },
    ];

    let updated = false;

    type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

    // The entry an older Tars wrote on UserPromptSubmit goes; the user's own
    // entries in that event stay, and so do another app's of the same name
    // (isTarsHooksFile decides, as on win32).
    const former = settings.hooks.UserPromptSubmit;
    if (Array.isArray(former)) {
      const isOlderTars = legacyShCommand('gemini/user-prompt-submit.sh', this.configDir, hooksDir);
      const kept = former
        .map((entry: HookEntry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hh) => !(typeof hh.command === 'string' && isOlderTars(hh.command))) }))
        .filter((entry: HookEntry) => entry.hooks.length > 0);
      if (kept.length !== former.length || kept.some((entry: HookEntry, i: number) => entry.hooks.length !== former[i].hooks?.length)) {
        if (kept.length) settings.hooks.UserPromptSubmit = kept;
        else delete settings.hooks.UserPromptSubmit;
        updated = true;
      }
    }

    for (const { type, file, matcher } of hookFiles) {
      const commandPath = path.join(geminiHooksDir, file);
      if (!fs.existsSync(commandPath)) continue;

      const existing: HookEntry[] = settings.hooks![type] || [];
      const entryIndex = existing.findIndex((h: HookEntry) =>
        h.hooks?.some((hh: { command?: string }) => hh.command?.includes(`gemini/${file}`))
      );

      if (entryIndex >= 0) {
        const entry: HookEntry = existing[entryIndex];
        const hookIndex = entry.hooks.findIndex((hh: { command?: string }) => hh.command?.includes(`gemini/${file}`));
        if (hookIndex >= 0 && entry.hooks[hookIndex].command !== commandPath) {
          entry.hooks[hookIndex].command = commandPath;
          updated = true;
        }
      } else {
        const hookConfig: { matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> } = {
          hooks: [{ type: 'command', command: commandPath, timeout: 10000 }]
        };
        if (matcher) hookConfig.matcher = matcher;
        settings.hooks![type] = [...existing, hookConfig];
        updated = true;
      }
    }

    // The agent token through Gemini's environment redaction, as on win32.
    if (allowAgentToken(settings)) updated = true;

    if (updated) {
      writeSharedJsonSync(settingsPath, settings);
      console.log('Gemini hooks configured/updated in', settingsPath);
    } else {
      console.log('Gemini hooks already configured');
    }
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    // Try gemini mcp add first (proper CLI registration)
    try {
      // execFileSync passes argv as a structured array, so name/command/args are
      // never seen by a shell. The previous form wrapped each arg in double
      // quotes and handed the whole line to execSync (/bin/sh -c), where
      // $(...) and backticks inside an argument are still expanded - and one of
      // those args is `tasmaniaServerPath` straight out of app-settings.json.
      // execCliSync resolves the name first: on Windows gemini is an npm
      // gemini.cmd, which a bare name never finds.
      execCliSync('gemini', ['mcp', 'add', '-s', 'user', name, command, ...args], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`[gemini] Registered MCP server ${name} via gemini mcp add`);
      return;
    } catch (err) {
      // Fallback: write to settings.json manually, and say why.
      console.warn(`[gemini] gemini mcp add failed (${cliFailureText(err)}), writing settings.json instead`);
    }

    const settingsPath = path.join(this.configDir, 'settings.json');

    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    let settings: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        settings = {};
      }
    }

    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    (settings.mcpServers as Record<string, unknown>)[name] = { command, args };
    writeSharedJsonSync(settingsPath, settings);
    console.log(`[gemini] Registered MCP server ${name} in settings.json (fallback)`);
  }

  async removeMcpServer(name: string): Promise<void> {
    // Try gemini mcp remove first
    try {
      // execFileSync, for the same reason the add path above uses it: a shell
      // string here would expand $(...) and backticks inside the name. The add
      // path was fixed and its sibling a few lines below was not, which is the
      // whole shape of this bug class.
      execCliSync('gemini', ['mcp', 'remove', '-s', 'user', name], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      // Not registered is fine; a gemini that cannot be started is said.
      if (err instanceof CliNotRunnableError) console.warn(`[gemini] gemini mcp remove not run: ${err.message}`);
    }

    // Also clean settings.json fallback
    const settingsPath = path.join(this.configDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings?.mcpServers?.[name]) {
        delete settings.mcpServers[name];
        writeSharedJsonSync(settingsPath, settings);
        console.log(`[gemini] Removed MCP server ${name} from settings.json`);
      }
    } catch {
      // Ignore parse errors
    }
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const settingsPath = path.join(this.configDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) return false;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const existing = settings?.mcpServers?.[name];
      if (!existing?.args) return false;
      return servedPathMatches(existing.args[existing.args.length - 1], expectedServerPath);
    } catch {
      return false;
    }
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
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              skills.push(entry.name);
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }
    return skills;
  }

  supportsSkills(): boolean {
    return true;
  }

  getMemoryBasePath(): string {
    // Gemini may not have a Claude-like memory system; return config dir as placeholder
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '--include-directories';
  }
}
