import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { AppSettings, AgentPermissionMode } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { shellQuote } from './cli-provider';
import { CLINE_SESSION_ID, clineAgentDir, clineUserDataDir } from './cline-cli';
import { ORCHESTRATOR_ONLY_MCP } from '../services/mcp-roles';
import { endpointLaunchForAgent } from '../services/traces-runtime';
import { agentNotice } from '../core/agent-notices';

/**
 * Cline CLI, the binary `cline` (npm `cline`), measured on 3.0.74 (20-21/11/2026) in throwaway homes, its TUI in a PTY
 * against a loopback endpoint:
 * - `cline -i` is its TUI, on a folder of the agent's own (cline-cli.ts): `--config` for its hooks, `--data-dir` for its
 *   provider, its MCP settings and its sessions. Its TUI reads its provider from `<data>/settings/providers.json` only,
 *   so the agent's is a copy of the user's (read, never written) or, on an endpoint, Tars's proxy; with neither, the
 *   launch is refused, since its onboarding would take the task's Enter to sign in with Cline. With --data-dir it starts
 *   no hub (measured, even with CLINE_SESSION_BACKEND_MODE=hub), and it is told the local backend all the same.
 * - Its hooks tell Tars its turns (hooks/cline-hook.mjs, one `<Event>.mjs` per event in the agent's hooks/), the way
 *   Claude Code's do: no prompt-keyed binding.
 * - A task on its line is ignored on a session resumed with `--id`, so a launch types the task in once its field and
 *   footer are drawn (upOnScreen), after bracketed paste turns on (measured).
 * - `--auto-approve false` asks in its terminal; `-p` still ran a command, so plan is refused.
 * - `--id <id>` resumes a session under its own id; there is no fork, so a restart starts a fresh session and says so.
 * - The first-run notice (it took an Enter and opened a page in the owner's browser) is always off.
 */

/** The events Tars reads; Cline runs `<event>.mjs` of the agent's hooks/ with node. */
const HOOK_EVENTS = ['TaskStart', 'TaskResume', 'TaskComplete', 'TaskCancel', 'TaskError'] as const;

const autoApproves = (mode: AgentPermissionMode | undefined): boolean => mode === 'auto' || mode === 'bypass';

/** Cline's providers file naming Tars's proxy and the model, the key left to OPENAI_API_KEY (the terminal's token). */
function endpointProviders(baseUrl: string, model: string): Record<string, unknown> {
  return {
    version: 1, lastUsedProvider: 'openai-compatible', modes: {},
    providers: { 'openai-compatible': { settings: { provider: 'openai-compatible', model, baseUrl }, updatedAt: new Date().toISOString(), tokenSource: 'manual' } },
  };
}

export class ClineProvider implements CLIProvider {
  readonly id = 'cline' as const;
  readonly displayName = 'Cline';
  readonly binaryName = 'cline';
  /** The user's own Cline folder, read for their provider and never written. */
  get configDir(): string {
    return path.dirname(clineUserDataDir());
  }

  /** Tars's servers, by name, written into each agent's own MCP settings by its role. */
  private servers = new Map<string, { command: string; args: string[] }>();
  /** Tars's hooks folder (configureHooks), where hooks/cline-hook.mjs ships. */
  private hooksDir: string | undefined;

  getModels(): ProviderModel[] {
    return [{ id: 'default', name: 'Default', description: 'The provider and model set in Cline' }];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.cline || 'cline';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    // Plan has no measured equivalent (-p still ran the shell tool): refused, as create and update refuse it (plan-mode.ts).
    if (params.permissionMode === 'plan') throw new Error(`${this.displayName} has no plan mode here: its plan mode still ran a command. Ask for normal, auto or bypass.`);
    if (!params.agentId) throw new Error('Cline runs as an agent of Tars only on a folder of its own: no agent was named.');
    const dir = clineAgentDir(params.agentId);
    this.writeAgentFolder(params.agentId, dir, params.orchestratorMode === true);
    let command = `${shellQuote(params.binaryPath)} -i --config ${shellQuote(dir)} --data-dir ${shellQuote(path.join(dir, 'data'))}`;
    command += ` --auto-approve ${shellQuote(autoApproves(params.permissionMode) ? 'true' : 'false')}`;
    // Cline's own id and nothing else: it reaches a command line. No fork: a restart, which goes on with the session its
    // stop made a tombstone (hooks-routes.ts refuses its posts), starts a fresh one, and says so.
    const session = params.resumeSessionId && CLINE_SESSION_ID.test(params.resumeSessionId) ? params.resumeSessionId : undefined;
    if (session && params.forkSession) {
      agentNotice(params.agentId, 'Its conversation starts over: Cline cannot fork a session, and a restart cannot continue the one it stops.', 'conversation-restart');
    } else if (session) {
      command += ` --id ${shellQuote(session)}`;
    }
    return command;
  }

  /** The agent's folder, written for this launch: its provider, its servers by role, its hooks. */
  private writeAgentFolder(agentId: string, dir: string, orchestrator: boolean): void {
    const settings = path.join(dir, 'data', 'settings');
    fs.mkdirSync(settings, { recursive: true, mode: 0o700 });
    const endpoint = endpointLaunchForAgent(agentId, 'cline');
    let providers: string;
    if (endpoint?.baseUrl && endpoint.modelArg) {
      providers = JSON.stringify(endpointProviders(endpoint.baseUrl, endpoint.modelArg), null, 2);
    } else {
      const users = path.join(clineUserDataDir(process.env, os.homedir()), 'settings', 'providers.json');
      try {
        providers = fs.readFileSync(users, 'utf8');
      } catch {
        throw new Error('Cline has no provider set up for Tars to use: run `cline auth` in a terminal once, or put this agent on an inference endpoint.');
      }
    }
    fs.writeFileSync(path.join(settings, 'providers.json'), providers, { mode: 0o600 });
    const mcpServers = Object.fromEntries([...this.servers]
      .filter(([name]) => orchestrator || !ORCHESTRATOR_ONLY_MCP.includes(name))
      .map(([name, s]) => [name, { command: s.command, args: s.args, disabled: false }]));
    fs.writeFileSync(path.join(settings, 'cline_mcp_settings.json'), JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    if (this.hooksDir) {
      const hook = pathToFileURL(path.join(this.hooksDir, 'cline-hook.mjs')).href;
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true, mode: 0o700 });
      for (const event of HOOK_EVENTS) {
        fs.writeFileSync(path.join(dir, 'hooks', `${event}.mjs`), `import(${JSON.stringify(hook)}).then((m) => m.run(${JSON.stringify(event)}));\n`);
      }
    }
  }

  readonly taskTypedAfterLaunch = true;

  /**
   * Up once its field (`❯`) and its footer (`Auto-approve all enabled|disabled (Shift+Tab)`) are drawn, after bracketed
   * paste turns on (measured): on a fresh session, on one resumed, never on its onboarding, which has neither.
   */
  upOnScreen(lines: readonly string[]): boolean {
    return lines.some((line) => /^\s*❯/.test(line)) && lines.some((line) => /Auto-approve all (enabled|disabled) \(Shift\+Tab\)/.test(line));
  }

  /** Measured on 3.0.74: a note typed during a turn went in after the turn. */
  readonly noteDuringTurn = 'after-the-turn' as const;

  /** What a launch types into the TUI: the task, with the skills line before it. No task, nothing. */
  typedTask(params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>): string {
    if (!params.prompt?.trim()) return '';
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      return `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them when relevant to the task.] ${params.prompt}`;
    }
    return params.prompt;
  }

  buildOneShotCommand(): string {
    // A run of Cline outside an agent's folder would write the user's ~/.cline: none is offered.
    throw new Error('Cline has no one-shot here: it runs as an agent on a folder of its own.');
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined): Record<string, string> {
    return {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
      CLINE_DISABLE_CLINE_PASS_NOTICE: '1',
      CLINE_SESSION_BACKEND_MODE: 'local',
      // Where the hook reads a task's prompt from (hooks/cline-hook.mjs): the same folder as --data-dir.
      CLINE_DATA_DIR: path.join(clineAgentDir(agentId), 'data'),
      // On an inference endpoint, the token's variable is filled at the spawn (core/agent-pty.ts).
      ...(endpointLaunchForAgent(agentId, 'cline')?.env ?? {}),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      // Its own hooks post its turns to Tars (hooks/cline-hook.mjs), installed in each agent's own folder: Tars's start
      // gives it the hooks folder (services/hooks-manager.ts, configureStatusHooks) for that.
      supportsNativeHooks: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'data', 'settings', 'cline_mcp_settings.json'),
    };
  }

  async configureHooks(hooksDir: string): Promise<void> {
    // Nothing written now: each launch writes the agent's own hooks/, pointing here.
    this.hooksDir = hooksDir;
  }

  /** Not Claude Code's `--mcp-config`: its servers go into each agent's own MCP settings. */
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
