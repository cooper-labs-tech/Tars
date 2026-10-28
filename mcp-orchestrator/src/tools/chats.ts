/**
 * Reading the project's other chats (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 5).
 *
 * Registered only in a chat's CLI that Tars started with the option on
 * (TARS_CHATS_READ=1): off, the tools are not there at all. Tars checks the
 * option and the caller's chat again at every call, from the caller's own
 * token: a chat reads its own project's chats only, and writes nothing to them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";
import { callerReadsChats } from "../../../mcp-shared/src/tars-api.js";

type Listed = { chats?: Array<{ id: string; number: number; title: string; state: string; lastActivityAt: string }>; error?: string; reason?: string };

export function registerChatTools(server: McpServer): void {
  // Read for each call's server: a shared server builds one per call, as its caller (tars-api.ts).
  if (!callerReadsChats()) return;
  registerTools(server, [
    tool({
      name: "chat_list",
      description: "List the other chats of your project: the user's other conversations with the orchestrator, each on its own topic. Read only: to have another chat act, tell the user.",
      schema: {},
      failure: "listing the project's chats",
      async run() {
        const data = await apiRequest("/api/chats/list", "GET") as Listed;
        if (data.error) return text(`Not listed: ${data.reason ?? data.error}`);
        const chats = data.chats ?? [];
        if (chats.length === 0) return text("Your project has no other chat.");
        return text(chats.map((c) => `#${c.number} ${c.title} (${c.state}, last active ${c.lastActivityAt}), id ${c.id}`).join("\n"));
      },
    }),
  ]);
}
