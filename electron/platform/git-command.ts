import { realFs, type Env, type FsProbe } from './fs-probe';
import { findOnPath } from './cli-binary';
import { getPath } from './path-env';

/**
 * Which git Tars starts, and the variable that keeps Windows from running a
 * program out of the folder it is started in.
 *
 * Node on Windows looks a bare name up in the folder a program is started in
 * before the PATH (libuv's search_path), and Tars starts git in a project's
 * folder: a repository that carries a git.exe of its own would have it run,
 * by the status line every 5 s and as soon as the project is listed. Measured
 * on 2026-10-13 (Node 22.23 with libuv 1.51, Electron 44 with libuv 1.52):
 * execFileSync('git', args, { cwd }) ran a git.exe planted in cwd;
 * NoDefaultCurrentDirectoryInExePath=1 in the child's env did not stop it, in
 * the starting process's own env it did.
 */

let cached: { pathValue: string; file: string } | undefined;

/**
 * darwin/linux: `git`, as always. win32: the full path of the first git.exe
 * on the PATH, looked up again only when the PATH changed; the bare name when
 * there is none, which then fails as a missing git does, since Tars turns the
 * current-folder lookup off in its own environment (currentFolderLookupsOff).
 */
export function gitCommand(env: Env = process.env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs): string {
  if (platform !== 'win32') return 'git';
  const pathValue = getPath(env, 'win32') ?? '';
  if (fs === realFs && cached?.pathValue === pathValue) return cached.file;
  const file = findOnPath('git.exe', env, fs) ?? 'git';
  if (fs === realFs) cached = { pathValue, file };
  return file;
}

/**
 * What a process's environment needs on win32 for a bare name not to be
 * looked up in the current folder: by Tars itself (main.ts), which then
 * starts nothing out of a project's folder, and by the agents' CLIs, which
 * look up git and rg the same way. darwin/linux never do such a lookup: none.
 */
export function currentFolderLookupsOff(platform: NodeJS.Platform = process.platform): Env {
  return platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {};
}
