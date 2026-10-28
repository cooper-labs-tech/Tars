import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

type Item = { kind: string; label: string; sizeBytes: number; rule: string };

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} kB`);

/** The disk janitor, read only: what it would propose. Only the owner approves, in the window. */
export function registerDiskTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "disk_scan",
      description: "List what Tars's disk janitor would propose to delete now, by rule: old .next and test artefacts of idle worktrees, merged worktrees, stale npx cache entries, unused Docker images, gone agents' temporary folders. Read only: nothing is deleted, and only the user approves a deletion, in Tars's window.",
      schema: {},
      failure: "scanning the disk",
      async run() {
        const { items } = (await apiRequest("/api/janitor/scan")) as { items: Item[] };
        if (!items.length) return text("The disk janitor proposes nothing now.");
        const total = items.reduce((s, i) => s + i.sizeBytes, 0);
        return text([
          `The disk janitor would propose ${items.length} item(s), ${size(total)} in all. Only the user approves, in Tars's window.`,
          ...items.map(i => `- ${i.label} (${i.kind}, ${size(i.sizeBytes)}): ${i.rule}`),
        ].join("\n"));
      },
    }),
  ]);
}
