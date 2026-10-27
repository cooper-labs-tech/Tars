import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execCliSync, cliFailureText, CliNotRunnableError } from './cli-exec';
import type { AppSettings } from '../types';
import { codexKeyConfig, keyEnvFor } from '../services/cli-keys';
import { handedSecondaryFolder } from '../utils/handed-folder';
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
import { readAppSettingsFromDisk, shellQuote } from './cli-provider';
import { CODEX_SESSION_ID, codexAccepts, codexEffortArgs, codexHome, codexPermissionArgs, readCodexFlags, readCodexModels } from './codex-cli';

/**
 * The models of a ChatGPT account as codex-cli 0.163.0 listed them on 2026-10-18, in its order: what Tars offers
 * until codex has written its own list (models_cache.json), which it reads first. gpt-5-codex-mini, offered here
 * before, is refused for a ChatGPT account.
 */
const CODEX_MODELS_FLOOR: ProviderModel[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.' },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Previous generation workhorse model.' },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Older generation workhorse model.' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' },
];

export class CodexProvider implements CLIProvider {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly binaryName = 'codex';
  readonly configDir = codexHome();

  /** The account's models from codex's own list, else the floor above. */
  getModels(): ProviderModel[] {
    const listed = readCodexModels(this.configDir);
    return listed.length > 0 ? listed.map(({ id, name, description }) => ({ id, name, description })) : CODEX_MODELS_FLOOR;
  }

  /** What follows the binary in every builder: the model, then the effort as codex takes it (codex-cli.ts). */
  private modelAndEffort(model: string | undefined, effort: string | undefined): string {
    let args = '';
    if (model) {
      if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) throw new Error('Invalid model name');
      args += ` --model '${model}'`;
    }
    const efforts = codexEffortArgs(effort, model, effort ? readCodexModels(this.configDir) : []);
    return efforts.length ? `${args} ${efforts.join(' ')}` : args;
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.codex || 'codex';
  }

  /**
   * The installed codex's flags, read off the main thread before a launch builds its line (codex-cli.ts): in auto
   * only, the one mode whose flag depends on them.
   */
  async prepareLaunch(binaryPath: string, permissionMode?: string): Promise<void> {
    if (permissionMode === 'auto') await readCodexFlags(binaryPath);
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    // The codex home Tars reads and writes, handed to the codex it starts (the
    // Audit's L4 on #465): Tars trusts the folder and names its MCP servers'
    // variables in that home's config.toml, and reads the sessions there, while
    // a CODEX_HOME an rc file of the agent's shell sets sent codex elsewhere, to
    // ask "Trust this folder?" for good. On macOS and Linux in the line, which no
    // rc file runs after; on Windows, where the line's first word is the binary
    // itself (platform/launch.ts) and nothing is sourced, in the terminal's
    // environment (getPtyEnvVars).
    let command = process.platform === 'win32' ? '' : `env CODEX_HOME=${shellQuote(this.configDir)} `;
    command += `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // A session to go on with (measured on 0.163): `codex resume <id>` continues
    // it in its own rollout, with its conversation, and `codex fork <id>` under a
    // new session, as a restart that applies new settings wants
    // (agent-restart.ts). Every option after the subcommand, a key's included, so
    // it applies to the session resumed (0.163 also takes codex's own before it);
    // the session before the prompt. A session id and nothing else: it reaches a
    // command line.
    const session = params.resumeSessionId && CODEX_SESSION_ID.test(params.resumeSessionId) ? params.resumeSessionId : undefined;
    if (session) command += params.forkSession ? ' fork' : ' resume';

    // A key from Settings: its interactive session reads none from its
    // environment (0.163), so a model provider of Tars's names CODEX_API_KEY,
    // by name only. None: Codex keeps its own login (services/cli-keys.ts).
    for (const arg of codexKeyConfig(params.appSettings ?? (readAppSettingsFromDisk() as AppSettings))) {
      command += ` ${shellQuote(arg)}`;
    }

    command += this.modelAndEffort(params.model, params.effort);

    // The mode in flags the installed codex has: 0.163 refuses --full-auto, and
    // every agent in auto or bypass died at launch on it (codex-cli.ts).
    const permission = codexPermissionArgs(params.permissionMode, codexAccepts(params.binaryPath));
    if (permission.length) command += ` ${permission.join(' ')}`;

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

    // Prompt with skills directive
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      const skillsList = params.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }

    if (session) command += ` ${shellQuote(session)}`;
    if (finalPrompt) {
      const escaped = finalPrompt.replace(/'/g, "'\\''");
      command += ` '${escaped}'`;
    }

    return command;
  }


  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `${shellQuote(params.binaryPath)} exec`;
    command += this.modelAndEffort(params.model, params.effort);
    command += ` ${shellQuote(params.prompt)}`;
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
      // The home Tars reads and writes (buildInteractiveCommand says why).
      CODEX_HOME: this.configDir,
      // Its API key from Settings, under the variable it reads (services/cli-keys.ts).
      ...keyEnvFor('codex', appSettings),
    };
  }

  getEnvVarsToDelete(): string[] {
    // Codex doesn't have a known nested session env var yet
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.toml'),
      // Read from codex's own session log (services/codex-sessions.ts).
      turnsReported: true,
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    // Codex CLI has minimal hook support (exit-code based status only).
    // No hook configuration needed.
    console.log('Codex CLI: hooks not supported, using exit-code based status detection');
  }

  async registerMcpServer(name: string, command: string, args: string[], envVars?: readonly string[]): Promise<void> {
    // Names for codex to hand the server from its own environment (Tars's
    // servers: the agent's token and id, services/mcp-orchestrator-env.ts).
    // codex hands its servers nothing else (measured, codex 0.163), and
    // `codex mcp add` has no way to say them: only --env, which would write the
    // values themselves. So Tars writes that section itself.
    if (envVars && envVars.length > 0) {
      this.writeSection(name, command, args, envVars);
      console.log(`[codex] Registered MCP server ${name} in config.toml, with the variables it reads`);
      return;
    }
    // Try codex mcp add first (proper CLI registration)
    try {
      // execFileSync passes argv as a structured array, so name/command/args are
      // never seen by a shell. The previous form wrapped each arg in double
      // quotes and handed the whole line to execSync (/bin/sh -c), where
      // $(...) and backticks inside an argument are still expanded - and one of
      // those args is `tasmaniaServerPath` straight out of app-settings.json.
      // execCliSync resolves the name first: on Windows codex is an npm
      // codex.cmd, which a bare name never finds.
      execCliSync('codex', ['mcp', 'add', name, '--', command, ...args], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`[codex] Registered MCP server ${name} via codex mcp add`);
      return;
    } catch (err) {
      // Fallback: write to config.toml manually, and say why.
      console.warn(`[codex] codex mcp add failed (${cliFailureText(err)}), writing config.toml instead`);
    }

    this.writeSection(name, command, args);
    console.log(`[codex] Registered MCP server ${name} in config.toml (fallback)`);
  }

  private writeSection(name: string, command: string, args: string[], envVars?: readonly string[]): void {
    const configPath = path.join(this.configDir, 'config.toml');
    // TOML basic strings, escaped: a Windows path written raw (C:\Users...)
    // holds `\U` and `\P`, which are no valid escape, and the whole file then
    // fails to parse. Byte for byte the old output when there is no backslash,
    // quote or control character to escape.
    const sectionKey = this.escapeTomlKey(name);
    const argsToml = args.map(a => this.tomlString(a)).join(', ');
    const envToml = envVars && envVars.length > 0 ? `env_vars = [${envVars.map(v => this.tomlString(v)).join(', ')}]\n` : '';
    const section = `\n[mcp_servers.${sectionKey}]\ncommand = ${this.tomlString(command)}\nargs = [${argsToml}]\n${envToml}`;
    // The section it had taken out first, then added at the end; written whole, parsed, never left broken
    // (utils/shared-file.ts, utils/toml-tables.ts).
    const outcome = updateSharedTextSync(configPath, current =>
      removeTomlTable(current ?? '', `mcp_servers.${sectionKey}`).trimEnd() + '\n' + section, { parse: parseToml });
    if (outcome === 'refused') throw new Error(`${configPath} would not parse with ${name} in it (or did not already): left as it was`);
    if (outcome === 'busy') throw new Error(`${configPath} kept changing: ${name} not registered`);
  }

  async removeMcpServer(name: string): Promise<void> {
    // Try codex mcp remove first
    try {
      // execFileSync, for the same reason the add path above uses it: a shell
      // string here would expand $(...) and backticks inside the name. The add
      // path was fixed and its sibling a few lines below was not, which is the
      // whole shape of this bug class.
      execCliSync('codex', ['mcp', 'remove', name], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      // Not registered is fine; a codex that cannot be started is said.
      if (err instanceof CliNotRunnableError) console.warn(`[codex] codex mcp remove not run: ${err.message}`);
    }

    // Also clean config.toml fallback
    const configPath = path.join(this.configDir, 'config.toml');
    if (!fs.existsSync(configPath)) return;

    const outcome = updateSharedTextSync(configPath, current =>
      (current === undefined ? undefined : removeTomlTable(current, `mcp_servers.${this.escapeTomlKey(name)}`)), { parse: parseToml });
    if (outcome === 'written') console.log(`[codex] Removed MCP server ${name} from config.toml`);
    else if (outcome !== 'unchanged') console.warn(`[codex] ${name} left in ${configPath}: ${outcome === 'refused' ? 'the file would not parse without it, or did not already' : 'the file kept changing'}`);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string, envVars?: readonly string[]): boolean {
    const configPath = path.join(this.configDir, 'config.toml');
    if (!fs.existsSync(configPath)) return false;
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const sectionKey = this.escapeTomlKey(name);
      const headerRegex = new RegExp(`\\[mcp_servers\\.${sectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
      if (!headerRegex.test(content)) return false;
      // The path as written: escaped, so a Windows path reads back doubled.
      if (!content.includes(expectedServerPath) && !content.includes(this.tomlString(expectedServerPath).slice(1, -1))) return false;
      if (!envVars || envVars.length === 0) return true;
      // A registration made before Tars named them (2.0.4) is made again.
      const section = content.slice(content.search(headerRegex)).split(/\n(?=\[)/)[0];
      const named = section.match(/^env_vars\s*=\s*\[(.*)\]\s*$/m)?.[1] ?? '';
      return envVars.every(v => named.includes(this.tomlString(v)));
    } catch {
      return false;
    }
  }

  private escapeTomlKey(key: string): string {
    // TOML keys with dots or special chars need quoting, and a quote or a
    // backslash inside the key escaping, as grok-provider.ts does.
    if (/[^a-zA-Z0-9_-]/.test(key)) {
      return this.tomlString(key);
    }
    return key;
  }

  /**
   * A TOML basic string. JSON string escaping is valid TOML for backslashes,
   * double quotes and control characters, except DEL (U+007F), which JSON
   * leaves raw and TOML refuses: escaped here.
   */
  private tomlString(value: string): string {
    return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  getSkillDirectories(): string[] {
    return [path.join(os.homedir(), '.agents', 'skills')];
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
    // Codex may not have a memory system; return config dir as placeholder
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '--add-dir';
  }
}
