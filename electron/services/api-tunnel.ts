/**
 * The port of the local API's second listener, the one a remote agent's reverse tunnel reaches (2.0.7, the Audit's gate
 * of #600). It serves the same routes as the API's own port, behind a gate: only the token of an agent placed on a host,
 * on every route, /api/health and /api/local-file included (services/remote-agents.ts, tunnelAdmits). A process of the
 * host that reaches the tunnel's end on its loopback gets nothing without that token, where the API's own port answers
 * its two routes exempt from the token.
 *
 * api-server.ts says how it is opened (setTunnelOpener), since it holds the request handler; a launch asks for the port
 * here (spawnAgentSession), so the routes need not import the server. Opened once, at the first launch on a host, on
 * 127.0.0.1 at a port the system picks; closed with the API.
 */

let opener: (() => Promise<number>) | undefined;
let opening: Promise<number> | undefined;

/** Called by the API server as it starts, and with undefined as it stops. */
export function setTunnelOpener(open: (() => Promise<number>) | undefined): void {
  opener = open;
  opening = undefined;
}

/** The listener's port, opened at the first call. Rejects while the API is not started, and when it cannot listen. */
export function tunnelListenerPort(): Promise<number> {
  if (!opener) return Promise.reject(new Error('the local API is not started, so no tunnel can reach it'));
  const open = opener;
  opening ??= open().catch((err: unknown) => {
    opening = undefined;
    throw err;
  });
  return opening;
}
