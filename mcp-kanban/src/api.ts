import * as http from "http";
import { send } from "../../mcp-shared/src/http.js";
import { API_URL, presentedToken, tokenToPresent } from "../../mcp-shared/src/tars-api.js";

/**
 * Tars's local API, as this agent. The kanban lives on the Hermes board, and
 * Tars is the way there: it knows the gateway, which project the agent works
 * on, and which tasks it may move. Nothing here reads or writes a file.
 */

// The Tars that spawned this agent, as mcp-orchestrator and mcp-vault read it.
const TARS = new URL(API_URL);

// A Tars that stopped answering is not waited on for ever: the tool says so,
// and the agent can act on it (the Backend's gate of #171). A claim or a
// hand-off makes a few calls to the gateway, each with its own timeout.
const REQUEST_TIMEOUT_MS = 60_000;

export async function apiRequest(method: string, path_: string, body?: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // This agent's own token, minted by Tars when it spawned the process. The
  // kanban tools act for an agent, so the shared ~/.tars-private/api-token,
  // which names none, is no use here: Tars refuses it with a message that says so.
  // Sent only once the port proved it is the Tars that started this CLI (tokenToPresent).
  // The token of this call's agent (a shared call's, or this process's: tars-api.ts).
  const token = presentedToken() ? await tokenToPresent(REQUEST_TIMEOUT_MS) : null;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const { status, data } = await send(http, {
    hostname: TARS.hostname,
    port: Number(TARS.port) || 80,
    path: path_,
    method,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  }, body && JSON.stringify(body), (err) => new Error(`Tars did not answer at ${TARS.origin}: ${err.message}`));
  let parsed: { error?: string } | undefined;
  try { parsed = JSON.parse(data); } catch { /* below */ }
  if (!parsed) throw new Error(`Tars answered ${status} with no JSON: ${data.slice(0, 200)}`);
  if (status && status >= 400) throw new Error(parsed.error || `HTTP ${status}`);
  return parsed;
}
