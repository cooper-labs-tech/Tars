#!/usr/bin/env node
/**
 * MCP server for Twitter/X data via SocialData API
 * Available to all Claude agents for searching tweets, getting user profiles, etc.
 *
 * Tars makes the calls with the user's SocialData key, which it keeps in ~/.tars-private (utils/api.ts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { serveShared } from "../../mcp-shared/src/shared-host.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTweetTools } from "./tools/tweets.js";
import { registerUserTools } from "./tools/users.js";

// Create MCP server
/** The server and its tools: one per call when shared, one for this agent on stdio. */
function createServer(): McpServer {
  const server = new McpServer({
    name: "dorothy-socialdata",
    version: "1.0.0",
  });

  // Register all tools
  registerSearchTools(server);
  registerTweetTools(server);
  registerUserTools(server);
  return server;
}

// Shared by every agent when Tars starts it so (shared-host.ts), with a server per call; else this agent's own, on stdio.
async function main() {
  if (await serveShared("dorothy-socialdata", {
    createServer,
    createTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }),
  })) return;
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("MCP SocialData server running on stdio");
}

main().catch(console.error);
