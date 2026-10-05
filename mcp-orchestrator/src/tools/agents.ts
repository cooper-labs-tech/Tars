/**
 * Agent management tools for the MCP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { problem, registerTools, text, tool, type Tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest, getCallerIdentity } from "../utils/api.js";

type WaitResult = {
  status: string;
  lastCleanOutput?: string;
  error?: string;
  timeout?: boolean;
  waitingReason?: string;
  /** Set when the agent was stopped: "you", "Tars", or the agent that asked. */
  stoppedBy?: string;
  stopReason?: string;
  /** ISO: running, yet nothing written and no tool at work since then (Tars's stall watch). */
  stalledSince?: string;
  /** ISO: asleep since then, its CLI ended after 30 minutes without a turn. */
  asleepSince?: string;
};

type DispatchResult = {
  success: boolean;
  mode: "message" | "start";
  previousStatus?: string;
  /**
   * Nothing was typed yet: the message is queued for the agent's terminal,
   * whose field is in use, and goes in by itself when it frees. The route has
   * said so since 1.7.8; the tools answered "Sent message" over it.
   */
  held?: boolean;
  heldReason?: string;
  agent: { id: string; name?: string; status: string };
};

/** What a caller is told when its message is queued rather than typed. */
function heldText(agentName: string, what: string, reason?: string): string {
  return `HELD: ${what} for "${agentName}" is waiting for its terminal and has not been typed in yet. `
    + (reason ?? "Its field is in use.")
    // Never "nothing needs resending": a field only a person can free may not
    // free (bug-held-forever-05-10.md). The route tells the sender again.
    + " It goes in by itself once the field is free; if it still waits a few minutes on, Tars tells you again.";
}

/**
 * Atomically hand a task to an agent. The server decides message-vs-spawn
 * under its single-threaded event loop: the old GET-status-then-POST pattern
 * raced against status changes and could message a dead PTY.
 *
 * The agent's own configured permission mode is respected (most agents are
 * 'auto'); if a permission dialog does block the agent, the server reports
 * waitingReason 'permission' instead of hanging.
 */
async function dispatchToAgent(
  id: string,
  message: string,
  model?: string,
  allowCrossProject?: boolean
): Promise<DispatchResult> {
  return (await apiRequest(`/api/agents/${id}/dispatch`, "POST", {
    message,
    model,
    allowCrossProject,
  })) as DispatchResult;
}

/**
 * The longest a single long-poll request may run.
 *
 * Node's fetch is undici, whose `headersTimeout` defaults to 300000ms, and
 * /wait sends no headers at all until the agent's status changes. So a wait
 * that stayed quiet for five minutes did not time out cleanly, it died as
 * "fetch failed", and the AbortController above it was never the thing that
 * fired. Waiting more than five minutes on a real piece of work is the normal
 * case, so every long wait was broken.
 *
 * Segmenting under that ceiling fixes it without depending on an undici
 * default: each request returns well before any of them can bite. Passing a
 * dispatcher with the timeout disabled would also work, and only for undici,
 * and only until a request is cut for some other reason. This survives that
 * too, because a failed segment is simply the next one's problem.
 */
const WAIT_SEGMENT_SECONDS = 120;
/**
 * How long the API may be unreachable before a wait gives up on it.
 *
 * Counted in time, not in attempts. Three bare retries with nothing between
 * them abandoned a thirty minute wait after two seconds, which replaces a
 * failure at five minutes with a worse one at two seconds. The case this has
 * to survive is Tars being restarted while an agent is working: that takes
 * several seconds, and the wait should still be there afterwards.
 */
const FAILURE_GRACE_MS = 90_000;
const FAILURE_BACKOFF_START_MS = 2_000;
const FAILURE_BACKOFF_MAX_MS = 30_000;

/**
 * Wait for an agent's status to change, for as long as asked.
 *
 * Made of short long-polls back to back rather than one long one. The server
 * already answers `{timeout: true}` when a segment expires with nothing to
 * report, which is the signal to go round again.
 */
async function waitForAgentStatus(id: string, timeoutSeconds: number): Promise<WaitResult> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let failingSince = 0;
  let backoffMs = FAILURE_BACKOFF_START_MS;
  let last: WaitResult | undefined;

  for (;;) {
    const remainingSec = Math.ceil((deadline - Date.now()) / 1000);
    if (remainingSec <= 0) {
      return last ?? { status: "running", timeout: true };
    }
    const segment = Math.min(WAIT_SEGMENT_SECONDS, remainingSec);

    const startedAt = Date.now();
    try {
      last = (await apiRequest(
        `/api/agents/${id}/wait?timeout=${segment}`,
        "GET",
        undefined,
        (segment + 30) * 1000
      )) as WaitResult;
      failingSince = 0;
      backoffMs = FAILURE_BACKOFF_START_MS;
    } catch (err) {
      // A segment that dies takes the rest of the wait with it only if they
      // keep dying, for long enough that the API is not coming back. One
      // dropped connection, or a Tars restart, is not a reason to abandon an
      // agent that is still working.
      const now = Date.now();
      if (!failingSince) failingSince = now;
      if (now - failingSince >= FAILURE_GRACE_MS || now >= deadline) throw err;

      await new Promise((r) => setTimeout(r, Math.min(backoffMs, deadline - now)));
      backoffMs = Math.min(backoffMs * 2, FAILURE_BACKOFF_MAX_MS);
      continue;
    }

    // Anything that is not a segment expiring is the answer being waited for.
    if (!last.timeout) return last;

    // A poll that reports its expiry the instant it is asked was not held
    // open, and going straight round again would turn a patient wait into a
    // hot loop against the API. Pause before asking again. Only the degenerate
    // case pays this: a poll that really waited has already spent its segment.
    if (Date.now() - startedAt < segment * 500) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Fetch the agent's captured clean output, retrying briefly: the Stop hook
 * posts output and status through separate HTTP calls, so the status event
 * that resolves /wait can beat the output write by a moment.
 */
async function fetchCleanOutput(
  id: string,
  attempts = 3,
  delayMs = 700
): Promise<{ output?: string; status: string; name?: string }> {
  let last: { agent: { status: string; name?: string; lastCleanOutput?: string } } | undefined;
  for (let i = 0; i < attempts; i++) {
    last = (await apiRequest(`/api/agents/${id}`)) as typeof last;
    if (last?.agent.lastCleanOutput) {
      return { output: last.agent.lastCleanOutput, status: last.agent.status, name: last.agent.name };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { output: undefined, status: last?.agent.status ?? "unknown", name: last?.agent.name };
}

/**
 * Sends the caller a progress notification every minute until stopped, when
 * the call carries a progressToken (Claude Code 2.1.280 sends one with every
 * call). Claude Code abandons an MCP call that sends nothing for 30 minutes,
 * "sent no response or progress for 1811s; aborting", and a progress
 * notification resets that clock: measured on a 150 s call with the limit
 * lowered to seconds, silent it was aborted, with progress every 5 s it
 * completed. Without this, a delegation longer than half an hour went on in
 * the agent while the orchestrator that asked for it had stopped listening.
 */
export function keepCallerListening(
  extra: { _meta?: { progressToken?: string | number }; sendNotification?: (n: never) => Promise<void> } | undefined,
  everyMs = 60_000,
): () => void {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return () => {};
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    send({ method: "notifications/progress", params: { progressToken: token, progress, message: "still waiting on the agent" } } as never)
      .catch(() => { /* the caller has gone: nothing to keep */ });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The agent tools, in the order tools/list gives them. */
const AGENT_TOOLS: Tool[] = [
  // Identity handshake for orchestrator sessions
  tool({
    name: "whoami",
    description: "Get YOUR identity as a Tars agent: id, name, project, role, and the roster of your project's agents. Call this first if you are unsure who you are or who you can delegate to.",
    schema: {},
    failure: "resolving identity",
    async run() {
      const { agentId, projectPath } = getCallerIdentity();
      if (!agentId && !projectPath) {
        return text("No agent identity found in the environment (CLAUDE_AGENT_ID / CLAUDE_PROJECT_PATH are unset). You are probably running outside a Tars-managed session; list_agents will return ALL agents unscoped.");
      }
      let selfInfo: string;
      if (agentId) {
        const data = (await apiRequest(`/api/agents/${agentId}`)) as {
          agent: { name?: string; role?: string; projectPath: string; branchName?: string; worktreePath?: string };
        };
        selfInfo =
          `You are "${data.agent.name || agentId}" (agent id: ${agentId}), ` +
          `${data.agent.role || "agent"} of project ${data.agent.projectPath}` +
          (data.agent.branchName ? ` (branch ${data.agent.branchName})` : "") +
          ".";
      } else {
        selfInfo = `Your project: ${projectPath} (no agent id available).`;
      }
      const list = (await apiRequest("/api/agents")) as { agents: unknown[] };
      return text(`${selfInfo}\n\nYour project's agents:\n${JSON.stringify(list.agents, null, 2)}`);
    },
  }),

  // Scoped to the caller's project by default
  tool({
    name: "list_agents",
    description: "List the agents of YOUR project and their current status (idle/running/waiting/completed/error). Only these agents can receive your tasks: delegating to another project's agents is rejected. `all: true` adds other projects' agents for visibility ONLY; they remain undelegatable, and you must not present them as agents you have access to.",
    schema: {
      all: z.boolean().optional().describe("If true, list agents of ALL projects instead of only your own"),
    },
    failure: "listing agents",
    async run({ all }) {
      const data = (await apiRequest(all ? "/api/agents?all=true" : "/api/agents")) as {
        agents: unknown[];
        scopedToProject?: string;
      };
      // When the caller asked for the global view, say plainly which of these
      // it can actually act on. Listing every project's agents under a
      // heading like "agents you have access to" is misleading: delegation
      // to another project is rejected, so most of that list is unreachable.
      // Asking an agent to list "all the agents you have access to" is
      // exactly the phrasing that makes a model pass all:true.
      const mine = getCallerIdentity().projectPath;
      if (all) {
        const rows = (data.agents as Array<Record<string, unknown>>) ?? [];
        const reachable = mine ? rows.filter(a => a.projectPath === mine) : rows;
        const others = mine ? rows.filter(a => a.projectPath !== mine) : [];
        const header = mine
          ? `You can delegate to these ${reachable.length} agent(s) - they are in your project (${mine}):`
          : `No caller identity, so nothing here is scoped:`;
        const tail = others.length
          ? `\n\nThe following ${others.length} agent(s) belong to OTHER projects. They are listed ` +
            `because all:true was requested. You CANNOT delegate to them - delegate_task will ` +
            `reject it. Do not describe them as available to you:\n` +
            JSON.stringify(others, null, 2)
          : "";
        return text(`${header}\n${JSON.stringify(reachable, null, 2)}${tail}`);
      }

      const scopeNote = data.scopedToProject
        ? `Agents of your project (${data.scopedToProject}):\n`
        : "";
      return text(`${scopeNote}${JSON.stringify(data.agents, null, 2)}`);
    },
  }),

  tool({
    name: "get_agent",
    description: "Get detailed information about a specific agent including its full output history.",
    schema: {
      id: z.string().describe("The agent ID"),
    },
    failure: "getting agent",
    async run({ id }) {
      const data = (await apiRequest(`/api/agents/${id}`)) as { agent: unknown };
      return text(JSON.stringify(data.agent, null, 2));
    },
  }),

  // Clean text from the transcript, no ANSI
  tool({
    name: "get_agent_output",
    description: "Get the agent's last response as clean text (no terminal formatting). This is captured from the agent's transcript by hooks. Falls back to noting output is available in terminal view if no clean output is captured yet.",
    schema: {
      id: z.string().describe("The agent ID"),
    },
    failure: "getting output",
    async run({ id }) {
      const data = (await apiRequest(`/api/agents/${id}`)) as {
        agent: {
          status: string;
          name?: string;
          lastCleanOutput?: string;
        };
      };
      const agentName = data.agent.name || id;

      if (data.agent.lastCleanOutput) {
        return text(`Agent "${agentName}" (${data.agent.status}):\n\n${data.agent.lastCleanOutput}`);
      }

      return text(`Agent "${agentName}" (${data.agent.status}): No clean output captured yet. The agent's terminal output is available in the Tars UI. Clean output is captured when the agent pauses or completes.`);
    },
  }),

  tool({
    name: "create_agent",
    description: "Create a new agent. Defaults to YOUR project when projectPath is omitted; another project is refused unless allowCrossProject is true. The agent will be in 'idle' state until started. By default, agents run with --dangerously-skip-permissions for autonomous operation.",
    schema: {
      projectPath: z.string().optional().describe("Absolute path to the project directory (defaults to your own project)"),
      name: z.string().optional().describe("Name for the agent (e.g., 'Backend Worker', 'Test Runner')"),
      skills: z.array(z.string()).optional().describe("List of skill names to enable for this agent"),
      character: z
        .enum(["robot", "ninja", "wizard", "astronaut", "knight", "pirate", "alien", "viking"])
        .optional()
        .describe("Visual character for the agent"),
      skipPermissions: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), agent runs with --dangerously-skip-permissions flag for autonomous operation"),
      secondaryProjectPath: z.string().optional().describe("Secondary project path to add as context (--add-dir)"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow creating the agent in ANOTHER project than yours (normally rejected)"),
    },
    failure: "creating agent",
    async run({ projectPath, name, skills, character, skipPermissions = true, secondaryProjectPath, allowCrossProject }) {
      const resolvedProjectPath = projectPath || getCallerIdentity().projectPath;
      if (!resolvedProjectPath) {
        return problem("Error: projectPath is required (no caller project identity available).");
      }
      const data = (await apiRequest("/api/agents", "POST", {
        projectPath: resolvedProjectPath,
        name,
        skills,
        character,
        skipPermissions,
        secondaryProjectPath,
        allowCrossProject,
      })) as { agent: { id: string; name: string } };
      return text(`Created agent "${data.agent.name}" with ID: ${data.agent.id}`);
    },
  }),

  tool({
    name: "start_agent",
    description: "Start an agent with a specific task/prompt. If agent is already running/waiting, sends the prompt as a message instead. The agent runs with its own configured permission mode.",
    schema: {
      id: z.string().describe("The agent ID"),
      prompt: z.string().describe("The task or instruction for the agent to work on"),
      model: z.string().optional().describe("Optional model to use. Aliases: 'sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]' (1M context). Full IDs: 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'. Omit to use the agent's configured default."),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    failure: "starting agent",
    async run({ id, prompt, model, allowCrossProject }) {
      const data = await dispatchToAgent(id, prompt, model, allowCrossProject);
      const agentName = data.agent.name || id;

      if (data.held) {
        return text(heldText(agentName, "The task", data.heldReason));
      }

      if (data.mode === "message") {
        return text(`Agent "${agentName}" was already ${data.previousStatus ?? "running"}. Sent message: "${prompt}"`);
      }

      return text(`Started agent "${agentName}". Status: ${data.agent.status}\nTask: ${prompt}`);
    },
  }),

  tool({
    name: "stop_agent",
    description: "Stop an agent: its CLI and everything it started are ended, and it reads 'stopped', with your name and your reason, until it is started again. Give the reason in one line; JeanBrasse reads it in the window.",
    schema: {
      id: z.string().describe("The agent ID"),
      reason: z.string().min(1).describe("Why you stop it, in one line (required), e.g. 'frozen for 40 minutes on a file read'"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    failure: "stopping agent",
    async run({ id, reason, allowCrossProject }) {
      const answer = (await apiRequest(`/api/agents/${id}/stop`, "POST", allowCrossProject ? { reason, allowCrossProject } : { reason })) as
        { alreadyStopped?: boolean; stoppedBy?: string; stopReason?: string } | undefined;
      if (answer?.alreadyStopped) {
        return text(`Agent ${id} was already stopped by ${answer.stoppedBy || "someone"}${answer.stopReason ? `: ${answer.stopReason}` : ""}. Nothing changed.`);
      }
      return text(`Stopped agent ${id}: ${reason}`);
    },
  }),

  tool({
    name: "send_message",
    description: "Send input/message to an agent. If the agent is idle/completed/error, this will START the agent with the message as the prompt. If the agent is 'waiting', this sends the message as input. WARNING: Sending to a 'running' agent may interfere with its current work. Prefer waiting until it reaches 'waiting' or 'completed' status.",
    schema: {
      id: z.string().describe("The agent ID"),
      message: z.string().optional().describe("The message to send to the agent"),
      prompt: z.string().optional().describe("Alias for 'message', use either one"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    failure: "sending message",
    async run({ id, message, prompt, allowCrossProject }) {
      // Accept either "message" or "prompt" so the LLM doesn't trip on naming
      const resolvedMessage = message || prompt;
      if (!resolvedMessage) {
        return problem("Error: either 'message' or 'prompt' is required.");
      }
      const data = await dispatchToAgent(id, resolvedMessage, undefined, allowCrossProject);
      const agentName = data.agent.name || id;
      const previousStatus = data.previousStatus ?? "idle";

      if (data.held) {
        return text(heldText(agentName, "Your message", data.heldReason));
      }

      if (data.mode === "start") {
        return text(`Agent "${agentName}" was ${previousStatus}, started it with prompt: "${resolvedMessage}". New status: ${data.agent.status}`);
      }

      if (previousStatus === "running") {
        return text(`⚠️ Agent "${agentName}" is currently running. Message sent but may interfere with current work. Consider using wait_for_agent first to wait until the agent is done.\nMessage sent: "${resolvedMessage}"`);
      }

      return text(`Sent message to agent "${agentName}" (${previousStatus}): "${resolvedMessage}"`);
    },
  }),

  tool({
    name: "remove_agent",
    description: "Permanently remove an agent. This will stop the agent if running and delete it from the system.",
    schema: {
      id: z.string().describe("The agent ID"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    failure: "removing agent",
    async run({ id, allowCrossProject }) {
      await apiRequest(`/api/agents/${id}${allowCrossProject ? "?allowCrossProject=true" : ""}`, "DELETE");
      return text(`Removed agent ${id}`);
    },
  }),

  // Long-poll, no polling loop
  tool({
    name: "wait_for_agent",
    description: "Wait for an agent to finish its current task. Uses long-polling for efficient waiting: returns as soon as the agent's status changes (no 5-second polling delay). Returns immediately if agent is already idle/waiting/completed/error/stopped.",
    schema: {
      id: z.string().describe("The agent ID"),
      timeoutSeconds: z.number().optional().describe("Maximum time to wait in seconds (default: 300)"),
    },
    failure: "waiting for agent",
    async run({ id, timeoutSeconds = 300 }) {
      const data = await waitForAgentStatus(id, timeoutSeconds);

      const agentData = (await apiRequest(`/api/agents/${id}`)) as {
        agent: { name?: string };
      };
      const agentName = agentData.agent.name || id;

      if (data.timeout) {
        return problem(`Timeout after ${timeoutSeconds}s. Agent "${agentName}" is still '${data.status}'. Use get_agent_output to check progress.`);
      }

      if (data.status === "completed" || data.status === "idle") {
        const outputInfo = data.lastCleanOutput
          ? `\n\nOutput:\n${data.lastCleanOutput}`
          : "\n\nUse get_agent_output to read the result.";
        return text(`Agent "${agentName}" finished (${data.status}).${outputInfo}`);
      }

      if (data.status === "error") {
        return problem(`Agent "${agentName}" encountered an error: ${data.error || "Unknown error"}`);
      }

      if (data.status === "stopped") {
        return text(`Agent "${agentName}" was stopped by ${data.stoppedBy || "someone"}${data.stopReason ? `: ${data.stopReason}` : ""}. It does nothing until it is started again.`);
      }

      if (data.status === "asleep") {
        return text(`Agent "${agentName}" is asleep${data.asleepSince ? ` since ${data.asleepSince}` : ""}: it had no turn for 30 minutes, so Tars ended its CLI and kept its conversation. Its last work is done; get_agent_output reads what it last said, and send_message wakes it on that conversation.`);
      }

      if (data.status === "waiting") {
        const reasonInfo = data.waitingReason === "permission"
          ? " It is blocked on a PERMISSION dialog: send_message cannot answer it; resolve it in the Tars UI or stop_agent and re-delegate."
          : " Use send_message to respond, or get_agent_output to see what it's asking.";
        return text(`Agent "${agentName}" is waiting for input.${reasonInfo}`);
      }

      if (data.status === "running" && data.stalledSince) {
        return problem(`Agent "${agentName}" is running but has written nothing since ${data.stalledSince} and runs no tool: it looks frozen. Read get_agent_output; if nothing moves, stop it and start it again with a brief of what is already done.`);
      }

      return text(`Agent "${agentName}" status: ${data.status}`);
    },
  }),

  // Composite: start, wait, then the output
  tool({
    name: "delegate_task",
    description: "Delegate a task to an agent and wait for the result. This is the primary tool for task delegation: it starts the agent, waits for completion using long-polling, and returns the clean text result. Much more efficient than calling start_agent + wait_for_agent + get_agent_output separately.",
    schema: {
      id: z.string().describe("The agent ID to delegate to"),
      prompt: z.string().describe("The task/instruction for the agent"),
      model: z.string().optional().describe("Optional model to use. Aliases: 'sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]' (1M context). Full IDs: 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'. Omit to use the agent's configured default."),
      timeoutSeconds: z.number().optional().describe("Maximum time to wait in seconds (default: 300)"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow delegating to an agent of ANOTHER project (normally rejected)"),
    },
    failure: "delegating task",
    async run({ id, prompt, model, timeoutSeconds = 300, allowCrossProject }, extra) {
      // Claude Code abandons an MCP call silent for 30 minutes; a delegation
      // can last an hour. Progress while it waits keeps the caller listening.
      const stopProgress = keepCallerListening(extra);
      try {
        // Preferred path: run the task over the Agent Client Protocol, which
        // returns the agent's actual answer, why the turn ended and what it
        // cost. Falls back to the terminal dispatch below for CLIs that have
        // no ACP mode, or when the run itself could not start.
        try {
          const acp = (await apiRequest(
            `/api/agents/${id}/run-task`,
            "POST",
            { task: prompt, timeoutSeconds },
            (timeoutSeconds + 60) * 1000,
          )) as {
            ok?: boolean;
            started?: boolean;
            stopReason?: string;
            text?: string;
            toolCalls?: string[];
            backgroundStopped?: string[];
            usage?: { totalTokens?: number };
            costUSD?: number;
            error?: string;
            retryWithDispatch?: boolean;
          };

          // A run that started is the answer, however it ended. Falling back
          // to the terminal after one typed the same brief into a second
          // session: the task ran twice (Parallel project, 2026-09-23).
          if (acp && !acp.retryWithDispatch && (acp.ok || acp.text || acp.started)) {
            const meta = [
              acp.stopReason ? `ended: ${acp.stopReason}` : "",
              acp.toolCalls?.length ? `tools: ${acp.toolCalls.slice(0, 8).join(", ")}` : "",
              acp.usage?.totalTokens ? `${acp.usage.totalTokens} tokens` : "",
              typeof acp.costUSD === "number" ? `$${acp.costUSD.toFixed(4)}` : "",
            ].filter(Boolean).join(" | ");
            // A run is one turn: what the agent left running when it answered
            // was stopped with it, and nothing brings it back for that work.
            const left = acp.backgroundStopped?.length
              ? `\nstopped when the run ended: ${acp.backgroundStopped.join(", ")}. Re-delegate what still needs doing.`
              : "";
            const why = !acp.ok && acp.error ? `\n${acp.error}` : "";

            return {
              content: [{
                type: "text",
                text: `${acp.text || "(the agent produced no text)"}\n\n---\n${meta}${why}${left}`,
              }],
              isError: !acp.ok,
            };
          }
        } catch (err) {
          // This call's own wait ran out: the run it started may still be
          // working, and typing the brief into the terminal as well would run
          // the task twice.
          if (err instanceof Error && err.name === "AbortError") {
            return problem(`No answer from agent ${id} within ${timeoutSeconds + 60} s. The run may still be working: follow it with get_agent or wait_for_agent rather than delegating the task again.`);
          }
          // No run started (this CLI has no ACP mode, or its launch failed).
          // The terminal path still works.
        }

        // Atomic dispatch: the server decides message-vs-spawn under its own
        // lock, so a stale status can never route the prompt to a dead PTY.
        const dispatched = await dispatchToAgent(id, prompt, model, allowCrossProject);
        const agentName = dispatched.agent.name || id;

        // Not typed yet: waiting here would wait on a turn that has not
        // started, for as long as the field stays in use, and then report the
        // agent as still running. Say it now; wait_for_agent follows it.
        if (dispatched.held) {
          return text(heldText(agentName, "The task", dispatched.heldReason)
            + " delegate_task is not waiting on it: use wait_for_agent to follow it.");
        }

        // Wait for completion via long-poll
        let waitData = await waitForAgentStatus(id, timeoutSeconds);

        if (waitData.status === "waiting") {
          if (waitData.waitingReason === "permission") {
            // A blocking permission dialog: typing text into it does nothing
            // useful (it expects arrow keys/enter). Surface it instead.
            return problem(`Agent "${agentName}" is blocked on a PERMISSION dialog and cannot proceed autonomously. Resolve it in the Tars UI, or stop_agent and re-delegate.`);
          }
          // Agent asked for confirmation: auto-reply "continue" and wait
          // again. A single retry only answers the FIRST question a task
          // asks - a multi-step task that pauses to confirm several times
          // used to fall back on the orchestrator to notice "still waiting"
          // and manually nudge it again for every subsequent question. Loop
          // instead, bounded so a truly stuck agent still surfaces rather
          // than spinning forever.
          const MAX_AUTO_CONTINUES = 8;
          const deadline = Date.now() + timeoutSeconds * 1000;
          let autoContinues = 0;

          while (waitData.status === "waiting" && waitData.waitingReason !== "permission") {
            if (autoContinues >= MAX_AUTO_CONTINUES) break;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;

            autoContinues++;
            let continued: DispatchResult;
            try {
              continued = await dispatchToAgent(
                id,
                "Yes, continue. Do not ask for confirmation. Complete the task and report your results.",
                undefined,
                allowCrossProject
              );
            } catch {
              // Auto-continue itself failed (agent gone, network hiccup):
              // stop looping and report the waiting state as-is below.
              break;
            }
            // Held like the task itself can be: nothing was typed, and a wait
            // now would run out on a turn that never began, then call the
            // agent still running (the gate of #128).
            if (continued.held) {
              return text(heldText(agentName, "The answer to its question", continued.heldReason)
                + " delegate_task is not waiting on it: use wait_for_agent to follow it.");
            }
            waitData = await waitForAgentStatus(id, Math.max(Math.floor(remainingMs / 1000), 30));
          }

          if (waitData.status === "waiting") {
            if (waitData.waitingReason === "permission") {
              return problem(`Agent "${agentName}" is blocked on a PERMISSION dialog and cannot proceed autonomously. Resolve it in the Tars UI, or stop_agent and re-delegate.`);
            }
            // Still waiting after every auto-continue: give up and let the
            // orchestrator handle it.
            const outputInfo = waitData.lastCleanOutput
              ? `\n\nAgent output:\n${waitData.lastCleanOutput}`
              : "";
            return text(`Agent "${agentName}" is still waiting for input after ${autoContinues} auto-continue attempt(s).${outputInfo}\n\nUse send_message to respond.`);
          }
        }

        if (waitData.timeout) {
          return problem(`Agent "${agentName}" is still running after ${timeoutSeconds}s. Use wait_for_agent to continue waiting, or get_agent_output to check progress.`);
        }

        if (waitData.status === "error") {
          return problem(`Agent "${agentName}" failed: ${waitData.error || "Unknown error"}`);
        }

        // Completed or idle: fetch the clean output, retrying briefly since
        // the Stop hook's output post can arrive just after the status event
        // that resolved the long-poll.
        const { output: fetchedOutput } = await fetchCleanOutput(id);
        const output = fetchedOutput || waitData.lastCleanOutput;

        if (output) {
          return text(`Agent "${agentName}" completed.\n\n${output}`);
        }

        return text(`Agent "${agentName}" finished (${waitData.status}) but no clean output was captured. Use get_agent_output to retry, or check the agent's terminal in the Tars UI.`);
      } finally {
        stopProgress();
      }
    },
  }),
];

export function registerAgentTools(server: McpServer): void {
  registerTools(server, AGENT_TOOLS);
}
