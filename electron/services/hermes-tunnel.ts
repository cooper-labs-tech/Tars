import { spawn as nodeSpawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import type { HermesConnection } from '../types/hermes';

/**
 * Tunnels to the MCP servers Hermes registered on its own machine's loopback (gbrain, Honcho on `localhost:<port>`
 * there), when Tars reaches Hermes over SSH (2.0.4, "Memory in one picture"). Without one, such a server was
 * "the gateway's own loopback address": unreachable from this Mac, for Brain and for the agents behind tars-memory.
 *
 * The Audit's R3.1 and R3.2 (audit-requirements-2-0-4-1810.md, section 3):
 * - `ssh -N -L 127.0.0.1:<port>:<host>:<port>`, an argument list, never a shell; the forward on this Mac's loopback
 *   only (never 0.0.0.0, never -g); a free port taken at each opening and saved nowhere; BatchMode and
 *   StrictHostKeyChecking, so that ssh never waits on a question nobody sees; ExitOnForwardFailure, so that a forward
 *   it could not open ends it;
 * - said open only once its port answers, else what ssh said;
 * - one per server, closed once unused for IDLE_MS, and all of them when Tars quits (closeTunnels);
 * - the tunnel carries no trust of its own: every local process can reach its port, so a server that answers there
 *   without its token is refused by the caller (answersWithoutToken).
 */

export type Spawn = (file: string, args: string[]) => {
  stderr: NodeJS.EventEmitter | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): unknown;
};

export interface TunnelDeps {
  spawn?: Spawn;
  freePort?: () => Promise<number>;
  readyWithinMs?: number;
  now?: () => number;
}

export const IDLE_MS = 10 * 60_000;
const READY_MS = 15_000;

interface Open { remote: string; localPort: number; child: ReturnType<Spawn>; lastUsed: number }
const open = new Map<string, Open>();
const opening = new Map<string, Promise<{ ok: true; localPort: number } | { ok: false; why: string }>>();

const realSpawn: Spawn = (file, args) => nodeSpawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

/** ssh's arguments for one forward, from this Mac's loopback to `remote` as Hermes's machine names it. */
export function tunnelArgs(conn: HermesConnection, localPort: number, remote: { host: string; port: number }): string[] {
  const ssh = conn.ssh!;
  return [
    '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30',
    '-L', `127.0.0.1:${localPort}:${remote.host}:${remote.port}`,
    '-p', String(ssh.port || 22),
    ...(ssh.keyPath ? ['-i', ssh.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    `${ssh.user}@${ssh.host}`,
  ];
}

/** A port free on 127.0.0.1 right now, as the system hands one out. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1_000, () => { socket.destroy(); resolve(false); });
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The tunnel to `remote` on Hermes's machine, over the SSH connection saved in Settings: the one already open for it,
 * or a new one once its port answers. Never a tunnel in any other mode than SSH.
 */
export function tunnelTo(conn: HermesConnection, remote: { host: string; port: number }, deps: TunnelDeps = {}): Promise<{ ok: true; localPort: number } | { ok: false; why: string }> {
  if (conn.mode !== 'ssh' || !conn.ssh?.host || !conn.ssh.user) {
    return Promise.resolve({ ok: false, why: 'Tars opens a tunnel to Hermes only when it reaches Hermes over SSH.' });
  }
  const now = (deps.now ?? Date.now)();
  const key = `${conn.ssh.user}@${conn.ssh.host}:${conn.ssh.port || 22}>${remote.host}:${remote.port}`;
  const known = open.get(key);
  if (known) {
    known.lastUsed = now;
    return Promise.resolve({ ok: true, localPort: known.localPort });
  }
  const pending = opening.get(key);
  if (pending) return pending;
  const started = openOne(conn, remote, key, now, deps).finally(() => opening.delete(key));
  opening.set(key, started);
  return started;
}

async function openOne(conn: HermesConnection, remote: { host: string; port: number }, key: string, now: number, deps: TunnelDeps): Promise<{ ok: true; localPort: number } | { ok: false; why: string }> {
  const localPort = await (deps.freePort ?? freePort)();
  const child = (deps.spawn ?? realSpawn)('ssh', tunnelArgs(conn, localPort, remote));
  let said = '';
  let exited: string | null = null;
  child.stderr?.on('data', (chunk: Buffer | string) => { said = (said + String(chunk)).slice(-2_000); });
  child.on('exit', (code, signal) => {
    exited = code !== null ? `ssh exited with code ${code}` : `ssh ended (${signal})`;
    if (open.get(key)?.child === child) open.delete(key);
  });
  const within = deps.readyWithinMs ?? READY_MS;
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (exited !== null) return { ok: false, why: `ssh did not open the tunnel: ${said.trim() || exited}` };
    if (await answers(localPort)) {
      open.set(key, { remote: `${remote.host}:${remote.port}`, localPort, child, lastUsed: now });
      return { ok: true, localPort };
    }
    await sleep(100);
  }
  child.kill();
  return { ok: false, why: `ssh did not open the tunnel within ${Math.round(within / 1000)} s${said.trim() ? `: ${said.trim()}` : ''}` };
}

/** The tunnels open now: what each reaches on Hermes's machine, and its port on this Mac. */
export function openTunnels(): Array<{ remote: string; localPort: number }> {
  return [...open.values()].map(t => ({ remote: t.remote, localPort: t.localPort }));
}

/** Closes the tunnels unused for IDLE_MS. */
export function sweepIdleTunnels(now: number = Date.now()): void {
  for (const [key, tunnel] of open) {
    if (now - tunnel.lastUsed > IDLE_MS) {
      open.delete(key);
      tunnel.child.kill();
    }
  }
}

/** Closes every tunnel: when Tars quits, and when the SSH connection changes. */
export function closeTunnels(): void {
  for (const tunnel of open.values()) tunnel.child.kill();
  open.clear();
}

/**
 * Whether an MCP server answers with no token: through a tunnel, any process on this Mac could then read and write the
 * user's memory (R3.2). An MCP initialize, sent without any credential; a server that wants one answers 401 or 403.
 */
export function answersWithoutToken(url: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL;
    try { target = new URL(url); } catch { resolve(false); return; }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tars', version: '1' } } });
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
    request.end(body);
  });
}
