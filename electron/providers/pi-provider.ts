import { endpointLaunchForAgent } from '../services/traces-runtime';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import { keyEnvFor } from '../services/cli-keys';
import { DATA_DIR } from '../constants';
import { piSessionDir } from '../services/pi-sessions';
import type {
  CLIProvider,
  InteractiveCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { updateSharedJsonSync } from '../utils/shared-file';
import { trustsTooMuch } from '../utils/trust-too-much';

/**
 * Where pi reads its MCP servers (`@earendil-works/pi-coding-agent` 1.3.0,
 * docs/mcp.md and docs/configuration.md, read on 19/10): `mcp.json` of its
 * agent folder, `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, under `mcpServers`,
 * each started with pi's whole environment (pi-mcp 1.3.0, transports/stdio.js),
 * the agent's token in it. `@mariozechner/pi-coding-agent`, its former name,
 * has no MCP at all.
 */
function mcpConfigFile(): string {
  return path.join(piAgentDir(), 'mcp.json');
}

/** pi's agent folder, `$PI_CODING_AGENT_DIR` or `~/.pi/agent`: where it keeps its MCP servers and its trust answers. */
function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

/**
 * The agent's folder trusted in pi's `trust.json` before pi starts, as ensureCodexProjectTrusted does for codex.
 * Measured on pi 1.5.2 (20/11): in a folder with pi resources of its own (`.pi/settings.json`, `mcp.json`,
 * `extensions`, `skills`, `prompts`, `themes`) or under a folder holding `.agents/skills` other than the user's, pi
 * first asks "Trust project folder?" and waits for good, which nobody answers in an agent's terminal. pi keeps the
 * folder's real path to true or false, and the entry nearest up the tree decides (its core/trust-manager.js): any
 * entry there already, for the folder or one above it, is the user's and is left as it is. A folder that would trust
 * every folder below it is refused (utils/trust-too-much.ts), and pi asks. The file is written whole (utils/shared-file.ts)
 * and left alone when it is not a JSON object.
 */
export function ensurePiProjectTrusted(projectPath: string, agentDir: string = piAgentDir()): 'written' | 'already' | 'refused' | 'failed' {
  if (!projectPath || trustsTooMuch(projectPath)) return 'refused';
  let real: string;
  try { real = fs.realpathSync(projectPath); } catch { return 'failed'; }
  const file = path.join(agentDir, 'trust.json');
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  let found: 'already' | 'unreadable' | undefined;
  try {
    const outcome = updateSharedJsonSync<Record<string, unknown>>(file, current => {
      if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
        found = 'unreadable';
        return undefined;
      }
      const entries = current ?? {};
      for (let dir = real; ; dir = path.dirname(dir)) {
        if (Object.entries(entries).some(([key, value]) => typeof value === 'boolean' && same(key, dir))) {
          found = 'already';
          return undefined;
        }
        if (path.dirname(dir) === dir) break;
      }
      return { ...entries, [real]: true };
    });
    if (found === 'already') return 'already';
    if (outcome === 'written') return 'written';
    console.warn(found === 'unreadable' || outcome === 'unreadable'
      ? `[pi] ${file} is not a JSON object pi can read: ${real} is not trusted there, and pi will ask`
      : `[pi] ${real} not trusted in ${file}: the file kept changing while Tars wrote it`);
    return 'failed';
  } catch (err) {
    console.warn(`[pi] ${real} not trusted in ${file}: it could not be read`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}

/** Whether the user's pi starts with no banner: `quietStartup: true` in its global settings.json. */
function piStartsQuietly(): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(piAgentDir(), 'settings.json'), 'utf-8')) as { quietStartup?: unknown };
    return settings?.quietStartup === true;
  } catch {
    return false;
  }
}

/** Where Tars wrote them until 2.0.4, which pi never reads. */
const legacyMcpFile = (): string => path.join(os.homedir(), '.pi', 'config.json');

type McpServersFile = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/** The server out of `file`'s `mcpServers`, the rest of the file left as it is. */
function dropServer(file: string, name: string): void {
  updateSharedJsonSync<McpServersFile>(file, current => {
    const servers = current?.mcpServers;
    if (!servers || typeof servers !== 'object' || !(name in servers)) return undefined;
    delete servers[name];
    return current;
  });
}

/** The tools pi announced it downloads (`<tool> not found. Downloading...`) with no outcome yet on `lines`. */
function downloadsUnderWay(lines: readonly string[]): string[] {
  const text = lines.join('\n');
  const announced = [...text.matchAll(/(?:^|\s)(fd|ripgrep) not found\. Downloading\.\.\./g)].map(([, tool]) => tool);
  return [...new Set(announced)].filter((tool) => !text.includes(`${tool} installed to `) && !text.includes(`Failed to download ${tool}`));
}

export class PiProvider implements CLIProvider {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi Terminal';
  readonly binaryName = 'pi';
  readonly configDir = path.join(os.homedir(), '.pi');

  /**
   * Pi sends no SessionStart and loses keys typed before its TUI runs (1.5.2, measured 20/11: a task typed at its exec
   * was echoed by the shell and never reached it). It takes keys once its footer is drawn under its field: the context
   * used over its window, `0.0%/128k (auto)` (one decimal, always), or `?/200k` when the share is unknown (its footer.js).
   */
  upOnScreen(lines: readonly string[]): boolean {
    if (!lines.some((line) => /(?:^|\s)(?:\d+\.\d%|\?)\/\d+(?:\.\d)?[kM]?(?: \(auto\))?(?:\s|$)/.test(line))) return false;
    // Its footer comes before its startup ends: pi first fetches fd and ripgrep when they are missing, and until then
    // answers Enter with "Startup is still in progress", the task left unsent (its interactive-mode.js and
    // tools-manager.js). Up once every download it announced has its outcome.
    if (downloadsUnderWay(lines).length > 0) return false;
    // And its first frame holds its field and footer alone: its banner and its download line come in the next, 20 to
    // 70 ms later (measured 20/11). These rows are the bottom ones only (terminal-mirror.ts, LAUNCH_ROWS), the banner
    // out of their sight: the first frame is the one with nothing above its field's top border. Up once something is
    // drawn there, or at once when the user's pi starts quietly and draws nothing there (`quietStartup: true` in its
    // settings.json; a project's own setting is not read, and such a pi is up when its launch's wait runs out).
    const rows = lines.filter((line) => line.trim());
    return rows.findIndex((line) => /^─{8,}/.test(line.trim())) > 0 || piStartsQuietly();
  }

  /** A download pi announced at its start and has not ended: until it does, pi takes no task (upOnScreen). */
  whyNotUp(lines: readonly string[]): string | undefined {
    const tools = downloadsUnderWay(lines);
    return tools.length > 0 ? `pi is still downloading ${tools.join(' and ')}, which it fetches at its first start when missing` : undefined;
  }

  /** Measured on 1.5.2 (20/11): a note typed during a slow tool call went out with that call's result. */
  readonly noteDuringTurn = 'next-tool-round' as const;

  getModels(): ProviderModel[] {
    return [
      { id: 'default', name: 'Default', description: 'Use configured model' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet', description: 'Anthropic' },
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus', description: 'Anthropic' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.pi || 'pi';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // On an inference endpoint: Tars's provider in pi's models.json, on the endpoint proxy (services/endpoint-harness.ts).
    for (const arg of endpointLaunchForAgent(params.agentId, 'pi')?.args ?? []) command += ` '${arg.replace(/'/g, "'\\''")}'`;

    // The agent's own session after a restart (utils/resume-session.ts): `--session <id>` continues it, `--fork <id>`
    // goes on under a new session, as a restart that applies new settings wants (measured on 1.5.2). A session id and
    // nothing else, it reaches a command line; before the prompt, which pi reads as text.
    const session = params.resumeSessionId && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(params.resumeSessionId)
      ? params.resumeSessionId : undefined;
    if (session) command += ` ${params.forkSession ? '--fork' : '--session'} '${session}'`;

    // For interactive PTY sessions, launch the TUI (no subcommand).
    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    // A delegated task arrives as params.prompt. Dropping it launched a bare
    // TUI and reported success while the task went nowhere.
    // No task, no prompt: the skills line alone was a turn nobody asked for.
    let finalPrompt = params.prompt?.trim() ? params.prompt : '';
    if (finalPrompt && params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    if (finalPrompt) {
      command += ` '${finalPrompt.replace(/'/g, "'\\''")}'`;
    }

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
      ...keyEnvFor('pi', appSettings),
      // Its sessions in a folder of its own, which pi ranks above its own setting:
      // every file there is this agent's, read for its turns (services/pi-sessions.ts).
      PI_CODING_AGENT_SESSION_DIR: piSessionDir(DATA_DIR, agentId),
    };
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      // Its turns are read from its session file and posted as the hooks would (services/pi-sessions.ts).
      turnsReported: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'config.json'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    // Pi uses extensions for hooks, no native hook configuration needed
    console.log('Pi Terminal: hooks configured via extensions, skipping native hook setup');
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'config-file';
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    const file = mcpConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const outcome = updateSharedJsonSync<McpServersFile>(file, current => {
      const config: McpServersFile = current ?? {};
      const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
      // Declared to the model like a built-in tool: pi 1.5.2's default exposure, `codemode`, leaves a server's tools
      // callable from its code tool alone, and an agent on pi never saw send_message or delegate_task (measured 19/11).
      config.mcpServers = { ...servers, [name]: { command, args, exposure: 'direct' } };
      return config;
    }, { createMode: 0o644 });
    if (outcome === 'unreadable') console.warn(`[pi] MCP server ${name} not registered: ${file} is not JSON, left untouched`);
    else if (outcome === 'busy') console.warn(`[pi] MCP server ${name} not registered: ${file} changed under every attempt, tried again at the next start`);
    else console.log(`[pi] Registered MCP server ${name} in ${file}`);
    dropServer(legacyMcpFile(), name);
  }

  async removeMcpServer(name: string): Promise<void> {
    dropServer(mcpConfigFile(), name);
    dropServer(legacyMcpFile(), name);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    try {
      const config = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf-8')) as McpServersFile;
      const server = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers[name] : undefined;
      if (!server) return false;
      // The path as JSON writes it too: a Windows path has every backslash
      // doubled there, never matched, and was registered again at every launch.
      const entry = JSON.stringify(server);
      return entry.includes(expectedServerPath) || entry.includes(JSON.stringify(expectedServerPath).slice(1, -1));
    } catch {
      return false;
    }
  }

  /** Registered, and with its tools declared to the model: a server an older Tars wrote without that is written again. */
  isMcpServerCurrent(name: string, expectedServerPath: string): boolean {
    if (!this.isMcpServerRegistered(name, expectedServerPath)) return false;
    try {
      const config = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf-8')) as McpServersFile;
      const server = config.mcpServers?.[name] as { exposure?: unknown } | undefined;
      return server?.exposure === 'direct';
    } catch {
      return false;
    }
  }

  getSkillDirectories(): string[] {
    // Pi uses extensions/packages rather than skills directories
    return [path.join(os.homedir(), '.pi', 'packages')];
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
    return false;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    return '';
  }
}
