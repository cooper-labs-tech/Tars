import * as path from 'path';
import { defaultShell } from '../utils/default-shell';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';
import { findOnPath } from './cli-binary';

/**
 * The shell a human terminal runs (the quick terminal, `pty:create`, the
 * installers), and its arguments. On Windows an agent gets no shell at all:
 * its CLI is the terminal's own process (see launch.ts).
 *
 * darwin/linux: the user's setting when it is an absolute path (Settings >
 * Terminal: a shell /etc/shells lists, or a path typed in), else
 * defaultShell(), $SHELL; with ['-l']. A setting that is no absolute path (a
 * Windows path, a bare name, a relative one) is no shell there.
 * win32: the user's setting, else pwsh.exe (PowerShell 7) when it is on the
 * PATH, else Windows PowerShell 5.1, else %ComSpec%. SHELL is ignored there:
 * started from Git Bash it reads /usr/bin/bash, which node-pty cannot spawn.
 */
export function resolveShell(opts: {
  env?: Env;
  platform?: NodeJS.Platform;
  /** The user's choice: a path, or on win32 a name on the PATH too. */
  setting?: string;
  fs?: FsProbe;
} = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    const chosen = opts.setting?.trim();
    if (chosen && path.posix.isAbsolute(chosen)) return chosen;
    // defaultShell reads SHELL alone; the cast only drops Next's NODE_ENV typing.
    return defaultShell(env as NodeJS.ProcessEnv, platform);
  }
  const fs = opts.fs ?? realFs;
  const w = path.win32;

  const setting = opts.setting?.trim();
  if (setting) {
    if (/[\\/]/.test(setting)) return setting;
    // A bare name: node-pty applies no PATHEXT, so find it here. Not found,
    // the word as typed, so the spawn error names what the user wrote.
    const names = w.extname(setting) ? [setting] : [`${setting}.exe`, `${setting}.com`];
    for (const n of names) {
      const found = findOnPath(n, env, fs);
      if (found) return found;
    }
    return setting;
  }

  const pwsh = findOnPath('pwsh.exe', env, fs);
  if (pwsh) return pwsh;
  const systemRoot = envValue(env, 'SystemRoot', 'win32') || 'C:\\Windows';
  const powershell = findOnPath('powershell.exe', env, fs)
    ?? [w.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find((p) => fs.isFile(p));
  if (powershell) return powershell;
  return envValue(env, 'ComSpec', 'win32') || w.join(systemRoot, 'System32', 'cmd.exe');
}

/**
 * The arguments a shell starts with. darwin/linux: ['-l'] whatever the shell,
 * as today (pwsh and fish take it there). win32: -l for bash and zsh (Git
 * Bash, MSYS2), -NoLogo for PowerShell, nothing for cmd.exe or anything else.
 */
export function shellArgs(shell: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['-l'];
  const name = path.win32.basename(shell.trim().replace(/^"|"$/g, '')).toLowerCase().replace(/\.(exe|com)$/, '');
  if (name === 'bash' || name === 'zsh') return ['-l'];
  if (name === 'pwsh' || name === 'powershell') return ['-NoLogo'];
  return [];
}

/**
 * The shell an agent's terminal waits in until its CLI starts.
 *
 * darwin/linux: `/bin/bash -l`, as always, since the launch line typed into it
 * is bash. win32: Tars types nothing into it (a start replaces it with the
 * CLI), so it is the shell a person gets there, the user's terminalShell
 * setting first, with that shell's own arguments.
 */
export function agentShell(opts: {
  setting?: string;
  platform?: NodeJS.Platform;
  env?: Env;
  fs?: FsProbe;
} = {}): { shell: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { shell: '/bin/bash', args: ['-l'] };
  const shell = resolveShell({ ...opts, platform });
  return { shell, args: shellArgs(shell, platform) };
}
