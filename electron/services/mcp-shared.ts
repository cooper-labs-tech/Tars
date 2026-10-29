import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { updateSharedJsonSync, type SharedJsonOutcome } from '../utils/shared-file';

/**
 * Tars's MCP servers shared between agents (2.0.5, lot 3 item G, the second step; reports/lot3-shared-mcp-servers-2810.md).
 *
 * Measured on 28/10: 19 agents ran 133 copies of the seven servers, 20 to 25 MB each, 2.75 GB in all. Six of them keep
 * nothing between calls (each call is a request to Tars's API with its agent's token), so one process each serves
 * every agent:
 * - Tars starts it with TARS_MCP_SHARED=1 (mcp-shared/src/shared-host.ts), writes a secret on its stdin, and reads
 *   the loopback port it listens on from its stdout. It ends when Tars closes its stdin, and is started again when it
 *   ends on its own.
 * - An agent's CLI reaches it through Tars's API, /api/mcp/<server> (api-routes/mcp-routes.ts): authenticated like
 *   every route under /api/, so the caller is the agent its own token names, and Tars hands the server that agent's
 *   identity from its fleet. The token is in no command line and no file: claude's config names the variable, and
 *   claude expands it from its own environment (measured on 2.1.312).
 * - Tars's own telegram server is gone since 2.0.5 (Telegram goes through Hermes, services/hermes-relay-switch.ts):
 *   the six above are every server Tars ships.
 * - The CLIs that cannot read such an entry (codex, gemini, qwen, opencode, pi, amp, grok) keep their per-agent
 *   copies, registered as before.
 */

/** The servers one process serves for every agent: all six Tars ships. */
export const SHARED_MCP_SERVERS: readonly string[] = [
  'claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x',
];

/**
 * An orchestrator's only (the owner's decision of 28/10): never in a worker's role file, and refused to one at the door.
 * `claude-mgr-telegram` is no longer shipped; it stays listed so a stale entry a 2.0.4 left never reaches a worker.
 */
export const ORCHESTRATOR_ONLY_MCP: readonly string[] = ['claude-mgr-telegram', 'dorothy-x'];

/** Each shared server's folder in the app's resources: how Tars's own per-agent copy is told from one the owner added. */
const BUNDLE_DIR: Record<string, string> = {
  'claude-mgr-orchestrator': 'mcp-orchestrator', 'tars-memory': 'mcp-memory', 'claude-mgr-kanban': 'mcp-kanban',
  'claude-mgr-vault': 'mcp-vault', 'dorothy-socialdata': 'mcp-socialdata', 'dorothy-x': 'mcp-x',
};

type Target = { port: number; secret: string };
type Host = { child?: ChildProcess; target?: Target; restarts: number[]; stopping: boolean; bundle: string; onGiveUp?: (name: string) => void };
const hosts = new Map<string, Host>();
const tests = new Map<string, Target | undefined>();

/** Where a shared server answers Tars, or undefined while it is not running. */
export function sharedMcpTarget(name: string): Target | undefined {
  if (tests.has(name)) return tests.get(name);
  return hosts.get(name)?.target;
}

/** Test seam: a stand-in of a running server, or none. */
export function setSharedMcpTarget(name: string, target: Target | undefined): void {
  tests.set(name, target);
}

const START_WAIT_MS = 15_000;
const RESTARTS_PER_MINUTE = 5;

function startOne(name: string, host: Host, env: { apiUrl: string; instanceId: string }): Promise<boolean> {
  const secret = crypto.randomBytes(32).toString('hex');
  // On the app's own Node (as tars-slot and the hooks run), with nothing of Tars's environment but what it needs: no
  // agent's identity and no token, which come with each call.
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? '', HOME: os.homedir(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ELECTRON_RUN_AS_NODE: '1', TARS_MCP_SHARED: '1', CLAUDE_MGR_API_URL: env.apiUrl, TARS_INSTANCE_ID: env.instanceId,
  };
  const child: ChildProcess = spawn(process.execPath, [host.bundle], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  host.child = child;
  host.target = undefined;
  child.stdin?.write(`${secret}\n`);
  child.stderr?.on('data', d => console.log(`[mcp-shared] ${name}: ${String(d).trim()}`));
  return new Promise<boolean>(resolve => {
    let said = '';
    const timer = setTimeout(() => { console.warn(`[mcp-shared] ${name} did not say its port in ${START_WAIT_MS / 1000} s`); resolve(false); }, START_WAIT_MS);
    child.stdout?.on('data', d => {
      said += d;
      const m = /listening (\d+)/.exec(said);
      if (m && !host.target) {
        clearTimeout(timer);
        host.target = { port: Number(m[1]), secret };
        resolve(true);
      }
    });
    child.on('error', err => { clearTimeout(timer); console.warn(`[mcp-shared] ${name} did not start:`, err); resolve(false); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (host.child !== child) return;
      host.child = undefined;
      host.target = undefined;
      resolve(false);
      if (host.stopping) return;
      // Ended on its own: started again, at most five times a minute, so a broken bundle does not spin.
      const now = Date.now();
      host.restarts = host.restarts.filter(t => now - t < 60_000);
      if (host.restarts.length >= RESTARTS_PER_MINUTE) {
        console.warn(`[mcp-shared] ${name} ended ${RESTARTS_PER_MINUTE} times in a minute (last ${code}): not started again`);
        // Its entries go, and claude gets its per-agent copy back (the Audit's L1 on #541).
        host.onGiveUp?.(name);
        return;
      }
      host.restarts.push(now);
      console.warn(`[mcp-shared] ${name} ended (${code}): started again`);
      void startOne(name, host, env);
    });
  });
}

/**
 * Starts every shared server whose bundle is there and is not running yet; resolves with those that answer.
 * `bundles` names each server's bundle (mcp-orchestrator.ts resolves them under the app's resources).
 */
export async function ensureSharedMcp(
  bundles: Record<string, string>,
  env: { apiUrl: string; instanceId: string },
  /** A server that gives up after its start: what the registration does then. */
  onGiveUp?: (name: string) => void,
): Promise<string[]> {
  const running: string[] = [];
  await Promise.all(SHARED_MCP_SERVERS.map(async name => {
    const bundle = bundles[name];
    if (!bundle || !fs.existsSync(bundle)) return;
    let host = hosts.get(name);
    if (host?.target && host.bundle === bundle) { running.push(name); return; }
    if (host?.child) { host.stopping = true; host.child.kill(); }
    host = { bundle, restarts: [], stopping: false, ...(onGiveUp ? { onGiveUp } : {}) };
    hosts.set(name, host);
    if (await startOne(name, host, env)) running.push(name);
  }));
  return running;
}

/** The quit: every shared server is told by its stdin closing, and stopped by its own pid. */
export function stopSharedMcp(): void {
  for (const host of hosts.values()) {
    host.stopping = true;
    host.child?.stdin?.end();
    host.child?.kill();
  }
  hosts.clear();
}

/** A shared server's entry in claude's config: this Tars's API, the token named by its variable, never written. */
export function sharedMcpEntry(apiUrl: string, name: string): { type: 'http'; url: string; headers: { Authorization: string } } {
  return { type: 'http', url: `${apiUrl}/api/mcp/${name}`, headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } };
}

type Servers = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type ConfigFiles = { claudeJson: string; mcpDir: string };
const DEFAULT_FILES = (): ConfigFiles => ({ claudeJson: path.join(os.homedir(), '.claude.json'), mcpDir: path.join(os.homedir(), '.claude') });

/** The role files claude agents are started with: mcp.json (made when missing), and a worker's own when there is one. */
function roleFiles(files: ConfigFiles): Array<{ file: string; worker: boolean; make: boolean }> {
  return [
    { file: path.join(files.mcpDir, 'mcp.json'), worker: false, make: true },
    { file: path.join(files.mcpDir, 'mcp-worker.json'), worker: true, make: false },
  ];
}

/** Tars's own per-agent copy of a shared server: a stdio entry running that server's bundle from Tars's resources. */
function tarsCopy(name: string, entry: unknown): boolean {
  const args = (entry as { args?: unknown } | undefined)?.args;
  const last = Array.isArray(args) ? args[args.length - 1] : undefined;
  return typeof last === 'string' && last.replace(/\\/g, '/').endsWith(`/${BUNDLE_DIR[name]}/dist/bundle.js`);
}

/**
 * The shared servers into the role files claude agents are started with (--mcp-config): ~/.claude/mcp.json, and
 * mcp-worker.json where there is one, without the orchestrator-only servers. Never into ~/.claude.json, the user
 * scope every claude session loads whatever its --mcp-config says (a worker would get x back, and the owner's own
 * sessions would warn of a missing variable: the Audit's M3 on #541), whose Tars copies of the shared servers go
 * instead. Nothing else in any file changes, a file that does not parse is left alone, an unchanged file is not
 * written.
 */
export function writeSharedMcpEntries(
  apiUrl: string,
  files: ConfigFiles = DEFAULT_FILES(),
  names: readonly string[] = SHARED_MCP_SERVERS,
): SharedJsonOutcome | 'unchanged' {
  let changed = false;
  let failed: SharedJsonOutcome | undefined;
  const note = (o: SharedJsonOutcome) => { if (o === 'written') changed = true; if (o === 'unreadable' || o === 'busy') failed ??= o; };
  for (const { file, worker, make } of roleFiles(files)) {
    if (!make && !fs.existsSync(file)) continue;
    note(updateSharedJsonSync<{ mcpServers?: Servers; [key: string]: unknown }>(file, current => {
      const cfg = current ?? {};
      const servers: Servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
      let here = false;
      for (const name of names) {
        if (worker && ORCHESTRATOR_ONLY_MCP.includes(name)) {
          if (name in servers) { delete servers[name]; here = true; }
          continue;
        }
        const entry = sharedMcpEntry(apiUrl, name);
        if (!same(servers[name], entry)) { servers[name] = entry; here = true; }
      }
      if (!here) return undefined;
      cfg.mcpServers = servers;
      return cfg;
    }));
  }
  if (fs.existsSync(files.claudeJson)) {
    note(updateSharedJsonSync<{ mcpServers?: Servers; [key: string]: unknown }>(files.claudeJson, current => {
      const servers = current?.mcpServers;
      if (!current || !servers || typeof servers !== 'object') return undefined;
      let here = false;
      for (const name of names) if (tarsCopy(name, servers[name])) { delete servers[name]; here = true; }
      return here ? current : undefined;
    }));
  }
  if (failed) return failed;
  return changed ? 'written' : 'unchanged';
}

/**
 * Claude's per-agent copy of a shared server that gave up, where its shared entry was (the Audit's L2 on #541): in
 * mcp.json, and in mcp-worker.json only for a server workers may have. Never through `claude mcp add -s user`, into
 * ~/.claude.json, which every claude session loads, workers and the owner's own included. An entry under that name
 * that is not Tars's (another program, another bundle) is left as it is.
 */
export function writeClaudeCopy(name: string, command: string, args: string[], files: ConfigFiles = DEFAULT_FILES()): void {
  for (const { file, worker, make } of roleFiles(files)) {
    if (worker && ORCHESTRATOR_ONLY_MCP.includes(name)) continue;
    if (!make && !fs.existsSync(file)) continue;
    updateSharedJsonSync<{ mcpServers?: Servers; [key: string]: unknown }>(file, current => {
      const cfg = current ?? {};
      const servers: Servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
      if (servers[name] && !tarsCopy(name, servers[name])) return undefined;
      const entry = { command, args };
      if (same(servers[name], entry)) return undefined;
      servers[name] = entry;
      cfg.mcpServers = servers;
      return cfg;
    });
  }
}

/**
 * A shared server that did not start, or gave up since: its HTTP entries come out of the role files (only Tars's own,
 * by their URL), so claude gets its per-agent copy back from the registration.
 */
export function dropSharedMcpEntries(names: readonly string[], files: ConfigFiles = DEFAULT_FILES()): void {
  for (const { file } of roleFiles(files)) {
    if (!fs.existsSync(file)) continue;
    updateSharedJsonSync<{ mcpServers?: Servers; [key: string]: unknown }>(file, current => {
      const servers = current?.mcpServers;
      if (!current || !servers || typeof servers !== 'object') return undefined;
      let here = false;
      for (const name of names) {
        const e = servers[name] as { type?: string; url?: string } | undefined;
        if (e?.type === 'http' && typeof e.url === 'string' && e.url.endsWith(`/api/mcp/${name}`)) { delete servers[name]; here = true; }
      }
      return here ? current : undefined;
    });
  }
}
