import { realFs, type Env, type FsProbe } from './fs-probe';
import { findOnPath } from './cli-binary';

/**
 * What Tars says at launch on Windows when Node is missing, or null.
 *
 * On win32 Tars's hooks run as `node "<runner>" <event>` (utils/hook-command.ts)
 * and its bundled MCP servers as `node <bundle>` (utils/mcp-node.ts), so both
 * need a node.exe on the PATH the agents get. With a native claude.exe and no
 * Node, the CLI starts, no session registers and the tools do not start, and
 * nothing said why. darwin/linux run the .sh hooks: null, and nothing is read.
 */
export function nodeMissing(env: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs): { message: string; detail: string } | null {
  if (platform !== 'win32' || findOnPath('node.exe', env, fs)) return null;
  return {
    message: 'Node.js is not installed',
    detail: 'Tars runs its hooks and its own tools (orchestrator, memory, kanban, vault) on Node.js, and found no node.exe on the PATH its agents get. '
      + 'Until it is installed, agents start, but Tars cannot see their status, and their Tars tools do not start. '
      + 'Install Node.js 22 or later from nodejs.org, then restart Tars.',
  };
}
