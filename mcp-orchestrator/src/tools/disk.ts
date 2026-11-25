import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, problem, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";
import { keepCallerListening } from "./agents.js";

type Item = { id: string; kind: string; label: string; sizeBytes: number; rule: string; why?: string };
type ScanAnswer = { running: boolean; items: Item[]; scannedAt: number | null; progress?: { what: string; done: number; total: number } };
type Report = {
  at: number;
  machine: { diskFreeBytes: number | null; swapUsedMb: number | null; swapGrowthMbPerMin: number | null };
  projects: Array<{ project: string; bytes: number; worktrees: Array<{ name: string; agent: string | null; idleDays: number; bytes: Record<string, number | null>; itemIds: string[] }> }>;
  agents: Array<{ id: string; name: string; status: string | null; tmpBytes: number; itemIds: string[] }>;
  proposedBytes: number;
};

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} kB`);

/**
 * How long one request of disk_scan waits, under the 300 s of undici's headers timeout; and how long the tool waits in
 * all. A scan outlasted the 30 s a single call waited under load on the owner's Mac (19/11): the route now answers
 * at its wait's end with `running`, and the tool asks again until the scan ends or its own time is up.
 */
const SEGMENT_S = 100;
const TOOL_WAIT_S = 600;

function itemsText(items: Item[], head: string): string {
  const total = items.reduce((s, i) => s + i.sizeBytes, 0);
  return [
    `${head} ${items.length} item(s), ${size(total)} in all. Only the user approves, in Tars's window; ask for a cleanup with disk_cleanup_request.`,
    ...items.map(i => `- ${i.id} ${i.label} (${i.kind}, ${size(i.sizeBytes)}): ${i.rule}`),
  ].join("\n");
}

/** The disk janitor: what it proposes, what agents leave behind, and a cleanup asked of the owner, who approves it in the window. */
export function registerDiskTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "disk_scan",
      description: "List what Tars's disk janitor would propose to delete now in your project, by rule: old .next, test artefacts and release/ folders, the node_modules of worktrees idle a week, merged worktrees, stale npx cache entries, unused Docker images, gone agents' temporary folders, and what live agents leave in theirs (ended sessions, old outputs). Each item has its id, for disk_cleanup_request. Read only: nothing is deleted, and only the user approves a deletion, in Tars's window. A scan can take minutes on a loaded machine: this waits for it, up to 10 minutes, and says so if it is still running.",
      schema: {},
      failure: "scanning the disk",
      readOnly: true,
      async run(_args, extra) {
        const stopProgress = keepCallerListening(extra as never);
        try {
          const until = Date.now() + TOOL_WAIT_S * 1000;
          let answer: ScanAnswer;
          do {
            answer = (await apiRequest(`/api/janitor/scan?wait=${SEGMENT_S}`, "GET", undefined, (SEGMENT_S + 30) * 1000)) as ScanAnswer;
          } while (answer.running && Date.now() < until);
          if (answer.running) {
            const since = answer.scannedAt ? ` What the last ended scan (${new Date(answer.scannedAt).toISOString()}) proposed:` : "";
            return text(`The scan is still running (${answer.progress?.what ?? "under way"}): the window shows it as it goes.${since}${answer.items.length ? `\n${itemsText(answer.items, "It proposed")}` : " nothing."}`);
          }
          if (!answer.items.length) return text("The disk janitor proposes nothing now in your project.");
          return text(itemsText(answer.items, "The disk janitor would propose"));
        } finally {
          stopProgress();
        }
      },
    }),
    tool({
      name: "disk_report",
      description: "What agents leave behind on the disk in your project, from the janitor's last scan (every 6 hours at least): each worktree with its agent, how long nothing changed in it, what its .next, release/, test artefacts and node_modules take, and the janitor items in it; each agent with what its temporary folders take; the machine's free disk, swap used and swap growth. Read only.",
      schema: {},
      failure: "reading the disk report",
      readOnly: true,
      async run(_args, extra) {
        const stopProgress = keepCallerListening(extra as never);
        try {
          const { report, running } = (await apiRequest(`/api/disk/report?wait=${SEGMENT_S}`, "GET", undefined, (SEGMENT_S + 30) * 1000)) as { report: Report | null; running: boolean };
          if (!report) return text(running ? "No report yet: the first scan is still running. Ask again in a few minutes." : "No report yet.");
          const m = report.machine;
          const lines = [
            `Disk report of ${new Date(report.at).toISOString()}. Free disk: ${m.diskFreeBytes === null ? "not measured" : size(m.diskFreeBytes)}; swap used: ${m.swapUsedMb === null ? "not measured" : `${(m.swapUsedMb / 1024).toFixed(1)} GB`}${m.swapGrowthMbPerMin === null ? "" : `, growing ${m.swapGrowthMbPerMin.toFixed(0)} MB a minute`}. The janitor proposes ${size(report.proposedBytes)} in all.`,
          ];
          for (const p of report.projects) {
            lines.push(`\n${p.project} (${size(p.bytes)} of caches):`);
            for (const w of p.worktrees) {
              const parts = Object.entries(w.bytes).filter(([, v]) => v !== null && v > 0).map(([k, v]) => `${k} ${size(v!)}`);
              lines.push(`- ${w.name}${w.agent ? `, ${w.agent}` : ""}, idle ${w.idleDays} d: ${parts.length ? parts.join(", ") : "no cache"}${w.itemIds.length ? `; items ${w.itemIds.join(" ")}` : ""}`);
            }
          }
          lines.push("\nAgents' temporary folders:");
          for (const a of report.agents) lines.push(`- ${a.name} (${a.status ?? "?"}): ${size(a.tmpBytes)}${a.itemIds.length ? `; items ${a.itemIds.join(" ")}` : ""}`);
          return text(lines.join("\n"));
        } finally {
          stopProgress();
        }
      },
    }),
    tool({
      name: "disk_cleanup_request",
      description: "Ask the user to clean up items of the disk janitor in your project (their ids, from disk_scan or disk_report), saying why. Tars shows the request in its window, where the user approves it in one click; nothing is deleted until then, and each item is checked again just before it goes.",
      schema: {
        ids: z.array(z.string()).min(1).max(200).describe("The janitor items' ids, from disk_scan or disk_report, all in your project"),
        why: z.string().min(1).max(300).describe("Why, in one line: what it frees and why now"),
      },
      failure: "asking for a cleanup",
      async run({ ids, why }) {
        try {
          const answer = (await apiRequest("/api/janitor/request", "POST", { ids, why })) as { requested: string; items: number; bytes: number };
          return text(`Request ${answer.requested} sent: ${answer.items} item(s), ${size(answer.bytes)}. The user approves it in Tars's window, in one click; nothing is deleted until then.`);
        } catch (err) {
          return problem(`The cleanup request was refused: ${(err as Error).message}`);
        }
      },
    }),
  ]);
}
