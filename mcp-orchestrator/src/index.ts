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

import { registerAgentTools, registerChatTools, registerDiskTools, registerGuideTools, registerHeavySlotTools, registerMessagingTools, registerRoomTools } from "./tools/index.js";

// Create MCP server
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
registerHeavySlotTools(server);
registerDiskTools(server);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Manager Orchestrator MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
