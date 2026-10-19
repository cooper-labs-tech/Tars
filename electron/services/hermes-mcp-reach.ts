import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import type { HermesConnection } from '../types/hermes';
import { answersWithoutToken, closeTunnelTo, tunnelTo } from './hermes-tunnel';

/**
 * How Tars reaches each MCP server Hermes registered (2.0.4, "Memory in one picture"): the path that worked and its
 * address on this Mac, or each path's answer when none did, kept for the sentence the window shows.
 *
 * - Hermes on this Mac, or a URL that is not Hermes's loopback: directly.
 * - Hermes's machine on the tailnet, the server listening on its tailnet address: that address, and no forward kept.
 * - Otherwise, over SSH: the tunnel to the server (services/hermes-tunnel.ts), refused when the server answers there
 *   without a token (the Audit's R3.2), its tunnel then closed at once.
 */

export const NO_TOKEN_REFUSAL = 'This server answers without a token: through the tunnel, any process on this Mac would read and write your memory. Give it a token on Hermes\'s machine, then check again.';

export type Reach =
  | { via: 'direct' | 'tunnel' | 'tailscale'; address: string }
  | { via: 'none'; why: string; answers: { tunnel?: string; tailscale?: string } };

export interface ReachDeps {
  tunnel: typeof tunnelTo;
  closeTunnel: typeof closeTunnelTo;
  tailnetAddress: (host: string) => Promise<string | null>;
  listens: (host: string, port: number) => Promise<boolean>;
  answersWithoutToken: (url: string) => Promise<boolean>;
}

/** Hermes's machine's IPv4 address on the tailnet, from `tailscale status --json`, or null. Never this Mac itself. */
export function tailnetAddressIn(statusJson: string, host: string): string | null {
  let status: { Peer?: Record<string, { HostName?: unknown; DNSName?: unknown; TailscaleIPs?: unknown }> | null };
  try { status = JSON.parse(statusJson); } catch { return null; }
  const wanted = host.trim().toLowerCase().replace(/\.$/, '');
  for (const peer of Object.values(status?.Peer ?? {})) {
    const ips = Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [];
    const name = typeof peer?.HostName === 'string' ? peer.HostName.toLowerCase() : '';
    const dns = typeof peer?.DNSName === 'string' ? peer.DNSName.toLowerCase().replace(/\.$/, '') : '';
    if (name === wanted || dns === wanted || ips.some(ip => ip.toLowerCase() === wanted)) {
      return ips.find(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? null;
    }
  }
  return null;
}

/** Tailscale's own command on each system: the app's on macOS, Program Files on Windows, the PATH's elsewhere. */
function tailscaleBinary(): string {
  const shipped = process.platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    : process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : '';
  return shipped && fs.existsSync(shipped) ? shipped : 'tailscale';
}

function tailnetAddressOf(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(tailscaleBinary(), ['status', '--json'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : tailnetAddressIn(String(stdout), host));
    });
  });
}

function listens(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(2_000, () => { socket.destroy(); resolve(false); });
  });
}

export const realReachDeps: ReachDeps = { tunnel: tunnelTo, closeTunnel: closeTunnelTo, tailnetAddress: tailnetAddressOf, listens, answersWithoutToken };

function withHost(url: URL, host: string, port: number): string {
  const moved = new URL(url.href);
  moved.hostname = host;
  moved.port = String(port);
  return moved.href;
}

export async function reachOf(
  conn: HermesConnection,
  server: { url: string | null; gatewayLocal: boolean },
  deps: ReachDeps = realReachDeps,
): Promise<Reach> {
  if (!server.url) return { via: 'none', why: 'Hermes names no URL for this server.', answers: {} };
  if (conn.mode === 'local' || !server.gatewayLocal) return { via: 'direct', address: server.url };
  const url = new URL(server.url);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  let hermesHost = '';
  try { hermesHost = conn.mode === 'ssh' ? conn.ssh?.host ?? '' : new URL(conn.url ?? '').hostname; } catch { /* no host to look for */ }
  const answers: { tunnel?: string; tailscale?: string } = {};
  const ip = hermesHost ? await deps.tailnetAddress(hermesHost) : null;
  if (ip && await deps.listens(ip, port)) return { via: 'tailscale', address: withHost(url, ip, port) };
  answers.tailscale = ip
    ? `The server does not listen on ${ip}:${port}, Hermes's tailnet address: only on Hermes's own loopback.`
    : 'Hermes\'s machine is not on your tailnet, or Tailscale does not run on this Mac.';
  if (conn.mode !== 'ssh') {
    answers.tunnel = 'Tars opens a tunnel only to a Hermes it reaches over SSH (Settings, Hermes, Connection).';
  } else {
    const remote = { host: url.hostname, port };
    const opened = await deps.tunnel(conn, remote);
    if (opened.ok) {
      const address = withHost(url, '127.0.0.1', opened.localPort);
      if (!(await deps.answersWithoutToken(address))) return { via: 'tunnel', address };
      deps.closeTunnel(conn, remote);
      answers.tunnel = NO_TOKEN_REFUSAL;
      return { via: 'none', why: NO_TOKEN_REFUSAL, answers };
    }
    answers.tunnel = opened.why;
  }
  return { via: 'none', why: `Neither path works. ${answers.tunnel} ${answers.tailscale}`, answers };
}
