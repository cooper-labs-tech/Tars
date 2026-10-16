import * as fsNode from 'fs';
import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';
import { findOnPath, isPlainAbsolute } from './cli-binary';
import { resolveShell } from './shell';

/**
 * The shells Settings > Terminal offers, and the one a terminal gets when the
 * user picked none (resolveShell's own answer).
 *
 * win32: PowerShell 7, Windows PowerShell and the Command Prompt are always
 * listed, with a null path when missing, so the list reads the same on every
 * machine; Git Bash only when it is installed.
 * darwin/linux (since 2.0.4, the parity program's P3): the login shells
 * /etc/shells lists that are on the disk, one per file (a merged /usr lists
 * /bin/bash and /usr/bin/bash, one file), in its order; not the programs it
 * lists that are no terminal for a person. No /etc/shells: none, the default
 * alone.
 */
export type WindowsShellId = 'pwsh' | 'powershell' | 'cmd' | 'git-bash';
/** win32: a WindowsShellId. darwin/linux: the shell's path, since two shells may share a name (Apple's bash, Homebrew's). */
export type ShellChoiceId = WindowsShellId | (string & {});

export interface ShellChoice {
  id: ShellChoiceId;
  /** The executable, or null when it is not installed. */
  path: string | null;
  /** darwin/linux: the shell's own name (zsh, bash, fish). Windows names its shells in the window. */
  name?: string;
}

export interface DetectedShells {
  /** What a terminal starts with no setting: resolveShell's own answer. */
  defaultPath: string;
  choices: ShellChoice[];
}

const w = path.win32;

/** /etc/shells lists them, and none is a terminal for a person: restricted shells, multiplexers, refusals. */
const NOT_A_TERMINAL = new Set(['rbash', 'rksh', 'rzsh', 'tmux', 'screen', 'byobu', 'nologin', 'false', 'true', 'git-shell']);

function posixShells(platform: NodeJS.Platform, env: Env, fs: FsProbe, realpath: (p: string) => string): DetectedShells {
  let listed: string[] = [];
  try {
    listed = fs.readFile('/etc/shells').split('\n');
  } catch {
    // None listed: the row offers its default alone.
  }
  const files = new Set<string>();
  const choices: ShellChoice[] = [];
  for (const line of listed) {
    const entry = line.replace(/#.*$/, '').trim();
    if (!entry.startsWith('/')) continue;
    const name = path.posix.basename(entry);
    if (NOT_A_TERMINAL.has(name) || !fs.isFile(entry)) continue;
    let file = entry;
    try { file = realpath(entry); } catch { /* the entry itself */ }
    if (files.has(file)) continue;
    files.add(file);
    choices.push({ id: entry, path: entry, name });
  }
  return { defaultPath: resolveShell({ platform, env, fs }), choices };
}

export function detectShells(opts: {
  platform?: NodeJS.Platform;
  env?: Env;
  fs?: FsProbe;
  /** darwin/linux: where a link leads, to offer each shell file once. */
  realpath?: (p: string) => string;
} = {}): DetectedShells | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? realFs;
  if (platform !== 'win32') return posixShells(platform, env, fs, opts.realpath ?? ((p) => fsNode.realpathSync(p)));
  // A folder or file the environment names counts only as a plain absolute
  // path: a relative one would be found against the working directory.
  const read = (name: string) => {
    const value = envValue(env, name, 'win32');
    return value && isPlainAbsolute(value) ? value : undefined;
  };
  const firstFile = (candidates: (string | undefined)[]) =>
    candidates.find((p): p is string => !!p && fs.isFile(p)) ?? null;

  const systemRoot = read('SystemRoot') || 'C:\\Windows';
  const programDirs = [read('ProgramW6432'), read('ProgramFiles'), read('ProgramFiles(x86)')]
    .filter((d): d is string => !!d);
  const localAppData = read('LOCALAPPDATA');

  const pwsh = findOnPath('pwsh.exe', env, fs)
    ?? firstFile(programDirs.map((d) => w.join(d, 'PowerShell', '7', 'pwsh.exe')));
  const powershell = findOnPath('powershell.exe', env, fs)
    ?? firstFile([w.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
  const cmd = firstFile([read('ComSpec'), w.join(systemRoot, 'System32', 'cmd.exe')]);

  // Git Bash is bin\bash.exe of a Git for Windows install, found from where
  // Git lives: Program Files, the per-user folder, or the root of the Git
  // layout (cmd\, bin\ or mingw64\bin\) around a git.exe on the PATH. bash.exe
  // itself is never looked up on the PATH: the first one there is System32's,
  // the WSL launcher, which is not Git Bash.
  const gitOnPath = findOnPath('git.exe', env, fs);
  const gitRoots = [
    ...programDirs.map((d) => w.join(d, 'Git')),
    ...(localAppData ? [w.join(localAppData, 'Programs', 'Git')] : []),
  ];
  if (gitOnPath) {
    const dir = w.dirname(gitOnPath);
    const leaf = w.basename(dir).toLowerCase();
    if (leaf === 'cmd' || leaf === 'bin') gitRoots.push(w.dirname(dir));
    if (leaf === 'bin' && w.basename(w.dirname(dir)).toLowerCase() === 'mingw64') gitRoots.push(w.dirname(w.dirname(dir)));
  }
  const gitBash = firstFile(gitRoots.map((r) => w.join(r, 'bin', 'bash.exe')));

  const choices: ShellChoice[] = [
    { id: 'pwsh', path: pwsh },
    { id: 'powershell', path: powershell },
    { id: 'cmd', path: cmd },
  ];
  if (gitBash) choices.push({ id: 'git-bash', path: gitBash });

  return { defaultPath: resolveShell({ platform: 'win32', env, fs }), choices };
}
