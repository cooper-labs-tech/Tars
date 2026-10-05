/**
 * What the contract asks each server: its environments (the variants), and
 * for every tool the calls that walk each of its answers, with what the fake
 * answers to each request the tool makes, in order. mcp-servers.contract.mjs
 * runs them.
 *
 * A scenario: { name, tool, args, meta?, tars?: [answers], settings? }.
 * An answer: { status, json } | { status, raw } | { status } (no body) |
 * { drop: true } (the socket is destroyed) | { hold: true } (never answered).
 * A call the server may leave unanswered past the harness's 90 s is the last of
 * its variant: once the held socket closes, its late answer would otherwise be
 * recorded as a notification of the next call.
 * `settings` is app-settings.json for that call (null: no file); without it,
 * the variant's.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ok = (json) => ({ status: 200, json });
const fail = (status, json) => ({ status, json });
const raw = (status, text) => ({ status, raw: text });
const drop = { drop: true };
const hold = { hold: true };

const AGENT_ENV = {
  CLAUDE_MGR_API_TOKEN: "agent-token-lead",
  CLAUDE_AGENT_ID: "agent-lead",
  CLAUDE_PROJECT_PATH: "/projects/alpha",
  CLAUDE_AGENT_NAME: "Lead",
};

/** The shared token file, for the sessions that have no token of their own. */
function sharedTokenFile(home) {
  fs.mkdirSync(path.join(home, ".dorothy"), { recursive: true });
  fs.writeFileSync(path.join(home, ".dorothy", "api-token"), "shared-token-file\n");
}

// ---------------------------------------------------------------- orchestrator

const lead = { name: "Lead", role: "orchestrator", projectPath: "/projects/alpha", branchName: "main", status: "running" };
const dune = { id: "a1", name: "Dune", projectPath: "/projects/alpha", status: "idle" };
const rest = { id: "a2", name: "Rest", projectPath: "/projects/alpha", status: "waiting" };
const far = { id: "b1", name: "Faraway", projectPath: "/projects/beta", status: "running" };
const long = "x".repeat(120);

const started = (extra = {}) => ok({ success: true, mode: "start", agent: { id: "a1", name: "Dune", status: "running" }, ...extra });
const messaged = (extra = {}) => ok({ success: true, mode: "message", agent: { id: "a1", name: "Dune", status: "running" }, ...extra });
const done = (output) => ok({ status: "completed", ...(output ? { lastCleanOutput: output } : {}) });
const asking = ok({ status: "waiting", waitingReason: "idle" });

const orchestratorAgent = [
  { name: "whoami, a named orchestrator", tool: "whoami", tars: [ok({ agent: lead }), ok({ agents: [dune, rest] })] },
  { name: "whoami, an agent with no name, role or branch", tool: "whoami", tars: [ok({ agent: { projectPath: "/projects/alpha" } }), ok({ agents: [] })] },
  { name: "whoami, Tars does not know it", tool: "whoami", tars: [fail(404, { error: "Agent not found" })] },

  { name: "list_agents, scoped", tool: "list_agents", tars: [ok({ agents: [dune, rest], scopedToProject: "/projects/alpha" })] },
  { name: "list_agents, unscoped answer", tool: "list_agents", tars: [ok({ agents: [dune] })] },
  { name: "list_agents all, other projects listed apart", tool: "list_agents", args: { all: true }, tars: [ok({ agents: [dune, far, rest] })] },
  { name: "list_agents all, only this project", tool: "list_agents", args: { all: true }, tars: [ok({ agents: [dune] })] },
  { name: "list_agents all false", tool: "list_agents", args: { all: false }, tars: [ok({ agents: [dune], scopedToProject: "/projects/alpha" })] },
  { name: "list_agents, Tars refuses", tool: "list_agents", tars: [fail(403, { error: "This token names no agent" })] },
  { name: "list_agents, an error with no message", tool: "list_agents", tars: [fail(500, {})] },
  { name: "list_agents, an answer that is not JSON", tool: "list_agents", tars: [raw(200, "oops")] },
  { name: "list_agents, the connection drops", tool: "list_agents", tars: [drop] },
  { name: "list_agents, an error whose body is null", tool: "list_agents", tars: [fail(500, null)] },

  { name: "get_agent", tool: "get_agent", args: { id: "a1" }, tars: [ok({ agent: { ...dune, output: ["line 1", "line 2"] } })] },
  { name: "get_agent, unknown", tool: "get_agent", args: { id: "zz" }, tars: [fail(404, { error: "Agent not found" })] },
  { name: "get_agent, no id", tool: "get_agent", args: {} },
  { name: "get_agent, Tars never answers: 30 s", tool: "get_agent", args: { id: "a1" }, tars: [hold] },

  { name: "get_agent_output, captured", tool: "get_agent_output", args: { id: "a1" }, tars: [ok({ agent: { ...dune, lastCleanOutput: "All tests pass." } })] },
  { name: "get_agent_output, nothing captured, no name", tool: "get_agent_output", args: { id: "a9" }, tars: [ok({ agent: { status: "running" } })] },
  { name: "get_agent_output, error", tool: "get_agent_output", args: { id: "a1" }, tars: [fail(500, { error: "boom" })] },

  { name: "create_agent, defaults to the caller's project", tool: "create_agent", args: { name: "Worker" }, tars: [ok({ agent: { id: "a3", name: "Worker" } })] },
  {
    name: "create_agent, every field", tool: "create_agent",
    args: { projectPath: "/projects/alpha", name: "Tester", skills: ["tdd", "review"], character: "ninja", skipPermissions: false, secondaryProjectPath: "/projects/shared", allowCrossProject: true },
    tars: [ok({ agent: { id: "a4", name: "Tester" } })],
  },
  { name: "create_agent, another project refused", tool: "create_agent", args: { projectPath: "/projects/beta" }, tars: [fail(403, { error: "Cross-project creation refused" })] },
  { name: "create_agent, a character that does not exist", tool: "create_agent", args: { character: "dragon" } },

  { name: "start_agent, started", tool: "start_agent", args: { id: "a1", prompt: "Run the tests" }, tars: [started()] },
  { name: "start_agent, with a model", tool: "start_agent", args: { id: "a1", prompt: "Run the tests", model: "opus", allowCrossProject: true }, tars: [started()] },
  { name: "start_agent, already running", tool: "start_agent", args: { id: "a1", prompt: "Also lint" }, tars: [messaged({ previousStatus: "waiting" })] },
  { name: "start_agent, already busy, no previous status", tool: "start_agent", args: { id: "a1", prompt: "Also lint" }, tars: [messaged()] },
  { name: "start_agent, held with a reason", tool: "start_agent", args: { id: "a1", prompt: "Run" }, tars: [messaged({ held: true, heldReason: "JeanBrasse is typing in it." })] },
  { name: "start_agent, held without a reason, no name", tool: "start_agent", args: { id: "a1", prompt: "Run" }, tars: [ok({ success: true, mode: "message", held: true, agent: { id: "a1", status: "running" } })] },
  { name: "start_agent, error", tool: "start_agent", args: { id: "a1", prompt: "Run" }, tars: [fail(409, { error: "Launch in progress" })] },

  { name: "stop_agent", tool: "stop_agent", args: { id: "a1", reason: "frozen on a file read" }, tars: [ok({ success: true })] },
  { name: "stop_agent, no reason", tool: "stop_agent", args: { id: "a1" } },
  { name: "stop_agent, already stopped", tool: "stop_agent", args: { id: "a1", reason: "done" }, tars: [ok({ success: true, alreadyStopped: true, stoppedBy: "Tars-Orchestrator", stopReason: "frozen on a file read" })] },
  { name: "stop_agent, cross-project", tool: "stop_agent", args: { id: "b1", reason: "done", allowCrossProject: true }, tars: [ok({ success: true })] },
  { name: "stop_agent, error", tool: "stop_agent", args: { id: "a1", reason: "done" }, tars: [fail(404, { error: "Agent not found" })] },

  { name: "send_message, no text", tool: "send_message", args: { id: "a1" } },
  { name: "send_message, starts an idle agent", tool: "send_message", args: { id: "a1", message: "Hello" }, tars: [started({ previousStatus: "completed" })] },
  { name: "send_message, starts, no previous status", tool: "send_message", args: { id: "a1", prompt: "Via prompt" }, tars: [started()] },
  { name: "send_message, into a running agent", tool: "send_message", args: { id: "a1", message: "Careful" }, tars: [messaged({ previousStatus: "running" })] },
  { name: "send_message, into a waiting agent", tool: "send_message", args: { id: "a2", message: "Yes", allowCrossProject: false }, tars: [ok({ success: true, mode: "message", previousStatus: "waiting", agent: { id: "a2", name: "Rest", status: "running" } })] },
  { name: "send_message, message wins over prompt", tool: "send_message", args: { id: "a1", message: "One", prompt: "Two" }, tars: [messaged()] },
  { name: "send_message, held", tool: "send_message", args: { id: "a1", message: "Later" }, tars: [messaged({ held: true, heldReason: "Its field is being edited." })] },
  { name: "send_message, error", tool: "send_message", args: { id: "a1", message: "Hi" }, tars: [fail(403, { error: "Cross-project action refused" })] },

  { name: "remove_agent", tool: "remove_agent", args: { id: "a1" }, tars: [ok({ success: true })] },
  { name: "remove_agent, cross-project", tool: "remove_agent", args: { id: "b1", allowCrossProject: true }, tars: [ok({ success: true })] },
  { name: "remove_agent, error", tool: "remove_agent", args: { id: "a1" }, tars: [fail(404, { error: "Agent not found" })] },

  { name: "wait_for_agent, completed with output", tool: "wait_for_agent", args: { id: "a1" }, tars: [done("Finished."), ok({ agent: dune })] },
  { name: "wait_for_agent, idle, no output, no name", tool: "wait_for_agent", args: { id: "a1", timeoutSeconds: 30 }, tars: [ok({ status: "idle" }), ok({ agent: {} })] },
  { name: "wait_for_agent, error with a reason", tool: "wait_for_agent", args: { id: "a1" }, tars: [ok({ status: "error", error: "The CLI exited" }), ok({ agent: dune })] },
  { name: "wait_for_agent, error without a reason", tool: "wait_for_agent", args: { id: "a1" }, tars: [ok({ status: "error" }), ok({ agent: dune })] },
  { name: "wait_for_agent, blocked on a permission", tool: "wait_for_agent", args: { id: "a1" }, tars: [ok({ status: "waiting", waitingReason: "permission" }), ok({ agent: dune })] },
  { name: "wait_for_agent, asking a question", tool: "wait_for_agent", args: { id: "a1" }, tars: [asking, ok({ agent: dune })] },
  { name: "wait_for_agent, another status", tool: "wait_for_agent", args: { id: "a1" }, tars: [ok({ status: "stopped" }), ok({ agent: dune })] },
  { name: "wait_for_agent, stopped with a reason", tool: "wait_for_agent", args: { id: "a1" }, tars: [ok({ status: "stopped", stoppedBy: "Tars-Orchestrator", stopReason: "frozen on a file read" }), ok({ agent: dune })] },
  { name: "wait_for_agent, times out", tool: "wait_for_agent", args: { id: "a1", timeoutSeconds: 1 }, tars: [ok({ status: "running", timeout: true }), ok({ agent: dune })] },
  { name: "wait_for_agent, the agent lookup fails", tool: "wait_for_agent", args: { id: "a1" }, tars: [done("x"), fail(404, { error: "Agent not found" })] },
  { name: "wait_for_agent, Tars never answers: its segment's 31 s", tool: "wait_for_agent", args: { id: "a1", timeoutSeconds: 1 }, tars: [hold] },

  {
    name: "delegate_task over ACP, answered", tool: "delegate_task", args: { id: "a1", prompt: "Fix the bug" },
    tars: [ok({ ok: true, started: true, stopReason: "end_turn", text: "Fixed in utils.ts.", toolCalls: ["Read", "Edit", "Bash", "Read", "Edit", "Bash", "Read", "Edit", "Grep"], usage: { totalTokens: 1234 }, costUSD: 0.01234 })],
  },
  {
    name: "delegate_task over ACP, a run that failed", tool: "delegate_task", args: { id: "a1", prompt: "Fix the bug", timeoutSeconds: 120 },
    tars: [ok({ ok: false, started: true, error: "The run was cancelled.", backgroundStopped: ["npm run dev"], costUSD: 0 })],
  },
  { name: "delegate_task over ACP, text but not ok, nothing else", tool: "delegate_task", args: { id: "a1", prompt: "Fix" }, tars: [ok({ text: "Partial answer" })] },
  { name: "delegate_task, ACP asks for the terminal, held", tool: "delegate_task", args: { id: "a1", prompt: "Fix", model: "sonnet" }, tars: [ok({ retryWithDispatch: true }), messaged({ held: true })] },
  {
    name: "delegate_task, no ACP mode, completed", tool: "delegate_task", args: { id: "a1", prompt: "Fix", allowCrossProject: true },
    tars: [fail(400, { error: "no ACP mode" }), started(), done("wait output"), ok({ agent: { ...dune, status: "completed", lastCleanOutput: "Clean output." } })],
  },
  {
    name: "delegate_task, no clean output captured, the wait's output is used", tool: "delegate_task", args: { id: "a1", prompt: "Fix" },
    tars: [fail(400, { error: "no ACP mode" }), started(), done("From the wait."), ok({ agent: dune }), ok({ agent: dune }), ok({ agent: dune })],
  },
  {
    name: "delegate_task, no output at all", tool: "delegate_task", args: { id: "a1", prompt: "Fix" },
    tars: [fail(400, { error: "no ACP mode" }), started(), ok({ status: "idle" }), ok({ agent: dune }), ok({ agent: dune }), ok({ agent: dune })],
  },
  { name: "delegate_task, blocked on a permission", tool: "delegate_task", args: { id: "a1", prompt: "Fix" }, tars: [fail(400, { error: "no ACP mode" }), started(), ok({ status: "waiting", waitingReason: "permission" })] },
  {
    name: "delegate_task, a question, the answer is held", tool: "delegate_task", args: { id: "a1", prompt: "Fix" },
    tars: [fail(400, { error: "no ACP mode" }), started(), asking, messaged({ held: true, heldReason: "Its field is in use by JeanBrasse." })],
  },
  {
    name: "delegate_task, a question answered, then completed", tool: "delegate_task", args: { id: "a1", prompt: "Fix" },
    tars: [fail(400, { error: "no ACP mode" }), started(), asking, messaged(), done(), ok({ agent: { ...dune, lastCleanOutput: "Done after a nudge." } })],
  },
  {
    name: "delegate_task, still asking after every auto-continue", tool: "delegate_task", args: { id: "a1", prompt: "Fix" },
    tars: [
      fail(400, { error: "no ACP mode" }), started(), asking,
      ...Array.from({ length: 7 }, () => [messaged(), asking]).flat(),
      messaged(), ok({ status: "waiting", waitingReason: "idle", lastCleanOutput: "Shall I go on?" }),
    ],
  },
  { name: "delegate_task, the auto-continue fails", tool: "delegate_task", args: { id: "a1", prompt: "Fix" }, tars: [fail(400, { error: "no ACP mode" }), started(), asking, fail(500, { error: "gone" })] },
  {
    name: "delegate_task, a question, then a permission", tool: "delegate_task", args: { id: "a1", prompt: "Fix" },
    tars: [fail(400, { error: "no ACP mode" }), started(), asking, messaged(), ok({ status: "waiting", waitingReason: "permission" })],
  },
  { name: "delegate_task, times out", tool: "delegate_task", args: { id: "a1", prompt: "Fix", timeoutSeconds: 1 }, tars: [fail(400, { error: "no ACP mode" }), started(), ok({ status: "running", timeout: true })] },
  { name: "delegate_task, the agent fails", tool: "delegate_task", args: { id: "a1", prompt: "Fix" }, tars: [fail(400, { error: "no ACP mode" }), started(), ok({ status: "error", error: "Crashed" })] },
  { name: "delegate_task, the agent fails without a reason", tool: "delegate_task", args: { id: "a1", prompt: "Fix" }, tars: [fail(400, { error: "no ACP mode" }), started(), ok({ status: "error" })] },
  { name: "delegate_task, no answer before its own deadline", tool: "delegate_task", args: { id: "a1", prompt: "Fix", timeoutSeconds: -59 }, tars: [hold] },
  { name: "delegate_task, the dispatch fails", tool: "delegate_task", args: { id: "a1", prompt: "Fix" }, tars: [fail(400, { error: "no ACP mode" }), fail(403, { error: "Cross-project action refused" })] },
  { name: "delegate_task, no prompt", tool: "delegate_task", args: { id: "a1" } },

  { name: "send_telegram", tool: "send_telegram", args: { message: "Short" }, tars: [ok({ success: true })] },
  { name: "send_telegram, long, to a chat", tool: "send_telegram", args: { message: long, chat_id: "123" }, tars: [ok({ success: true })] },
  { name: "send_telegram, refused", tool: "send_telegram", args: { message: "Hi", chat_id: "999" }, tars: [fail(403, { error: "Chat 999 is not authorized" })] },
  { name: "send_slack", tool: "send_slack", args: { message: long }, tars: [ok({ success: true })] },
  { name: "send_slack, error", tool: "send_slack", args: { message: "Hi" }, tars: [fail(503, { error: "Slack is not connected" })] },
  { name: "send_discord, to its channel", tool: "send_discord", args: { message: "Dune is on it.", channel_id: "C-TEAM" }, tars: [ok({ success: true })] },
  { name: "send_discord, no channel, long", tool: "send_discord", args: { message: long }, tars: [ok({ success: true })] },
  { name: "send_discord, refused", tool: "send_discord", args: { message: "Hi", channel_id: "C-OTHER" }, tars: [fail(403, { error: "Tars posts only to the channel Settings > Discord detected" })] },
  { name: "ask_user, asked", tool: "ask_user", args: { question: "Staging or prod?", context: "The migration touches billing." }, tars: [ok({ success: true, id: "q-1", expiresAt: "2026-09-28T12:00:00.000Z" })] },
  { name: "ask_user, one already open", tool: "ask_user", args: { question: "Again?" }, tars: [fail(409, { error: "You already have a question open for JeanBrasse" })] },
  { name: "ask_user, no question", tool: "ask_user", args: { context: "nothing asked" }, tars: [] },

  { name: "room_post, refused with a message", tool: "room_post", args: { text: "(pass)" }, tars: [ok({ refused: "silence", message: "Nothing was published." })] },
  { name: "room_post, refused without a message", tool: "room_post", args: { text: "Hi" }, tars: [ok({ refused: "bounded" })] },
  {
    name: "room_post, posted, some queued, some not sent, bounded", tool: "room_post", args: { text: "Result: green", mentions: ["a1", "a2"] },
    tars: [ok({ success: true, messageId: "m1", threadId: "t1", threadState: "bounded", round: 3, agentMessageCount: 10, deliveries: [
      { targetAgentId: "a1", state: "queued" }, { targetAgentId: "a2", state: "queued" },
      { targetAgentId: "a3", state: "not_sent", reason: "codex has no way in at rest" }, { targetAgentId: "a4", state: "not_sent" },
    ] })],
  },
  { name: "room_post, posted to a named room, nobody queued", tool: "room_post", args: { text: "FYI", room: "room-beta" }, tars: [ok({ success: true, threadId: "t2", threadState: "open", round: 1, agentMessageCount: 1 })] },
  { name: "room_post, error", tool: "room_post", args: { text: "Hi" }, tars: [fail(404, { error: "No such room" })] },
  { name: "room_read, empty", tool: "room_read", tars: [ok({ room: { id: "r1", title: "alpha", memberIds: [] }, messages: [], threads: [] })] },
  {
    name: "room_read, an open thread", tool: "room_read", args: { room: "r1", limit: 2 },
    tars: [ok({ room: { id: "r1", title: "alpha", memberIds: ["a1"] }, messages: [
      { authorName: "JeanBrasse", authorKind: "human", text: "Status?", createdAt: "2026-09-24T08:00:00.000Z", mentions: [] },
      { authorName: "Dune", authorKind: "agent", text: "Green.", createdAt: "2026-09-24T08:01:00.000Z", mentions: [] },
    ], threads: [{ id: "t1", state: "open", round: 2, agentMessageCount: 3 }] })],
  },
  {
    name: "room_read, no open thread, no room title", tool: "room_read",
    tars: [ok({ messages: [{ authorName: "Dune", authorKind: "agent", text: "Done.", createdAt: "2026-09-24T09:00:00.000Z", mentions: [] }], threads: [{ id: "t1", state: "bounded", round: 3, agentMessageCount: 10 }] })],
  },
  { name: "room_read, error", tool: "room_read", tars: [fail(500, { error: "The bus is not ready" })] },

  { name: "a tool that does not exist", tool: "no_such_tool" },
];

const orchestratorShared = [
  { name: "whoami, no identity", tool: "whoami" },
  { name: "list_agents, the shared token", tool: "list_agents", tars: [ok({ agents: [dune, far] })] },
  { name: "list_agents all, no identity", tool: "list_agents", args: { all: true }, tars: [ok({ agents: [dune, far] })] },
  { name: "create_agent, no project anywhere", tool: "create_agent", args: { name: "Worker" } },
  { name: "stop_agent, the shared token", tool: "stop_agent", args: { id: "a1", reason: "done" }, tars: [ok({ success: true })] },
];

const orchestratorProjectOnly = [
  { name: "whoami, a project and no agent id", tool: "whoami", tars: [ok({ agents: [dune] })] },
  { name: "list_agents all, a project and no agent id", tool: "list_agents", args: { all: true }, tars: [ok({ agents: [dune, far] })] },
];

const orchestratorNoToken = [
  { name: "list_agents, no token at all", tool: "list_agents", tars: [fail(401, { error: "Unauthorized" })] },
];

// ---------------------------------------------------------------------- memory

const memoryAgent = [
  {
    name: "memory_search, hits and a source down", tool: "memory_search", args: { query: "port 9119" },
    tars: [ok({ hits: [{ source: "project", title: "MEMORY.md", content: "9119 is the tunnel." }, { source: "hermes", title: "Hermes", content: "Tunnel on 9119.", ref: "h1" }], errors: [{ source: "honcho", error: "timeout" }] })],
  },
  { name: "memory_search, hits only, every option", tool: "memory_search", args: { query: "db", sources: ["project", "gbrain"], limit: 5, project_path: "/projects/beta" }, tars: [ok({ hits: [{ source: "gbrain", title: "Schema", content: "SQLite." }] })] },
  { name: "memory_search, nothing, sources down", tool: "memory_search", args: { query: "nothing" }, tars: [ok({ hits: [], errors: [{ source: "hermes", error: "unreachable" }, { source: "gbrain", error: "401" }] })] },
  { name: "memory_search, nothing", tool: "memory_search", args: { query: "nothing" }, tars: [ok({})] },
  { name: "memory_search, Tars refuses", tool: "memory_search", args: { query: "x" }, tars: [fail(403, { error: "This token names no agent" })] },
  { name: "memory_search, limit out of range", tool: "memory_search", args: { query: "x", limit: 99 } },
  { name: "memory_read", tool: "memory_read", tars: [ok({ context: "  # Memory\nThings.\n  " })] },
  { name: "memory_read, nothing recorded", tool: "memory_read", args: { project_path: "/projects/beta" }, tars: [ok({ context: "   " })] },
  { name: "memory_read, error", tool: "memory_read", tars: [fail(500, { error: "boom" })] },
  { name: "memory_read, Tars never answers: 30 s", tool: "memory_read", tars: [hold] },
  {
    name: "memory_write, to several memories", tool: "memory_write", args: { content: "Use port 31478 for proofs.", to: ["project", "hermes"], file: "ports.md" },
    tars: [ok({ success: false, results: [{ target: "project", success: true, path: "/projects/alpha/memory/ports.md" }, { target: "hermes", success: false, error: "Hermes is not configured" }] })],
  },
  { name: "memory_write, recorded", tool: "memory_write", args: { content: "A fact." }, tars: [ok({ success: true, path: "/projects/alpha/memory/MEMORY.md" })] },
  { name: "memory_write, recorded, path from the one result", tool: "memory_write", args: { content: "A fact." }, tars: [ok({ success: true, results: [{ target: "project", success: true, path: "/p/MEMORY.md" }] })] },
  { name: "memory_write, recorded, no path at all", tool: "memory_write", args: { content: "A fact." }, tars: [ok({ success: true })] },
  { name: "memory_write, refused", tool: "memory_write", args: { content: "A fact." }, tars: [ok({ success: false, error: "The memory folder is read-only" })] },
  { name: "memory_write, refused, the one result says why", tool: "memory_write", args: { content: "A fact." }, tars: [ok({ results: [{ target: "project", success: false, error: "disk full" }] })] },
  { name: "memory_write, refused, no reason", tool: "memory_write", args: { content: "A fact." }, tars: [ok({})] },
  { name: "memory_write, a memory that does not exist", tool: "memory_write", args: { content: "A fact.", to: ["notes"] } },
  {
    name: "memory_sources", tool: "memory_sources",
    tars: [ok({ sources: [
      { id: "project", label: "Project memory", configured: true, reachable: true, detail: "3 files" },
      { id: "hermes", label: "Hermes", configured: true, reachable: false, detail: "connect ECONNREFUSED" },
      { id: "honcho", label: "Honcho", configured: false, reachable: false, detail: "no token" },
    ] })],
  },
  { name: "memory_sources, none", tool: "memory_sources", args: { project_path: "/projects/beta" }, tars: [ok({ sources: [] })] },
];

const memoryNoProject = [
  { name: "memory_read, no project: this process's directory", tool: "memory_read", tars: [ok({ context: "cwd memory" })] },
];

// ---------------------------------------------------------------------- kanban

const task = (extra = {}) => ({ id: "t_1", title: "Ship D4", column: "ongoing", status: "running", holder: "Lead", priority: "high", description: "The MCP refactor.", heldByCaller: true, ...extra });

const kanbanAgent = [
  { name: "list_tasks", tool: "list_tasks", tars: [ok({ tasks: [task(), task({ id: "t_2", title: "Parked", column: "backlog", status: "triage", holder: null })] })] },
  { name: "list_tasks, filtered", tool: "list_tasks", args: { column: "done", assigned_to_me: true }, tars: [ok({ tasks: [] })] },
  { name: "list_tasks, not mine", tool: "list_tasks", args: { assigned_to_me: false }, tars: [ok({})] },
  { name: "list_tasks, Hermes not configured", tool: "list_tasks", tars: [fail(503, { error: "Hermes is not configured: set it up in Settings > Hermes" })] },
  { name: "list_tasks, an error with no message", tool: "list_tasks", tars: [fail(502, {})] },
  { name: "list_tasks, not JSON", tool: "list_tasks", tars: [raw(502, `<html>${"Bad gateway ".repeat(30)}</html>`)] },
  { name: "list_tasks, the connection drops", tool: "list_tasks", tars: [drop] },
  { name: "list_tasks, Tars never answers: 60 s", tool: "list_tasks", tars: [hold] },
  { name: "list_tasks, an answer that is null", tool: "list_tasks", tars: [ok(null)] },
  { name: "list_tasks, an error whose body is null", tool: "list_tasks", tars: [fail(500, null)] },
  { name: "list_tasks, a column that does not exist", tool: "list_tasks", args: { column: "later" } },
  { name: "get_task, everything", tool: "get_task", args: { task_id: " t 1/x " }, tars: [ok({ task: task({ result: "Merged.", comments: ["Started", "Half way"] }) })] },
  { name: "get_task, the least", tool: "get_task", args: { task_id: "t_2" }, tars: [ok({ task: task({ holder: null, result: null, comments: [] }) })] },
  { name: "get_task, unknown", tool: "get_task", args: { task_id: "nope" }, tars: [fail(404, { error: "No task nope on this project's board" })] },
  { name: "create_task", tool: "create_task", args: { title: "New", description: "Details", project_path: "/projects/alpha", priority: "low", labels: ["a", "b"] }, tars: [ok({ task: task({ id: "t_3", title: "New" }) })] },
  { name: "create_task, error", tool: "create_task", args: { title: "New", description: "Details" }, tars: [fail(500, { error: "gateway error" })] },
  { name: "update_task_progress", tool: "update_task_progress", args: { task_id: "t_1", progress: 40 }, tars: [ok({ task: task() })] },
  { name: "update_task_progress, out of range", tool: "update_task_progress", args: { task_id: "t_1", progress: 140 } },
  { name: "update_task_progress, error", tool: "update_task_progress", args: { task_id: "t_1", progress: 40 }, tars: [fail(403, { error: "Not your task" })] },
  { name: "mark_task_done", tool: "mark_task_done", args: { task_id: "t_1", summary: "Merged." }, tars: [ok({ task: task({ column: "done" }) })] },
  { name: "mark_task_done, error", tool: "mark_task_done", args: { task_id: "t_1", summary: "x" }, tars: [fail(403, { error: "Not your task" })] },
  { name: "move_task", tool: "move_task", args: { task_id: "t_1", column: "planned" }, tars: [ok({ task: task({ column: "planned", status: "todo", holder: null }) })] },
  { name: "move_task, error", tool: "move_task", args: { task_id: "t_1", column: "done" }, tars: [fail(400, { error: "Use mark_task_done" })] },
  { name: "delete_task", tool: "delete_task", args: { task_id: "t_1" }, tars: [ok({ task: { id: "t_1" } })] },
  { name: "delete_task, error", tool: "delete_task", args: { task_id: "t_1" }, tars: [fail(403, { error: "Only its creator deletes it" })] },
  { name: "assign_task, to myself", tool: "assign_task", args: { task_id: "t_1" }, tars: [ok({ task: task() })] },
  { name: "assign_task, to another agent", tool: "assign_task", args: { task_id: "t_1", agent_id: "a1" }, tars: [ok({ task: task({ heldByCaller: false, holder: "Dune" }) })] },
  { name: "assign_task, error", tool: "assign_task", args: { task_id: "t_1" }, tars: [fail(409, { error: "You already hold a task" })] },
];

const kanbanNoToken = [
  { name: "list_tasks, no agent token", tool: "list_tasks", tars: [fail(403, { error: "The kanban tools act for an agent" })] },
];

// ----------------------------------------------------------------------- vault

const doc = (extra = {}) => ({ id: "d1234567890", title: "Report", content: "# Report\nBody.", folder_id: "f1", author: "Lead", agent_id: "agent-lead", tags: "[\"weekly\",\"db\"]", created_at: "2026-09-24T08:00:00.000Z", updated_at: "2026-09-24T09:00:00.000Z", ...extra });
const folder = (id, name, parent_id = null) => ({ id, name, parent_id, created_at: "2026-09-24T08:00:00.000Z", updated_at: "2026-09-24T08:00:00.000Z" });

const vaultAgent = [
  { name: "vault_create_document, into an existing folder", tool: "vault_create_document", args: { title: "Report", content: "Body", folder: "weekly reports", tags: ["weekly"] }, tars: [ok({ folders: [folder("f0", "Other"), folder("f1", "Weekly Reports")] }), ok({ success: true, document: doc() })] },
  { name: "vault_create_document, a new folder, no tags", tool: "vault_create_document", args: { title: "Report", content: "Body", folder: "Research" }, tars: [ok({ folders: [] }), ok({ success: true, folder: folder("f9", "Research") }), ok({ success: true, document: doc({ folder_id: "f9" }) })] },
  { name: "vault_create_document, error", tool: "vault_create_document", args: { title: "R", content: "B", folder: "X" }, tars: [fail(500, { error: "disk I/O error" })] },
  { name: "vault_update_document, every field", tool: "vault_update_document", args: { document_id: "d1", title: "T", content: "C", tags: ["t"], folder_id: "f2" }, tars: [ok({ success: true, document: doc({ title: "T" }) })] },
  { name: "vault_update_document, nothing", tool: "vault_update_document", args: { document_id: "d1" }, tars: [ok({ success: true, document: doc() })] },
  { name: "vault_update_document, error", tool: "vault_update_document", args: { document_id: "d1" }, tars: [fail(404, { error: "Document not found" })] },
  { name: "vault_get_document, with attachments", tool: "vault_get_document", args: { document_id: "d1" }, tars: [ok({ document: doc(), attachments: [{ id: "at1", filename: "a.png", mimetype: "image/png", size: 42 }] })] },
  { name: "vault_get_document, bare", tool: "vault_get_document", args: { document_id: "d1" }, tars: [ok({ document: doc({ tags: "", folder_id: null }), attachments: [] })] },
  { name: "vault_get_document, tags that are not JSON", tool: "vault_get_document", args: { document_id: "d1" }, tars: [ok({ document: doc({ tags: "weekly" }), attachments: [] })] },
  { name: "vault_get_document, error", tool: "vault_get_document", args: { document_id: "d1" }, tars: [fail(404, { error: "Document not found" })] },
  { name: "vault_list_documents, filtered", tool: "vault_list_documents", args: { folder_id: "f 1", tags: ["a b", "c"] }, tars: [ok({ documents: [doc(), doc({ id: "d2", title: "Notes", tags: "[]" })] })] },
  { name: "vault_list_documents, empty tags filter", tool: "vault_list_documents", args: { tags: [] }, tars: [ok({ documents: [] })] },
  { name: "vault_list_documents, error", tool: "vault_list_documents", tars: [fail(500, { error: "boom" })] },
  { name: "vault_delete_document", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [ok({ success: true })] },
  { name: "vault_delete_document, error", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [fail(404, { error: "Document not found" })] },
  { name: "vault_attach_file", tool: "vault_attach_file", args: { document_id: "d1", file_path: "/projects/alpha/a.png" }, tars: [ok({ success: true, attachment: { id: "at1", filename: "a.png", mimetype: "image/png", size: 42 } })] },
  { name: "vault_attach_file, refused", tool: "vault_attach_file", args: { document_id: "d1", file_path: "/Users/x/.ssh/id_rsa" }, tars: [fail(403, { error: "Refused: .ssh holds credentials" })] },
  { name: "vault_create_folder, nested", tool: "vault_create_folder", args: { name: "Sub", parent_id: "f1" }, tars: [ok({ success: true, folder: folder("f5", "Sub", "f1") })] },
  { name: "vault_create_folder, at the root", tool: "vault_create_folder", args: { name: "Top" }, tars: [ok({ success: true, folder: folder("f6", "Top") })] },
  { name: "vault_create_folder, error", tool: "vault_create_folder", args: { name: "Top" }, tars: [fail(409, { error: "exists" })] },
  { name: "vault_list_folders, a tree", tool: "vault_list_folders", tars: [ok({ folders: [folder("f1aaaaaaaa", "A"), folder("f2bbbbbbbb", "B", "f1aaaaaaaa"), folder("f3cccccccc", "C", "f2bbbbbbbb"), folder("f4dddddddd", "D")] })] },
  { name: "vault_list_folders, none", tool: "vault_list_folders", tars: [ok({ folders: [] })] },
  { name: "vault_list_folders, error", tool: "vault_list_folders", tars: [fail(500, { error: "boom" })] },
  { name: "vault_delete_folder", tool: "vault_delete_folder", args: { folder_id: "f1" }, tars: [ok({ success: true })] },
  { name: "vault_delete_folder, recursive", tool: "vault_delete_folder", args: { folder_id: "f1", recursive: true }, tars: [ok({ success: true })] },
  { name: "vault_delete_folder, error", tool: "vault_delete_folder", args: { folder_id: "f1" }, tars: [fail(404, { error: "Folder not found" })] },
  {
    name: "vault_search", tool: "vault_search", args: { query: "\"port 9119\" OR tunnel", limit: 3 },
    tars: [ok({ results: [{ id: "d1234567890", title: "Report", content: "c", author: "Lead", tags: "[\"a\"]", created_at: "x", updated_at: "y", snippet: "the <mark>tunnel</mark> is on <mark>9119</mark>" }, { id: "d2", title: "Other", content: "c", author: "Dune", tags: "", created_at: "x", updated_at: "y" }] })],
  },
  { name: "vault_search, nothing", tool: "vault_search", args: { query: "zzz" }, tars: [ok({ results: [] })] },
  { name: "vault_search, error", tool: "vault_search", args: { query: "a AND" }, tars: [fail(400, { error: "fts5: syntax error" })] },
  { name: "vault, an error without a message", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [fail(500, { detail: "no error field" })] },
  { name: "vault, an answer that is not JSON", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [raw(200, "oops")] },
  { name: "vault, the connection drops", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [drop] },
  { name: "vault, an error whose body is null", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [fail(500, null)] },
  { name: "vault, an empty answer", tool: "vault_delete_document", args: { document_id: "d1" }, tars: [raw(200, "")] },
  { name: "vault_get_document, Tars never answers", tool: "vault_get_document", args: { document_id: "d1" }, tars: [hold] },
];

const vaultNoName = [
  { name: "vault_create_document, no agent name: the id is the author", tool: "vault_create_document", args: { title: "R", content: "B", folder: "A" }, tars: [ok({ folders: [folder("f1", "A")] }), ok({ success: true, document: doc() })] },
];

const vaultNoIdentity = [
  { name: "vault_create_document, no identity, the shared token", tool: "vault_create_document", args: { title: "R", content: "B", folder: "A" }, tars: [ok({ folders: [folder("f1", "A")] }), ok({ success: true, document: doc() })] },
];

const vaultNoToken = [
  { name: "vault_list_folders, no token at all", tool: "vault_list_folders", tars: [fail(401, { error: "Unauthorized" })] },
];

// ------------------------------------------------------------------ socialdata

const SOCIAL = { socialDataApiKey: "sd-key" };
const tweet = (extra = {}) => ({
  id_str: "1001", full_text: "Hello world", tweet_created_at: "2026-09-24T08:00:00.000000Z",
  user: { id_str: "44", name: "JeanBrasse", screen_name: "jeanbrasse", description: "bio", followers_count: 12345, friends_count: 678, verified: false, profile_image_url_https: "https://img" },
  retweet_count: 1, favorite_count: 2, reply_count: 3, quote_count: 4, views_count: 5000, bookmark_count: 6, lang: "en", source: "web",
  in_reply_to_status_id_str: null, in_reply_to_screen_name: null, is_pinned: false, entities: {}, ...extra,
});
const user = (extra = {}) => ({
  id_str: "44", name: "JeanBrasse", screen_name: "jeanbrasse", description: "Builds Tars.", location: "Dubai", url: "https://tars.dev", protected: false, verified: true,
  followers_count: 1234567, friends_count: 89, listed_count: 10, favourites_count: 4321, statuses_count: 9876, created_at: "2010-01-01", profile_banner_url: "", profile_image_url_https: "", can_dm: true, ...extra,
});

const socialdata = [
  { name: "twitter_search, a page and a cursor", tool: "twitter_search", args: { query: "from:jeanbrasse tars", type: "Top", cursor: "c0" }, tars: [ok({ tweets: [tweet(), tweet({ id_str: "1002", full_text: "Second" })], next_cursor: "c1" })] },
  { name: "twitter_search, last page", tool: "twitter_search", args: { query: "tars" }, tars: [ok({ tweets: [tweet()], next_cursor: null })] },
  { name: "twitter_search, nothing", tool: "twitter_search", args: { query: "zzz" }, tars: [ok({ tweets: [] })] },
  { name: "twitter_search, no tweets field", tool: "twitter_search", args: { query: "zzz" }, tars: [ok({})] },
  { name: "twitter_search, no API key", tool: "twitter_search", args: { query: "tars" }, settings: {} },
  { name: "twitter_search, no settings file", tool: "twitter_search", args: { query: "tars" }, settings: null },
  { name: "twitter_search, settings that are not JSON", tool: "twitter_search", args: { query: "tars" }, settings: "{ broken" },
  { name: "twitter_search, settings that are null", tool: "twitter_search", args: { query: "tars" }, settings: "null" },
  { name: "twitter_search, out of credits", tool: "twitter_search", args: { query: "tars" }, tars: [fail(402, { status: "error" })] },
  { name: "twitter_search, not found", tool: "twitter_search", args: { query: "tars" }, tars: [fail(404, { status: "error" })] },
  { name: "twitter_search, validation", tool: "twitter_search", args: { query: "tars" }, tars: [fail(422, { message: "bad query" })] },
  { name: "twitter_search, another error", tool: "twitter_search", args: { query: "tars" }, tars: [fail(500, { message: "down" })] },
  { name: "twitter_search, not JSON", tool: "twitter_search", args: { query: "tars" }, tars: [raw(200, "x".repeat(600))] },
  { name: "twitter_search, the connection drops", tool: "twitter_search", args: { query: "tars" }, tars: [drop] },
  { name: "twitter_search, a validation error with a null body", tool: "twitter_search", args: { query: "tars" }, tars: [fail(422, null)] },
  { name: "twitter_search, an answer that is null", tool: "twitter_search", args: { query: "tars" }, tars: [ok(null)] },
  { name: "twitter_search, a type that does not exist", tool: "twitter_search", args: { query: "tars", type: "Oldest" } },
  {
    name: "twitter_get_tweet, everything", tool: "twitter_get_tweet", args: { tweet_id: "1001" },
    tars: [ok(tweet({ in_reply_to_screen_name: "elon", in_reply_to_status_id_str: "999", entities: {
      hashtags: [{ text: "ai" }, { text: "agents" }], urls: [{ expanded_url: "https://a.dev", display_url: "a.dev" }, { expanded_url: "https://b.dev", display_url: "b.dev" }],
      media: [{ type: "photo", media_url_https: "https://m/1.jpg" }], user_mentions: [{ screen_name: "alice" }, { screen_name: "bob" }],
    } }))],
  },
  { name: "twitter_get_tweet, bare", tool: "twitter_get_tweet", args: { tweet_id: "1001" }, tars: [ok(tweet({ entities: { hashtags: [], urls: [], media: [], user_mentions: [] } }))] },
  { name: "twitter_get_tweet, error", tool: "twitter_get_tweet", args: { tweet_id: "1" }, tars: [fail(404, {})] },
  { name: "twitter_get_tweet_comments, a page", tool: "twitter_get_tweet_comments", args: { tweet_id: "1001", cursor: "c0" }, tars: [ok({ tweets: [tweet({ full_text: "Nice" })], next_cursor: "c2" })] },
  { name: "twitter_get_tweet_comments, last page", tool: "twitter_get_tweet_comments", args: { tweet_id: "1001" }, tars: [ok({ tweets: [tweet({ full_text: "Nice" })] })] },
  { name: "twitter_get_tweet_comments, none", tool: "twitter_get_tweet_comments", args: { tweet_id: "1001" }, tars: [ok({ tweets: [] })] },
  { name: "twitter_get_tweet_comments, error", tool: "twitter_get_tweet_comments", args: { tweet_id: "1001" }, tars: [fail(500, { message: "down" })] },
  { name: "twitter_get_user, with an @", tool: "twitter_get_user", args: { username: "@jeanbrasse" }, tars: [ok(user())] },
  { name: "twitter_get_user, bare profile", tool: "twitter_get_user", args: { username: "ghost" }, tars: [ok(user({ description: "", location: "", url: null, protected: true, verified: false, can_dm: false }))] },
  { name: "twitter_get_user, error", tool: "twitter_get_user", args: { username: "ghost" }, tars: [fail(404, {})] },
  { name: "twitter_get_user_tweets, with replies and a cursor", tool: "twitter_get_user_tweets", args: { user_id: "44", include_replies: true, cursor: "c0" }, tars: [ok({ tweets: [tweet(), tweet({ id_str: "1003" })], next_cursor: "c3" })] },
  { name: "twitter_get_user_tweets, tweets only", tool: "twitter_get_user_tweets", args: { user_id: "44", include_replies: false }, tars: [ok({ tweets: [tweet()] })] },
  { name: "twitter_get_user_tweets, none", tool: "twitter_get_user_tweets", args: { user_id: "44" }, tars: [ok({ tweets: [] })] },
  { name: "twitter_get_user_tweets, error", tool: "twitter_get_user_tweets", args: { user_id: "44" }, tars: [fail(402, {})] },
  { name: "twitter_search, SocialData never answers", tool: "twitter_search", args: { query: "tars" }, tars: [hold] },
];

// ------------------------------------------------------------------------- x

const X = { xApiKey: "ck", xApiSecret: "cs", xAccessToken: "at", xAccessTokenSecret: "ats", xPostingEnabled: true };

const x = [
  { name: "x_post_tweet", tool: "x_post_tweet", args: { text: "Hello from Tars" }, tars: [ok({ data: { id: "2001", text: "Hello from Tars" } })] },
  { name: "x_post_tweet, a quote", tool: "x_post_tweet", args: { text: "Look", quote_tweet_id: "1001" }, tars: [ok({ data: { id: "2002", text: "Look" } })] },
  { name: "x_post_tweet, no data back", tool: "x_post_tweet", args: { text: "Hi" }, tars: [ok({ meta: { sent: true } })] },
  { name: "x_post_tweet, nothing back", tool: "x_post_tweet", args: { text: "Hi" }, tars: [{ status: 204 }] },
  { name: "x_post_tweet, posting is off", tool: "x_post_tweet", args: { text: "Hi" }, settings: { ...X, xPostingEnabled: false } },
  { name: "x_post_tweet, posting on as a string is off", tool: "x_post_tweet", args: { text: "Hi" }, settings: { ...X, xPostingEnabled: "true" } },
  { name: "x_post_tweet, no settings file", tool: "x_post_tweet", args: { text: "Hi" }, settings: null },
  { name: "x_post_tweet, settings that are null", tool: "x_post_tweet", args: { text: "Hi" }, settings: "null" },
  { name: "x_post_tweet, no credentials", tool: "x_post_tweet", args: { text: "Hi" }, settings: { xPostingEnabled: true, xApiKey: "ck" } },
  { name: "x_post_tweet, an error with a detail", tool: "x_post_tweet", args: { text: "Hi" }, tars: [fail(403, { detail: "You are not permitted to perform this action." })] },
  { name: "x_post_tweet, an error with errors", tool: "x_post_tweet", args: { text: "Hi" }, tars: [fail(400, { errors: [{ message: "Duplicate content" }] })] },
  { name: "x_post_tweet, an error with neither", tool: "x_post_tweet", args: { text: "Hi" }, tars: [fail(429, { title: "Too Many Requests" })] },
  { name: "x_post_tweet, not JSON", tool: "x_post_tweet", args: { text: "Hi" }, tars: [raw(500, "y".repeat(600))] },
  { name: "x_post_tweet, the connection drops", tool: "x_post_tweet", args: { text: "Hi" }, tars: [drop] },
  { name: "x_post_tweet, an error whose body is null", tool: "x_post_tweet", args: { text: "Hi" }, tars: [fail(500, null)] },
  { name: "x_post_tweet, an empty answer", tool: "x_post_tweet", args: { text: "Hi" }, tars: [raw(200, "")] },
  { name: "x_post_tweet, over 280 characters", tool: "x_post_tweet", args: { text: "z".repeat(281) } },
  { name: "x_reply_tweet", tool: "x_reply_tweet", args: { text: "Agreed", reply_to_id: "1001" }, tars: [ok({ data: { id: "2003", text: "Agreed" } })] },
  { name: "x_reply_tweet, no data back", tool: "x_reply_tweet", args: { text: "Agreed", reply_to_id: "1001" }, tars: [ok({})] },
  { name: "x_reply_tweet, posting is off", tool: "x_reply_tweet", args: { text: "Agreed", reply_to_id: "1001" }, settings: { ...X, xPostingEnabled: false } },
  { name: "x_reply_tweet, error", tool: "x_reply_tweet", args: { text: "Agreed", reply_to_id: "1001" }, tars: [fail(404, { detail: "Not found" })] },
  { name: "x_delete_tweet", tool: "x_delete_tweet", args: { tweet_id: "2001" }, tars: [ok({ data: { deleted: true } })] },
  { name: "x_delete_tweet, not deleted", tool: "x_delete_tweet", args: { tweet_id: "2001" }, tars: [ok({ data: { deleted: false } })] },
  { name: "x_delete_tweet, posting is off", tool: "x_delete_tweet", args: { tweet_id: "2001" }, settings: { ...X, xPostingEnabled: false } },
  { name: "x_delete_tweet, error", tool: "x_delete_tweet", args: { tweet_id: "2001" }, tars: [fail(403, { detail: "Not yours" })] },
  { name: "x_post_tweet, X never answers", tool: "x_post_tweet", args: { text: "Hi" }, tars: [hold] },
];

// -------------------------------------------------------------------- telegram

const TG = { telegramBotToken: "123:tok", telegramChatId: "111", telegramAuthorizedChatIds: ["222"] };
const tgOk = ok({ ok: true, result: { message_id: 1 } });

/** Files to send, and the ones the guard must refuse, under the sandbox HOME. */
function telegramFiles(home) {
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  };
  put("work/shot.png", "PNGDATA");
  put("work/clip.mp4", "MP4DATA");
  put("work/report.pdf", "PDFDATA");
  put("work/project/.env", "SECRET=1");
  put("work/project/.env.local", "SECRET=2");
  put("work/project/nested/.ssh/key", "KEY");
  put(".ssh/id_rsa", "KEY");
  put(".dorothy/app-settings.json.bak", "{}");
  put(".tars-private/hermes-webhook-secret", "SECRET");
  fs.symlinkSync(path.join(home, ".dorothy"), path.join(home, "work", "innocent"));
  fs.linkSync(path.join(home, ".tars-private", "hermes-webhook-secret"), path.join(home, "work", "notes.txt"));
}

const telegram = [
  { name: "send_telegram, the default chat", tool: "send_telegram", args: { message: "Hello *there*" }, tars: [tgOk] },
  { name: "send_telegram, an authorized chat, long", tool: "send_telegram", args: { message: long, chat_id: "222" }, tars: [tgOk] },
  { name: "send_telegram, a chat id as a number", tool: "send_telegram", args: { message: "Hi", chat_id: 111 }, tars: [tgOk] },
  { name: "send_telegram, a chat that is not authorized", tool: "send_telegram", args: { message: "Hi", chat_id: "999" } },
  { name: "send_telegram, no bot token", tool: "send_telegram", args: { message: "Hi" }, settings: { telegramChatId: "111" } },
  { name: "send_telegram, no chat anywhere", tool: "send_telegram", args: { message: "Hi" }, settings: { telegramBotToken: "123:tok" } },
  { name: "send_telegram, no settings file", tool: "send_telegram", args: { message: "Hi" }, settings: null },
  { name: "send_telegram, settings that are not JSON", tool: "send_telegram", args: { message: "Hi" }, settings: "{ broken" },
  { name: "send_telegram, settings that are null", tool: "send_telegram", args: { message: "Hi" }, settings: "null" },
  { name: "send_telegram, Telegram refuses", tool: "send_telegram", args: { message: "Hi" }, tars: [ok({ ok: false, description: "Bad Request: can't parse entities" })] },
  { name: "send_telegram, Telegram refuses without a word", tool: "send_telegram", args: { message: "Hi" }, tars: [ok({ ok: false })] },
  { name: "send_telegram, not JSON", tool: "send_telegram", args: { message: "Hi" }, tars: [raw(502, "Bad gateway")] },
  { name: "send_telegram, the connection drops", tool: "send_telegram", args: { message: "Hi" }, tars: [drop] },
  { name: "send_telegram, an answer that is null", tool: "send_telegram", args: { message: "Hi" }, tars: [ok(null)] },
  { name: "send_telegram_photo, with a long caption", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png", caption: `Look ${long}` }, tars: [tgOk] },
  { name: "send_telegram_photo, no caption, another chat", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png", chat_id: "222" }, tars: [tgOk] },
  { name: "send_telegram_photo, a relative path", tool: "send_telegram_photo", args: { photo_path: "../home/work/shot.png" }, tars: [tgOk] },
  { name: "send_telegram_photo, outside the home", tool: "send_telegram_photo", args: { photo_path: "/etc/hosts" } },
  { name: "send_telegram_photo, in .ssh", tool: "send_telegram_photo", args: { photo_path: "<home>/.ssh/id_rsa" } },
  { name: "send_telegram_photo, in .dorothy", tool: "send_telegram_photo", args: { photo_path: "<home>/.dorothy/app-settings.json.bak" } },
  { name: "send_telegram_photo, a .ssh deep in a project", tool: "send_telegram_photo", args: { photo_path: "<home>/work/project/nested/.ssh/key" } },
  { name: "send_telegram_photo, through a symlink to .dorothy", tool: "send_telegram_photo", args: { photo_path: "<home>/work/innocent/app-settings.json.bak" } },
  { name: "send_telegram_photo, not there", tool: "send_telegram_photo", args: { photo_path: "<home>/work/missing.png" } },
  { name: "send_telegram_photo, an unauthorized chat", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png", chat_id: "999" } },
  { name: "send_telegram_photo, Telegram refuses", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png" }, tars: [ok({ ok: false, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" })] },
  { name: "send_telegram_photo, not JSON", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png" }, tars: [raw(502, "Bad gateway")] },
  { name: "send_telegram_photo, an answer that is null", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png" }, tars: [ok(null)] },
  { name: "send_telegram_photo, the connection drops", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png" }, tars: [drop] },
  { name: "send_telegram_video", tool: "send_telegram_video", args: { video_path: "<home>/work/clip.mp4", caption: "Demo" }, tars: [tgOk] },
  { name: "send_telegram_video, a .env", tool: "send_telegram_video", args: { video_path: "<home>/work/project/.env" } },
  { name: "send_telegram_video, no bot token", tool: "send_telegram_video", args: { video_path: "<home>/work/clip.mp4" }, settings: { telegramChatId: "111" } },
  { name: "send_telegram_document", tool: "send_telegram_document", args: { document_path: "<home>/work/report.pdf" }, tars: [tgOk] },
  { name: "send_telegram_document, a .env.local", tool: "send_telegram_document", args: { document_path: "<home>/work/project/.env.local" } },
  { name: "send_telegram_document, a hard link into .tars-private", tool: "send_telegram_document", args: { document_path: "<home>/work/notes.txt" } },
  { name: "send_telegram_document, no chat anywhere", tool: "send_telegram_document", args: { document_path: "<home>/work/report.pdf" }, settings: { telegramBotToken: "123:tok" } },
  { name: "send_telegram_photo, Telegram never answers", tool: "send_telegram_photo", args: { photo_path: "<home>/work/shot.png" }, tars: [hold] },
];

// --------------------------------------------------------------------- servers

/**
 * The seven, in the order Tars registers them. `env` is what the agent's
 * process holds besides HOME, PATH and CLAUDE_MGR_API_URL, which the contract
 * sets for every variant.
 */
export const SERVERS = [
  {
    id: "orchestrator", dir: "mcp-orchestrator",
    variants: [
      { name: "an agent's own token and identity", env: AGENT_ENV, scenarios: orchestratorAgent },
      { name: "the shared token file, no identity", env: {}, setup: sharedTokenFile, scenarios: orchestratorShared },
      { name: "a project and no agent id", env: { CLAUDE_PROJECT_PATH: "/projects/alpha" }, scenarios: orchestratorProjectOnly },
      { name: "no token at all", env: {}, scenarios: orchestratorNoToken },
    ],
  },
  {
    id: "memory", dir: "mcp-memory",
    variants: [
      { name: "an agent's own token and identity", env: AGENT_ENV, scenarios: memoryAgent },
      { name: "no project in the environment", env: { CLAUDE_MGR_API_TOKEN: "agent-token-lead" }, scenarios: memoryNoProject },
    ],
  },
  {
    id: "telegram", dir: "mcp-telegram",
    variants: [
      { name: "an agent, Telegram configured", env: AGENT_ENV, settings: TG, setup: telegramFiles, scenarios: telegram },
      // A variant of its own: each call Telegram leaves unanswered is the last of its variant.
      {
        name: "an agent, Telegram configured, and Telegram never answers a message", env: AGENT_ENV, settings: TG, setup: telegramFiles,
        scenarios: [{ name: "send_telegram, Telegram never answers", tool: "send_telegram", args: { message: "Hi" }, tars: [hold] }],
      },
    ],
  },
  {
    id: "kanban", dir: "mcp-kanban",
    variants: [
      { name: "an agent's own token", env: AGENT_ENV, scenarios: kanbanAgent },
      { name: "no agent token, the shared file present", env: {}, setup: sharedTokenFile, scenarios: kanbanNoToken },
    ],
  },
  {
    id: "vault", dir: "mcp-vault",
    variants: [
      { name: "an agent's own token and name", env: AGENT_ENV, scenarios: vaultAgent },
      { name: "an agent id and no name", env: { CLAUDE_MGR_API_TOKEN: "agent-token-lead", CLAUDE_AGENT_ID: "agent-lead" }, scenarios: vaultNoName },
      { name: "no identity, the shared token file", env: {}, setup: sharedTokenFile, scenarios: vaultNoIdentity },
      { name: "no token at all", env: {}, scenarios: vaultNoToken },
    ],
  },
  {
    id: "socialdata", dir: "mcp-socialdata",
    variants: [{ name: "an agent, a SocialData key", env: AGENT_ENV, settings: SOCIAL, scenarios: socialdata }],
  },
  {
    id: "x", dir: "mcp-x",
    variants: [{ name: "an agent, X credentials, posting on", env: AGENT_ENV, settings: X, scenarios: x }],
  },
];
