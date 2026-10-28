#!/usr/bin/env node
/**
 * MCP server for Vault document management
 * Available to all Claude agents for creating, reading, and searching documents
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { serveShared } from "../../mcp-shared/src/shared-host.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerSearchTools } from "./tools/search.js";

/** The server and its tools: one per call when shared, one for this agent on stdio. */
function createServer(): McpServer {
  // Create MCP server
  const server = new McpServer({
    name: "claude-mgr-vault",
    version: "1.0.0",
  });

  // Register all tools
  registerDocumentTools(server);
  registerFolderTools(server);
  registerSearchTools(server);
  return server;
}

// Start server
// Shared by every agent when Tars starts it so (shared-host.ts), with a server per call; else this agent's own, on stdio.
async function main() {
  if (await serveShared("claude-mgr-vault", {
    createServer,
    createTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }),
  })) return;
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("MCP Vault server running on stdio");
}

main().catch(console.error);
