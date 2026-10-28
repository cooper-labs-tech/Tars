/**
 * The heavy-run slot for the whole machine (electron/services/heavy-slot.ts, the local API's /api/heavy-slot):
 * test suites, builds, dev servers, Docker and simulators of every project's agents take it in turn.
 *
 * The lease is held by this server's parent, the agent's CLI: it goes back by itself when the CLI ends, and the agent
 * gives it back when its run is over. For a git hook or a script, `tars-slot run -- <command>` in the agent's
 * terminal holds it for the command alone, which is the better way when the run is one command.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { problem, registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

type Ticket = {
  id: string; state: "granted" | "waiting"; position?: number; why?: string; priority: string; clamped?: boolean;
  label: string; agentName: string; project: string; grantedAt?: string; nestedIn?: string; alerts: string[];
};
type Status = { slots: number; holders: Ticket[]; waiting: Ticket[] };

const WAIT_DEFAULT_S = 60;
const WAIT_MAX_S = 600;

function said(t: Ticket): string {
  if (t.state === "granted") {
    return [
      `Granted: ticket ${t.id}${t.nestedIn ? " (inside the run that holds the slot)" : ""}. Run your heavy command now, then give the slot back with heavy_slot_give_back.`,
      ...(t.clamped ? ["gate is an orchestrator's: asked as normal."] : []),
      ...t.alerts.map(a => `Alert: ${a}`),
    ].join("\n");
  }
  return `Waiting (position ${t.position ?? "?"}): ${t.why ?? "in the queue"}. Ticket ${t.id}: call heavy_slot_take with this ticket to wait again. Do not start the heavy run before it is granted.`;
}

export function registerHeavySlotTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "heavy_slot_take",
      description: "Take the machine's heavy-run slot before a test suite, a build, a dev server, Docker or a simulator: every project's agents share it. Waits up to wait_seconds; if not granted by then, returns the ticket and why it waits (the holder, or free disk or memory under the floor), to wait again with it. The slot is yours until you give it back or your CLI ends. For one command, `tars-slot run -- <command>` in your terminal is simpler.",
      schema: {
        label: z.string().max(120).optional().describe("What the run is, as others will see it in the queue: e.g. 'e2e suite' or 'next build'."),
        priority: z.enum(["gate", "normal", "background"]).optional().describe("gate: a release gate (orchestrators only; others get normal). normal by default; background for what can wait."),
        ticket: z.string().optional().describe("A ticket a previous call returned waiting: wait on it again instead of asking anew."),
        wait_seconds: z.number().int().min(0).max(WAIT_MAX_S).optional().describe(`How long to wait for the grant in this call (default ${WAIT_DEFAULT_S}).`),
      },
      failure: "taking the heavy-run slot",
      async run({ label, priority, ticket, wait_seconds }) {
        let t: Ticket;
        if (ticket) {
          t = ((await apiRequest(`/api/heavy-slot/tickets/${encodeURIComponent(ticket)}`, "GET")) as { ticket: Ticket }).ticket;
        } else {
          // The CLI that started this server holds the lease: it ends when the CLI ends.
          t = ((await apiRequest("/api/heavy-slot/ask", "POST", { pid: process.ppid, label: label ?? "a heavy run", ...(priority ? { priority } : {}) })) as { ticket: Ticket }).ticket;
        }
        const deadline = Date.now() + (wait_seconds ?? WAIT_DEFAULT_S) * 1000;
        while (t.state !== "granted" && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 2000));
          t = ((await apiRequest(`/api/heavy-slot/tickets/${encodeURIComponent(t.id)}`, "GET")) as { ticket: Ticket }).ticket;
        }
        return text(said(t));
      },
    }),
    tool({
      name: "heavy_slot_give_back",
      description: "Give the heavy-run slot back once your heavy run is over (or give up a ticket that still waits), so the next agent in the queue gets it.",
      schema: {
        ticket: z.string().describe("The ticket heavy_slot_take returned."),
      },
      failure: "giving the heavy-run slot back",
      async run({ ticket }) {
        await apiRequest(`/api/heavy-slot/tickets/${encodeURIComponent(ticket)}/give-back`, "POST");
        return text(`Given back: ${ticket}.`);
      },
    }),
    tool({
      name: "heavy_slot_status",
      description: "Who holds the machine's heavy-run slot, since when and for what, and who waits, in which order and why.",
      schema: {},
      failure: "reading the heavy-run slot",
      async run() {
        const s = (await apiRequest("/api/heavy-slot", "GET")) as Status & { error?: string };
        if (s.error) return problem(s.error);
        const line = (t: Ticket) => `${t.agentName} (${t.project}): ${t.label}, ${t.priority}`;
        return text([
          `Slots: ${s.slots}.`,
          ...(s.holders.length ? s.holders.map(t => `Holds: ${line(t)} since ${t.grantedAt}.`) : ["Nobody holds it."]),
          ...s.waiting.map(t => `Waits ${t.position}: ${line(t)}${t.why ? `: ${t.why}` : ""}.`),
        ].join("\n"));
      },
    }),
  ]);
}
