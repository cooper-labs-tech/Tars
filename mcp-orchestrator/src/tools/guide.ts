/**
 * How Tars works, for an agent, from the Tars that runs it (electron/services/agent-guide.ts,
 * served by GET /api/guide). No topic: the list of topics. A topic: its text, stamped with
 * Tars's version, and with this agent's project folder where the topic names it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { problem, registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

type Guide = { text?: string; error?: string };

export function registerGuideTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "tars_guide",
      description: "How Tars works, for an agent: delegation and long runs, messages and their modes, held and refused messages, the kanban, your project folder, asking the user, limits. Without a topic, lists the topics; with one, returns it, from the Tars that runs you.",
      schema: {
        topic: z.string().optional().describe("A topic id from the list, e.g. 'kanban' or 'project-folder'. Omit to list the topics."),
      },
      failure: "reading the Tars guide",
      async run({ topic }) {
        const q = topic?.trim() ? `?topic=${encodeURIComponent(topic.trim())}` : "";
        const data = await apiRequest(`/api/guide${q}`, "GET") as Guide;
        if (data.error) return problem(data.error);
        return text(data.text ?? "");
      },
    }),
  ]);
}
