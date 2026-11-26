import { endpointLaunchForAgent } from '../services/traces-runtime';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { shellQuote } from './cli-provider';
import { hermesProfileDir, hermesRoot, type HermesMcpServer } from '../services/hermes-home';
import { updateSharedJsonSync } from '../utils/shared-file';

/**
 * Hermes Agent (Nous Research), measured on 0.23.4 (26 and 27/11), as an agent's CLI on an inference endpoint, through
 * Tars's proxy, and nothing else.
 *
 * - Its home is the agent's profile in Tars's own Hermes home (services/hermes-home.ts), written at each spawn of the
 *   agent's terminal with its endpoint, its approvals, Tars's MCP servers and a 0600 `.env` holding its tokens. The
 *   terminal holds no token: Hermes's sessions run in one gateway per home, started from the first terminal and
 *   shared by every Hermes agent.
 * - On macOS and Linux the home is on the line (`env HERMES_HOME=...`), which no rc file of the agent's shell runs
 *   after, with the user's OPENAI_API_KEY and OPENAI_BASE_URL taken out (`env -u`): Hermes would use them before the
 *   profile's. On Windows, where nothing is sourced, both in the terminal's environment.
 * - `chat --source tool`: Hermes's tag for an integration's sessions, which keeps them out of the user's own lists;
 *   it refuses any tag of Tars's own ("Gateway does not support source").
 * - Approvals: normal asks (`approvals.mode: manual`), auto lets Hermes judge (`smart`), bypass adds `--yolo`.
 * - Its turns are read from the profile's `state.db` (services/hermes-agent-turns.ts): it runs no hook of Tars's.
 * hermes-provider.test.ts says each way this goes wrong.
 */

/** Tars's MCP servers for Hermes, kept in Tars's Hermes home, written into each agent's profile at its start. */
export function hermesMcpFile(root: string = hermesRoot()): string {
  return path.join(root, 'tars-mcp-servers.json');
}

export function hermesMcpServers(root: string = hermesRoot()): Record<string, HermesMcpServer> {
  try {
    const raw = JSON.parse(fs.readFileSync(hermesMcpFile(root), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, HermesMcpServer> = {};
    for (const [name, s] of Object.entries(raw as Record<string, unknown>)) {
      const e = s as Partial<HermesMcpServer> | null;
      if (e && typeof e.command === 'string' && Array.isArray(e.args) && e.args.every(a => typeof a === 'string')) {
        out[name] = { command: e.command, args: e.args, env: Array.isArray(e.env) ? e.env.filter((v): v is string => typeof v === 'string') : [] };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** A session id Hermes gives (`local-<hex>`), the only thing a resume puts on the line. */
const HERMES_SESSION_ID = /^local-[0-9a-f]{64}$/;

/** What Hermes is not to take from the terminal: the profile's `.env` holds them, the terminal none. */
const NOT_FROM_THE_TERMINAL = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_ENDPOINT_TOKEN'];

export class HermesProvider implements CLIProvider {
  readonly id = 'hermes' as const;
  readonly displayName = 'Hermes Agent';
  readonly binaryName = 'hermes';

  get configDir(): string {
    return hermesRoot();
  }

  getModels(): ProviderModel[] {
    // Its models are the endpoint's (the endpoint's own list, refreshed in the window).
    return [];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return (appSettings.cliPaths as unknown as Record<string, string> | undefined)?.hermes || 'hermes';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    if (!params.agentId) throw new Error('A Hermes agent starts in a profile of its own: its id is needed.');
    const endpoint = endpointLaunchForAgent(params.agentId, 'hermes')?.profile;
    if (!endpoint) throw new Error('A Hermes agent runs on an inference endpoint: choose one, and one of its models, in the agent\'s settings.');
    const home = hermesProfileDir(hermesRoot(), params.agentId);

    let command = process.platform === 'win32'
      ? ''
      : `env ${NOT_FROM_THE_TERMINAL.slice(0, 2).map(v => `-u ${v}`).join(' ')} HERMES_HOME=${shellQuote(home)} `;
    command += `${shellQuote(params.binaryPath)} chat --source tool -m ${shellQuote(endpoint.model)}`;
    if (params.permissionMode === 'bypass') command += ' --yolo';
    if (params.resumeSessionId && HERMES_SESSION_ID.test(params.resumeSessionId)) command += ` --resume ${params.resumeSessionId}`;
    // No task, no prompt. A task is Hermes's first turn, submitted as it is (`-q` on a terminal).
    if (params.prompt?.trim()) command += ` -q ${shellQuote(params.prompt)}`;
    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `${shellQuote(params.binaryPath)} chat --source tool --oneshot --format stream-json`;
    if (params.model) command += ` -m ${shellQuote(params.model)}`;
    return `${command} -q ${shellQuote(params.prompt)}`;
  }

  getPtyEnvVars(agentId: string, projectPath: string): Record<string, string> {
    return {
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      // Windows' only way in (nothing is sourced there); macOS and Linux have it on the line as well.
      HERMES_HOME: hermesProfileDir(hermesRoot(), agentId),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [...NOT_FROM_THE_TERMINAL];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      // Its turns are read from its profile's state.db and posted as the hooks would (services/hermes-agent-turns.ts).
      turnsReported: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.yaml'),
    };
  }

  async configureHooks(): Promise<void> {
    // None: a hook runs in the shared gateway without its agent's token (hermes-home.ts).
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  async registerMcpServer(name: string, command: string, args: string[], envVars: readonly string[] = []): Promise<void> {
    const file = hermesMcpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const outcome = updateSharedJsonSync<Record<string, HermesMcpServer>>(file, current => ({
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      [name]: { command, args: [...args], env: [...envVars] },
    }), { createMode: 0o644 });
    if (outcome === 'unreadable' || outcome === 'busy') console.warn(`[hermes] MCP server ${name} not registered: ${file} was ${outcome}`);
  }

  async removeMcpServer(name: string): Promise<void> {
    updateSharedJsonSync<Record<string, HermesMcpServer>>(hermesMcpFile(), current => {
      if (!current || typeof current !== 'object' || !(name in current)) return undefined;
      delete current[name];
      return current;
    });
  }

  isMcpServerRegistered(name: string, expectedServerPath: string, envVars: readonly string[] = []): boolean {
    const server = hermesMcpServers()[name];
    if (!server || !server.args.includes(expectedServerPath)) return false;
    return envVars.every(v => server.env.includes(v));
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
