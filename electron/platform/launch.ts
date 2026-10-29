import { realFs, type Env, type FsProbe } from './fs-probe';
import { getPath, withPath } from './path-env';
import { posixWords, PosixWordsError } from './posix-words';
import { resolveCliBinary, type CliBinaryFailure } from './cli-binary';
import { buildWindowsCommandLine, quoteWindowsArg, WindowsCommandLineError } from './windows-command-line';

/**
 * A provider's command as the thing an agent's PTY runs.
 *
 * darwin/linux: today's shape, byte for byte, nothing parsed. The API path
 * (agent-routes.ts spawnAgentSession) spawns `/bin/bash -l -c "cd '<dir>' &&
 * exec <cmd>"`; the typed paths (ipc-handlers.ts agent:start, bot-core.ts
 * typeLaunch) type `cd '<dir>' && <cmd>` into a shell already running. Both
 * are returned, the caller picks the one it uses today.
 *
 * win32: no shell, no `cd`, nothing typed. The command is read back into argv
 * (posix-words.ts), its binary resolved against the env the child gets
 * (cli-binary.ts: a .exe, or node.exe plus an npm shim's script), and the
 * Windows command line built by us (windows-command-line.ts) for node-pty,
 * which starts the CLI itself in `cwd` through ConPTY. A prompt's newlines
 * therefore stay inside one argument and never reach a shell as lines. The
 * caller spawns `spawnPty(file, commandLine, { cwd, env })` (core/pty-spawn.ts).
 */

export interface PosixLaunch {
  platform: 'posix';
  shell: '/bin/bash';
  /** For a PTY spawned to run the CLI: `-l -c "cd '<dir>' && exec <cmd>"`. */
  args: ['-l', '-c', string];
  /** For a shell already running: `cd '<dir>' && <cmd>`, typed. */
  typedLine: string;
  cwd: string;
  /** The env passed in, the same object. */
  env: Env;
}

export interface DirectLaunch {
  platform: 'win32';
  /** The executable, absolute: node-pty's `file`. */
  file: string;
  /** The arguments as one string, quoted: node-pty's `args`, appended as is after `file`. */
  commandLine: string;
  /** [file, ...arguments], what the CLI receives, for logs and tests. */
  argv: string[];
  cwd: string;
  /** A copy of the env with PATH under one key (see path-env.ts withPath). */
  env: Env;
  /** The PTY's process is the CLI: what spawnAgentPty records, as `-c` said it before. */
  runsCommand: true;
}

export type Launch = PosixLaunch | DirectLaunch;

export type LaunchErrorCode = 'command-grammar' | 'binary' | 'command-line';

export class LaunchError extends Error {
  constructor(
    readonly code: LaunchErrorCode,
    message: string,
    cause?: unknown,
    /** The resolver's answer, for code 'binary'. */
    readonly binary?: CliBinaryFailure,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LaunchError';
  }
}

export function toLaunch(
  cliCommand: string,
  cwd: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
  deps: { fs?: FsProbe } = {},
): Launch {
  if (platform !== 'win32') {
    const quotedDir = cwd.replace(/'/g, "'\\''");
    return {
      platform: 'posix',
      shell: '/bin/bash',
      args: ['-l', '-c', `cd '${quotedDir}' && exec ${cliCommand}`],
      typedLine: `cd '${quotedDir}' && ${cliCommand}`,
      cwd,
      env,
    };
  }

  let words: string[];
  try {
    words = posixWords(cliCommand);
  } catch (err) {
    if (!(err instanceof PosixWordsError)) throw err;
    throw new LaunchError('command-grammar', `The CLI command cannot be launched without a shell: ${err.message}`, err);
  }

  const childPath = getPath(env, 'win32');
  const childEnv = childPath === undefined ? { ...env } : withPath(env, childPath, 'win32');
  const binary = resolveCliBinary(words[0], childEnv, 'win32', deps.fs ?? realFs);
  if (!binary.ok) throw new LaunchError('binary', `Cannot start ${words[0]}: ${binary.detail}`, undefined, binary);

  const args = [...binary.prefixArgs, ...words.slice(1)];
  try {
    buildWindowsCommandLine([binary.file, ...args]);
  } catch (err) {
    if (!(err instanceof WindowsCommandLineError)) throw err;
    throw new LaunchError('command-line', err.message, err);
  }

  return {
    platform: 'win32',
    file: binary.file,
    commandLine: args.map(quoteWindowsArg).join(' '),
    argv: [binary.file, ...args],
    cwd,
    env: childEnv,
    runsCommand: true,
  };
}
