import {
  execFile, execFileSync, type ExecFileOptionsWithStringEncoding, type ExecFileSyncOptionsWithStringEncoding,
} from 'child_process';
import { promisify } from 'util';
import {
  cliEnv, realFs, resolveCliBinary,
  type CliBinaryFailure, type Env, type FsProbe,
} from '../platform';

/**
 * How Tars runs a CLI outside an agent's PTY, and finds one on Windows.
 *
 * Registering an MCP server (`claude mcp add`, `codex mcp add`, ...), asking
 * `claude mcp list`, the kanban's one-shot `claude -p`, `gws auth status`:
 * each used to hand a bare name to execFile, or a whole line to a shell. On
 * Windows the bare name finds only a .exe (libuv skips PATHEXT), so every npm
 * install (claude.cmd, codex.cmd) was ENOENT and the error was swallowed; and
 * a line handed to cmd.exe is split and expanded. Here the name goes through
 * the platform layer's resolveCliBinary and the CLI is started with execFile
 * and an argv: `file` is a .exe or node.exe, and an npm shim's script goes in
 * front of the arguments, with no console window (windowsHide): Tars is a
 * GUI program, and each CLI started from it would flash one. darwin and linux
 * get the name as given and the options as given, which is what execFile got
 * before, byte for byte.
 *
 * The environment (cliEnv), the MCP stdio command (stdioServerCommand,
 * nodeServerCommand) and the Windows lookup (windowsCliFile, findWindowsCli,
 * windowsCliDirs, windowsGcloudDirs) live in electron/platform, and are
 * re-exported here for the callers that import them from this file.
 */
export {
  cliEnv, stdioServerCommand, nodeServerCommand,
  windowsCliFile, findWindowsCli, windowsCliDirs, windowsGcloudDirs, type CliLookup,
} from '../platform';

/** Why a CLI cannot be started: the resolver's answer, kept whole for the log. */
export class CliNotRunnableError extends Error {
  readonly failure: CliBinaryFailure;
  constructor(failure: CliBinaryFailure) {
    super(`${failure.name} cannot be started (${failure.reason}): ${failure.detail}`);
    this.name = 'CliNotRunnableError';
    this.failure = failure;
  }
}

/** The file to start for `name` and the argv it gets. Throws CliNotRunnableError. */
export function cliInvocation(
  name: string, args: readonly string[], env: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs,
): { file: string; args: string[] } {
  const binary = resolveCliBinary(name, env, platform, fs);
  if (!binary.ok) throw new CliNotRunnableError(binary);
  return { file: binary.file, args: [...binary.prefixArgs, ...args] };
}

function prepare<O extends { env?: NodeJS.ProcessEnv }>(name: string, args: readonly string[], options: O) {
  const platform = process.platform;
  const env = options.env ?? (cliEnv(platform) as NodeJS.ProcessEnv | undefined);
  const invocation = cliInvocation(name, args, env ?? process.env, platform);
  if (platform === 'win32') return { ...invocation, options: { ...options, env, windowsHide: true } };
  return { ...invocation, options: env === options.env ? options : { ...options, env } };
}

/**
 * How long a synchronous CLI call (`mcp add`, `mcp remove`) is waited for when its caller names no time. It blocks the
 * main thread, which paints the window and pumps every terminal, so a CLI that hangs froze Tars for good (27/11). A
 * `claude mcp add` takes about a second; past this, the child is ended and the call throws, as on any failure.
 */
const SYNC_CLI_TIMEOUT_MS = 20_000;

/** execFileSync for a CLI named or configured by the user. Throws CliNotRunnableError before any spawn. */
export function execCliSync(name: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  const run = prepare(name, args, options.timeout === undefined ? { ...options, timeout: SYNC_CLI_TIMEOUT_MS } : options);
  return execFileSync(run.file, run.args, run.options);
}

/** execFile (promisified) for a CLI. Rejects with CliNotRunnableError before any spawn. */
export async function execCli(
  name: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  const run = prepare(name, args, options);
  // Promisified here, not at load: a module that only needs the sync path
  // (the providers) does not need execFile to exist.
  return promisify(execFile)(run.file, run.args, run.options);
}

/** One line for a log: the resolver's reason, or the first line of the spawn error. */
export function cliFailureText(err: unknown): string {
  if (err instanceof CliNotRunnableError) return err.message;
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0];
}

