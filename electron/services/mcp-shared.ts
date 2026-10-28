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
 * - The telegram server stays per agent: it resolves a file to send against its agent's working folder.
 * - The CLIs that cannot read such an entry (codex, gemini, qwen, opencode, pi, amp, grok) keep their per-agent
 *   copies, registered as before.
 */

/** The servers one process serves for every agent; telegram is not one (above). */
export const SHARED_MCP_SERVERS: readonly string[] = [
  'claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x',
];

type Target = { port: number; secret: string };
type Host = { child?: ChildProcess; target?: Target; restarts: number[]; stopping: boolean; bundle: string };
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
export async function ensureSharedMcp(bundles: Record<string, string>, env: { apiUrl: string; instanceId: string }): Promise<string[]> {
  const running: string[] = [];
  await Promise.all(SHARED_MCP_SERVERS.map(async name => {
    const bundle = bundles[name];
    if (!bundle || !fs.existsSync(bundle)) return;
    let host = hosts.get(name);
    if (host?.target && host.bundle === bundle) { running.push(name); return; }
    if (host?.child) { host.stopping = true; host.child.kill(); }
    host = { bundle, restarts: [], stopping: false };
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

/**
 * The shared servers into claude's config: ~/.claude.json (where `claude mcp add -s user` writes, read by every claude
 * agent) gets each one; ~/.claude/mcp.json (every claude agent's --mcp-config) has its copies replaced, and is not
 * made when there is none. Nothing else in either file changes, a file that does not parse is left alone, and an
 * unchanged file is not written.
 */
export function writeSharedMcpEntries(
  apiUrl: string,
  files: { claudeJson: string; mcpJson: string } = { claudeJson: path.join(os.homedir(), '.claude.json'), mcpJson: path.join(os.homedir(), '.claude', 'mcp.json') },
  names: readonly string[] = SHARED_MCP_SERVERS,
): SharedJsonOutcome | 'unchanged' {
  let changed = false;
  const outcome = updateSharedJsonSync<{ mcpServers?: Servers; [key: string]: unknown }>(files.claudeJson, current => {
    const cfg = current ?? {};
    const servers: Servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    changed = false;
    for (const name of names) {
      const entry = sharedMcpEntry(apiUrl, name);
      if (!same(servers[name], entry)) { servers[name] = entry; changed = true; }
    }
    if (!changed) return undefined;
    cfg.mcpServers = servers;
    return cfg;
  });
  if (fs.existsSync(files.mcpJson)) {
    updateSharedJsonSync<{ mcpServers?: Servers; [key: string]: unknown }>(files.mcpJson, current => {
      const servers = current?.mcpServers;
      if (!current || !servers || typeof servers !== 'object') return undefined;
      let here = false;
      for (const name of names) {
        if (!(name in servers)) continue;
        const entry = sharedMcpEntry(apiUrl, name);
        if (!same(servers[name], entry)) { servers[name] = entry; here = true; }
      }
      if (here) changed = true;
      return here ? current : undefined;
    });
  }
  if (outcome === 'unreadable' || outcome === 'busy') return outcome;
  return changed ? 'written' : 'unchanged';
}

/**
 * A shared server that did not start: its HTTP entries come out of claude's config (only Tars's own, by their URL), so
 * claude gets its per-agent copy back from the registration that follows.
 */
export function dropSharedMcpEntries(
  names: readonly string[],
  files: { claudeJson: string; mcpJson: string } = { claudeJson: path.join(os.homedir(), '.claude.json'), mcpJson: path.join(os.homedir(), '.claude', 'mcp.json') },
): void {
  for (const file of [files.claudeJson, files.mcpJson]) {
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

