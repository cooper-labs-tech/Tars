import * as os from 'os';
import * as path from 'path';
import type { AppSettings, AgentPermissionMode } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
  PtyLaunch,
} from './cli-provider';
import { shellQuote } from './cli-provider';
import { GOOSE_SESSION_ID, goosePathRoot } from './goose-cli';
import { ORCHESTRATOR_ONLY_MCP } from '../services/mcp-roles';
import { endpointLaunchForAgent } from '../services/traces-runtime';

/**
 * Goose, the binary `goose` (block/goose, Apache-2.0), measured on 1.60.1 (20/11/2026) in throwaway homes, its TUI in a
 * PTY against a loopback endpoint:
 * - `goose session` is its TUI. It takes no task on its command line, so a launch types the task in once it runs
 *   (taskTypedAfterLaunch, core/typed-task.ts), and a message once its field is drawn (upOnScreen);
 * - its permission mode is GOOSE_MODE, read from its environment only: `auto` runs every tool unasked, `approve` asks
 *   in its terminal. `chat` asked the same, so nothing measured is a plan mode, and plan is refused;
 * - its MCP servers are given per run, `--with-extension '<name>:<command> <args>'`, and nothing is written into its
 *   config: each is started with Goose's whole environment, the agent's token in it. A session resumed or forked starts
 *   again the ones it was started with, and refuses to start when one is named again;
 * - `--resume --session-id <id>` continues a session with its history, and `--fork` with it under a new id;
 * - its turns, its answer and its tokens are read from its sessions.db (services/goose-sessions.ts): it runs no hook
 *   Tars installs;
 * - a message typed during its turn is lost (its Enter dropped, the text left in its field), so Tars holds every
 *   message to it until the turn ends (noteDuringTurn 'lost', core/send-mode.ts).
 * Its model is the user's own (its config.yaml), or the endpoint Tars hands it (services/endpoint-harness.ts).
 */

/** Goose's mode for an agent's: normal asks, auto and bypass never do (plan is refused at the line, buildInteractiveCommand). */
const gooseModeOf = (mode: AgentPermissionMode | undefined): 'approve' | 'auto' => (mode === 'auto' || mode === 'bypass' ? 'auto' : 'approve');

/**
 * A word of an extension's command as Goose splits it (into shell words, measured): as it is when it holds nothing a
 * split would read, single-quoted when it holds a space, a quote or a backslash (a backslash inside single quotes
 * reached the process as it is); undefined for one with a single quote, which nothing can carry there.
 */
function extensionWord(word: string): string | undefined {
  if (word.includes("'")) return undefined;
  return word && !/[\s"\\]/.test(word) ? word : `'${word}'`;
}

export class GooseProvider implements CLIProvider {
  readonly id = 'goose' as const;
  readonly displayName = 'Goose';
  readonly binaryName = 'goose';
  get configDir(): string {
    const root = goosePathRoot();
    return root ? path.join(root, 'config') : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'goose');
  }

  /** Tars's servers, by name, put on each fresh launch's line: Goose's own config is never written. */
  private servers = new Map<string, { command: string; args: string[] }>();

  getModels(): ProviderModel[] {
    return [{ id: 'default', name: 'Default', description: 'The provider and model set in Goose' }];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.goose || 'goose';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    // Plan has no measured equivalent: refused, with the reason create and update give (plan-mode.ts).
    if (params.permissionMode === 'plan') throw new Error(`${this.displayName} has no plan mode here: its chat mode still asked to run a command. Ask for normal, auto or bypass.`);
    const mode = gooseModeOf(params.permissionMode);
    // On macOS and Linux in the line, which no rc file runs after; on Windows, where the line's first word is the
    // binary itself and nothing is sourced, in the terminal's environment (getPtyEnvVars), as codex's CODEX_HOME.
    let command = process.platform === 'win32' ? '' : `env GOOSE_MODE=${shellQuote(mode)} `;
    command += `${shellQuote(params.binaryPath)} session`;
    // On an inference endpoint, Tars's provider and model; the proxy in the environment (getPtyEnvVars).
    for (const arg of endpointLaunchForAgent(params.agentId, 'goose')?.args ?? []) command += ` ${shellQuote(arg)}`;
    // Goose's own id and nothing else: it reaches a command line. A session resumed or forked brings its servers back.
    const session = params.resumeSessionId && GOOSE_SESSION_ID.test(params.resumeSessionId) ? params.resumeSessionId : undefined;
    if (session) return `${command} --resume --session-id ${shellQuote(session)}${params.forkSession ? ' --fork' : ''}`;
    // A worker's Goose starts without the orchestrator's own servers, Telegram and X (services/mcp-roles.ts).
    const orchestrator = params.orchestratorMode === true;
    for (const [name, server] of this.servers) {
      if (!orchestrator && ORCHESTRATOR_ONLY_MCP.includes(name)) continue;
      const words = [server.command, ...server.args].map(extensionWord);
      if (words.some((w) => w === undefined)) {
        console.warn(`[goose] MCP server ${name} not given: a quote in its command or path, which Goose's extension value cannot carry`);
        continue;
      }
      command += ` --with-extension ${shellQuote(`${name}:${words.join(' ')}`)}`;
    }
    return command;
  }

  readonly taskTypedAfterLaunch = true;

  /**
   * Up once its field line is drawn (`> Enter to send`), which comes in the same write as bracketed paste turning on
   * (measured three times); `goose is ready` comes 5 to 68 ms before, when a paste arrives raw.
   */
  upOnScreen(lines: readonly string[]): boolean {
    return lines.some((line) => /^\s*>?\s*Enter to send\b/.test(line));
  }

  /** Measured on 1.60.1: a message typed during a turn waits in its field, unsent. */
  readonly noteDuringTurn = 'lost' as const;

  /** What a launch types into the TUI: the task, with the skills line before it. No task, nothing. */
  typedTask(params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>): string {
    if (!params.prompt?.trim()) return '';
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      return `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them when relevant to the task.] ${params.prompt}`;
    }
    return params.prompt;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    // `goose run` (1.60.1 --help): one prompt, its answer, and no session left behind.
    return `${shellQuote(params.binaryPath)} run --no-session --quiet --text ${shellQuote(params.prompt)}`;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, _appSettings?: AppSettings, launch?: PtyLaunch): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      GOOSE_MODE: gooseModeOf(launch?.permissionMode),
      // On an inference endpoint, the proxy; the token's variable is filled at the spawn (core/agent-pty.ts).
      ...(endpointLaunchForAgent(agentId, 'goose')?.env ?? {}),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      // Its turns are read from its sessions.db and posted as the hooks would (services/goose-sessions.ts).
      turnsReported: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.yaml'),
    };
  }

  async configureHooks(): Promise<void> {
    // Nothing to install: its database is read instead.
  }

  /** Not Claude Code's `--mcp-config` ('flag', services/mcp-roles.ts): its servers go on its own line, from this provider. */
  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    this.servers.set(name, { command, args: [...args] });
  }

  async removeMcpServer(name: string): Promise<void> {
    this.servers.delete(name);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const server = this.servers.get(name);
    return !!server && [server.command, ...server.args].some((w) => w.includes(expectedServerPath));
  }

  getSkillDirectories(): string[] {
    return [];
  }

  getInstalledSkills(): string[] {
    return [];
  }

  supportsSkills(): boolean {
    return false;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '';
  }
}
