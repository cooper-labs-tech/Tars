#!/usr/bin/env node

/**
 * Tars memory MCP server.
 *
 * The point of this server is that it is not Claude-specific. Every CLI Tars
 * can run registers it, so an agent on Codex, Gemini, Grok, opencode or pi
 * reaches the same memory as an agent on Claude: the project's own memory
 * files, what other sessions observed, the Hermes gateway's memory and
 * session history, and the gbrain / Honcho backends.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { serveShared } from "../../mcp-shared/src/shared-host.js";
import { z } from "zod";
import { text } from "../../mcp-shared/src/tools.js";
import { apiRequest, getCallerIdentity } from "./utils/api.js";

/** The server and its tools: one per call when shared, one for this agent on stdio. */
function createServer(): McpServer {
  const server = new McpServer({
    name: "tars-memory",
    version: "1.0.0",
  });

  interface MemoryHit {
    source: string;
    title: string;
    content: string;
    ref?: string;
  }

  function projectOf(explicit?: string): string {
    return explicit || getCallerIdentity().projectPath || process.cwd();
  }

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Search everything this team remembers: the project's memory notes, what other " +
        "sessions observed, the Hermes gateway's memory and past sessions, and the " +
        "connected gbrain / Honcho backends, and the user's Obsidian vault. Use it before assuming something is new, " +
        "before re-investigating a bug, and before asking the user something that was " +
        "already decided.",
      inputSchema: {
        query: z.string().describe("What to look for, in plain words"),
        sources: z
          .array(z.enum(["project", "observations", "obsidian", "hermes", "gbrain", "honcho"]))
          .optional()
          .describe("Restrict to specific sources (default: all configured)"),
        limit: z.number().min(1).max(50).optional(),
        project_path: z.string().optional().describe("Defaults to this agent's project"),
      },
    },
    async ({ query, sources, limit, project_path }) => {
      const params = new URLSearchParams({ q: query, project_path: projectOf(project_path) });
      if (limit) params.set("limit", String(limit));
      if (sources?.length) params.set("sources", sources.join(","));

      const res = (await apiRequest(`/api/memory/search?${params}`)) as {
        hits?: MemoryHit[];
        errors?: { source: string; error: string }[];
      };

      const hits = res?.hits ?? [];
      if (hits.length === 0) {
        const why = res?.errors?.length
          ? `\n\nSources that could not answer: ${res.errors.map(e => `${e.source} (${e.error})`).join(", ")}`
          : "";
        return text(`No memory matches "${query}".${why}`);
      }

      const body = hits
        .map(h => `### ${h.title}  [${h.source}]\n${h.content}`)
        .join("\n\n");
      const errors = res?.errors?.length
        ? `\n\n---\nUnavailable: ${res.errors.map(e => `${e.source} (${e.error})`).join(", ")}`
        : "";
      return text(`${hits.length} match(es) for "${query}":\n\n${body}${errors}`);
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read the memory digest",
      description:
        "The full context this project carries: its memory notes, recent activity from " +
        "other sessions, and the Hermes gateway's memory. Read it when you join a project " +
        "or when you are unsure what has already been established.",
      inputSchema: {
        project_path: z.string().optional().describe("Defaults to this agent's project"),
      },
    },
    async ({ project_path }) => {
      const params = new URLSearchParams({ project_path: projectOf(project_path) });
      const res = (await apiRequest(`/api/memory/context?${params}`)) as { context?: string };
      return text(res?.context?.trim() || "This project has no memory recorded yet.");
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "Remember something",
      description:
        "Record a durable fact for every future session: an architectural decision, a root " +
        "cause, where something lives, a constraint the user stated. Not for progress " +
        "updates or anything the code or git history already says. `to` picks which memory " +
        "it goes in, and you can name more than one: 'project' is this project's own notes " +
        "and is the default; 'hermes' is the gateway's MEMORY.md, which every project and " +
        "every session on that gateway can see; 'gbrain' and 'honcho' are the shared " +
        "backends; 'obsidian' appends to a Tars folder in the user's vault, where they " +
        "will read it alongside their own notes. Put something in the project when it " +
        "is about this codebase, and in hermes or a shared backend when it is about the " +
        "user or holds true everywhere.",
      inputSchema: {
        content: z.string().describe("The fact, written so it is useful months from now"),
        to: z
          .array(z.enum(["project", "hermes", "obsidian", "gbrain", "honcho"]))
          .optional()
          .describe("Which memories to write to (default: project only)"),
        file: z
          .string()
          .optional()
          .describe("Memory file to append to (default MEMORY.md; use a topic file for detail)"),
        project_path: z.string().optional(),
      },
    },
    async ({ content, to, file, project_path }) => {
      const res = (await apiRequest("/api/memory/write", "POST", {
        project_path: projectOf(project_path),
        content,
        file,
        to,
      })) as {
        success?: boolean;
        path?: string;
        error?: string;
        results?: { target: string; success: boolean; path?: string; error?: string }[];
      };

      // Every target answers for itself, so say what happened to each rather than
      // collapsing a partial write into one success or one failure.
      const results = res?.results ?? [];
      if (results.length > 1) {
        return text(
          results
            .map(r => (r.success ? `${r.target}: recorded in ${r.path}` : `${r.target}: ${r.error}`))
            .join("\n"),
        );
      }

      return text(
        res?.success
          ? `Recorded in ${res.path ?? results[0]?.path ?? "memory"}.`
          : `Could not record it: ${res?.error ?? results[0]?.error ?? "unknown error"}`,
      );
    },
  );

  server.registerTool(
    "memory_sources",
    {
      title: "Memory sources",
      description:
        "Which memory backends are actually reachable right now, and what each one offers. " +
        "Use it when a search comes back empty to tell 'nothing recorded' apart from " +
        "'a backend is down'.",
      inputSchema: {
        project_path: z.string().optional(),
      },
    },
    async ({ project_path }) => {
      const params = new URLSearchParams({ project_path: projectOf(project_path) });
      const res = (await apiRequest(`/api/memory/status?${params}`)) as {
        sources?: { id: string; label: string; configured: boolean; reachable: boolean; detail: string }[];
      };
      const sources = res?.sources ?? [];
      if (sources.length === 0) return text("No memory source reported.");

      return text(
        sources
          .map(s => {
            const state = !s.configured ? "not configured" : s.reachable ? "ready" : "unreachable";
            return `- ${s.label}: ${state} (${s.detail})`;
          })
          .join("\n"),
      );
    },
  );
  return server;
}

// Shared by every agent when Tars starts it so (shared-host.ts), with a server per call; else this agent's own, on stdio.
async function main() {
  if (await serveShared("tars-memory", {
    createServer,
    createTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }),
  })) return;
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("Tars memory MCP server running on stdio");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
