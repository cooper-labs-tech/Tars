/**
 * The ports of the local API's second listeners, one per remote host, which that host's agents' reverse tunnels reach
 * (2.0.7, the Audit's gate of #600). Each serves the same routes as the API's own port, behind a gate: only the token of
 * an agent placed on that host, on every route, /api/health and /api/local-file included (services/remote-agents.ts,
 * tunnelAdmits). A process of the host that reaches the tunnel's end on its loopback gets nothing without that token,
 * where the API's own port answers its two routes exempt from the token.
 *
 * api-server.ts says how one is opened (setTunnelOpener), since it holds the request handler; a launch asks for its
 * host's port here (spawnAgentSession), so the routes need not import the server. Each is opened once, at the first
 * launch on its host, on 127.0.0.1 at a port the system picks; all close with the API.
 */

/**
 * The room one agent's token has on its host's listener (the re-audit's I-g on #600, set from a measure in the short
 * re-read): every connection to the tunnel's end is a socket of this Tars's main process, and any user of the host can
 * open them. A real Claude Code (2.1.329, a worker with Tars's five HTTP MCP servers) held 6 connections, steady through
 * 10 MCP calls at once; its shell hooks on a host open one each, at most 10 at once (it runs at most 10 tools at once);
 * a turn's own hooks, 2 more: 18 at its peak (__tests__/electron/services/api-tunnel-listener.test.ts, 8). Past this
 * many under one token, more than three times that, a new connection is answered 429 and closed.
 */
export const TUNNEL_SOCKETS_PER_AGENT = 64;
/**
 * And past this many on one host's listener, open or idle, it takes no more until some close: per host, so one host's
 * connections never take another's room (the short re-read of #600).
 */
export const TUNNEL_MAX_CONNECTIONS = 128;
/** A connection that has not sent its headers in this long is closed; one whose request is not in, in REQUEST_MS. */
export const TUNNEL_HEADERS_MS = 10_000;
export const TUNNEL_REQUEST_MS = 30_000;

let opener: ((hostId: string) => Promise<number>) | undefined;
const opening = new Map<string, Promise<number>>();

/** Called by the API server as it starts, and with undefined as it stops. */
export function setTunnelOpener(open: ((hostId: string) => Promise<number>) | undefined): void {
  opener = open;
  opening.clear();
}

/** The port of `hostId`'s listener, opened at its first call. Rejects while the API is not started, and when it cannot listen. */
export function tunnelListenerPort(hostId: string): Promise<number> {
  if (!opener) return Promise.reject(new Error('the local API is not started, so no tunnel can reach it'));
  let port = opening.get(hostId);
  if (!port) {
    port = opener(hostId).catch((err: unknown) => {
      opening.delete(hostId);
      throw err;
    });
    opening.set(hostId, port);
  }
  return port;
}
