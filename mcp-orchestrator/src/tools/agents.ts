/**
 * Agent management tools for the MCP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { problem, registerTools, text, tool, type Tool, type ToolResult } from "../../../mcp-shared/src/tools.js";
import { apiRequest, getCallerIdentity } from "../utils/api.js";

/** What each refusal of POST /api/tasks/:ref/cancel means, for the agent that asked (core/task-cancel.ts). */
const CANCEL_REFUSALS: Record<string, string> = {
  not_found: "no agent holds a task with that id: it ended, or was never asked",
  not_your_task: "another chat asked for it, and only that chat, or the project's orchestrator with a reason, may cancel it",
  reason_required: "cancelling a task another chat asked for needs a reason, which that chat is told",
  already_delivered: "it is already in the agent's terminal, where it cannot be taken back: stop the agent to end it",
  already_started: "it has started, and no longer waits in the agent's queue: stop the agent to end it",
};

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
  mode: "message" | "start" | "queued";
  /** mode `queued`: the agent works on another task, and this one waits its turn (one task at a time). */
  queuedBehind?: string;
  queuedTask?: string;
  /** The request's id, the one its sender line names. */
  taskRef?: string;
  /** Queued while the agent's queue is paused (2.0.5): it goes in once the queue is resumed. */
  paused?: { since: string; why: string };
  /** A worker's message to another worker: typed in as a note for information, once that agent's turn ends. */
  note?: boolean;
  /** Answered from the receipt of an earlier call with the same clientRequestId: nothing was sent again. */
  duplicate?: boolean;
  /** Sent in `queue` mode to an agent in a turn: it goes in once the turn ends. */
  queued?: boolean;
  /** Sent in `steer` mode: whether the turn was interrupted first. */
  interrupted?: boolean;
  clientRequestId?: string;
  previousStatus?: string;
  /**
   * Nothing was typed yet: the message is queued for the agent's terminal,
   * whose field is in use, and goes in by itself when it frees. The route has
   * said so since 1.7.8; the tools answered "Sent message" over it.
   */
  held?: boolean;
  heldReason?: string;
  /** This start undid a stop: who had stopped the agent, when, and why. Tars notes the restart on the agent. */
  restartedAfterStop?: { stoppedBy?: string; stoppedAt?: string; stopReason?: string };
  agent: { id: string; name?: string; status: string };
};

/** What a caller is told when its start undid somebody's stop, or nothing. */
function restartNote(data: Pick<DispatchResult, "restartedAfterStop">): string {
  const stop = data.restartedAfterStop;
  if (!stop) return "";
  // Another agent's words, or the user's: quoted as data, as the other tool
  // texts quote what others wrote. The window files its stops as "you".
  const by = !stop.stoppedBy ? "someone" : stop.stoppedBy === "you" ? "the user" : JSON.stringify(stop.stoppedBy);
  return `\nIt had been stopped by ${by}${stop.stopReason ? `: ${JSON.stringify(stop.stopReason)}.` : ", with no reason given."} Your restart is noted on it.`;
}

/** What a caller is told when its message is queued rather than typed. */
function heldText(agentName: string, what: string, reason?: string): string {
  return `HELD: ${what} for "${agentName}" is waiting for its terminal and has not been typed in yet. `
    + (reason ?? "Its field is in use.")
    // Never "nothing needs resending": a field only a person can free may not
    // free (bug-held-forever-05-10.md). The route tells the sender again.
    + " It goes in by itself once the field is free; if it still waits a few minutes on, Tars tells you again.";
}

/** How a message goes in (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 4). */
const SEND_MODES = ["auto", "queue", "steer", "restart", "note", "note-now"] as const;
type SendMode = (typeof SEND_MODES)[number];

/**
 * The pauses before trying a send again, after Tars did not answer or could
 * not be reached: two retries, then the call fails and names its id.
 */
const RETRY_PAUSES_MS = [500, 1_500];

/** Tars could not be reached or did not answer: an answer, even a refusal, is not this. */
function unreached(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || (err instanceof TypeError && /fetch failed/.test(err.message))
    || /ECONNREFUSED|ECONNRESET|socket hang up/.test(err.message);
}

/**
 * A send with a clientRequestId (4.4 item 1): the agent's own, or one minted
 * for this call. A call that timed out at 30 s was made again by the agent,
 * and the worker got the work twice; tried again here with the same id, a
 * send Tars already did is answered from its receipt and done once.
 */
async function sendOnce(endpoint: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const clientRequestId = typeof body.clientRequestId === "string" && body.clientRequestId ? body.clientRequestId : randomUUID();
  const withId = { ...body, clientRequestId };
  for (let attempt = 0; ; attempt++) {
    try {
      return await apiRequest(endpoint, "POST", withId, timeoutMs);
    } catch (err) {
      if (!unreached(err) || attempt >= RETRY_PAUSES_MS.length) {
        if (!unreached(err)) throw err;
        throw new Error(`${err instanceof Error ? err.message : String(err)}. Tried ${attempt + 1} times with clientRequestId "${clientRequestId}": `
          + `call again with that clientRequestId, and a send Tars already made is answered, not made twice.`);
      }
      await new Promise((r) => setTimeout(r, RETRY_PAUSES_MS[attempt]));
    }
  }
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
  allowCrossProject?: boolean,
  send: { clientRequestId?: string; mode?: SendMode; reason?: string } = {},
): Promise<DispatchResult> {
  return (await sendOnce(`/api/agents/${id}/dispatch`, {
    message,
    model,
    allowCrossProject,
    ...(send.mode ? { mode: send.mode } : {}),
    ...(send.reason ? { reason: send.reason } : {}),
    ...(send.clientRequestId ? { clientRequestId: send.clientRequestId } : {}),
  })) as DispatchResult;
}

/** What a caller is told when its send was answered from an earlier call's receipt. */
function duplicateNote(data: DispatchResult): string {
  return data.duplicate
    ? `\n(clientRequestId ${data.clientRequestId ?? ""}: an earlier call already sent this; this is its answer, and nothing was sent again.)`
    : "";
}

type TaskView = {
  id: string; agentId: string; outcome: string; stopReason?: string; result?: string; startedAt?: number | null; endedAt?: number | null;
  /** Queued: what it waits behind, and since when (one task at a time per agent). */
  queuedBehind?: string; queuedAt?: string; error?: string;
  /** Delivered: a task that waited its turn and went into the agent's terminal, typed in or as a session started on it. */
  how?: "typed" | "started"; deliveredAt?: string;
  /** Running: the line the agent last wrote about itself during this task (checkpoint). */
  checkpoint?: { line: string; at: string };
};

/** A task waiting its turn, said for its asker: behind which task, from whom, since when, and how to follow it. */
function queuedText(task: TaskView): string {
  if (task.outcome === "starting") {
    return `Task ${task.id} is going into agent ${task.agentId}'s terminal: its turn has not begun yet. Follow it with task_status({ taskId: "${task.id}" }).`;
  }
  return `Task ${task.id} is queued on agent ${task.agentId}${task.queuedAt ? ` since ${task.queuedAt}` : ""}`
    + `${task.queuedBehind ? `, behind ${task.queuedBehind}` : ""}: an agent runs one task at a time, and this one starts once it is free. `
    + `Follow it with task_status({ taskId: "${task.id}" }), or take it back with task_cancel({ taskId: "${task.id}" }).`;
}

/**
 * A task that had not started when the wait on it lost Tars's answer. A task
 * waiting its turn is kept across a restart, its queue paused, and goes in once
 * the queue is resumed (2.0.5, #536): said so, never "ask it again", which ran
 * it twice (the QA's F1 on the 2.0.5 train). `err` is what the wait met:
 * another Tars on the port (mcp-shared/src/tars-api.ts, `anotherTars`), this
 * Tars no longer knowing it (404), or null for Tars out of reach past the
 * grace period. Null when it is none of these.
 */
function notStartedText(task: TaskView, err: unknown): string | null {
  if ((err as { anotherTars?: unknown } | null)?.anotherTars === true) {
    return task.outcome === "starting"
      ? `Tars restarted while task ${task.id} on agent ${task.agentId} was being started, so it may not have run. A task being started has left its agent's queue, which is what a restart keeps: unless Tars tells you it ran, ask for it again (delegate_task).`
      : `Tars restarted while task ${task.id} waited its turn on agent ${task.agentId}${task.queuedAt ? ` (queued since ${task.queuedAt})` : ""}. `
        + `It is kept: a restart keeps an agent's queue, paused, and the task goes in once the queue is resumed (agent_queue with action 'resume', by the project's orchestrator or the owner). `
        + `Do not delegate it again, which would run it twice: follow it with task_status({ taskId: "${task.id}" }).`;
  }
  if (answerOf(err)?.status === 404) {
    return `Task ${task.id} on agent ${task.agentId} never started, and Tars no longer has it (${(err as Error).message}). Ask for it again if it still needs doing.`;
  }
  if (err === null) {
    return `Tars could not be reached for ${FAILURE_GRACE_MS / 1000} s while task ${task.id} waited its turn on agent ${task.agentId}: it had not started. `
      + `A task waiting its turn is kept if Tars quits or restarts, its queue paused until it is resumed: once Tars answers, follow it with task_status({ taskId: "${task.id}" }), and ask for it again only if Tars no longer has it.`;
  }
  return null;
}

/** A delegated task as the ledger keeps it, said for the caller. */
function taskText(task: TaskView): string {
  if (task.outcome === "queued" || task.outcome === "starting") return queuedText(task);
  if (task.outcome === "delivered") {
    return `Task ${task.id} on agent ${task.agentId} waited its turn and went into its terminal`
      + `${task.how === "started" ? ", as the task of a session started on it" : ", typed into its session"}${task.deliveredAt ? ` at ${task.deliveredAt}` : ""}: `
      + "it is that agent's work now. Follow it with wait_for_agent and get_agent_output.";
  }
  const head = `Task ${task.id} on agent ${task.agentId}: ${task.outcome}${task.stopReason ? ` (${task.stopReason})` : ""}.`;
  if (task.outcome === "running") {
    const said = task.checkpoint ? ` Its last checkpoint, at ${task.checkpoint.at}: ${task.checkpoint.line}` : "";
    return `${head} It is still working: ask task_status again later.${said}`;
  }
  if (task.outcome === "delivered") return `Task ${task.id} on agent ${task.agentId}: delivered. ${task.error ?? ""}`.trim();
  if (task.error && !task.result) return `${head} ${task.error}`;
  return task.result ? `${head}\n\n${task.result}` : `${head} It left no answer.`;
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

/** A delegated task's answer, as run-task or the ledger gives it. */
type RunAnswer = {
  ok?: boolean;
  started?: boolean;
  /** Queued behind the agent's work in hand: `taskId` is the queued task's id. */
  queued?: boolean;
  queuedBehind?: string;
  queuedAt?: string;
  duplicate?: boolean;
  taskId?: string;
  outcome?: string;
  stopReason?: string;
  text?: string;
  result?: string;
  toolCalls?: string[];
  backgroundStopped?: string[];
  /** Background work the task's turn left running when it ended (2.0.4): never waited for. */
  backgroundLeft?: string[];
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; costUSD?: number | null };
  costUSD?: number;
  error?: string;
  /** A session started for this task undid a stop: who had stopped the agent, when, and why. */
  restartedAfterStop?: DispatchResult["restartedAfterStop"];
  /** A model asked for this task: taken (a session started for it) or not, and the agent's own. */
  model?: { asked: string; taken: boolean; own?: string; ranOn?: string };
};

/** How long run-task may take to answer with the task's id: one segment, as every wait. */
const RUN_START_WAIT_SECONDS = WAIT_SEGMENT_SECONDS;

/** Tars answered (a status came back), as opposed to a request that never got an answer. */
function answerOf(err: unknown): { status: number; body: Record<string, unknown> } | null {
  const e = err as { status?: unknown; body?: unknown } | null;
  return e && typeof e.status === "number" ? { status: e.status, body: (e.body ?? {}) as Record<string, unknown> } : null;
}

/** What became of a model asked for the task, when the agent did not take it: said as it happened. */
function modelNoteOf(model: RunAnswer["model"]): string {
  if (!model || model.taken) return "";
  return `\nThis task is not on ${model.asked}: the agent's session was already open, and a model applies only to a session started for the task. It ran on ${model.own ? `its own model, ${model.own}` : "its session's model"}.`;
}

/** A task's end, said for the caller: its answer, then how it ended and what it cost. */
function runText(run: RunAnswer, modelNote: string): ToolResult {
  const tokens = run.usage?.totalTokens ?? ((run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0));
  const cost = typeof run.costUSD === "number" ? run.costUSD : run.usage?.costUSD;
  const meta = [
    run.stopReason ? `ended: ${run.stopReason}` : "",
    tokens ? `${tokens} tokens` : "",
    typeof cost === "number" ? `$${cost.toFixed(4)}` : "",
    run.taskId ? `task ${run.taskId}` : "",
  ].filter(Boolean).join(" | ");
  const ok = run.ok ?? run.outcome === "completed";
  const why = !ok && run.error ? `\n${run.error}` : "";
  const left = run.backgroundLeft?.length
    ? `\nstill running in the background: ${run.backgroundLeft.join(", ")} (the task ended with its turn; that work goes on in the agent's session)`
    : "";
  return {
    content: [{ type: "text", text: `${run.text || run.result || "(the agent produced no text)"}\n\n---\n${meta}${why}${left}${modelNote}` }],
    isError: !ok,
  };
}

/** A task typed into a CLI whose turns Tars cannot see: it went in, and that is all Tars knows. */
function deliveredResult(taskId: string, note: string | undefined): ToolResult {
  return text(`Task ${taskId}: ${note ?? "it went into the agent's terminal."}`);
}

/**
 * The task, handed to the agent's own permanent terminal (POST run-task): the
 * session its card shows, or the one Tars starts for it, resuming its
 * conversation. Followed by its id to its end, read from that session.
 *
 * No request here waits more than a segment. run-task answers at once with
 * the task's id (`answer: 'started'`), and the task is then waited on in the
 * ledger, segment by segment, as waitForAgentStatus waits on a status. One
 * request held for the whole task was cut by undici at 300 s.
 *
 * A request that got no answer (cut, reset, refused, or out of time) is asked
 * again with the same clientRequestId and payload: the receipt answers with
 * the first call's task, and hands it over only if the first did nothing.
 * `waitSeconds` bounds this call's wait, never the task, which goes on in the
 * agent's terminal.
 */
async function runTask(
  id: string, prompt: string, model: string | undefined, waitSeconds: number, clientRequestId: string,
  allowCrossProject: boolean | undefined, follow: boolean,
): Promise<ToolResult> {
  const deadline = Date.now() + waitSeconds * 1000;
  const followIt = `follow it with task_status({ clientRequestId: "${clientRequestId}" }) rather than delegating the task again`;
  // allowCrossProject as /dispatch carries it: run-task asks the same guard.
  const body = {
    task: prompt, clientRequestId, answer: "started",
    ...(model ? { model } : {}), ...(allowCrossProject ? { allowCrossProject } : {}),
  };

  let started: RunAnswer | undefined;
  let failingSince = 0;
  let backoffMs = FAILURE_BACKOFF_START_MS;
  while (!started) {
    try {
      started = (await apiRequest(`/api/agents/${id}/run-task`, "POST", body, (RUN_START_WAIT_SECONDS + 30) * 1000)) as RunAnswer;
    } catch (err) {
      // Tars answered: that is the answer (refused, never started, an id used for another request).
      if (answerOf(err)) return problem(`Not delegated: ${(err as Error).message}`);
      // No answer at all: the task may have been handed over. Ask again, for a while.
      const now = Date.now();
      if (!failingSince) failingSince = now;
      if (now - failingSince >= FAILURE_GRACE_MS || now >= deadline) {
        return problem(`Tars could not be reached about this delegation to agent ${id} (${(err as Error).message}). The task may still be working in its terminal: ${followIt}.`);
      }
      await new Promise((r) => setTimeout(r, Math.min(backoffMs, deadline - now)));
      backoffMs = Math.min(backoffMs * 2, FAILURE_BACKOFF_MAX_MS);
    }
  }

  const modelNote = modelNoteOf(started.model) + restartNote(started);
  if (!started.taskId) return runText(started, modelNote);
  let taskId = started.taskId;
  // An answer that is already the end (a duplicate of a task that ended): said as it is.
  if (started.outcome === "delivered") return deliveredResult(taskId, started.error);
  if (started.outcome && !["queued", "starting", "running"].includes(started.outcome)) return runText(started, modelNote);
  let waiting: TaskView | undefined = started.outcome === "queued" || started.outcome === "starting"
    ? { id: taskId, agentId: id, outcome: started.outcome, queuedBehind: started.queuedBehind, queuedAt: started.queuedAt }
    : undefined;
  // start_agent: handed over, not waited on.
  if (!follow) {
    return text((waiting?.outcome === "queued"
      ? queuedText(waiting)
      : `Task ${taskId} is going into agent ${id}'s terminal. Follow it with task_status({ taskId: "${taskId}" }); delegate_task hands a task and waits for its answer.`) + modelNote);
  }
  failingSince = 0;
  backoffMs = FAILURE_BACKOFF_START_MS;
  for (;;) {
    const remainingSec = Math.ceil((deadline - Date.now()) / 1000);
    if (remainingSec <= 0) {
      if (waiting) return text(`${queuedText(waiting)} delegate_task stopped waiting after ${waitSeconds} s; nothing else was started.`);
      return problem(`Task ${taskId} on agent ${id} is still working after ${waitSeconds} s, in its terminal: ${followIt}. Nothing else was started, and the task goes on.`);
    }
    const segment = Math.min(WAIT_SEGMENT_SECONDS, remainingSec);
    const askedAt = Date.now();
    try {
      const found = (await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}?wait=${segment}`, "GET", undefined, (segment + 30) * 1000)) as { task: RunAnswer & TaskView };
      failingSince = 0;
      backoffMs = FAILURE_BACKOFF_START_MS;
      waiting = found.task.outcome === "queued" || found.task.outcome === "starting" ? found.task : undefined;
      // Its turn begun: the ledger's task from here.
      if (!waiting && found.task.id) taskId = found.task.id;
      if (found.task.outcome === "delivered") return deliveredResult(taskId, found.task.error);
      if (!waiting && found.task.outcome !== "running") {
        return runText({ ...found.task, taskId }, modelNoteOf(found.task.model ?? started.model) + restartNote(found.task.restartedAfterStop ? found.task : started));
      }
      // Not held open (an older Tars, or a wait answered at once): no hot loop.
      if (Date.now() - askedAt < segment * 500) await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      // A task that had not started: lost with a restart, or no longer queued (notStartedText).
      const lost = waiting ? notStartedText(waiting, err) : null;
      if (lost) return problem(lost);
      const now = Date.now();
      if (!failingSince) failingSince = now;
      if (now - failingSince >= FAILURE_GRACE_MS || now >= deadline) {
        if (waiting) return problem(`${notStartedText(waiting, null)} (${(err as Error).message})`);
        return problem(`Tars could not be reached while task ${taskId} ran on agent ${id} (${(err as Error).message}). The task may still be working in its terminal: ${followIt}.`);
      }
      await new Promise((r) => setTimeout(r, Math.min(backoffMs, deadline - now)));
      backoffMs = Math.min(backoffMs * 2, FAILURE_BACKOFF_MAX_MS);
    }
  }
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

/** The providers by id, as create_agent and update_agent name them. */
const PROVIDERS = "The provider, by id. Its own CLI: claude, codex, gemini, grok, opencode, pi, amp, qwen-code (Qwen Code, the CLI qwen, on the models of its own settings). Claude Code run against another provider, with the key set in Tars's Settings (refused without it): openrouter, deepseek, mimo, moonshot, qwen (the Qwen API), zhipu, minimax, nvidia, nous-portal, ollama, ollama-cloud, venice, custom-openai.";

const CHARACTERS = ["robot", "ninja", "wizard", "astronaut", "knight", "pirate", "alien", "viking"] as const;

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
    name: "checkpoint",
    description: "Write one line about yourself: where you stand in the task in hand, 120 characters at most (for instance: tests written, 3 of 5 green). Tars keeps it with you, shows it on your card, and gives it to whoever follows your task (task_status) or reads you (list_agents, get_agent). A new line replaces the last. Write one at a step worth knowing, not at every action.",
    schema: {
      line: z.string().describe("One line, 120 characters at most, no newline."),
    },
    failure: "writing your checkpoint",
    async run({ line }) {
      const { agentId } = getCallerIdentity();
      if (!agentId) return problem("No agent identity found in the environment (CLAUDE_AGENT_ID is unset): only an agent Tars started has a checkpoint.");
      const data = (await apiRequest(`/api/agents/${encodeURIComponent(agentId)}/checkpoint`, "POST", { line })) as { checkpoint: { line: string; at: string } };
      return text(`Checkpoint kept at ${data.checkpoint.at}: ${data.checkpoint.line}`);
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

  // A task's answer, by its id or the agent's last one (2.0.5: the DB brief fix-answer-per-task-2810.md).
  tool({
    name: "get_agent_output",
    description: "Get an agent's answer as clean text: with taskId, that task's answer, as task_status has it; without, "
      + "the answer of the agent's last task that ended, whatever it does next. A task's answer is its report and what "
      + "the agent wrote after it (a memory note, a closing line), whole. Falls back to the hooks' last copy when no task "
      + "of the agent has an answer yet. An agent's answers are read by its task's asker, the agent itself, its "
      + "project's orchestrator and Tars: anyone else is told so.",
    schema: {
      id: z.string().describe("The agent ID"),
      taskId: z.string().optional().describe("A task's id (t-xxxxxxxx, or the id task_status gives): that task's answer"),
    },
    failure: "getting output",
    async run({ id, taskId }) {
      if (taskId) {
        const found = (await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`)) as {
          task?: { id: string; agentId?: string; outcome: string; result?: string };
        };
        const task = found.task;
        if (!task) return text(`No task ${taskId} is known to you.`);
        if (task.agentId && task.agentId !== id) return text(`Task ${task.id} is not "${id}"'s: it is "${task.agentId}"'s. Ask with that agent's id.`);
        if (task.result) return text(`Task ${task.id} (${task.outcome}):\n\n${task.result}`);
        return text(`Task ${task.id} (${task.outcome}) has no answer${task.outcome === "running" || task.outcome === "queued" || task.outcome === "starting" ? " yet" : ""}.`);
      }
      const data = (await apiRequest(`/api/agents/${id}`)) as {
        agent: {
          status: string;
          name?: string;
          lastCleanOutput?: string;
          lastAnswer?: { taskId: string; result: string };
          answersWithheld?: { taskId?: string; reason: string };
        };
      };
      const agentName = data.agent.name || id;

      // Not the caller's to read: said, with whose they are, rather than another copy of them (the Audit's L1 on #550).
      if (data.agent.answersWithheld) {
        return text(`Agent "${agentName}" (${data.agent.status}): its answers are not yours to read: ${data.agent.answersWithheld.reason}. Ask whoever handed it the task, or your project's orchestrator.`);
      }

      if (data.agent.lastAnswer) {
        return text(`Agent "${agentName}" (${data.agent.status}), its last task ${data.agent.lastAnswer.taskId}:\n\n${data.agent.lastAnswer.result}`);
      }
      if (data.agent.lastCleanOutput) {
        return text(`Agent "${agentName}" (${data.agent.status}):\n\n${data.agent.lastCleanOutput}`);
      }

      return text(`Agent "${agentName}" (${data.agent.status}): No clean output captured yet. The agent's terminal output is available in the Tars UI. Clean output is captured when the agent pauses or completes.`);
    },
  }),

  tool({
    name: "create_agent",
    description: "Create a new agent, on any provider Tars runs or on a CLI binary of your choosing. Defaults to YOUR project when projectPath is omitted; another project is refused unless allowCrossProject is true. The agent will be in 'idle' state until started. By default, agents run with --dangerously-skip-permissions for autonomous operation.",
    schema: {
      projectPath: z.string().optional().describe("Absolute path to the project directory (defaults to your own project)"),
      name: z.string().optional().describe("Name for the agent (e.g., 'Backend Worker', 'Test Runner')"),
      skills: z.array(z.string()).optional().describe("List of skill names to enable for this agent"),
      character: z.enum(CHARACTERS).optional().describe("Visual character for the agent"),
      skipPermissions: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), agent runs with --dangerously-skip-permissions flag for autonomous operation"),
      secondaryProjectPath: z.string().optional().describe("Secondary project path to add as context (--add-dir)"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow creating the agent in ANOTHER project than yours (normally rejected)"),
      provider: z.string().optional().describe(`${PROVIDERS} Default claude.`),
      model: z.string().optional().describe("The model, as the provider names it (e.g. 'opus' for claude, 'gpt-6-luna' for codex). Omit for the provider's default."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort. Omit for the CLI's own."),
      permissionMode: z
        .enum(["plan", "normal", "auto", "bypass"])
        .optional()
        .describe("plan (Claude Code: reads and plans, edits nothing until approved), normal (asks before acting), auto, or bypass (asks nothing). Omit for auto."),
      cliPath: z.string().optional().describe("Absolute path of the CLI's executable file, run instead of the provider's own (the one set in Tars's Settings, or on the PATH). Refused unless it is an executable file."),
    },
    failure: "creating agent",
    async run({ projectPath, name, skills, character, skipPermissions = true, secondaryProjectPath, allowCrossProject, provider, model, effort, permissionMode, cliPath }) {
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
        provider,
        model,
        effort,
        permissionMode,
        cliPath,
      })) as { agent: { id: string; name: string; provider?: string } };
      return text(`Created agent "${data.agent.name}" with ID: ${data.agent.id}${data.agent.provider ? ` (${data.agent.provider})` : ""}`);
    },
  }),

  tool({
    name: "update_agent",
    description: "Change an agent of your project after creating it: its name, provider (any CLI or API-key provider), model, effort, permission mode, CLI path, skills, character or secondary project path. Only your project's orchestrator does this, on its project's other agents: a worker is refused (worker_may_not_update), and so is an agent of another project (other_project). The role stays the user's: an agent is made the orchestrator, or stops being it, in the Agents page of Tars, where the orchestrator's own settings are changed too (orchestrator_settings), and so is a move to another project. A running turn is never cut. A change of model, effort or permission mode on the same CLI restarts a claude agent's CLI once its turn ends, on the same conversation; another CLI takes it at its next start. A change of provider or CLI path is refused while a CLI runs in the agent's terminal (cli_running): stop it with stop_agent once its work is done, then change it; its next start runs the new CLI on a new conversation, and the old CLI's model and CLI path are cleared unless you give new ones. The answer says when the change applies and whether the conversation is kept.",
    schema: {
      id: z.string().describe("The agent ID"),
      name: z.string().min(1).optional().describe("Its new name"),
      provider: z.string().optional().describe(PROVIDERS),
      model: z.string().nullable().optional().describe("The model, as the provider's CLI names it (e.g. 'opus' or 'sonnet' for claude); null for the provider's default."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional().describe("Reasoning effort; null for the CLI's own."),
      permissionMode: z
        .enum(["plan", "normal", "auto", "bypass"])
        .optional()
        .describe("plan (Claude Code: reads and plans, edits nothing until approved), normal (asks before acting), auto, or bypass (asks nothing)."),
      cliPath: z.string().nullable().optional().describe("Absolute path of the CLI's executable file, run instead of the provider's own; null for the provider's own. Refused unless it is an executable file."),
      skills: z.array(z.string()).optional().describe("Its skills: the whole list, which replaces the one it has"),
      character: z.enum(CHARACTERS).optional().describe("Visual character for the agent"),
      secondaryProjectPath: z.string().nullable().optional().describe("Secondary project path added as context (--add-dir); null to take it away"),
    },
    failure: "updating agent",
    async run({ id, ...fields }) {
      // Only what was named: null clears a setting, so a field nobody named must not reach Tars as one.
      const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      try {
        const data = (await apiRequest(`/api/agents/${encodeURIComponent(id)}/update`, "POST", body)) as {
          agent: { id: string; name?: string }; changed?: string[]; text?: string;
        };
        const changed = data.changed?.length ? data.changed.join(", ") : "nothing";
        return text(`Updated "${data.agent.name || data.agent.id}" (${changed}). ${data.text ?? ""}`.trim());
      } catch (err) {
        // The refusal's code, which the description names, with its reason.
        const code = (err as { body?: { code?: unknown } }).body?.code;
        if (typeof code === "string") return problem(`Error updating agent (${code}): ${(err as Error).message}`);
        throw err;
      }
    },
  }),

  tool({
    name: "start_agent",
    description: "Deprecated: use delegate_task, which hands the task the same way and waits for its answer. start_agent is kept as an alias for 2.0.4: it hands the task to the agent's own terminal (the session its card shows, or the one Tars starts for it on its conversation) exactly as delegate_task does, and answers at once with the task's id instead of waiting (task_status follows it). One task at a time: an agent at work gets it queued. Only Tars, the user and the project's orchestrator hand an agent work: a worker calling this is refused, and asks its orchestrator instead (send_message to \"orchestrator\").",
    schema: {
      id: z.string().describe("The agent ID"),
      prompt: z.string().describe("The task or instruction for the agent to work on"),
      model: z.string().optional().describe("Optional model for this task only, taken only when Tars starts the agent's session for it; an open session keeps its own, and the answer says so."),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
      clientRequestId: z.string().optional().describe("An id of 8 to 128 characters for this request. Calling again with the same id is answered with the first call's task, and nothing is handed over twice. Omitted: one is made for this call."),
    },
    failure: "starting agent",
    async run({ id, prompt, model, allowCrossProject, clientRequestId }) {
      return runTask(id, prompt, model, RUN_START_WAIT_SECONDS, clientRequestId || randomUUID(), allowCrossProject, false);
    },
  }),

  tool({
    name: "stop_agent",
    description: "Stop an agent: its CLI and everything it started are ended, and it reads 'stopped', with your name and your reason, until it is started again. Give the reason in one line; the user reads it in the window. Only Tars, the user and the project's orchestrator stop an agent, and an agent may stop itself: a worker calling this on another agent is refused, and asks its orchestrator instead (send_message to \"orchestrator\"), saying why.",
    schema: {
      id: z.string().describe("The agent ID"),
      reason: z.string().min(1).describe("Why you stop it, in one line (required), e.g. 'frozen for 40 minutes on a file read'"),
      dropQueue: z.boolean().optional().describe("Also drop what waits in its queue, each sender told it never ran. Omitted: the queue is kept, paused, and goes in once you resume it with agent_queue."),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    failure: "stopping agent",
    async run({ id, reason, dropQueue, allowCrossProject }) {
      const answer = (await apiRequest(`/api/agents/${id}/stop`, "POST", { reason, ...(dropQueue ? { dropQueue } : {}), ...(allowCrossProject ? { allowCrossProject } : {}) })) as
        { alreadyStopped?: boolean; stoppedBy?: string; stopReason?: string; queueKept?: number; queueDropped?: number } | undefined;
      if (answer?.alreadyStopped) {
        return text(`Agent ${id} was already stopped by ${answer.stoppedBy || "someone"}${answer.stopReason ? `: ${answer.stopReason}` : ""}. Nothing changed.`);
      }
      const kept = answer?.queueKept ?? 0;
      const dropped = answer?.queueDropped ?? 0;
      const queue = kept ? ` Its queue is kept, paused: ${kept} item${kept === 1 ? "" : "s"} wait${kept === 1 ? "s" : ""}, and go${kept === 1 ? "es" : ""} in once you resume it (agent_queue({ id: "${id}", action: "resume" })).`
        : dropped ? ` ${dropped} item${dropped === 1 ? "" : "s"} of its queue dropped, each sender told.` : "";
      return text(`Stopped agent ${id}: ${reason}.${queue}`);
    },
  }),

  tool({
    name: "send_message",
    description: "Send input/message to an agent. If the agent is idle/completed/error, this will START the agent with the message as the prompt. If the agent is 'waiting', this sends the message as input. WARNING: Sending to a 'running' agent may interfere with its current work. Prefer waiting until it reaches 'waiting' or 'completed' status. To answer whoever asked you for your current task, use the id \"requester\" (a chat's orchestrator, or the project's orchestrator); \"orchestrator\" or the orchestrator's name reach it too. An agent's id always reaches that agent. A worker never orders work from another agent: what a worker sends another worker arrives as a note for information, labelled so, typed in once that agent's turn has ended, never as a task, and never starting an agent that has no session open; steer and restart are refused to it, as a stop is. To get work done by another agent, or to have it stopped, a worker asks its orchestrator. Use mode 'note' (or 'note-now') for information the agent needs no answer to, such as a release cut, a branch moved or a gate passed: it is labelled a note, it is no task, and you are not told when the agent's turn ends.",
    schema: {
      id: z.string().describe("The agent ID, or \"requester\" for whoever asked you for your current task"),
      message: z.string().optional().describe("The message to send to the agent"),
      prompt: z.string().optional().describe("Alias for 'message', use either one"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
      mode: z.enum(SEND_MODES).optional().describe("How it goes in. 'auto' (default): typed at once, into a running turn too. 'queue': typed once the agent's current turn ends. 'steer': its turn interrupted first, then typed (claude agents only; refused as not_steerable otherwise). 'restart': the agent stopped and started again with the message. steer and restart are refused while the agent works on a task another agent asked for. 'note': a note for information, typed once its current turn ends; 'note-now': the same, typed at once. A note is no task: no task id, no end notice, and it never starts an agent that has no session open."),
      reason: z.string().optional().describe("With mode 'restart': why, in one line, kept with the stop"),
      clientRequestId: z.string().optional().describe("An id of 8 to 128 characters for this request. Calling again with the same id is answered with the first call's outcome, and nothing is sent twice. Omitted: one is made for this call."),
    },
    failure: "sending message",
    async run({ id, message, prompt, allowCrossProject, mode, reason, clientRequestId }) {
      // Accept either "message" or "prompt" so the LLM doesn't trip on naming
      const resolvedMessage = message || prompt;
      if (!resolvedMessage) {
        return problem("Error: either 'message' or 'prompt' is required.");
      }
      const data = await dispatchToAgent(id, resolvedMessage, undefined, allowCrossProject, { clientRequestId, mode, reason });
      const agentName = data.agent.name || id;
      const previousStatus = data.previousStatus ?? "idle";
      const again = duplicateNote(data);

      if (data.held) {
        return text(heldText(agentName, "Your message", data.heldReason) + again);
      }

      if (data.note) {
        const where = data.queued ? "it goes in once its current turn ends" : "it is in its terminal";
        // Asked for as a note, or a worker's message Tars made one.
        return text(mode === "note" || mode === "note-now"
          ? `Sent to agent "${agentName}" as a note for information, not a task: ${where}. You are not told when its turn ends.${again}`
          : `Sent to agent "${agentName}" as a note for information, not a task: ${where}. A worker does not hand work to another agent: if this needs doing, ask your orchestrator.${again}`);
      }

      if (data.queued && data.paused) {
        return text(`Queued for agent "${agentName}" as ${data.queuedTask ?? data.taskRef}: its queue is paused (${data.paused.why}), so it goes in once the queue is resumed. agent_queue({ id: "${id}" }) shows what waits there.${again}`);
      }
      if (data.queued) {
        return text(`Queued for agent "${agentName}"${data.queuedTask ?? data.taskRef ? ` as ${data.queuedTask ?? data.taskRef}` : ""}: it goes in once its current turn ends.${data.interrupted === false ? " Its turn could not be interrupted in time, so it waits for the end of it." : ""} task_status and task_cancel know it by that id.${again}`);
      }

      if (data.mode === "start") {
        return text(`Agent "${agentName}" was ${previousStatus}, started it with prompt: "${resolvedMessage}". New status: ${data.agent.status}${restartNote(data)}${again}`);
      }

      if (data.interrupted) {
        return text(`Interrupted agent "${agentName}"'s turn, then sent: "${resolvedMessage}"${again}`);
      }

      if (previousStatus === "running") {
        return text(`⚠️ Agent "${agentName}" is currently running. Message sent but may interfere with current work. Consider using wait_for_agent first, or send with mode 'queue'.\nMessage sent: "${resolvedMessage}"${again}`);
      }

      return text(`Sent message to agent "${agentName}" (${previousStatus}): "${resolvedMessage}"${again}`);
    },
  }),

  tool({
    name: "agent_queue",
    description: "What waits in an agent's queue, in the order it goes in (each item's task id, who sent it, since when, whether it is a task, a message or a note, and its first line), and whether the queue is paused. With action 'pause', nothing goes in until it is resumed; the turn in progress is never touched. With 'resume', the items go in again, one at a time, in order. A stop keeps the queue, paused, and a restart of Tars too. The project's orchestrator acts on its agents' queues; a worker sees in another agent's queue only what it sent itself, and pauses nothing. Move an item with task_move, take one back with task_cancel.",
    schema: {
      id: z.string().describe("The agent ID"),
      action: z.enum(["list", "pause", "resume", "drop"]).optional().describe("'list' (default), 'pause', 'resume', or 'drop' (everything that waits taken back, each sender told)"),
      reason: z.string().optional().describe("With 'pause': why, in one line, shown with the queue"),
    },
    failure: "reading the agent's queue",
    async run({ id, action, reason }) {
      const view = (action && action !== "list"
        ? await apiRequest(`/api/agents/${encodeURIComponent(id)}/queue/${action}`, "POST", reason ? { reason } : {})
        : await apiRequest(`/api/agents/${encodeURIComponent(id)}/queue`)) as
        { paused?: { since: string; why: string }; items?: Array<{ ref: string; position: number; from?: string; how?: string; title: string; queuedAt: string }> };
      const items = view.items ?? [];
      const head = action === "pause" ? `Paused ${id}'s queue.` : action === "resume" ? `Resumed ${id}'s queue.` : action === "drop" ? `Dropped what waited in ${id}'s queue.` : `${id}'s queue${view.paused ? `, paused since ${view.paused.since} (${view.paused.why})` : ""}:`;
      if (!items.length) return text(`${head} Nothing waits in it.`);
      return text([head, ...items.map((i) => `${i.position}. ${i.ref}, ${i.how ?? "task"} from ${i.from ?? "Tars"}, since ${i.queuedAt}: ${JSON.stringify(i.title)}`)].join("\n"));
    },
  }),

  tool({
    name: "task_move",
    description: "Move an item of an agent's queue: to the head, so it goes in next, or just before another item of the same queue. The project's orchestrator moves any item of its agents' queues; a worker only what it sent itself.",
    schema: {
      taskId: z.string().describe("The item's task id: t- and 8 hex characters"),
      before: z.string().optional().describe("The task id it goes just before; omitted, it goes to the head"),
    },
    failure: "moving the task",
    async run({ taskId, before }) {
      const view = (await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/move`, "POST", before ? { before } : {})) as { items?: Array<{ ref: string }> };
      return text(`Moved ${taskId}${before ? ` before ${before}` : " to the head"}. The queue now reads: ${(view.items ?? []).map((i) => i.ref).join(", ")}.`);
    },
  }),

  tool({
    name: "task_cancel",
    description: "Cancel a task you asked another agent for, while it still waits to go into that agent's terminal, or waits its turn behind that agent's work in hand (delegate_task and start_agent name it). Its id is the t-xxxxxxxx Tars named in the line it typed before your message, or in the answer that said it was queued. Only the agent that asked may cancel it, or the project's orchestrator with a reason, which the chat that asked is told. A task already in the agent's terminal cannot be taken back: stop the agent to end it.",
    schema: {
      taskId: z.string().describe("The task's id: t- and 8 hex characters"),
      reason: z.string().optional().describe("Why. Required when the task was asked for by another chat: that chat is told it."),
    },
    failure: "cancelling the task",
    async run({ taskId, reason }) {
      try {
        const data = (await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, "POST", { reason })) as { worker?: { name?: string }; queuedRun?: boolean };
        if (data.queuedRun) return text(`Cancelled task ${taskId}: it was waiting its turn on ${data.worker?.name || "its agent"}, and never started.`);
        return text(`Cancelled task ${taskId}: it never went into ${data.worker?.name ? `${data.worker.name}'s` : "its agent's"} terminal.`);
      } catch (err) {
        const why = CANCEL_REFUSALS[(err as Error).message];
        if (why) return problem(`Task ${taskId} was not cancelled: ${why}.`);
        throw err;
      }
    },
  }),

  tool({
    name: "remove_agent",
    description: "Permanently remove an agent. This will stop the agent if running and delete it from the system. Only Tars, the user and the project's orchestrator remove an agent, and an agent may remove itself: a worker calling this on another agent is refused, and asks its orchestrator instead.",
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
    async run({ id, timeoutSeconds = 300 }, extra) {
      // As delegate_task's: any timeoutSeconds is taken, and Claude Code gives up a call silent for 30 minutes
      // (the QA's F8 of the 2.0.5 final verification: the keep-alive everyone counted on was delegate_task's only).
      const stopProgress = keepCallerListening(extra);
      let data: WaitResult;
      try {
        data = await waitForAgentStatus(id, timeoutSeconds);
      } finally {
        stopProgress();
      }

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

  tool({
    name: "delegate_task",
    description: "Delegate a task to an agent and wait for its answer: the primary tool for handing work. The task goes into the agent's own permanent terminal, the session its card shows, which keeps its conversation, its memory and its background work; with no CLI running there, Tars starts that session on its conversation with the task. You get back the agent's full final answer for this task, why it ended (completed, error, stopped, interrupted), and its tokens and cost where its CLI lets Tars read them (claude: all of them; other CLIs: see the guide's delegation topic). An agent runs one task at a time: a task given to an agent already working waits its turn in that agent's queue, and this keeps waiting and returns its real result; if your wait ends first, the answer says which task it is queued behind, from whom, since when, and how to follow it (task_status) or take it back (task_cancel). The task is never stopped when your wait ends: it goes on in the agent's terminal. A task still waiting its turn is kept across a restart of Tars, its agent's queue paused: this says so, and it goes in once the queue is resumed (agent_queue), so do not ask for it again. Only Tars, the user and the project's orchestrator hand an agent work: a worker calling this is refused, and asks its orchestrator instead (send_message to \"orchestrator\"). Write the prompt as a spec in five parts: Target (what must be true at the end), Change (what to do), Constraints (what must not break), May touch (the files, folders and tools the agent may use), Proof (the observable check of acceptance the agent runs and reports); the guide's delegation topic says more.",
    schema: {
      id: z.string().describe("The agent ID to delegate to"),
      prompt: z.string().describe("The task, as a spec, a line each. Target: the end state. Change: what to do. Constraints: what must not break. May touch: the files, folders and tools allowed. Proof: the observable check of acceptance."),
      model: z.string().optional().describe("Optional model for this task only; the agent's saved model is not changed. Taken only when Tars starts the agent's session for the task: an open session keeps its own model, and the answer says so. Aliases: 'sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]' (1M context). Omit to use the agent's configured default."),
      timeoutSeconds: z.number().optional().describe("How long this call waits for the answer, in seconds: 3600 (an hour) when omitted. The task itself is not stopped there: it goes on in the agent's terminal, and task_status reads its end."),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow delegating to an agent of ANOTHER project (normally rejected)"),
      clientRequestId: z.string().optional().describe("An id of 8 to 128 characters for this delegation. Calling again with the same id answers with the first call's task (task_status reads it), and nothing is handed over twice. Omitted: one is made for this call."),
    },
    failure: "delegating task",
    async run({ id, prompt, model, timeoutSeconds = 3600, allowCrossProject, clientRequestId: givenId }, extra) {
      // Claude Code abandons an MCP call silent for 30 minutes; a delegation
      // can last an hour. Progress while it waits keeps the caller listening.
      const stopProgress = keepCallerListening(extra);
      try {
        return await runTask(id, prompt, model, Math.max(timeoutSeconds, 1), givenId || randomUUID(), allowCrossProject, true);
      } finally {
        stopProgress();
      }
    },
  }),

  tool({
    name: "task_status",
    description: "Read a task you delegated, as Tars's ledger keeps it, after a restart too (a task still waiting its turn is kept, its agent's queue paused until it is resumed): queued behind the agent's work in hand (which task, from whom, since when), running, or how it ended and what the agent answered. By its taskId (delegate_task names it) or by the clientRequestId it was sent with.",
    schema: {
      taskId: z.string().optional().describe("The task's id"),
      clientRequestId: z.string().optional().describe("The clientRequestId the delegation was sent with"),
    },
    failure: "reading the task",
    async run({ taskId, clientRequestId }) {
      if (!taskId && !clientRequestId) return problem("Error: taskId or clientRequestId is required.");
      const endpoint = taskId ? `/api/tasks/${encodeURIComponent(taskId)}` : `/api/tasks?clientRequestId=${encodeURIComponent(clientRequestId!)}`;
      const found = (await apiRequest(endpoint)) as { task: TaskView };
      return text(taskText(found.task));
    },
  }),
];

export function registerAgentTools(server: McpServer): void {
  registerTools(server, AGENT_TOOLS);
}
