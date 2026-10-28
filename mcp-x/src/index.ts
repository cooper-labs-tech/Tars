#!/usr/bin/env node
/**
 * MCP server for posting tweets via X API v2 (OAuth 1.0a)
 * Available to all Claude agents for publishing content on X/Twitter.
 *
 * Tars makes the calls with the account's credentials, which it keeps in
 * ~/.tars-private (utils/api.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { serveShared } from "../../mcp-shared/src/shared-host.js";
import { registerPostTools } from "./tools/post.js";

// Create MCP server
/** The server and its tools: one per call when shared, one for this agent on stdio. */
function createServer(): McpServer {
  const server = new McpServer({
    name: "dorothy-x",
    version: "1.0.0",
  });

  // Register all tools
  registerPostTools(server);
  return server;
}

// Shared by every agent when Tars starts it so (shared-host.ts), with a server per call; else this agent's own, on stdio.
async function main() {
  if (await serveShared("dorothy-x", {
    createServer,
    createTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false }),
  })) return;
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("MCP X server running on stdio");
}

main().catch(console.error);
