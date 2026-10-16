import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execCliSync, cliFailureText, CliNotRunnableError } from './cli-exec';
import type { AppSettings } from '../types';
import { DATA_DIR } from '../constants';
import { configureGeminiNodeHooks } from '../utils/gemini-node-hooks';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ScheduledCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { shellQuote } from './cli-provider';

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

    // Gemini has no documented skip-permissions flag

    // Secondary project (Gemini uses --include-directories)
    if (params.secondaryProjectPath) {
      command += ` --include-directories ${shellQuote(params.secondaryProjectPath)}`;
    }

    // The template's folders: added to what the CLI may reach, with whatever
    // the agent's permission mode allows there, reading and writing alike.
    if (params.obsidianVaultPaths) {
      for (const vp of params.obsidianVaultPaths) {
        if (fs.existsSync(vp)) {
          command += ` --include-directories ${shellQuote(vp)}`;
        }
      }
    }

    // Include Tars directory
    command += ` --include-directories ${shellQuote(DATA_DIR)}`;

    // Prompt with skills directive
    let finalPrompt = params.prompt;
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      const skillsList = params.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }

    if (finalPrompt) {
      const escaped = finalPrompt.replace(/'/g, "'\\''");
      command += ` '${escaped}'`;
    }

    return command;
  }

  buildScheduledCommand(params: ScheduledCommandParams): string {
    let command = shellQuote(params.binaryPath);

    // Gemini has no skip-permissions flag

    if (params.outputFormat) {
      command += ` --output-format ${params.outputFormat}`;
    }

    if (params.verbose) {
      command += ' --debug';
    }

    command += ` --include-directories ${shellQuote(DATA_DIR)}`;

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` -p '${escaped}'`;

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

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, _appSettings?: AppSettings): Record<string, string> {
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

  async configureHooks(hooksDir: string): Promise<void> {
    const geminiHooksDir = path.join(hooksDir, 'gemini');
    if (!fs.existsSync(geminiHooksDir)) {
      console.log('Gemini hooks directory not found at', geminiHooksDir);
      return;
    }
    // The Node runner on every platform, on Gemini's own events (see hook-command.ts and gemini-node-hooks.ts).
    configureGeminiNodeHooks(this.configDir, hooksDir);
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
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
      return existing.args[existing.args.length - 1] === expectedServerPath;
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
${shellQuote(params.binaryPath)} --output-format stream-json --debug --include-directories ${shellQuote(DATA_DIR)} -p ${shellQuote(promptWithSkills)} >> ${shellQuote(params.logPath)} 2>&1
echo "=== Task completed at $(date) ===" >> ${shellQuote(params.logPath)}
`;
  }
}
