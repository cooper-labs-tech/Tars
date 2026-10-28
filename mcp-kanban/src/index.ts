#!/usr/bin/env node
/**
 * MCP server for Kanban task management
 * Available to all Claude agents for creating, updating, and completing tasks
 *
 * The board is Hermes's: every tool goes through Tars (its local API, this
 * agent's own token) to the Hermes board, the one the Kanban page shows. A task
 * an agent creates arrives parked, where Hermes never starts it; an agent claims
 * one with assign_task, one at a time. There is no local fallback: when Hermes
 * is not configured or does not answer, the tool says so. The names, the
 * descriptions and the schemas are the ones these tools always had.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { serveShared } from "../../mcp-shared/src/shared-host.js";
import { z } from "zod";
import { registerTools, tool } from "../../mcp-shared/src/tools.js";

import * as tools from "./tools.js";

/** The server and its tools: one per call when shared, one for this agent on stdio. */
function createServer(): McpServer {
  // Create MCP server
  const server = new McpServer({
    name: "claude-mgr-kanban",
    version: "1.0.0",
  });

  registerTools(server, [
    tool({
      name: "list_tasks",
      description: "List all kanban tasks. Optionally filter by column (backlog, planned, ongoing, done).",
      schema: {
        column: z.enum(["backlog", "planned", "ongoing", "done"]).optional().describe("Filter by column"),
        assigned_to_me: z.boolean().optional().describe("Only show tasks assigned to this agent"),
      },
      failure: "listing tasks",
      run: (args) => tools.listTasks(args),
    }),
    tool({
      name: "get_task",
      description: "Get detailed information about a specific task.",
      schema: {
        task_id: z.string().describe("The task ID (can be partial, will match prefix)"),
      },
      failure: "getting task",
      run: (args) => tools.getTask(args),
    }),
    tool({
      name: "create_task",
      description: "Create a new kanban task. Tasks start in the backlog column.",
      schema: {
        title: z.string().describe("Task title"),
        description: z.string().describe("Task description with details"),
        project_path: z.string().optional().describe("Project path (defaults to current directory)"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("Task priority (default: medium)"),
        labels: z.array(z.string()).optional().describe("Labels/tags for the task"),
      },
      failure: "creating task",
      run: (args) => tools.createTask(args),
    }),
    tool({
      name: "update_task_progress",
      description: "Update the progress percentage of a task.",
      schema: {
        task_id: z.string().describe("The task ID"),
        progress: z.number().min(0).max(100).describe("Progress percentage (0-100)"),
      },
      failure: "updating task",
      run: (args) => tools.updateTaskProgress(args),
    }),
    tool({
      name: "mark_task_done",
      description: "Mark a task as completed and move it to the done column. IMPORTANT: Call this when you finish working on an assigned task.",
      schema: {
        task_id: z.string().describe("The task ID to mark as done"),
        summary: z.string().describe("A brief summary of what was accomplished (1-3 sentences)"),
      },
      failure: "completing task",
      run: (args) => tools.markTaskDone(args),
    }),
    tool({
      name: "move_task",
      description: "Move a task to a different column (backlog, planned, ongoing, done).",
      schema: {
        task_id: z.string().describe("The task ID to move"),
        column: z.enum(["backlog", "planned", "ongoing", "done"]).describe("Target column"),
      },
      failure: "moving task",
      run: (args) => tools.moveTask(args),
    }),
    tool({
      name: "delete_task",
      description: "Delete a task from the kanban board.",
      schema: {
        task_id: z.string().describe("The task ID to delete"),
      },
      failure: "deleting task",
      run: (args) => tools.deleteTask(args),
    }),
    tool({
      name: "assign_task",
      description: "Assign an agent to a task (or assign yourself).",
      schema: {
        task_id: z.string().describe("The task ID"),
        agent_id: z.string().optional().describe("Agent ID to assign (defaults to self if CLAUDE_AGENT_ID is set)"),
      },
      failure: "assigning task",
      run: (args) => tools.assignTask(args),
    }),
  ]);
  return server;
}

// Start server
// Shared by every agent when Tars starts it so (shared-host.ts), with a server per call; else this agent's own, on stdio.
async function main() {
  if (await serveShared("claude-mgr-kanban", {
    createServer,
    createTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false }),
  })) return;
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("MCP Kanban server running on stdio");
}

main().catch(console.error);
