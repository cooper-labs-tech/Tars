import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { pathEntries } from './path-env';
import { buildFullPath } from '../utils/path-builder';

/** What the .sh hooks run: jq reads the JSON a CLI hands them, curl posts it to Tars. */
const HOOK_TOOLS = ['jq', 'curl'] as const;

/**
 * What Tars says at launch on macOS and Linux when jq or curl is missing, or
 * null: nodeMissing's counterpart (the parity audit's G2).
 *
 * There the agents' hooks are the .sh scripts of hooks/. Without jq each one
 * posts an empty session_id, which the API refuses, so no session registers,
 * the status does not move, and nothing said why. macOS 13 and 14 ship no jq,
 * and most Linux desktops install neither. win32 runs the Node hooks: null,
 * and nothing is read.
 *
 * `env` is Tars's own environment. The tools are looked up on the PATH its
 * agents' terminals get from it (buildFullPath, as agent-manager builds
 * theirs), in its absolute entries: a Tars opened from the Finder has
 * launchd's bare PATH, without Homebrew's folder, where the agents' has it.
 */
export function hookToolsMissing(env: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs): { message: string; detail: string } | null {
  if (platform === 'win32') return null;
  const agentsPath = buildFullPath([], { env: env as NodeJS.ProcessEnv, platform });
  const dirs = pathEntries(agentsPath, platform).filter((dir) => path.posix.isAbsolute(dir));
  const missing = HOOK_TOOLS.filter((tool) => !dirs.some((dir) => fs.isFile(path.posix.join(dir, tool))));
  if (!missing.length) return null;
  const names = missing.join(' and ');
  const both = missing.length > 1;
  const them = both ? 'them' : 'it';
  const packages = missing.join(' ');
  const install = platform === 'darwin'
    ? `Install ${them} with Homebrew (brew install ${packages})`
    : `Install ${them} with your package manager (sudo apt install ${packages}, or sudo dnf install ${packages})`;
  return {
    message: `${names} ${both ? 'are' : 'is'} not installed`,
    detail: `Tars runs its agents' hooks with jq and curl, and found ${both ? 'neither jq nor curl' : `no ${names}`} on the PATH its agents get. `
      + `Until ${both ? 'they are' : 'it is'} installed, those hooks post nothing, so Tars cannot follow most agents' status. `
      + `${install}, then restart Tars.`,
  };
}
