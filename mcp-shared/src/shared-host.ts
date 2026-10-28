/**
 * One process per Tars MCP server for every agent (2.0.5, lot 3 item G, the
 * second step): the server serves MCP over HTTP to Tars alone, and Tars
 * proxies each agent's call to it from /api/mcp/<server> (the local API, which
 * resolves the caller from its own token: electron/services/api-routes/
 * mcp-routes.ts). Until then every agent started its own copy of every server,
 * about 20 MB each, 133 processes for 19 agents (measured on 28/10).
 *
 * What makes a shared call its agent's, and no other's:
 * - Tars starts the server with TARS_MCP_SHARED=1 and writes a secret on its
 *   stdin, read once; a request without it is refused before anything is
 *   built, so a process that found the port reaches nothing. The port is a
 *   loopback one the server picks, said on its stdout.
 * - The identity is what Tars put on the request (the x-tars-agent-* headers,
 *   from its fleet's record of the token's agent), and the token is the
 *   agent's own, which every call to Tars presents again (tars-api.ts). The
 *   server has no identity of its own, and none from the CLI.
 * - Each request is served by an MCP server and a transport built for it, run
 *   as its caller (runAsCaller), and closed when its answer ends: nothing of a
 *   call is kept for the next, which is what makes a server shareable. A
 *   server that keeps state between calls stays per agent (telegram resolves
 *   a file against its agent's folder).
 * - Tars gone (its end of stdin closed), the server ends.
 *
 * Like every file of mcp-shared, it imports node's builtins and nothing else:
 * the SDK's server and transport are handed in by each server.
 */

import * as http from "http";
import { timingSafeEqual } from "crypto";
import { runAsCaller } from "./tars-api.js";

/** The headers Tars puts on a shared call, lower-cased as node reads them. */
export const SHARED_HEADERS = {
  secret: "x-tars-mcp-secret",
  agentId: "x-tars-agent-id",
  project: "x-tars-agent-project",
  name: "x-tars-agent-name",
  chatsRead: "x-tars-chats-read",
} as const;

export type SharedServer = { connect(transport: never): Promise<void>; close(): Promise<void> };
export type SharedTransport = {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body?: unknown): Promise<void>;
  close(): Promise<void>;
};
export type SharedDeps = { createServer: () => SharedServer; createTransport: () => SharedTransport };

function header(req: http.IncomingMessage, name: string): string {
  const v = req.headers[name];
  return typeof v === "string" ? v : "";
}

function refuse(res: http.ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: error }, id: null }));
}

async function bodyOf(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

/** What answers Tars's requests: the secret checked, the caller set, one server and transport per request. */
export function sharedHandler(secret: string, deps: SharedDeps): http.RequestListener {
  const expected = Buffer.from(secret);
  return (req, res) => {
    void (async () => {
      const given = Buffer.from(header(req, SHARED_HEADERS.secret));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refuse(res, 401, "not Tars");
      const agentId = header(req, SHARED_HEADERS.agentId);
      const token = /^Bearer (\S+)$/.exec(header(req, "authorization"))?.[1] ?? "";
      if (!agentId || !token) return refuse(res, 400, "a shared call names its agent and carries its token");
      let agentName = header(req, SHARED_HEADERS.name);
      try { agentName = decodeURIComponent(agentName); } catch { /* as sent */ }
      const caller = { agentId, projectPath: header(req, SHARED_HEADERS.project), agentName, chatsRead: header(req, SHARED_HEADERS.chatsRead) === "1", token };
      let body: unknown;
      try { body = await bodyOf(req); } catch { return refuse(res, 400, "a body that is not JSON"); }
      await runAsCaller(caller, async () => {
        const server = deps.createServer();
        const transport = deps.createTransport();
        res.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport as never);
        await transport.handleRequest(req, res, body);
      });
    })().catch((err) => {
      console.error("[shared] a call failed:", err);
      if (!res.headersSent) refuse(res, 500, "the call failed");
    });
  };
}

/** Its first line: the secret Tars writes once. */
function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = "";
    const onData = (chunk: Buffer | string) => {
      got += chunk;
      const end = got.indexOf("\n");
      if (end < 0) return;
      stream.off("data", onData);
      resolve(got.slice(0, end).trim());
    };
    stream.on("data", onData);
    stream.once("end", () => reject(new Error("no secret on stdin")));
  });
}

/**
 * Serves this server for every agent when Tars started it so (TARS_MCP_SHARED=1): true, and the process stays up
 * until Tars closes its stdin. False otherwise: the per-agent copy goes on with stdio, as before.
 */
export async function serveShared(name: string, deps: SharedDeps): Promise<boolean> {
  if (process.env.TARS_MCP_SHARED !== "1") return false;
  const secret = await firstLine(process.stdin);
  if (secret.length < 32) throw new Error("the secret Tars gave is too short");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  const server = http.createServer(sharedHandler(secret, deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  process.stdout.write(`listening ${port}\n`);
  console.error(`${name} serves every agent on 127.0.0.1:${port}`);
  return true;
}
