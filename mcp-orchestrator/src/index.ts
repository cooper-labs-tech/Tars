#!/usr/bin/env node

/**
 * Claude Manager Orchestrator MCP Server
 *
 * Provides tools for:
 * - Agent management (create, start, stop, monitor)
 * - Messaging (Telegram, Slack)
 * - Rooms (room_post, room_read): how an agent talks to its team
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { serveShared } from "../../mcp-shared/src/shared-host.js";

import { registerAgentTools, registerChatTools, registerGuideTools, registerMessagingTools, registerRoomTools } from "./tools/index.js";

// Create MCP server
/** The server and its tools: one per call when shared, one for this agent on stdio. */
function createServer(): McpServer {
  const server = new McpServer({
    name: "claude-mgr-orchestrator",
    version: "1.0.0",
  });

  // Register all tool categories
  registerAgentTools(server);
  registerMessagingTools(server);
  registerRoomTools(server);
  registerChatTools(server);
  registerGuideTools(server);
  return server;
}

// Shared by every agent when Tars starts it so (shared-host.ts), with a server per call; else this agent's own, on stdio.
async function main() {
  if (await serveShared("claude-mgr-orchestrator", {
    createServer,
    createTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false }),
  })) return;
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("Claude Manager Orchestrator MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
