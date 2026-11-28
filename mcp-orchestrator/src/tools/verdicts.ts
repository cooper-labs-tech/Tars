import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

/**
 * A gate's verdict as data (Tars's gate-verdicts): QA's, the Audit's or CI's MERGE or NO-MERGE on a pull request's
 * head. Tars records it in your own name (your token says who you are), links it to the traced turns of your project
 * that made that head or an ancestor of it on the pull request's branch, and puts it in those sessions' outcome.
 */
export function registerVerdictTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "record_verdict",
      description: "Record a gate's verdict on a pull request's head, as data: gate (qa or audit), the pull request's number, the judged head's full commit hash, merge or no_merge, and the test counts when you ran tests. Recorded in your own name and role, for your project; the latest verdict for a gate, pull request and head stands. Refused on your own work (your traced turns made that head or a commit before it). Tars links it to the traced turns that made that head and puts it in their sessions' outcome; CI's verdict Tars reads itself from the pull request's checks.",
      schema: {
        gate: z.enum(["qa", "audit"]).describe("Which gate judged."),
        pr: z.number().int().min(1).describe("The pull request's number."),
        head: z.string().regex(/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).describe("The full hash of the commit judged (the pull request's head at the time)."),
        verdict: z.enum(["merge", "no_merge"]).describe("MERGE or NO-MERGE."),
        branch: z.string().max(200).optional().describe("The pull request's branch, if you know it: earlier turns on it whose commits the head contains are linked too."),
        test_command: z.string().max(500).optional().describe("The test command the gate ran."),
        passed: z.number().int().min(0).optional(),
        failed: z.number().int().min(0).optional(),
        skipped: z.number().int().min(0).optional(),
        report: z.string().max(1000).optional().describe("The path of the gate's report on this computer (kept here, never uploaded)."),
      },
      failure: "recording the verdict",
      async run(args: { gate: string; pr: number; head: string; verdict: string; branch?: string; test_command?: string; passed?: number; failed?: number; skipped?: number; report?: string }) {
        const r = (await apiRequest("/api/verdicts", "POST", {
          gate: args.gate, pr: args.pr, head: args.head, verdict: args.verdict, branch: args.branch, testCommand: args.test_command,
          passed: args.passed, failed: args.failed, skipped: args.skipped, report: args.report,
        })) as { changed: boolean; linked: Array<{ traceId: string; turnIndex: number }>; incomplete?: boolean };
        const sessions = new Set(r.linked.map(l => l.traceId)).size;
        return text(`Recorded ${args.gate} ${args.verdict} on #${args.pr} at ${args.head.slice(0, 9)}${r.changed ? "" : " (the same verdict was already recorded)"}: linked to ${r.linked.length} traced turn(s) in ${sessions} session(s)${r.incomplete ? "; some earlier commits on the branch were not checked in time" : ""}.`);
      },
    }),
  ]);
}
