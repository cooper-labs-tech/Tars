import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentProvider, AppSettings, AgentPermissionMode, AgentEffort } from '../types';
import { dataPath, DATA_DIR_SHELL } from '../constants';

/**
 * Synchronously read the persisted app settings. Providers use this in
 * command/script builders that don't receive live settings (the same pattern
 * initAgentPty and the automation handlers already use).
 */
export function readAppSettingsFromDisk(): Partial<AppSettings> {
  try {
    const settingsFile = dataPath('app-settings.json');
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

/**
 * Parameters for building an interactive (PTY) agent command.
 */
export interface InteractiveCommandParams {
  binaryPath: string;
  prompt: string;
  model?: string;
  verbose?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  secondaryProjectPath?: string;
  obsidianVaultPaths?: string[];
  mcpConfigPath?: string;
  systemPromptFile?: string;
  skills?: string[];
  isSuperAgent?: boolean;
  chrome?: boolean;
  /** Orchestrator mode: disable Edit/Write/NotebookEdit/Task so the agent
   *  cannot do implementation work itself and must delegate. See BUG 5. */
  orchestratorMode?: boolean;
  /**
   * A session to pick up where it left off, already checked against the
   * transcript on disk (see utils/resume-session.ts). Only the providers that
   * run a binary with a verified resume flag act on it; the rest ignore it and
   * start fresh, which is what they did before.
   */
  resumeSessionId?: string;
  /**
   * Continue `resumeSessionId` under a new session id rather than its own. A
   * restart needs this: the session it resumes is the one it just killed, whose
   * id is the tombstone the hooks routes refuse posts from.
   */
  forkSession?: boolean;
  /** The settings the command is built with: read from disk when absent (codex's key, services/cli-keys.ts). */
  appSettings?: AppSettings;
}

/**
 * Parameters for building a scheduled (non-interactive, one-shot) command.
 */
export interface ScheduledCommandParams {
  binaryPath: string;
  prompt: string;
  autonomous: boolean;
  mcpConfigPath?: string;
  outputFormat?: string;
  verbose?: boolean;
}

/**
 * Parameters for building a quick one-shot command (e.g. kanban task generation).
 */
export interface OneShotCommandParams {
  binaryPath: string;
  prompt: string;
  model?: string;
}

/**
 * Model definition for a provider.
 */
export interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

/**
 * Hook configuration for a provider.
 */
export interface HookConfig {
  supportsNativeHooks: boolean;
  configDir: string;
  settingsFile: string;
}

/**
 * Strategy pattern interface for CLI providers.
 * Each provider (Claude, Codex, Gemini) implements this interface
 * to encapsulate all provider-specific behavior.
 */
export interface CLIProvider {
  readonly id: AgentProvider;
  readonly displayName: string;
  readonly binaryName: string;
  readonly configDir: string;

  /** Available models for this provider */
  getModels(): ProviderModel[];

  /** Resolve the binary path from app settings or defaults */
  resolveBinaryPath(appSettings: AppSettings): string;

  /** Build command string for interactive PTY sessions */
  buildInteractiveCommand(params: InteractiveCommandParams): string;

  /**
   * The CLI has no interactive form that takes a starting prompt (amp): its
   * command never carries the task, and every launch with one types it in once
   * the CLI runs (core/typed-task.ts). Absent: the task is on the command line.
   */
  readonly taskTypedAfterLaunch?: boolean;
  /** With taskTypedAfterLaunch: the text a launch types in for this task ('' for none). */
  typedTask?(params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>): string;

  /** Build command string for scheduled task execution */
  buildScheduledCommand(params: ScheduledCommandParams): string;

  /** Build command string for quick one-shot prompts */
  buildOneShotCommand(params: OneShotCommandParams): string;

  /** Get environment variables to set for PTY sessions */
  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string>;

  /** Get environment variable names to delete before spawning PTY */
  getEnvVarsToDelete(): string[];

  /** Get hook configuration for this provider */
  getHookConfig(): HookConfig;

  /** Configure hooks in the provider's settings */
  configureHooks(hooksDir: string): Promise<void>;

  /** MCP configuration strategy: 'flag' = pass via CLI flag, 'config-file' = write to config file */
  getMcpConfigStrategy(): 'flag' | 'config-file';

  /** Register an MCP server with this provider's configuration */
  registerMcpServer(name: string, command: string, args: string[]): Promise<void>;

  /** Remove an MCP server from this provider's configuration */
  removeMcpServer(name: string): Promise<void>;

  /** Check if an MCP server is registered with the expected server path */
  isMcpServerRegistered(name: string, expectedServerPath: string): boolean;

  /** Directories where this provider reads skills from */
  getSkillDirectories(): string[];

  /** List installed skill names by scanning skill directories */
  getInstalledSkills(): string[];

  /** Whether this provider supports native skill installation */
  supportsSkills(): boolean;

  /** Base path for project memory directories */
  getMemoryBasePath(): string;

  /** Get the Tars --add-dir equivalent flag for this provider */
  getAddDirFlag(): string;

  /** Generate the shell script content for scheduled tasks */
  buildScheduledScript(params: {
    binaryPath: string;
    binaryDir: string;
    projectPath: string;
    prompt: string;
    autonomous: boolean;
    mcpConfigPath: string;
    logPath: string;
    homeDir: string;
    /** Optional skills list to inject as a prompt prefix (same as interactive sessions) */
    skills?: string[];
  }): string;
}

/**
 * The reasoning-effort values a CLI accepts.
 *
 * This lands unquoted in a command string that is written to a shell, and it
 * arrives from an IPC message, so it is validated at the point of use rather
 * than trusted from the caller.
 */
const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The tools an orchestrator may not use, as a command fragment.
 *
 * Here rather than in each provider because thirteen of them run the same
 * `claude` binary and none of them applied this: an orchestrator on DeepSeek,
 * Venice or Ollama Cloud could edit files directly, which is the one thing
 * orchestrator mode exists to prevent. The restriction lived only in
 * claude-provider.ts, next to the twelve copies that had gone without it.
 *
 * `Task` is in the list because it spawns an ephemeral subagent: that looks
 * like delegating and is not. The work happens inside the orchestrator's own
 * session, so it never appears in list_agents, never reaches the specialist
 * whose project and permissions were set up for it, and cannot be watched or
 * stopped from Tars. An orchestrator asked for a security audit used it
 * instead of the Audit agent that already existed.
 *
 * Bash stays available: an orchestrator still has to run git, gh and read-only
 * inspection commands to know what it is delegating.
 */
export function orchestratorToolFlags(orchestratorMode: boolean | undefined): string {
  if (!orchestratorMode) return '';
  // No MultiEdit: claude has no tool by that name any more. 2.1.268, 2.1.273
  // and 2.1.280 all print `Permission deny rule "MultiEdit" matches no known
  // tool` at every orchestrator start (measured 2026-09-23), and Edit covers
  // what it did.
  return ' --disallowed-tools "Edit" "Write" "NotebookEdit" "Task"';
}

/**
 * The task, as the CLI's positional argument, after `--`.
 *
 * Several of claude's options are variadic (`--add-dir <directories...>`,
 * `--mcp-config`, `--allowed-tools`, `--disallowed-tools`, `--betas`, `--file`),
 * and one written just before the prompt takes the prompt as one more of its
 * values. Tars ends its command line with `--add-dir ~/.dorothy`, so every task
 * handed over as an argument was being read as a second directory: the CLI came
 * up with no task at all, registered its session about a second later, and Tars
 * marked the agent as working. Measured on claude 2.1.241 through 2.1.268, and
 * on every spawn path here.
 *
 * `--` rather than `--add-dir=<path>`: it ends option parsing outright, so it
 * also covers a task that begins with a dash and any variadic option added
 * later, wherever it lands in the line.
 *
 * No task, no operand. The skills directive on its own is not a task, and an
 * agent started without one should not spend a turn being told what it may use.
 */
export function promptOperand(prompt: string | undefined): string {
  if (!prompt || !prompt.trim()) return '';
  return ` -- ${shellQuote(prompt)}`;
}

/**
 * A value as one POSIX shell word: wrapped in single quotes, each `'` in it
 * written `'\''`. Inside single quotes nothing is special, so spaces, `$`,
 * backticks and line breaks reach the program as they are.
 *
 * Every folder a command hands its CLI (`--add-dir`, `--include-directories`)
 * goes through this. They used to be written `'${DATA_DIR}'`, and the scheduled
 * builders `"${DATA_DIR}"`, and DATA_DIR carries the home folder's own name:
 * a home such as `/Users/o'neil` closed the quote early and the command did
 * not run, and a name built to close it could add arguments of its own.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Whether orchestrator mode is enforced for a binary, or only asked for.
 *
 * `--disallowed-tools` is Claude Code's flag. Fourteen providers run that
 * binary, so for them the restriction is real: the tools are not there.
 *
 * The five CLIs with their own syntax (codex, gemini, grok, opencode, pi) have
 * no verified equivalent. None of them is installed on the machine this was
 * written on, so a flag could not be checked against `--help`, and a guessed
 * flag is worse than none: it would look enforced and silently do nothing.
 * Until one is verified against the real binary, an orchestrator on those runs
 * on its persona alone, and the app says so rather than implying otherwise.
 */
export function enforcesOrchestratorMode(binaryName: string): boolean {
  return binaryName === 'claude';
}

/**
 * Extra environment for a CLI that Tars launched, as opposed to one the user is
 * driving themselves.
 *
 * This is NOT what loses a dispatch. Claude Code's auto-updater is a
 * fire-and-forget effect inside its footer component: it is started without
 * being awaited and re-runs on a thirty minute interval, and a real agent here
 * has been observed finishing a four minute task while the updater cycled and
 * failed underneath it. An agent that looks stopped on "Checking for updates"
 * is not stopped by it.
 *
 * It stays off in a managed PTY because Tars updates claude itself, once, in
 * services/cli-updater.ts. Measured from 2.1.273 to 2.1.280: the updater in each
 * session made its own 217 MB download, three for three sessions started
 * together, and left every footer reading "Update installed · Restart to
 * update", a restart the user is not the one performing. It does not replace
 * the binary under a running session, as this comment used to say: the native
 * installer gives each version its own file, and a session keeps running the
 * one it started from. Its thirty minute redraw was also, on 2026-09-02, the
 * only output idle agents had left in their buffers.
 *
 * DISABLE_AUTOUPDATER rather than DISABLE_UPDATES. Both stop the background
 * updater. DISABLE_UPDATES is the administrator lockdown: it is checked first,
 * and it also makes an explicitly typed `claude update` refuse with a message
 * about contacting your IT team. These are real terminals the user can take
 * over at any time, so a command they type themselves stays theirs. Tars only
 * takes back what it started.
 *
 * CLAUDE_CODE_DISABLE_MOUSE_CLICKS because a Tars terminal hands Claude Code
 * the wheel and never a click, which stays local for selecting text. Measured
 * with Claude Code 2.1.273 in fullscreen, same answers, same wheel reports: it
 * asks for 1000 and 1006 instead of 1000, 1002, 1003 and 1006, scrolls line for
 * line the same, and its hint reads "Jump to bottom: fn+↓ to scroll" instead of
 * offering a click that does nothing here.
 *
 * Only for the binary that reads them. The fourteen providers that re-point the
 * claude binary get them; codex, gemini, grok, opencode and pi have their own
 * updaters and would silently ignore them.
 */
export function managedCliEnv(binaryName: string): Record<string, string> {
  if (binaryName !== 'claude') return {};
  return { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1' };
}

/**
 * What points the claude binary at a key provider's endpoint: its URL, and the
 * key as ANTHROPIC_AUTH_TOKEN, which Claude Code sends as `Authorization:
 * Bearer`. Never as ANTHROPIC_API_KEY: an interactive Claude Code asks before
 * it uses an API key it finds in its environment ("Detected a custom API key
 * in your environment. Do you want to use this API key?", No preselected), and
 * nothing answers that in an agent's terminal, so no key-provider agent ever
 * started by itself. The first Enter typed there, Tars's own included,
 * answered No: the key was then refused for good in that folder's
 * .claude.json, and a session with a subscription signed in went on with its
 * OAuth token, sent to the vendor's URL. An auth token is never asked about,
 * whichever Claude account folder the CLI reads, and is written nowhere
 * (measured on claude 2.1.302). Every key provider's endpoint takes the
 * Bearer: their own instructions for Claude Code say this variable.
 *
 * ANTHROPIC_API_KEY is blanked: a key the user's shell exports, inherited,
 * would bring the question back, about itself, and go out as `x-api-key` to a
 * vendor it has nothing to do with. Scheduled runs (`claude -p`) take the key
 * the same way, from scheduledKeyExports.
 */
export function keyProviderEnv(baseUrl: string, key: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' };
}

/**
 * The lines of a scheduled script that point `claude -p` at a key provider
 * and hand it the key, as keyProviderEnv does a terminal's (the Audit's M1 on
 * #458). Measured on claude 2.1.302 against a stand-in of the vendor:
 * `claude -p` with ANTHROPIC_API_KEY empty or unset, or ANTHROPIC_AUTH_TOKEN
 * empty, and a subscription signed in, sends the subscription's OAuth token
 * as a Bearer to the vendor's URL. So the key is read as the task runs, by
 * Tars's own node (the launcher its MCP servers run on, else `node`), never by
 * jq, which macOS ships only from 15, and never in an argument; with no key,
 * or settings it cannot read, the script says why in the task's log and ends
 * before claude starts.
 */
export function scheduledKeyExports(baseUrl: string, setting: string, logPath: string): string {
  const read = 'try{const v=JSON.parse(require("fs").readFileSync(process.env.TARS_SETTINGS,"utf8"))[process.env.TARS_KEY_NAME];'
    + 'if(typeof v==="string"&&v.trim())process.stdout.write(v.trim())}catch(e){}';
  return [
    `export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}`,
    `TARS_NODE="${DATA_DIR_SHELL}/bin/tars-mcp-node"; [ -x "$TARS_NODE" ] || TARS_NODE=node`,
    `TARS_KEY="$(TARS_SETTINGS="${DATA_DIR_SHELL}/app-settings.json" TARS_KEY_NAME=${shellQuote(setting)} "$TARS_NODE" -e '${read}' 2>/dev/null)"`,
    'if [ -z "$TARS_KEY" ]; then',
    `  echo "=== Not run: no ${setting} in Tars's settings, or they could not be read. claude was not started, and nothing was sent to ${baseUrl} ===" >> ${shellQuote(logPath)}`,
    '  exit 1',
    'fi',
    'export ANTHROPIC_AUTH_TOKEN="$TARS_KEY" ANTHROPIC_API_KEY=""',
    'unset TARS_KEY TARS_NODE',
    '',
  ].join('\n');
}

export function safeEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  return EFFORT_VALUES.has(effort) ? effort : undefined;
}

/**
 * The agent's effort as the CLI's flag: every level Tars stores, medium too.
 *
 * Medium used to be left off, as if no flag meant medium. It means whatever the
 * CLI picks by itself, and Claude Code picks the effort last saved for that
 * model by `/effort` in any session on the machine. Measured on 2.1.280:
 * `/effort high` writes `modelSettings.<model>.effortLevel` into
 * ~/.claude/settings.json, and a later launch of that model without the flag
 * comes up at high. An agent set to medium therefore ran at whatever level
 * somebody last chose in another terminal. With the flag, each of low, medium,
 * high, xhigh and max comes up as passed, read back from the session header,
 * and the flag wins over the saved level.
 *
 * No effort on the agent, no flag: that one does mean the CLI's own. Shared by
 * the fourteen providers that run the claude binary, which each carried their
 * own copy of the medium exception.
 */
export function effortFlag(effort: string | undefined): string {
  const level = safeEffort(effort);
  return level ? ` --effort ${level}` : '';
}

/**
 * Pick a conversation up: `--resume <id>`, and with `--fork-session` continue
 * it under a new id. Verified against `claude --help`: `-r, --resume [value]`
 * takes a session id, and `--fork-session` is "When resuming, create a new
 * session ID instead of reusing the original". The caller passes only an id
 * whose transcript it has found (utils/resume-session.ts), because a missing
 * one makes the binary exit rather than start.
 *
 * Shared by the fourteen providers that run the claude binary. The thirteen
 * that point it at another vendor had no resume at all, so the restart that
 * applies a changed setting started them on a new conversation, silently (the
 * Audit's gate of #120). The binary resumes wherever it is pointed: measured
 * on 2.1.280 with ANTHROPIC_BASE_URL on a local Messages API, as those
 * providers set it, a session resumed with --fork-session sent the endpoint
 * its whole history under a new id, and a fresh one sent none.
 */
export function resumeFlags(resumeSessionId: string | undefined, forkSession: boolean | undefined): string {
  if (!resumeSessionId) return '';
  return ` --resume '${resumeSessionId}'${forkSession ? ' --fork-session' : ''}`;
}

/**
 * Whether a user-supplied string is a usable OpenAI-compatible base URL:
 * parses at all, and is http/https (not file:, not a bare host that `new
 * URL()` would otherwise reject, not a scheme fetch() cannot use). Used by
 * custom-openai-provider.ts to decide whether to wire the bridge up at all,
 * and by the Settings screen before it persists what was typed - the same
 * check on both sides of the IPC boundary rather than trusting the renderer.
 */
export function isValidOpenAIBaseUrl(value: string | undefined): boolean {
  if (!value || !value.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Credentials in the URL would be sent to whatever host it names, and end up
  // in logs and error messages. There is no OpenAI-compatible vendor that
  // authenticates this way - they all use the API key field beside this one.
  if (parsed.username || parsed.password) return false;

  // The link-local range is where every cloud provider parks its instance
  // metadata service (169.254.169.254 on AWS, GCP and Azure alike), and the
  // stored vendor key would be attached to the call. Nothing that serves
  // completions lives there.
  //
  // Loopback and the private LAN ranges are deliberately allowed: pointing
  // this at LM Studio on 127.0.0.1, or at a vLLM box on the LAN, is the main
  // reason the custom provider exists. Blocking them to say "SSRF" would
  // remove the feature and protect nothing the user did not choose.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^169\.254\./.test(host)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
  if (host === 'metadata.google.internal') return false;

  return true;
}
