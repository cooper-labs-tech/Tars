import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execCliSync, cliFailureText, CliNotRunnableError } from './cli-exec';
import type { AppSettings } from '../types';
import { keyEnvFor } from '../services/cli-keys';
import { updateSharedTextSync } from '../utils/shared-file';
import { removeTomlTable } from '../utils/toml-tables';
import { parse as parseToml } from 'smol-toml';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { safeEffort } from './cli-provider';

/**
 * Provider for xAI's Grok CLI ("Grok Build", https://x.ai/cli).
 *
 * Install:  curl -fsSL https://x.ai/cli/install.sh | bash
 *           (installs to ~/.grok/bin/grok, also symlinked into ~/.local/bin)
 * Binary:   `grok`
 * Auth:     `grok login` (interactive) or the GROK_DEPLOYMENT_KEY env var;
 *           credentials are cached in ~/.grok/auth.json.
 * Config:   ~/.grok/config.toml (TOML: MCP servers under [mcp_servers.<name>]).
 *
 * Flags verified against grok 0.2.64:
 *   Interactive:  grok [-m <model>] [--permission-mode <mode>] [--effort <lvl>] [--debug] "<prompt>"
 *   Headless:     grok -p "<prompt>" [--output-format plain|json|streaming-json]
 *   Models:       grok models            (default model: grok-build)
 *   MCP:          grok mcp add <name> <command> -- <args> | grok mcp remove <name> | grok mcp list
 *
 * Grok's CLI semantics closely mirror Claude Code / Codex, so MCP handling
 * follows the Codex provider (config.toml with [mcp_servers.<name>] sections).
 * Note: Grok has no `--add-dir`/multi-root flag, so secondary-project and
 * Obsidian-vault mounting are intentionally not emitted.
 */
export class GrokProvider implements CLIProvider {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok CLI';
  readonly binaryName = 'grok';
  readonly configDir = path.join(os.homedir(), '.grok');

  getModels(): ProviderModel[] {
    // IDs from `grok models` (authenticated). The available set is
    // account-dependent; these are isolated here for easy updates.
    return [
      { id: 'grok-composer-2.5-fast', name: 'Grok Composer 2.5 Fast', description: 'Recommended (default)' },
      { id: 'grok-build', name: 'Grok Build', description: 'Agentic coding' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.grok || 'grok';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // Model
    if (params.model) {
      if (!/^[a-zA-Z0-9._:/-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` -m '${params.model}'`;
    }

    // Permission mode → Grok's Claude-Code-aligned --permission-mode.
    // (normal keeps Grok's default plan-mode gate; no flag emitted.)
    if (params.permissionMode === 'auto') {
      command += ' --permission-mode auto';
    } else if (params.permissionMode === 'bypass') {
      command += ' --permission-mode bypassPermissions';
    }

    // Reasoning effort (Grok accepts low|medium|high|xhigh|max).
    if (safeEffort(params.effort) && params.effort !== 'medium') {
      command += ` --effort ${safeEffort(params.effort)}`;
    }

    // Verbose → debug logging.
    if (params.verbose) {
      command += ' --debug';
    }

    // Prompt (positional) with optional skills directive.
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      const skillsList = params.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }

    if (finalPrompt) {
      const escaped = finalPrompt.replace(/'/g, "'\\''");
      command += ` '${escaped}'`;
    }

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // Model must precede -p, since -p/--single consumes the next token as the prompt.
    if (params.model) {
      if (!/^[a-zA-Z0-9._:/-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` -m '${params.model}'`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` -p '${escaped}'`;

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
      // Its API key from Settings, under the variable it reads (services/cli-keys.ts).
      ...keyEnvFor('grok', appSettings),
    };
  }

  getEnvVarsToDelete(): string[] {
    // Grok doesn't have a known nested-session env var yet.
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.toml'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    // Grok CLI hook payload format is not yet documented for the public beta.
    // Fall back to exit-code based status detection, like the Codex provider.
    console.log('Grok CLI: native hooks not wired yet, using exit-code based status detection');
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    // Try `grok mcp add` first: `grok mcp add <name> <command> -- <args...>`.
    // execFileSync passes argv as a structured array, so name/command/args are
    // never interpreted by a shell (no command injection).
    try {
      // execCliSync resolves the name first (a grok.exe or an npm grok.cmd on Windows).
      execCliSync('grok', ['mcp', 'add', name, command, '--', ...args], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`[grok] Registered MCP server ${name} via grok mcp add`);
      return;
    } catch (err) {
      // Fallback: write to config.toml manually, and say why.
      console.warn(`[grok] grok mcp add failed (${cliFailureText(err)}), writing config.toml instead`);
    }

    const configPath = path.join(this.configDir, 'config.toml');
    const sectionKey = this.escapeTomlKey(name);
    const argsToml = args.map(a => this.tomlString(a)).join(', ');
    const section = `\n[mcp_servers.${sectionKey}]\ncommand = ${this.tomlString(command)}\nargs = [${argsToml}]\nenabled = true\n`;
    // Its section taken out first, then added at the end; written whole, parsed, never left broken.
    const outcome = updateSharedTextSync(configPath, current =>
      removeTomlTable(current ?? '', `mcp_servers.${sectionKey}`).trimEnd() + '\n' + section, { parse: parseToml });
    if (outcome === 'refused') throw new Error(`${configPath} would not parse with ${name} in it (or did not already): left as it was`);
    if (outcome === 'busy') throw new Error(`${configPath} kept changing: ${name} not registered`);
    console.log(`[grok] Registered MCP server ${name} in config.toml (fallback)`);
  }

  async removeMcpServer(name: string): Promise<void> {
    // Try `grok mcp remove` first. execFileSync avoids shell interpolation.
    try {
      execCliSync('grok', ['mcp', 'remove', name], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      // Not registered is fine; a grok that cannot be started is said.
      if (err instanceof CliNotRunnableError) console.warn(`[grok] grok mcp remove not run: ${err.message}`);
    }

    // Also clean the config.toml fallback.
    const configPath = path.join(this.configDir, 'config.toml');
    if (!fs.existsSync(configPath)) return;

    const outcome = updateSharedTextSync(configPath, current =>
      (current === undefined ? undefined : removeTomlTable(current, `mcp_servers.${this.escapeTomlKey(name)}`)), { parse: parseToml });
    if (outcome === 'written') console.log(`[grok] Removed MCP server ${name} from config.toml`);
    else if (outcome !== 'unchanged') console.warn(`[grok] ${name} left in ${configPath}: ${outcome === 'refused' ? 'the file would not parse without it, or did not already' : 'the file kept changing'}`);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const configPath = path.join(this.configDir, 'config.toml');
    if (!fs.existsSync(configPath)) return false;
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const sectionKey = this.escapeTomlKey(name);
      const escapedKey = sectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Extract only this server's [mcp_servers.<name>] block so a path that
      // belongs to a *different* server section can't produce a false match.
      const sectionRegex = new RegExp(`(?:^|\\n)\\[mcp_servers\\.${escapedKey}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`);
      const section = content.match(sectionRegex)?.[0];
      // The path as written, escaped by tomlString: a Windows path reads back
      // with its backslashes doubled, and was re-registered on every boot.
      return Boolean(section?.includes(expectedServerPath) || section?.includes(this.tomlString(expectedServerPath).slice(1, -1)));
    } catch {
      return false;
    }
  }

  private escapeTomlKey(key: string): string {
    // TOML keys with dots or special chars need quoting; use full TOML string
    // escaping so backslashes/quotes in the key can't break the header.
    if (/[^a-zA-Z0-9_-]/.test(key)) {
      return this.tomlString(key);
    }
    return key;
  }

  /**
   * POSIX single-quote shell escaping. Wrapping a value in single quotes and
   * replacing embedded quotes with '\'' makes it inert to spaces, $(), backticks,
   * and other metacharacters when interpolated into a generated shell command.
   */
  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Serialize a value as a TOML basic string. JSON string escaping is a valid
   * superset for the common cases (backslashes, double quotes, control chars),
   * preventing Windows paths like C:\Users\me"x.js from producing invalid TOML.
   */
  private tomlString(value: string): string {
    return JSON.stringify(value);
  }

  getSkillDirectories(): string[] {
    return [
      path.join(this.configDir, 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ];
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
          // Ignore read errors.
        }
      }
    }
    return skills;
  }

  supportsSkills(): boolean {
    return true;
  }

  getMemoryBasePath(): string {
    // Grok supports cross-session memory; config/memory live under ~/.grok.
    return this.configDir;
  }

  getAddDirFlag(): string {
    // Grok has no --add-dir / multi-root flag.
    return '';
  }
}
