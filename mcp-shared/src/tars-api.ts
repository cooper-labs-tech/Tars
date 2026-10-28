/**
 * Tars's local API, as the MCP servers an agent runs call it: where it is,
 * the token presented, and who the caller says it is.
 *
 * One copy for every server that talks to Tars, bundled into each by esbuild.
 * It imports node's builtins and nothing else, here and in every file of
 * mcp-shared: a package imported from this folder would be resolved from the
 * repository's root, not from the server's own locked node_modules.
 */

import * as fs from "fs";
import * as http from "http";
import { AsyncLocalStorage } from "async_hooks";
import { createHash, randomBytes } from "crypto";
import { noAnswerWithin, send, TARS_WAIT_MS } from "./http.js";
import { toolCall } from "./tool-call.js";

export const API_URL = process.env.CLAUDE_MGR_API_URL || "http://127.0.0.1:31415";

/**
 * Who a call of a shared server is for (2.0.5, lot 3 item G: one process per
 * server for every agent, shared-host.ts): what Tars put on that call's
 * request, the agent its token names, kept through every await of that call
 * and seen by no other. Outside a shared call (a per-agent copy on stdio),
 * there is none, and the environment Tars gave the process says it, as before.
 */
export type Caller = { agentId: string; projectPath: string; agentName: string; chatsRead: boolean; token: string };
const callers = new AsyncLocalStorage<Caller>();

/** Runs a shared call as its agent. */
export function runAsCaller<T>(caller: Caller, fn: () => T): T {
  return callers.run(caller, fn);
}

// Caller identity: the shared call's, or the one injected into the PTY
// environment by Tars when it spawns the agent. Sent on every request so the
// server can scope agent listings and reject cross-project actions (the
// "orchestrator drove another project's agents" bug). Read at each call: a
// test or a shared server sets it after this module loads.
export function getCallerIdentity(): { agentId: string; projectPath: string } {
  const c = callers.getStore();
  if (c) return { agentId: c.agentId, projectPath: c.projectPath };
  return { agentId: process.env.CLAUDE_AGENT_ID || "", projectPath: process.env.CLAUDE_PROJECT_PATH || "" };
}

/** The caller's name (a vault document's author): its id when it has none. */
export function callerName(): string {
  const c = callers.getStore();
  if (c) return c.agentName || c.agentId;
  return process.env.CLAUDE_AGENT_NAME || process.env.CLAUDE_AGENT_ID || "";
}

/** Whether the caller runs a chat that may read the others (chat_list). */
export function callerReadsChats(): boolean {
  const c = callers.getStore();
  return c ? c.chatsRead : process.env.TARS_CHATS_READ === "1";
}

// This agent's own token, minted by Tars when it spawned the process and
// handed down through the environment. It says which agent is calling. The
// only token a server presents: the shared ~/.dorothy/api-token, which said
// only that the caller was on the machine, went to ~/.tars-private in 2.0.4,
// and nothing an agent runs reads that folder. A delegated run hands its
// servers the path of a file that holds it instead (CLAUDE_MGR_API_TOKEN_FILE,
// services/acp/delegate.ts): the list of servers a run hands its CLI is
// written into the claude adapter's command line.
function tokenFromFile(file: string | undefined): string {
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}
export const AGENT_API_TOKEN = process.env.CLAUDE_MGR_API_TOKEN || tokenFromFile(process.env.CLAUDE_MGR_API_TOKEN_FILE);

/** The token this call is made with, before the port proves it is Tars: the shared call's agent's, else this process's. */
export function presentedToken(): string {
  return callers.getStore()?.token ?? AGENT_API_TOKEN;
}

/** What the Tars that started this CLI proves it is with (tars-hook.sh): never sent. */
const INSTANCE_ID = process.env.TARS_INSTANCE_ID || "";
/**
 * Whether the port at API_URL is the Tars that started this CLI (`this`): a fresh
 * challenge to /api/health, whose answer must be sha256("<id>:<challenge>"),
 * as the hooks ask it (tars-hook.sh, the Audit's table #11). While Tars is
 * down, or after a quit this CLI outlived, any process may hold the port, and
 * got the agent's token with the next call.
 *
 * Asked before every call, never remembered: a proof kept for the server's
 * life (as it first was) let a squatter that took the port after the first
 * call get the token with the next one, which is how a CLI that outlived a
 * quit would meet it (the Audit's M1 on #376). One loopback request per tool
 * call. It waits as long as the call it guards (`waitMs`): a port that never
 * answers gets nothing however long the wait, and a Tars whose main thread is
 * held past a shorter one had its caller's call leave with no token and come
 * back refused (the Audit's Low on #376's delta).
 *
 * `another` when the port answered without this CLI's proof: a Tars started
 * since (Tars restarted while this CLI outlived it), or another process.
 * `none` when nothing answered, or there is no instance to prove.
 */
async function portHolder(waitMs: number): Promise<"this" | "another" | "none"> {
  if (!INSTANCE_ID) return "none";
  const challenge = randomBytes(16).toString("hex");
  const tars = new URL(API_URL);
  try {
    const { data } = await send(http, {
      hostname: tars.hostname,
      port: Number(tars.port) || 80,
      path: `/api/health?challenge=${challenge}`,
      method: "GET",
      timeout: waitMs,
    }, undefined, (err) => err);
    const proof = (JSON.parse(data) as { proof?: unknown }).proof;
    return proof === createHash("sha256").update(`${INSTANCE_ID}:${challenge}`).digest("hex") ? "this" : "another";
  } catch {
    return "none";
  }
}

/**
 * The token a call presents: this agent's own, once the port proved it is the
 * Tars that started this CLI, and none when it did not: a squatter would get
 * it. A CLI Tars did not start has no token: it presents none, and Tars
 * answers 401.
 */
export async function tokenToPresent(waitMs: number = TARS_WAIT_MS): Promise<string | null> {
  return (await credentials(waitMs)).token;
}

/** The token a call presents, and whether it was withheld because another Tars holds the port. */
async function credentials(waitMs: number): Promise<{ token: string | null; anotherTars: boolean }> {
  const token = presentedToken();
  if (!token) return { token: null, anotherTars: false };
  const holder = await portHolder(waitMs);
  return { token: holder === "this" ? token : null, anotherTars: holder === "another" };
}

export async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
  timeoutMsOverride?: number
): Promise<unknown> {
  const url = `${API_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Marks this as an agent-initiated call, so the server can refuse to act
    // when the caller turns out to have no identity to scope it by.
    "X-Tars-Client": "mcp",
  };
  // Long-poll wait endpoints need a longer timeout. Callers passing a custom
  // wait timeout must override this so the client never aborts before the
  // server-side long-poll resolves. The proof before it waits as long.
  const isLongPoll = endpoint.includes("/wait");
  const timeoutMs = timeoutMsOverride ?? (isLongPoll ? 600_000 : TARS_WAIT_MS);
  const { token, anotherTars } = await credentials(timeoutMs);
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const { agentId: callerId, projectPath: callerProject } = getCallerIdentity();
  if (callerId) {
    headers["X-Tars-Caller-Id"] = callerId;
  }
  // The tool this call runs for, so that Tars can report an error it answers with as that tool's (tool-call.ts).
  const tool = toolCall.getStore();
  if (tool) {
    headers["X-Tars-Tool"] = tool;
  }
  if (callerProject) {
    headers["X-Tars-Caller-Project"] = callerProject;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    // Tars answered: the status and the body go with the error, so that a
    // caller can tell an answer (a refusal, "no run started") from a request
    // that never got one, which carries neither. Refused for going without
    // the token another Tars was not given: `anotherTars`, so that a caller
    // waiting on what the Tars that started this CLI held in memory (a task
    // still queued, in delegate_task) can say it was lost with a restart.
    if (!response.ok) {
      throw Object.assign(new Error((data as { error?: string }).error || `API error: ${response.status}`), {
        status: response.status, body: data, ...(anotherTars ? { anotherTars: true } : {}),
      });
    }

    return data;
  } catch (err) {
    // Said as mcp-kanban says it, with the wait that ran out: fetch's own
    // "This operation was aborted" named neither. Still an AbortError, the name
    // delegate_task reads as its own wait running out: anything else sends it
    // on to type the task into the agent's terminal too, and the task runs twice.
    if (timedOut) {
      const late = new Error(`Tars did not answer at ${new URL(API_URL).origin}: ${noAnswerWithin(timeoutMs)}`);
      late.name = "AbortError";
      throw late;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
