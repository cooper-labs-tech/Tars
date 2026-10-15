import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { classifyInstall, locate } from './cli-updater';
import { readAppSettingsFromDisk } from '../providers/cli-provider';

/**
 * The state mod: Claude Code reports an agent's state to Tars from inside the
 * CLI (mods/tars-state/, a hooks module of Claude Code's function hooks).
 *
 * JeanBrasse's go of 2026-10-05, step 1 of ETUDE-MODS-CLAUDE-CODE.md. The mod posts
 * what the four shell hooks post (SessionStart's registration,
 * UserPromptSubmit's running, Stop's output and idle, StopFailure's error),
 * marked `via: 'mod'`, and a heartbeat every 15 s from the CLI's own event
 * loop. It reads and reports: it changes nothing in what the agent does.
 *
 * Measured on claude 2.1.289 (mods-study/ in the review folder): a module
 * loaded through CLAUDE_CODE_PLUGIN_DIRS sees `classic.SessionStart`,
 * `classic.UserPromptSubmit` and `classic.Stop` with the shell hooks' own
 * inputs, and the shell hooks still run when it calls `next`. The API is early
 * access: only a claude at that version or newer is handed the mod, and a
 * session that never registers through it keeps today's path, the shell hooks
 * and #283's stall rule, untouched.
 */

/** The first version the mod was measured on. */
export const MOD_MIN_CLAUDE = '2.1.289';

/** a >= b, for plain x.y.z versions; anything else (a pre-release, nothing) is not. */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/**
 * The environment a launch adds for the mod: the folder, after any the user
 * named, and the switch. Nothing for another CLI, an older or unknown claude,
 * or a build without the folder.
 */
export function stateModEnv(opts: {
  binaryName: string;
  version: string | null;
  dir: string;
  base: Record<string, string | undefined>;
}): Record<string, string> {
  if (opts.binaryName !== 'claude' || !opts.version || !versionAtLeast(opts.version, MOD_MIN_CLAUDE)) return {};
  if (!opts.dir || !fs.existsSync(opts.dir)) return {};
  const theirs = opts.base.CLAUDE_CODE_PLUGIN_DIRS;
  return {
    CLAUDE_CODE_PLUGIN_DIRS: theirs ? `${theirs}${path.delimiter}${opts.dir}` : opts.dir,
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
  };
}

/**
 * The version of the claude a launch runs, read the way the updater reads it
 * (cli-updater.ts): the path Settings names first, then `claude` on the
 * launch's PATH, followed to the native installer's versions/<x.y.z> or an npm
 * package's manifest. Null when none is found or its version cannot be read.
 */
export function launchedClaudeVersion(opts: { settingsPath: string | undefined; envPath: string }): string | null {
  const launcher = locate(opts.settingsPath || 'claude', opts.envPath);
  if (!launcher) return null;
  try {
    const install = classifyInstall(launcher);
    return install.kind === 'other' ? null : install.version;
  } catch {
    return null;
  }
}

/** Where the mod ships: beside the bundled MCP servers in a packaged app (extraResources), the repository's root otherwise. */
function shippedStateModDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mods', 'tars-state')
    : path.join(app.getAppPath(), 'mods', 'tars-state');
}

function setTree(dir: string, dirMode: number, fileMode: number): void {
  fs.chmodSync(dir, dirMode);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) setTree(p, dirMode, fileMode);
    else fs.chmodSync(p, fileMode);
  }
}

/** What Claude Code writes into a mod's folder at every load (measured on 2.1.289). */
const CLAUDE_WRITES = [['.claude-plugin', 'types'], ['tsconfig.json']];

/**
 * Copies the shipped mod to `target`, replacing what an earlier launch left
 * there. Measured on claude 2.1.289 (the Audit's delta gate of #308): Claude
 * Code writes `.claude-plugin/types/` and a tsconfig into a mod's folder at
 * every load, which from `process.resourcesPath` is inside the signed
 * Tars.app. In the copy the files are read-only and those two paths are empty
 * read-only folders already, so nothing can be written into the one or in
 * place of the other; the folders stay writable, so an ordinary recursive
 * delete still removes the copy (read-only folders made vitest's throwaway
 * home and every sandbox fail to clean up). Null, and no folder, when the
 * copy fails: the launch goes on without the mod.
 */
export function installStateMod(source: string, target: string): string | null {
  try {
    if (fs.existsSync(target)) {
      setTree(target, 0o755, 0o644);
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (!fs.statSync(source).isDirectory()) return null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // What the mod ships, not what claude wrote beside it in a folder it
    // could write to (the repository's, in a dev run): its declarations and
    // a tsconfig.
    const written = new Set(CLAUDE_WRITES.map(parts => path.join(source, ...parts)));
    fs.cpSync(source, target, { recursive: true, filter: from => !written.has(from) });
    setTree(target, 0o755, 0o444);
    for (const parts of CLAUDE_WRITES) {
      const sentinel = path.join(target, ...parts);
      fs.mkdirSync(sentinel, { recursive: true });
      fs.chmodSync(sentinel, 0o555);
    }
    return target;
  } catch (err) {
    console.warn(`[state-mod] could not install the mod at ${target}: ${err instanceof Error ? err.message : String(err)}`);
    try {
      if (fs.existsSync(target)) {
        setTree(target, 0o755, 0o644);
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch { /* nothing more to do: the folder is not handed */ }
    return null;
  }
}

let installed: string | null | undefined;

/**
 * The folder handed to claude: a read-only copy of the shipped mod in Tars's
 * own userData, made once per run. Not the bundle, which claude would write
 * into, and not ~/.dorothy, which every agent is handed and could change the
 * code that runs inside every other agent's claude. Empty when it could not
 * be made, and stateModEnv then hands nothing.
 */
export function stateModDir(): string {
  if (installed === undefined) installed = installStateMod(shippedStateModDir(), path.join(app.getPath('userData'), 'mods', 'tars-state'));
  return installed ?? '';
}

/**
 * What an agent terminal's launch adds (spawnAgentPty): the mod for a claude
 * at the measured version or newer, nothing otherwise. Never throws: a launch
 * does not fail for want of the mod, it keeps today's path.
 */
export function stateModLaunchEnv(binaryName: string, env: Record<string, string | undefined>): Record<string, string> {
  if (binaryName !== 'claude') return {};
  try {
    const version = launchedClaudeVersion({ settingsPath: readAppSettingsFromDisk().cliPaths?.claude, envPath: env.PATH ?? '' });
    return stateModEnv({ binaryName, version, dir: stateModDir(), base: env });
  } catch {
    return {};
  }
}

/** Each agent's session that runs the mod, and its last heartbeat. In memory only. */
const sessions = new Map<string, { sessionId: string; at: number; tool: string | null }>();

/** The mod registered this session for this agent: the shell hooks' four posts are set aside for it. */
export function noteModSession(agentId: string, sessionId: string, at: number = Date.now()): void {
  sessions.set(agentId, { sessionId, at, tool: null });
}

export function modRunsSession(agentId: string, sessionId: string | undefined): boolean {
  return !!sessionId && sessions.get(agentId)?.sessionId === sessionId;
}

/** A heartbeat, kept only for the agent's mod session. */
export function noteModBeat(agentId: string, sessionId: string, tool: string | null, at: number = Date.now()): boolean {
  const known = sessions.get(agentId);
  if (!known || known.sessionId !== sessionId) return false;
  sessions.set(agentId, { sessionId, at, tool });
  return true;
}

export function modBeatFor(agentId: string): { sessionId: string; at: number; tool: string | null } | undefined {
  return sessions.get(agentId);
}

/** Test seam. */
export function resetStateMod(): void {
  sessions.clear();
}
