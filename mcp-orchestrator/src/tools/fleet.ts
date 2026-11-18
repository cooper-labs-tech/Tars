import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

/** A project's view, as Tars answers it (electron/services/fleet-operations.ts). */
type Project = {
  projectPath: string;
  schedule?: { line: string; onStart: string; setBy: string; next: { open: boolean; start: string; end: string } };
  cap?: { cap: number; setBy: string };
  window?: {
    start: string; end: string; openedAt: string; late?: string; closedAt?: string; closedLate?: string; ended?: string;
    resumed: string[]; started: string[]; startFailed: Array<{ agent: string; why: string }>;
    stopped: Array<{ agent: string; afterTurn?: boolean }>; stopping: Array<{ agent: string }>; leftRunning: Array<{ agent: string; why: string }>;
    warnings: Array<{ text: string }>; slept: Array<{ at: string; wokeAt?: string }>;
  };
};

/** One project, in lines an agent reads. */
function describe(p: Project): string {
  const lines = [`${p.projectPath}:`];
  if (p.schedule) {
    lines.push(`- hours: ${p.schedule.line}, set by ${p.schedule.setBy}; at the start: ${p.schedule.onStart === "start-agents" ? "the queues resume and each agent at rest is started" : "the queues resume, and the agents start as their work comes"}.`);
    lines.push(p.schedule.next.open ? `- open now, until ${p.schedule.next.end}.` : `- next window: ${p.schedule.next.start} to ${p.schedule.next.end}.`);
  } else {
    lines.push("- no hours: its agents work whenever they are handed work.");
  }
  lines.push(p.cap ? `- cap: ${p.cap.cap} workers at work at once, set by ${p.cap.setBy}; work beyond it waits in the agents' queues.` : "- no cap on its workers at work.");
  const w = p.window;
  if (w) {
    lines.push(`- ${w.closedAt ? "last window" : "this window"}: ${w.start} to ${w.end}, opened ${w.openedAt}${w.late ? ` (${w.late})` : ""}${w.closedAt ? `, closed ${w.closedAt}${w.closedLate ? ` (${w.closedLate})` : ""}${w.ended === "cleared" ? ", its hours cleared" : ""}` : ""}.`);
    if (w.resumed.length) lines.push(`  queues resumed: ${w.resumed.join(", ")}`);
    if (w.started.length) lines.push(`  started: ${w.started.join(", ")}`);
    for (const f of w.startFailed) lines.push(`  did not start: ${f.agent}: ${f.why}`);
    if (w.stopped.length) lines.push(`  stopped: ${w.stopped.map((s) => `${s.agent}${s.afterTurn ? " (after its turn)" : ""}`).join(", ")}`);
    if (w.stopping.length) lines.push(`  to stop once its turn ends: ${w.stopping.map((s) => s.agent).join(", ")}`);
    for (const l of w.leftRunning) lines.push(`  left running: ${l.agent}: ${l.why}`);
    for (const s of w.slept) lines.push(`  the computer slept at ${s.at}${s.wokeAt ? `, woke at ${s.wokeAt}` : ", and has not woken since"}`);
    for (const warning of w.warnings) lines.push(`  warning: ${warning.text}`);
  }
  return lines.join("\n");
}

/**
 * A project's hours and its cap on workers at work (2.0.7). Set by the project's own orchestrator and the owner; any
 * agent reads them.
 */
export function registerFleetTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "project_schedule",
      description: "A project's hours: a window every day when its agents work, from a start to a stop in HH:MM, in UTC or in the computer's local time (always say which). At the start, the queues the last stop paused go again (and, with onStart 'start-agents', each agent at rest is started); at the stop, every agent's queue is paused, so work handed outside the hours waits for the next window, never refused and never lost, and every agent is stopped once its current turn has ended, never in the middle of one. Kept across a restart of Tars. While a window is open the computer is kept awake, and the owner is warned once a window when it runs on battery or with its lid closed. action 'get' (the default) reads every project's hours, cap and what its last window did, or one project's; 'set' and 'clear' are for the project's own orchestrator (and the owner, in the window).",
      schema: {
        action: z.enum(["get", "set", "clear"]).optional().describe("'get' (default), 'set' or 'clear'"),
        project: z.string().optional().describe("The project's folder, as list_agents gives it. Omitted: your own project (for 'get' with no project and no own project: every project)."),
        start: z.string().optional().describe("With 'set': the start of the window, HH:MM on 24 hours, e.g. '22:00'"),
        stop: z.string().optional().describe("With 'set': its stop, HH:MM; before the start, it ends the next day, e.g. '06:00'"),
        timeZone: z.enum(["UTC", "local"]).optional().describe("With 'set', required: 'UTC', or 'local' for the computer's own time. Tars never guesses it."),
        onStart: z.enum(["resume-queues", "start-agents"]).optional().describe("With 'set': 'resume-queues' (default: the agents start as their work comes) or 'start-agents' (each agent at rest is started too)"),
      },
      failure: "reading or setting the project's hours",
      async run({ action = "get", project, start, stop, timeZone, onStart }) {
        if (action === "get") {
          if (project) {
            const { project: p } = (await apiRequest(`/api/fleet/project?project=${encodeURIComponent(project)}`)) as { project: Project };
            return text(describe(p));
          }
          const { projects } = (await apiRequest("/api/fleet/projects")) as { projects: Project[] };
          return text(projects.length ? projects.map(describe).join("\n\n") : "No project has hours or a cap.");
        }
        if (action === "clear") {
          const { project: p } = (await apiRequest("/api/fleet/schedule/clear", "POST", project ? { project } : {})) as { project: Project };
          return text(`Cleared the hours of ${p.projectPath}: its agents work whenever they are handed work. A window open now ended with it: nobody was stopped, and no queue was paused.`);
        }
        const { project: p } = (await apiRequest("/api/fleet/schedule", "POST", { ...(project ? { project } : {}), start, stop, timeZone, ...(onStart ? { onStart } : {}) })) as { project: Project };
        return text(`Set. ${describe(p)}`);
      },
    }),
    tool({
      name: "project_cap",
      description: "A project's cap: the most of its workers at work at once (its orchestrator is neither counted nor held). Work handed to a worker beyond it (delegate_task, start_agent, a message that would start a session) is never refused and never lost: it waits in that agent's queue, read as waiting for its project's cap, and goes in when a place frees, the oldest of the project first. A message typed into a session already up goes in as before. Set by the project's own orchestrator (and the owner, in the window); project_schedule 'get' reads it.",
      schema: {
        cap: z.number().int().min(1).max(64).nullable().describe("1 to 64, or null to remove the cap"),
        project: z.string().optional().describe("The project's folder, as list_agents gives it. Omitted: your own project."),
      },
      failure: "setting the project's cap",
      async run({ cap, project }) {
        const { project: p } = (await apiRequest("/api/fleet/cap", "POST", { ...(project ? { project } : {}), cap })) as { project: Project };
        return text(p.cap ? `${p.projectPath}: at most ${p.cap.cap} workers at work at once from now; work beyond it waits in their queues.` : `${p.projectPath}: no cap on its workers at work any more.`);
      },
    }),
  ]);
}
