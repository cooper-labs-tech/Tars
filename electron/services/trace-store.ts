import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';
import type { MaskNumber, MaskType } from './trace-scrub';
import {
  hashOf, historyKeys, historyRewrite, instructionText, isStreamed, newToolResultIds, opensTurn, parseRequest, parseResponse, type Surface,
} from './trace-wire';
import type { SessionEnvironment } from './session-environment';
import { sessionTiming, type RequestTiming } from './server-timing';
import { mergeToolCall, toolCallAt, toolCallRecordOf, toolCallSpan, type ToolCallPart, type ToolCallRecord } from './tool-calls';
import type { GivenContext } from './endpoint-harness';
import type { HarnessCompaction } from './harness-compactions';

/**
 * The trace store (native traces): one SQLite file, `~/.tars/traces/traces.db`.
 *
 * - A **trace** is one terminal session of one agent on an inference endpoint: its id is minted with the proxy
 *   token when the terminal is spawned, and it is the `X-Session-Id` an external trace reader keys on.
 * - A **turn** opens on a request whose last history entry is a new user instruction (trace-wire.ts opensTurn), and
 *   holds every request after it until the next one. A **side** request, one sent with no tools or under a system
 *   prompt other than the session's (opencode's title call, Qwen Code's memory call, measured 19/11), is attached to
 *   the turn and opens none.
 * - Messages, system prompts and tool sets are **blobs**, stored once by content hash and compressed (zstd where
 *   Node has it, else brotli), so a history resent on every request costs its new messages only.
 * - **Authorship**: what Tars typed into the agent's terminal, and from whom, is noted here as it is typed
 *   (noteTypedInput). A turn takes the author whose words its instruction holds; a closed model's words set `mixed`;
 *   a turn nobody can be found for is `unknown` and counted in `unknown_turns`, which an external trace
 *   reader may filter out. Unknown never sets `mixed`.
 * - **Cap and retention**: sweep() deletes the oldest ended sessions until the store is under its cap, and any
 *   ended session past its days; an open session is never deleted by retention. Past the cap with only open
 *   sessions left, bodies are no longer written (setBodiesDropped) and the requests' metadata still is.
 * - **Tombstones**: every session deleted (the user's delete, retention, the cap) leaves its id, why it went and when,
 *   in the same transaction, and nothing else of it, so every copy can follow: a reader of the loopback read API
 *   (deletions(), GET /api/traces/deletions) and the back-office, which the uploader owes a per-session delete for a
 *   session it sent and the user or retention deleted (`owed`; the cap frees this disk and says nothing of the data).
 *   "Sent" is from the session's first upload call on (markSending): a delete while its batches land is owed too.
 *   A tombstone is kept TOMBSTONE_DAYS, then pruned by the sweep; one still owed stays until it is sent, or until what
 *   was sent is forgotten (resetUploads: a new install, or a whole deletion that went through, covers it).
 *
 * - **Workspace** (turn-workspace.ts): per turn, the agent's checkout at its start and end (HEAD, a tree hash), its
 *   files and lines, and the share of its added lines that survive; the file versions kept to count that stay here,
 *   local only, counted against the cap and deleted with the session.
 *
 * Every write here comes after the response has reached the harness: ingest() never throws to its caller.
 */

export interface TraceMeta {
  traceId: string;
  projectPath: string;
  agentId: string;
  agentName?: string;
  harness: string;
  harnessVersion?: string;
  endpointId: string;
  endpointName?: string;
  endpointBaseUrl?: string;
  model: string;
  startedAt: number;
  /**
   * The owner's switch "May be used to train models" as it stood when the session opened (trace feature A5). Turned
   * off while the session runs, the session is false for good (denyTraining). None given reads false.
   */
  training?: boolean;
}

/** One request and its response as the proxy saw them on the wire. */
export interface WireRecord {
  traceId: string;
  agentId: string;
  surface: Surface;
  startedAt: number;
  firstByteAt?: number;
  /**
   * For a stream: when the chunk came that held the first event with text, reasoning or a tool call (the model's
   * first token; endpoint-proxy.ts). The ttft is this, or, for a response that is not streamed, the first byte.
   */
  firstContentAt?: number;
  endedAt: number;
  status: number;
  contentType?: string;
  requestBody: Buffer;
  responseBody: Buffer;
  upstreamRequestId?: string;
  /** Tries at the endpoint, the held ones included (§ 3, pause not fail), and the time held. */
  attempts: number;
  heldMs: number;
  error?: string;
  /** The traced sessions live on this computer when the request was sent (traces-runtime.ts), this one included. */
  liveSessions?: number;
  /** The harness's own id for its session, when it sends one (codex's session-id header). */
  nativeSessionId?: string;
  /** The round trip, the clocks' offset, the endpoint's queue and upstream times, from its Server-Timing. */
  timing?: RequestTiming;
  /** Cut before the endpoint answered: a request the harness gave up while the proxy held it (status 499). */
  cancel?: RequestCancel;
}

/** Something that happened to the computer during a session (Electron's powerMonitor, traces-runtime.ts). */
export interface TraceEvent {
  at: number;
  kind: 'sleep' | 'wake' | 'battery' | 'ac';
}

/**
 * Who cut a request, why and when, and what of the model's response reached the harness before (nothing, for one given
 * up while held). The causes, a closed list per party (trace feature B3, 27/11; A3's `abandoned_while_held` kept):
 * - harness: `esc` or `ctrl_c` (a key Tars saw from the window during the request), `cli_interrupt` (the CLI's own log
 *   said its turn was interrupted, codex's turn_aborted or pi's), `abandoned_while_held`, `unknown` (no key Tars saw:
 *   its own timeout, a crash);
 * - tars: `stop`, `restart`, `sleep`, `remove`, `quit`, `replace` (Tars ended the agent's terminal);
 * - proxy: `hold_ceiling` (the hold reached its ceiling and the endpoint's answer passed);
 * - endpoint: `stream_cut` (it closed or reset the stream before its end).
 */
export const CANCEL_CAUSES = {
  harness: ['esc', 'ctrl_c', 'cli_interrupt', 'abandoned_while_held', 'unknown'],
  tars: ['stop', 'restart', 'sleep', 'remove', 'quit', 'replace'],
  proxy: ['hold_ceiling'],
  endpoint: ['stream_cut'],
} as const;
export type CancelBy = keyof typeof CANCEL_CAUSES;
export interface RequestCancel { by: CancelBy; cause: string; at: number; deliveredBytes: number }

/**
 * Given up while held: a request that never reached the endpoint. A3's cause, or a cut by the harness or Tars (an Esc,
 * a Ctrl-C, a stop...) of a request the proxy held and never answered (status 499, after a hold). One rule, read by
 * every count that leaves such a request out (the request counts, the model time, the first request, the export) and
 * by `abandonedWhileHeld`, so none counts it both ways (the Audit's M1 on #680 at 9c3784838).
 */
export function givenUpWhileHeld(r: { cancel?: RequestCancel | null; status?: number | null; attempts?: number | null; heldMs?: number | null }): boolean {
  if (!r.cancel) return false;
  if (r.cancel.cause === 'abandoned_while_held') return true;
  return (r.cancel.by === 'harness' || r.cancel.by === 'tars') && r.status === 499 && ((r.attempts ?? 1) > 1 || (r.heldMs ?? 0) > 0);
}

/** The same rule over a `requests` row, in SQL: 1 when given up while held, else 0. */
const GIVEN_UP_WHILE_HELD_SQL = `COALESCE(cancel_json IS NOT NULL AND (json_extract(cancel_json, '$.cause') IS 'abandoned_while_held'
  OR (json_extract(cancel_json, '$.by') IN ('harness', 'tars') AND status = 499 AND (attempts > 1 OR held_ms > 0))), 0)`;

/**
 * How a turn was interrupted, a closed list (the back office checks it as an enum): a lone key from the window (`esc`,
 * `ctrl_c`), the CLI's own log (`cli`), or Tars ending the terminal while the turn was open (`stop`, `remove`, `quit`,
 * `sleep`).
 */
export const INTERRUPTED_BY = ['esc', 'ctrl_c', 'cli', 'stop', 'remove', 'quit', 'sleep'] as const;
export type InterruptedBy = typeof INTERRUPTED_BY[number];
/** How a turn's agent restarted: asked or for its settings (`restart`), or its terminal replaced (`replace`). */
export const RESTARTED_BY = ['restart', 'replace'] as const;
export type RestartedBy = typeof RESTARTED_BY[number];
/** What the agent was doing when interrupted: answering (a request in flight) or running its tools (the turn open). */
export const INTERVENTION_DURING = ['answer', 'tools'] as const;
export type InterventionDuring = typeof INTERVENTION_DURING[number];
/** Who wrote a turn, by kind (authorFor): the owner, an orchestrator, an agent, a channel, Tars, or nobody known. */
export const TURN_AUTHORS = ['user', 'orchestrator', 'agent', 'relay', 'tars', 'unknown'] as const;
export type TurnAuthor = typeof TURN_AUTHORS[number];

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * What a person, an orchestrator or Tars did to a session's work, as it happened (trace feature B3): an interruption
 * or a restart, each `by` of its closed list. Kept with the session; each lands on the turn it came in when read
 * (TurnInterventions), and one a store holds outside the lists (an older or edited build's) is dropped there.
 */
export type InterventionEvent =
  | { kind: 'interrupted'; at: number; by: InterruptedBy; during: InterventionDuring }
  | { kind: 'restarted'; at: number; by: RestartedBy };

/**
 * A turn's interventions, as read (trace feature B3): its first interruption and restart; `next`, the instruction that
 * opened the turn after it, by its author's kind (one outside TURN_AUTHORS reads `unknown`) and its delay in seconds
 * from this turn's end, a fraction, whatever the delay; `corrected`, that instruction from the owner or an orchestrator
 * within CORRECTION_WINDOW_MS of a turn that ended done; `redelegated`, a later session that took this session's task
 * (start.redelegatedFrom, A3), on the last turn.
 */
export interface TurnInterventions {
  interrupted?: { at: number; by: InterruptedBy; during: InterventionDuring };
  restarted?: { at: number; by: RestartedBy };
  next?: { by: TurnAuthor; delaySec: number };
  corrected?: true;
  redelegated?: { to: string; at: number };
}

/** A correction: the next instruction within 10 minutes of a turn that ended done (the reader's N). */
export const CORRECTION_WINDOW_MS = 10 * 60_000;
/** Who may correct a turn: the owner and an orchestrator. */
const CORRECTORS: ReadonlySet<string> = new Set(['user', 'orchestrator']);

/**
 * What started a session, read at its spawn (core/session-start.ts), and what it started from. Every field but the
 * trigger is absent when it is not known, never guessed: `queuedAt` and `handedAt` come from the agent's queue for a
 * task that came with a ref, `taskId` once the ledger names that task, `commit` and `branch` from git in the agent's
 * folder, and `firstRequestAt` is the session's first request at the endpoint.
 */
export interface TraceStart {
  /** owner | task | channel | restart | start | wake | redelegation | unknown (core/session-start.ts SessionTrigger). */
  trigger: string;
  /** How, by its kind, never a name: one of core/session-start.ts StartVia. */
  via?: string;
  taskRef?: string;
  taskId?: string;
  requesterAgentId?: string;
  queuedAt?: number;
  handedAt?: number;
  firstRequestAt?: number;
  commit?: string;
  branch?: string;
  /** The session that had this task's ref before. */
  redelegatedFrom?: string;
}

/** The lost demand as a session keeps it: its last drops, and how many older ones it left out. */
interface StoredDemand { items: LostDemand[]; omitted: number }

/** A task that left the agent's queue never to start, while this session ran: demand the endpoint never saw. */
export interface LostDemand {
  kind: 'queue_drop';
  ref: string;
  queuedAt: number;
  at: number;
  /** cancelled | taken_back | dropped_with_stop | queue_cleared | agent_removed | not_handed_again */
  reason: string;
}

/**
 * One task the session ran, from the task ledger, with its queue times: queued (when it reached Tars for this agent,
 * equal to handedAt when it did not wait in the line), handed over, started (its first turn), its first request at
 * the endpoint after it was handed, and its end. `alsoIn`: the other sessions the same task ran in.
 */
export interface TraceTask {
  id: string;
  ref?: string;
  source?: string;
  parentTaskId?: string;
  requesterAgentId?: string;
  status: string;
  /** Kept from the type's first draft; not written. */
  from?: string;
  queuedAt?: number;
  handedAt?: number;
  startedAt?: number;
  firstRequestAt?: number;
  endedAt?: number;
  alsoIn?: string[];
}

export interface TypedInput {
  agentId: string;
  at: number;
  /** Who typed it, by kind: one of TURN_AUTHORS but `unknown`, which is no typist. */
  author: Exclude<TurnAuthor, 'unknown'>;
  authorDetail?: string;
  text: string;
  /** The words come from a closed model (a Claude agent, say): the session becomes `mixed`. */
  closed: boolean;
  /** The ref of the task these words hand over (core/task-requests.ts): the turn they open served it. */
  taskRef?: string;
}

export interface TraceFilter {
  /** One session exactly. */
  traceId?: string;
  project?: string;
  agentId?: string;
  harness?: string;
  model?: string;
  endpointId?: string;
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}

export interface TraceTotals { count: number; bytes: number; tokensIn: number; tokensCached: number; tokensOut: number }

/** Why a session went: the user deleted it, it passed its days (retention), or the store passed its cap. */
export type TraceDeletionReason = 'user' | 'retention' | 'cap';
/** A tombstone as a reader gets it: the back-office's deletions feed's fields (backoffice/API.md § 6.4), one install. */
export interface TraceDeletion { sessionId: string; reason: TraceDeletionReason; at: number }

/**
 * What Tars knows of how a session ended, kept with it at its end. Every field is optional: what is not known is
 * absent, never guessed. Filled: branch and head (git, in the agent's folder), heldRequests, requestErrors and
 * abandonedWhileHeld (the proxy), task and tasks (the task ledger: the session's own task, and every task it ran),
 * and pr, after the end, once the pull request of its branch is merged or closed (github-watch.ts). tests and gates
 * are filled where Tars knows them (a gate's verdict), later.
 */
export interface TraceOutcome {
  task?: TraceTask;
  /** The last OUTCOME_TASKS_MAX tasks, fewer when more would pass OUTCOME_BYTES_MAX (boundOutcomeTasks). */
  tasks?: TraceTask[];
  /** How many of the session's tasks `tasks` leaves out, the oldest: their turns still carry their ref. */
  tasksOmitted?: number;
  branch?: string;
  head?: string;
  tests?: { command?: string; passed?: number; failed?: number; at?: number };
  /**
   * The gates' verdicts on the pull request heads this session's turns made (gate-verdicts.ts): its kind (qa, audit,
   * ci), merge or no_merge, when, the pull request and head judged, the session's turns it covers (inclusive ranges of
   * turn indexes), who recorded it, and the test counts when given. The newest within GATES_BUDGET_BYTES; the others
   * counted in gatesOmitted.
   */
  gates?: Array<{
    kind: string; verdict: string; at?: number; pr?: number; head?: string; turns?: Array<[number, number]>; by?: string; byName?: string; byRole?: string;
    testCommand?: string; passed?: number; failed?: number; skipped?: number; report?: string;
  }>;
  gatesOmitted?: number;
  heldRequests?: number;
  requestErrors?: number;
  /** Requests the harness gave up while the proxy held them (each a row with its `cancel`). */
  abandonedWhileHeld?: number;
  pr?: { number: number; state: 'merged' | 'closed'; at: number };
}

/**
 * The lost demand a session keeps: its last LOST_DEMAND_MAX drops, the rest counted in `lostDemandOmitted`, within
 * LOST_DEMAND_BYTES_MAX as JSON (a drop weighs about 105 bytes, so 50 take about 5.3 KB). A busy agent's queue can drop
 * hundreds in one session; unbounded, its batch would pass what the back office takes, and hold every later upload.
 */
export const LOST_DEMAND_MAX = 50;
export const LOST_DEMAND_BYTES_MAX = 8 * 1024 - 256;

/** The most tasks an outcome lists: the last ones, the rest counted in `tasksOmitted` (the back office's need, #675). */
export const OUTCOME_TASKS_MAX = 50;
/**
 * What an outcome may weigh as JSON: the back office refuses one over 16 KiB, and its whole batch with it. 512 bytes
 * under, for what the scrub may write in a string. Fifty tasks with every field filled and links to other sessions
 * weigh more (about 21 KB), so the list may hold fewer than fifty.
 */
export const OUTCOME_BYTES_MAX = 16 * 1024 - 512;

/**
 * The outcome with its task list bounded: the last OUTCOME_TASKS_MAX tasks, then the oldest of those out until the
 * outcome weighs OUTCOME_BYTES_MAX at most, each left out counted in `tasksOmitted` (with what an earlier bound
 * counted). The session's own `task` stays whatever the list keeps. No list and no count when there is nothing to say.
 */
export function boundOutcomeTasks(outcome: TraceOutcome): TraceOutcome {
  const all = outcome.tasks ?? [];
  const before = outcome.tasksOmitted ?? 0;
  const shaped = (kept: TraceTask[]): TraceOutcome => {
    const omitted = before + all.length - kept.length;
    const out: TraceOutcome = { ...outcome };
    delete out.tasks;
    delete out.tasksOmitted;
    if (kept.length) out.tasks = kept;
    if (omitted) out.tasksOmitted = omitted;
    return out;
  };
  let kept = all.slice(-OUTCOME_TASKS_MAX);
  while (kept.length && Buffer.byteLength(JSON.stringify(shaped(kept))) > OUTCOME_BYTES_MAX) kept = kept.slice(1);
  return shaped(kept);
}

export interface TraceSessionSummary {
  traceId: string; projectPath: string; agentId: string; agentName?: string;
  harness: string; harnessVersion?: string; endpointId: string; endpointName?: string; model: string;
  startedAt: number; endedAt?: number; finalStatus: 'done' | 'failed' | 'abandoned' | 'open';
  turnCount: number; requestCount: number; tokensIn: number; tokensCached: number; tokensOut: number;
  bytes: number; mixed: boolean; unknownTurns: number;
  /** The harness's own session id, the machine and the system at the start, and the power events (session-environment.ts). */
  nativeSessionId?: string; environment?: SessionEnvironment; events?: TraceEvent[];
  /** From its requests' Server-Timing (server-timing.ts sessionTiming), in a session read whole (session()). */
  rttMedianMs?: number; clockOffsetMs?: number;
  /** What the harness was given at launch, and its compactions (trace feature C2). */
  contextWindowGiven?: number; outputCapGiven?: number; autoCompaction?: 'on' | 'off'; compactions?: TraceCompaction[];
  /** The compactions left out past the newest MAX_COMPACTIONS. */
  compactionsOmitted?: number;
  /** Whether the session may be used to train models: false once the switch was off at any moment while it ran. */
  consent: { training: boolean };
}

/**
 * A compaction of the session's history (trace feature C2): from the harness's own log (`harness`), or from the wire
 * when the log has none (`wire`: a history rewritten that no log names). `requestId`: the request after it.
 */
export interface TraceCompaction {
  at: number;
  kind: 'compact' | 'summarize' | 'truncate';
  before?: number;
  after?: number;
  requestId?: string;
  source: 'harness' | 'wire';
}

/** How a request's history was rewritten since the request before it: a compaction, a truncation, or a new task. */
export interface ContextReset {
  kind: 'compact' | 'summarize' | 'truncate' | 'new';
  /** The earlier request's prompt less this one's, as the endpoint counted them. */
  droppedTokens?: number;
}

export interface TraceRequestView {
  requestId: string; upstreamRequestId?: string; seq: number; surface: string; side: boolean;
  startedAt: number; ttftMs?: number; totalMs?: number; status: number; finishReason?: string; error?: string;
  tokensIn?: number; tokensCached?: number; tokensOut?: number; reqBytes: number; respBytes: number;
  newMessages: number; attempts: number; heldMs: number; bodiesDropped: boolean;
  liveSessions?: number; rttMs?: number; clockOffsetMs?: number; queueMs?: number; upstreamMs?: number; cancel?: RequestCancel;
  contextReset?: ContextReset;
  /** How the time since the previous reply divides (trace feature C1); none for a session's first request. */
  gap?: RequestGap;
  /** The tool calls whose results this request carries, as the harness's log says them (trace feature C1). */
  toolCalls?: ToolCallRecord[];
}

/**
 * The gap before a main request that reached the endpoint (trace feature C1), from the previous such request's end to
 * when this one left for the endpoint, in ms: its tools' run (the union of its calls, cut to the gap), the wait for the
 * typed words that opened its turn and their author (#680's), the proxy's hold, and the rest, the harness's own work.
 * A part the log or the typing record does not say is null, never 0, and the rest is then null too. The rest is the gap
 * less the other three: they add up to it exactly when all are known; parts over it by more than GAP_TOLERANCE_MS
 * leave the rest null (they disagree with the gap), and within it, 0.
 */
export interface RequestGap {
  ms: number;
  toolMs: number | null;
  inputWaitMs: number | null;
  inputBy?: TurnAuthor;
  heldMs: number;
  harnessMs: number | null;
}

/** How far the measured parts of a gap may go over it (clocks read in ms, lines written a few ms after the event). */
export const GAP_TOLERANCE_MS = 25;

/** Each tool call of a session, its parts merged, as the harness's log says them (trace feature C1). */
const TOOL_CALLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_calls (
  trace_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, part_json TEXT NOT NULL, PRIMARY KEY (trace_id, tool_call_id)
);
`;

/** A call belongs to a session when it happened within it, give or take this. */
const TOOL_CALL_SLACK_MS = 1000;

/** What a tool call's row weighs in the store's size and its session's bytes: its id and its facts, in bytes. */
function toolCallRowBytes(callId: string, partJson: string): number {
  return Buffer.byteLength(callId) + Buffer.byteLength(partJson);
}

/** The time a set of intervals covers, each counted once where they overlap (calls run at once). */
function unionMs(spans: Array<[number, number]>): number {
  let total = 0;
  let reach = -Infinity;
  for (const [a, b] of spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    if (b <= reach) continue;
    total += b - Math.max(a, reach);
    reach = b;
  }
  return total;
}

export interface TraceTurnView {
  turnId: string; index: number; startedAt: number; endedAt?: number; gapBeforeMs?: number;
  author: string; authorDetail?: string; finalStatus?: string; toolCalls: number; toolErrors: number;
  modelMs: number; toolMs: number; requests: TraceRequestView[];
  /** The ref of the task the turn served, when the words that opened it handed one over, or the session started on one. */
  taskRef?: string;
  /** Its interventions (trace feature B3), absent when none. */
  interventions?: TurnInterventions;
  /** What the turn changed in the agent's repository (turn-workspace.ts); absent when nothing was recorded. */
  workspace?: TurnWorkspaceView;
}

/** A turn's repository record: null is unknown (a failed snapshot, lost bytes), never 0. */
export interface TurnWorkspaceView {
  startHead: string | null; startTree: string | null; endHead: string | null; endTree: string | null;
  files: number | null; linesAdded: number | null; linesRemoved: number | null;
  changedLines: number | null; survivedLines: number | null; reverted: boolean | null;
  survivalBasis: 'session_end' | 'merged' | 'deleted' | null; survivalAt: number | null;
}

/** A file's version kept to measure survival: its text, or binary, or neither (its bytes were not kept). Local only. */
export interface StoredVersion { id: string; text?: string; binary?: boolean }
/** A workspace snapshot's place: a turn's start, or the session's end. */
export interface WorkspacePoint { index: number; at: number; kind: 'turn' | 'end'; head: string | null; tree: string | null; ms: number; failed: boolean }

export interface TracePart {
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'image';
  text?: string; toolName?: string; toolCallId?: string; isError?: boolean; size: number;
}
export interface TraceMessageView { hash: string; role: string; parts: TracePart[] }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS uploads (trace_id TEXT PRIMARY KEY, uploaded_seq INTEGER NOT NULL, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT,
  harness TEXT NOT NULL, harness_version TEXT, native_session_id TEXT,
  endpoint_id TEXT NOT NULL, endpoint_name TEXT, endpoint_base_url TEXT, model TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, last_end_at INTEGER,
  turn_count INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  final_status TEXT NOT NULL DEFAULT 'open', outcome_json TEXT,
  mixed INTEGER NOT NULL DEFAULT 0, unknown_turns INTEGER NOT NULL DEFAULT 0,
  main_system_hash TEXT, bytes INTEGER NOT NULL DEFAULT 0, updated_seq INTEGER NOT NULL DEFAULT 0,
  training INTEGER
);
CREATE INDEX IF NOT EXISTS traces_seq ON traces(updated_seq);
CREATE INDEX IF NOT EXISTS traces_started ON traces(started_at);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, gap_before_ms INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0, tool_error_count INTEGER NOT NULL DEFAULT 0,
  tool_ms INTEGER NOT NULL DEFAULT 0, model_ms INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  final_status TEXT, final_finish_reason TEXT, author TEXT NOT NULL, author_detail TEXT,
  UNIQUE(trace_id, turn_index)
);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY, upstream_request_id TEXT, trace_id TEXT NOT NULL, turn_id TEXT, seq INTEGER NOT NULL,
  side INTEGER NOT NULL DEFAULT 0, surface TEXT NOT NULL, model_requested TEXT, model_served TEXT, params_json TEXT,
  system_hash TEXT, tools_hash TEXT, started_at INTEGER NOT NULL, ttft_ms INTEGER, total_ms INTEGER,
  tokens_in INTEGER, tokens_cached INTEGER, tokens_out INTEGER, status INTEGER, error TEXT, finish_reason TEXT,
  streamed INTEGER, req_bytes INTEGER, resp_bytes INTEGER, new_messages INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1, held_ms INTEGER NOT NULL DEFAULT 0, bodies_dropped INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_trace ON requests(trace_id);
CREATE TABLE IF NOT EXISTS request_messages (
  request_id TEXT NOT NULL, position INTEGER NOT NULL, message_hash TEXT NOT NULL, direction TEXT NOT NULL,
  PRIMARY KEY (request_id, position)
);
CREATE INDEX IF NOT EXISTS request_messages_hash ON request_messages(message_hash);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, stored INTEGER NOT NULL, codec TEXT NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS typed_inputs (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, author_detail TEXT,
  text_norm TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, used_by TEXT
);
CREATE INDEX IF NOT EXISTS typed_inputs_agent ON typed_inputs(agent_id, at);
CREATE TABLE IF NOT EXISTS tombstones (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
  owed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mask_numbers (
  trace_id TEXT NOT NULL, type TEXT NOT NULL, key_hash TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (trace_id, type, key_hash)
);
CREATE TABLE IF NOT EXISTS workspace_points (
  trace_id TEXT NOT NULL, idx INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, head TEXT, tree TEXT,
  ms INTEGER, failed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trace_id, idx)
);
CREATE TABLE IF NOT EXISTS workspace_turns (
  trace_id TEXT NOT NULL, started_at INTEGER NOT NULL, start_head TEXT, start_tree TEXT, end_head TEXT, end_tree TEXT,
  files INTEGER, lines_added INTEGER, lines_removed INTEGER, changed_lines INTEGER, survived_lines INTEGER,
  reverted INTEGER, survival_basis TEXT, survival_at INTEGER, PRIMARY KEY (trace_id, started_at)
);
CREATE TABLE IF NOT EXISTS workspace_versions (
  trace_id TEXT NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL, id TEXT, binary INTEGER NOT NULL DEFAULT 0,
  codec TEXT, data BLOB, PRIMARY KEY (trace_id, idx, path)
);
CREATE TABLE IF NOT EXISTS workspace_renames (
  trace_id TEXT NOT NULL, idx INTEGER NOT NULL, from_path TEXT NOT NULL, to_path TEXT NOT NULL, PRIMARY KEY (trace_id, idx, from_path)
);
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, gate TEXT NOT NULL, pr INTEGER NOT NULL, head TEXT NOT NULL,
  verdict TEXT NOT NULL, at INTEGER NOT NULL, by_agent TEXT NOT NULL, by_name TEXT, by_role TEXT, branch TEXT,
  test_command TEXT, passed INTEGER, failed INTEGER, skipped INTEGER, report TEXT, UNIQUE (project_path, gate, pr, head)
);
CREATE TABLE IF NOT EXISTS verdict_links (
  verdict_id INTEGER NOT NULL, trace_id TEXT NOT NULL, turn_started_at INTEGER NOT NULL, PRIMARY KEY (verdict_id, trace_id, turn_started_at)
);
CREATE TABLE IF NOT EXISTS workspace_final (
  trace_id TEXT PRIMARY KEY, state TEXT NOT NULL, checked_at INTEGER NOT NULL, next_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * How long a tombstone is kept: a year, past which a reader that never came back has lost more than deletions. One
 * whose delete is still owed to the back-office is kept until it is sent, whatever its age.
 */
export const TOMBSTONE_DAYS = 365;

/**
 * Columns added after the first schema, put on a store an older Tars wrote as on a new one (SQLite adds a column
 * without touching the rows), each where it is missing: each session's environment and power events (JSON), each
 * request's live count; a session's start and the demand it never received (trace feature A3), and a request's
 * cancel.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type: string]> = [
  ['traces', 'environment_json', 'TEXT'],
  ['traces', 'events_json', 'TEXT'],
  ['requests', 'live_sessions', 'INTEGER'],
  // From the endpoint's Server-Timing (server-timing.ts): null when it sent none, or one that could not be read.
  ['requests', 'rtt_ms', 'REAL'],
  ['requests', 'clock_offset_ms', 'REAL'],
  ['requests', 'queue_ms', 'REAL'],
  ['requests', 'upstream_ms', 'REAL'],
  ['traces', 'start_json', 'TEXT'], ['traces', 'demand_json', 'TEXT'], ['requests', 'cancel_json', 'TEXT'],
  ['typed_inputs', 'task_ref', 'TEXT'], ['turns', 'task_ref', 'TEXT'],
  // Trace feature B3: a session's interventions, and when the words that opened a turn were typed.
  ['traces', 'interventions_json', 'TEXT'], ['turns', 'instructed_at', 'INTEGER'],
  // Trace feature C1: the ids of the tool calls whose results a request newly carries.
  ['requests', 'tool_result_ids', 'TEXT'],
  // What the harness was given and how it compacted (trace feature C2): the session's, then each request's reset.
  ['traces', 'context_window_given', 'INTEGER'],
  ['traces', 'output_cap_given', 'INTEGER'],
  ['traces', 'auto_compaction', 'TEXT'],
  ['traces', 'compactions_json', 'TEXT'],
  ['requests', 'context_reset_json', 'TEXT'],
  // Each main request's history keys (trace-wire.ts historyKeys), which the next request is compared with; and the
  // compactions past the newest MAX_COMPACTIONS, counted.
  ['requests', 'history_keys', 'TEXT'],
  ['traces', 'compactions_omitted', 'INTEGER'],
  // A store made before the training stamp (trace feature A5) gets its column; its sessions then read false.
  ['traces', 'training', 'INTEGER'],
];

/** How long after its end a session's branch is still watched for a merge or a deletion (as the PR watch, 14 days). */
const WORKSPACE_FINAL_DAYS = 14;

/** The file versions one session keeps to measure survival, at most: past it a version keeps its id, not its text. */
const WORKSPACE_KEPT_BYTES = 64 * 1024 * 1024;

const WORKSPACE_COLUMNS: Record<string, string> = {
  startHead: 'start_head', startTree: 'start_tree', endHead: 'end_head', endTree: 'end_tree', files: 'files',
  linesAdded: 'lines_added', linesRemoved: 'lines_removed', changedLines: 'changed_lines', survivedLines: 'survived_lines',
  reverted: 'reverted', survivalBasis: 'survival_basis', survivalAt: 'survival_at',
};

/**
 * A session keeps its newest compactions, this many, and counts the rest (`compactions_omitted`): the back-office takes
 * at most 1,000, and a harness that rewrote its history at every request must not get the whole session refused.
 */
export const MAX_COMPACTIONS = 200;

/**
 * The harnesses whose history the rewrite rule is measured on (trace feature C2): codex 0.163 and 0.170 keep it whole
 * at the head; Qwen Code 0.25.2 does, its reminders aside (trace-wire.ts historyKeys). The others' requests are never
 * marked on the wire's guess: measured, they join this list.
 */
const REWRITE_MEASURED = new Set(['codex', 'qwen-code']);

/** The newest MAX_COMPACTIONS of a list in time order, and how many more were left out. */
function capped(list: TraceCompaction[], omitted: number): { list: TraceCompaction[]; omitted: number } {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  if (sorted.length <= MAX_COMPACTIONS) return { list: sorted, omitted };
  return { list: sorted.slice(sorted.length - MAX_COMPACTIONS), omitted: omitted + sorted.length - MAX_COMPACTIONS };
}

/** Per request, what the cap counts on top of its blobs: the rows themselves. */
const ROW_BYTES = 512;
/** How long a typed input may wait for the request that carries it. */
const TYPED_INPUT_WINDOW_MS = 6 * 3600_000;

const zstd = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer; zstdDecompressSync?: (b: Buffer) => Buffer };
const CODEC = typeof zstd.zstdCompressSync === 'function' ? 'zstd' : 'br';

function compress(raw: Buffer): Buffer {
  return CODEC === 'zstd' ? zstd.zstdCompressSync!(raw) : zlib.brotliCompressSync(raw);
}
function decompress(codec: string, data: Buffer): Buffer {
  if (codec === 'zstd') {
    if (typeof zstd.zstdDecompressSync !== 'function') throw new Error('this Node cannot read zstd blobs');
    return zstd.zstdDecompressSync(data);
  }
  return zlib.brotliDecompressSync(data);
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const id = (prefix: string): string => `${prefix}${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
/**
 * At most this much of a session's outcome, gates included: the back office takes an outcome of 16 KiB at most and
 * refuses the whole batch past it; the rest of the outcome (branch, head, task, tests) is kept room for.
 */
const GATES_BUDGET_BYTES = 12 * 1024;
/** Sorted turn indexes as inclusive ranges: [0, 1, 2, 5] is [[0, 2], [5, 5]]. */
function ranges(indexes: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const i of indexes) {
    const last = out[out.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else if (!last || i > last[1]) out.push([i, i]);
  }
  return out;
}
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Whether a session may be used to train models, beyond its stamp: the runtime's private list (TraceStore options). */
export type Trainable = (traceId: string) => boolean;

function summaryOf(r: Row, trainable: Trainable): TraceSessionSummary {
  return {
    traceId: String(r.trace_id), projectPath: String(r.project_path), agentId: String(r.agent_id), agentName: optStr(r.agent_name),
    harness: String(r.harness), harnessVersion: optStr(r.harness_version), endpointId: String(r.endpoint_id), endpointName: optStr(r.endpoint_name),
    model: String(r.model), startedAt: num(r.started_at), endedAt: optNum(r.ended_at),
    finalStatus: (String(r.final_status) as TraceSessionSummary['finalStatus']),
    turnCount: num(r.turn_count), requestCount: num(r.request_count),
    tokensIn: num(r.tokens_in), tokensCached: num(r.tokens_cached), tokensOut: num(r.tokens_out),
    bytes: num(r.bytes), mixed: r.mixed === 1, unknownTurns: num(r.unknown_turns),
    nativeSessionId: optStr(r.native_session_id), environment: jsonOf<SessionEnvironment>(r.environment_json),
    events: jsonOf<TraceEvent[]>(r.events_json) ?? [],
    contextWindowGiven: optNum(r.context_window_given), outputCapGiven: optNum(r.output_cap_given),
    autoCompaction: r.auto_compaction === 'on' || r.auto_compaction === 'off' ? r.auto_compaction : undefined,
    compactions: jsonOf<TraceCompaction[]>(r.compactions_json) ?? [],
    compactionsOmitted: num(r.compactions_omitted) > 0 ? num(r.compactions_omitted) : undefined,
    // The one rule wherever the field leaves (the reader's list and document, the export, the upload, the preview): a
    // stamp of 1, which an agent can write (the store is under ~/.tars), and the session on the private list of those
    // Tars opened while training was on, which no agent reaches (the Audit's M1 on #690).
    consent: { training: r.training === 1 && trainable(String(r.trace_id)) },
  };
}

/** A JSON column read back; undefined when it is empty or unreadable. */
function jsonOf<T>(v: unknown): T | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try { return JSON.parse(v) as T; } catch { return undefined; }
}

/** A session's lost demand as it reads: its kept drops and how many older ones it left out (none: neither). */
function demandOf(raw: unknown): { lostDemand?: LostDemand[]; lostDemandOmitted?: number } {
  if (typeof raw !== 'string' || !raw) return {};
  const value = JSON.parse(raw) as StoredDemand | LostDemand[];
  const items = Array.isArray(value) ? value : value.items ?? [];
  const omitted = Array.isArray(value) ? 0 : value.omitted ?? 0;
  return { ...(items.length ? { lostDemand: items } : {}), ...(omitted ? { lostDemandOmitted: omitted } : {}) };
}

function encodeCursor(n: number, kind = 's'): string {
  return Buffer.from(`${kind}:${n}`).toString('base64url');
}
function decodeCursor(cursor: string | undefined, kind = 's'): number {
  if (!cursor) return 0;
  const m = new RegExp(`^${kind}:(\\d+)$`).exec(Buffer.from(cursor, 'base64url').toString());
  return m ? Number(m[1]) : 0;
}

/** The parts of one stored message, for the window: text, thinking, tool calls and results, with their sizes. */
export function partsOf(message: unknown): TracePart[] {
  const parts: TracePart[] = [];
  const size = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  const o = (message && typeof message === 'object' ? message : {}) as Row;
  const pushText = (kind: TracePart['kind'], text: unknown) => { if (typeof text === 'string' && text) parts.push({ kind, text, size: size(text) }); };
  if (typeof message === 'string') { pushText('text', message); return parts; }
  // Responses' items.
  if (o.type === 'function_call' || o.type === 'custom_tool_call') {
    parts.push({ kind: 'tool_call', toolName: optStr(o.name), toolCallId: optStr(o.call_id), text: String(o.arguments ?? o.input ?? ''), size: size(o.arguments ?? o.input) });
    return parts;
  }
  if (o.type === 'function_call_output' || o.type === 'custom_tool_call_output') {
    const out = typeof o.output === 'string' ? o.output : JSON.stringify(o.output);
    parts.push({ kind: 'tool_result', toolCallId: optStr(o.call_id), text: out, size: size(out) });
    return parts;
  }
  if (o.type === 'reasoning') {
    for (const s of Array.isArray(o.summary) ? o.summary : []) pushText('thinking', (s as Row).text);
    return parts;
  }
  if (o.role === 'tool') {
    const out = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
    parts.push({ kind: 'tool_result', toolCallId: optStr(o.tool_call_id), text: out, size: size(out) });
    return parts;
  }
  pushText('thinking', o.reasoning_content);
  if (typeof o.content === 'string') pushText('text', o.content);
  for (const raw of Array.isArray(o.content) ? o.content : []) {
    const b = (raw ?? {}) as Row;
    if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') pushText('text', b.text);
    else if (b.type === 'thinking') pushText('thinking', b.thinking);
    else if (b.type === 'tool_use') parts.push({ kind: 'tool_call', toolName: optStr(b.name), toolCallId: optStr(b.id), text: JSON.stringify(b.input ?? {}), size: size(b.input) });
    else if (b.type === 'tool_result') {
      const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      parts.push({ kind: 'tool_result', toolCallId: optStr(b.tool_use_id), isError: b.is_error === true, text: out, size: size(out) });
    } else if (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image') parts.push({ kind: 'image', size: size(b) });
  }
  for (const raw of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
    const c = (raw ?? {}) as Row;
    const fn = (c.function ?? {}) as Row;
    parts.push({ kind: 'tool_call', toolName: optStr(fn.name), toolCallId: optStr(c.id), text: String(fn.arguments ?? ''), size: size(fn.arguments) });
  }
  return parts;
}

const nullNum = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const nullStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function workspaceViewOf(r: Row): TurnWorkspaceView {
  return {
    startHead: nullStr(r.start_head), startTree: nullStr(r.start_tree), endHead: nullStr(r.end_head), endTree: nullStr(r.end_tree),
    files: nullNum(r.files), linesAdded: nullNum(r.lines_added), linesRemoved: nullNum(r.lines_removed),
    changedLines: nullNum(r.changed_lines), survivedLines: nullNum(r.survived_lines),
    reverted: r.reverted === 1 ? true : r.reverted === 0 ? false : null,
    survivalBasis: (nullStr(r.survival_basis) as TurnWorkspaceView['survivalBasis']), survivalAt: nullNum(r.survival_at),
  };
}

/**
 * Whether a request is a side one (no tools, or a system prompt other than the session's), with the session's main
 * system prompt as it stands after it: the one rule ingest() and opensTurnAt() share.
 */
function sideOf(mainSystemHash: unknown, req: ReturnType<typeof parseRequest>): { side: boolean; systemHash?: string; mainSystem?: string } {
  const systemHash = req && req.system !== undefined ? hashOf(req.system) : undefined;
  const hasTools = !!req?.tools && req.tools.length > 0;
  let mainSystem = optStr(mainSystemHash);
  if (!mainSystem && hasTools) mainSystem = systemHash ?? 'none';
  return { side: !!req && (!hasTools || (systemHash ?? 'none') !== mainSystem), systemHash, mainSystem };
}

function roleOf(message: unknown): string {
  const o = (message && typeof message === 'object' ? message : {}) as Row;
  if (typeof o.role === 'string') return o.role;
  if (typeof o.type === 'string') return o.type.endsWith('_output') ? 'tool' : 'assistant';
  return 'user';
}

export class TraceStore {
  private db: Database.Database;
  private bodiesDropped = false;
  /** What makes a stamped session trainable; none given, no session is (it fails closed). */
  private readonly trainable: Trainable;

  constructor(file: string, opts: { trainable?: Trainable } = {}) {
    this.trainable = opts.trainable ?? (() => false);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: modes do not apply */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.db.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const has = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(TOOL_CALLS_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Past the cap with nothing left to delete: metadata only, until a sweep makes room. */
  setBodiesDropped(dropped: boolean): void {
    this.bodiesDropped = dropped;
  }

  private nextSeq(): number {
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = 'seq'`).get() as { v?: string } | undefined;
    const next = Number(row?.v ?? 0) + 1;
    this.db.prepare(`INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(next));
    return next;
  }

  openTrace(m: TraceMeta): void {
    this.db.prepare(`INSERT OR IGNORE INTO traces (trace_id, project_path, agent_id, agent_name, harness, harness_version,
      endpoint_id, endpoint_name, endpoint_base_url, model, started_at, updated_seq, training)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.traceId, m.projectPath, m.agentId, m.agentName ?? null, m.harness,
      m.harnessVersion ?? null, m.endpointId, m.endpointName ?? null, m.endpointBaseUrl ?? null, m.model, m.startedAt, this.nextSeq(),
      m.training === undefined ? null : m.training ? 1 : 0);
  }

  /**
   * The training switch turned off while these sessions run: each is false for good, and its change sequence moves,
   * so a session already sent goes again with its consent false. A session already false is left as it is.
   */
  denyTraining(traceIds: string[]): void {
    const deny = this.db.prepare('UPDATE traces SET training = 0, updated_seq = ? WHERE trace_id = ? AND (training IS NULL OR training != 0)');
    for (const traceId of traceIds) {
      const seq = this.nextSeq();
      deny.run(seq, traceId);
    }
  }

  /** The harness's exact version, read after the start (harness-version.ts): a change, so it is sent again. */
  setHarnessVersion(traceId: string, version: string): void {
    this.setIfChanged(traceId, 'harness_version', version);
  }

  /** The machine and the system at the session's start (session-environment.ts): a change, so it is sent again. */
  setEnvironment(traceId: string, environment: SessionEnvironment): void {
    this.setIfChanged(traceId, 'environment_json', JSON.stringify(environment));
  }

  /** What the harness was given at launch (trace feature C2): the window, the cap, whether it compacts on its own. */
  setContextGiven(traceId: string, given: GivenContext): void {
    this.db.prepare(`UPDATE traces SET context_window_given = ?, output_cap_given = ?, auto_compaction = ?, updated_seq = ? WHERE trace_id = ?`)
      .run(given.contextWindow, given.outputCap, given.autoCompaction, this.nextSeq(), traceId);
  }

  /**
   * The compactions the harness logged (harness-compactions.ts), merged with what the wire saw: each names the first
   * rewrite marked at or after it (within 2 s before, one machine's clocks; 10 minutes after at most), which takes the
   * harness's kind; one the wire did not see (bodies dropped) is kept on its own; a rewrite no log names stays, its
   * source `wire`. Read twice, counted once. A change, so the session is sent again.
   */
  applyHarnessCompactions(traceId: string, events: HarnessCompaction[]): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT compactions_json, compactions_omitted FROM traces WHERE trace_id = ?').get(traceId) as Row | undefined;
      if (!row) return;
      const list = jsonOf<TraceCompaction[]>(row.compactions_json) ?? [];
      const resets = this.db.prepare(`SELECT request_id, started_at, context_reset_json FROM requests
        WHERE trace_id = ? AND context_reset_json IS NOT NULL ORDER BY started_at`).all(traceId) as Row[];
      let touched = false;
      for (const e of [...events].sort((a, b) => a.at - b.at)) {
        if (list.some(c => c.source === 'harness' && c.at === e.at && c.kind === e.kind)) continue;
        // Older than the newest kept, once some were left out: counted already, at a reading before this one.
        if (num(row.compactions_omitted) > 0 && list.length >= MAX_COMPACTIONS && e.at < list[0].at) continue;
        const claimed = new Set(list.filter(c => c.source === 'harness' && c.requestId).map(c => c.requestId));
        const r = resets.find(x => num(x.started_at) >= e.at - 2000 && num(x.started_at) <= e.at + 600_000
          && !claimed.has(String(x.request_id)) && jsonOf<ContextReset>(x.context_reset_json)?.kind !== 'new');
        const entry: TraceCompaction = {
          at: e.at, kind: e.kind, ...(e.before !== undefined ? { before: e.before } : {}), ...(e.after !== undefined ? { after: e.after } : {}),
          ...(r ? { requestId: String(r.request_id) } : {}), source: 'harness',
        };
        if (r) {
          const wire = list.findIndex(c => c.source === 'wire' && c.requestId === entry.requestId);
          if (wire >= 0) list.splice(wire, 1);
          const reset = jsonOf<ContextReset>(r.context_reset_json)!;
          this.db.prepare('UPDATE requests SET context_reset_json = ? WHERE request_id = ?').run(JSON.stringify({ ...reset, kind: e.kind }), r.request_id);
        }
        list.push(entry);
        touched = true;
      }
      if (!touched) return;
      const kept = capped(list, num(row.compactions_omitted));
      this.db.prepare('UPDATE traces SET compactions_json = ?, compactions_omitted = ?, updated_seq = ? WHERE trace_id = ?')
        .run(JSON.stringify(kept.list), kept.omitted, this.nextSeq(), traceId);
    })();
  }

  /** A session's column set, with a new change sequence, only when its value changes. */
  private setIfChanged(traceId: string, column: 'harness_version' | 'environment_json', value: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT ${column} AS v FROM traces WHERE trace_id = ?`).get(traceId) as Row | undefined;
      if (!row || row.v === value) return;
      this.db.prepare(`UPDATE traces SET ${column} = ?, updated_seq = ? WHERE trace_id = ?`).run(value, this.nextSeq(), traceId);
    })();
  }

  /** A power event, on a session still open: a change, so it is sent again. An ended session takes none. */
  addEvent(traceId: string, event: TraceEvent): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT events_json FROM traces WHERE trace_id = ? AND ended_at IS NULL').get(traceId) as Row | undefined;
      if (!row) return;
      const events = [...(jsonOf<TraceEvent[]>(row.events_json) ?? []), { at: event.at, kind: event.kind }];
      this.db.prepare('UPDATE traces SET events_json = ?, updated_seq = ? WHERE trace_id = ?').run(JSON.stringify(events), this.nextSeq(), traceId);
    })();
  }

  hasTrace(traceId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM traces WHERE trace_id = ?').get(traceId);
  }

  /** The session ended (its terminal exited): its status from its last turn, and what Tars knows of the outcome. */
  endTrace(traceId: string, endedAt: number, outcome?: TraceOutcome): void {
    const last = this.db.prepare('SELECT final_status FROM turns WHERE trace_id = ? ORDER BY turn_index DESC LIMIT 1').get(traceId) as { final_status?: string } | undefined;
    const status = last?.final_status === 'done' ? 'done' : last?.final_status === 'failed' ? 'failed' : last ? 'abandoned' : 'abandoned';
    this.db.transaction(() => {
      this.db.prepare(`UPDATE traces SET ended_at = ?, final_status = ?, outcome_json = COALESCE(?, outcome_json), updated_seq = ? WHERE trace_id = ?`)
        .run(endedAt, status, outcome === undefined ? null : JSON.stringify(outcome), this.nextSeq(), traceId);
      // The end writes a whole outcome: the gates already linked to the session's turns go back into it, budgeted
      // against what the end wrote (the Audit's M1 at a3047a696).
      this.refreshGates(traceId);
    })();
  }

  /**
   * One JSON column of a session, changed by `change`, and its change sequence moved when it changed, so that the
   * reader's cursor and the upload take it up again. False when nothing changed: the same state written again moves
   * nothing.
   */
  private changeJson<T>(traceId: string, column: 'start_json' | 'demand_json' | 'outcome_json' | 'interventions_json', change: (current: T | undefined) => T): boolean {
    const row = this.db.prepare(`SELECT ${column} AS v FROM traces WHERE trace_id = ?`).get(traceId) as { v?: string | null } | undefined;
    if (!row) return false;
    const before = row.v ?? null;
    const next = JSON.stringify(change(before ? JSON.parse(before) as T : undefined));
    if (next === before) return false;
    this.db.prepare(`UPDATE traces SET ${column} = ?, updated_seq = ? WHERE trace_id = ?`).run(next, this.nextSeq(), traceId);
    return true;
  }

  /** What started the session, merged into what it holds: its trigger at the spawn, its commit once git answers, its task once named. */
  setStart(traceId: string, patch: Partial<TraceStart>): boolean {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return this.changeJson<TraceStart>(traceId, 'start_json', current => ({ ...(current ?? { trigger: 'unknown' }), ...defined }));
  }

  /**
   * A task that left the agent's queue never to start, while this session ran: kept with the last LOST_DEMAND_MAX,
   * within LOST_DEMAND_BYTES_MAX, the older ones counted. Kept as `{ items, omitted }`; a list an earlier build of
   * this change wrote is read as its items.
   */
  addLostDemand(traceId: string, demand: LostDemand): boolean {
    return this.changeJson<StoredDemand | LostDemand[]>(traceId, 'demand_json', (current) => {
      const before = Array.isArray(current) ? { items: current, omitted: 0 } : { items: current?.items ?? [], omitted: current?.omitted ?? 0 };
      const all = [...before.items, demand];
      let items = all.slice(-LOST_DEMAND_MAX);
      while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > LOST_DEMAND_BYTES_MAX) items = items.slice(1);
      return { items, omitted: before.omitted + all.length - items.length };
    });
  }

  /** Fields of the outcome, merged into what it holds (a pull request's end, a link to another session). */
  mergeOutcome(traceId: string, patch: Partial<TraceOutcome>): boolean {
    return this.changeJson<TraceOutcome>(traceId, 'outcome_json', current => ({ ...(current ?? {}), ...patch }));
  }

  /** An intervention, kept with its session (trace feature B3): its change sequence moves, so it is sent again. */
  addIntervention(traceId: string, e: InterventionEvent): boolean {
    return this.changeJson<InterventionEvent[]>(traceId, 'interventions_json', current => [...(current ?? []), e]);
  }

  /** The session's change sequence moved: what another session now links to it is read and sent anew. */
  touch(traceId: string): void {
    this.db.prepare('UPDATE traces SET updated_seq = ? WHERE trace_id = ?').run(this.nextSeq(), traceId);
  }

  /** Whether the session's last turn is open: its model called tools, which run. */
  lastTurnOpen(traceId: string): boolean {
    const r = this.db.prepare('SELECT final_status FROM turns WHERE trace_id = ? ORDER BY turn_index DESC LIMIT 1').get(traceId) as { final_status?: string | null } | undefined;
    return r?.final_status === 'open';
  }

  /**
   * The session's latest request the harness hung up on for no cause Tars knew, cut at or after `since`, given the
   * cause its CLI's own log tells (`cli_interrupt`). The moment of its cut, or undefined when there is none.
   */
  reviseUnknownCut(traceId: string, since: number, cause: string): number | undefined {
    const row = this.db.prepare(`SELECT request_id, cancel_json FROM requests WHERE trace_id = ? AND cancel_json IS NOT NULL
      AND json_extract(cancel_json, '$.by') = 'harness' AND json_extract(cancel_json, '$.cause') = 'unknown'
      AND json_extract(cancel_json, '$.at') >= ? ORDER BY json_extract(cancel_json, '$.at') DESC LIMIT 1`).get(traceId, since) as Row | undefined;
    if (!row) return undefined;
    const cancel = { ...(JSON.parse(String(row.cancel_json)) as RequestCancel), cause };
    this.db.prepare('UPDATE requests SET cancel_json = ? WHERE request_id = ?').run(JSON.stringify(cancel), String(row.request_id));
    this.touch(traceId);
    return cancel.at;
  }

  /** The session's first request at the endpoint at or after `from`: one given up while held never reached it. */
  firstRequestAt(traceId: string, from: number = Number.MIN_SAFE_INTEGER): number | undefined {
    const r = this.db.prepare(`SELECT MIN(started_at) AS m FROM requests WHERE trace_id = ? AND started_at >= ?
      AND ${GIVEN_UP_WHILE_HELD_SQL} = 0`).get(traceId, from) as { m: number | null };
    return r.m ?? undefined;
  }

  /** The other sessions that had this task's ref: started on it, or ran it. Oldest first. */
  sessionsWithRef(ref: string, except: string): string[] {
    return (this.db.prepare(`SELECT trace_id FROM traces t WHERE trace_id != ? AND (json_extract(start_json, '$.taskRef') = ?
      OR EXISTS (SELECT 1 FROM json_each(t.outcome_json, '$.tasks') WHERE json_extract(value, '$.ref') = ?)) ORDER BY started_at`)
      .all(except, ref, ref) as Array<{ trace_id: string }>).map(r => r.trace_id);
  }

  /** The other sessions whose outcome lists this task. Oldest first. */
  sessionsWithTask(taskId: string, except: string): string[] {
    return (this.db.prepare(`SELECT trace_id FROM traces t WHERE trace_id != ?
      AND EXISTS (SELECT 1 FROM json_each(t.outcome_json, '$.tasks') WHERE json_extract(value, '$.id') = ?) ORDER BY started_at`)
      .all(except, taskId) as Array<{ trace_id: string }>).map(r => r.trace_id);
  }

  /** The sessions ended since `since` on a branch, whose pull request's end is not known yet. */
  awaitingPullRequest(since: number = Number.MIN_SAFE_INTEGER): Array<{ traceId: string; projectPath: string; branch: string; startedAt: number }> {
    return (this.db.prepare(`SELECT trace_id, project_path, started_at, json_extract(outcome_json, '$.branch') AS branch FROM traces
      WHERE ended_at IS NOT NULL AND ended_at >= ? AND outcome_json IS NOT NULL AND json_type(outcome_json, '$.branch') = 'text'
      AND json_extract(outcome_json, '$.branch') != 'HEAD' AND json_type(outcome_json, '$.pr') IS NULL`).all(since) as Row[])
      .map(r => ({ traceId: String(r.trace_id), projectPath: String(r.project_path), branch: String(r.branch), startedAt: num(r.started_at) }));
  }

  /** The sessions with something not yet uploaded (new, or grown since), oldest change first. */
  /**
   * The sessions with a change not sent, oldest change first, a page at a time: `afterSeq` is the last change of the
   * page before, and `since` leaves out what started at or before a deletion's moment, which never goes again. The
   * rest of what decides a sending (the trace gate) is the uploader's: a page may hold none it can send, so it reads
   * the next one rather than stopping (the Audit's L2 at c447c1ceb).
   */
  uploadQueue(limit: number, page: { afterSeq?: number; since?: number } = {}): Array<{ traceId: string; seq: number; projectPath: string; agentId: string; startedAt: number; harness: string; model: string; endpointId: string }> {
    return (this.db.prepare(`SELECT t.trace_id, t.updated_seq, t.project_path, t.agent_id, t.started_at, t.harness, t.model, t.endpoint_id FROM traces t
      LEFT JOIN uploads u ON u.trace_id = t.trace_id
      WHERE t.updated_seq > COALESCE(u.uploaded_seq, 0) AND t.updated_seq > ? AND t.started_at > ?
      ORDER BY t.updated_seq ASC LIMIT ?`).all(page.afterSeq ?? 0, page.since ?? Number.MIN_SAFE_INTEGER, limit) as Row[])
      .map(r => ({
        traceId: String(r.trace_id), seq: num(r.updated_seq), projectPath: String(r.project_path), agentId: String(r.agent_id), startedAt: num(r.started_at),
        harness: String(r.harness ?? ''), model: String(r.model ?? ''), endpointId: String(r.endpoint_id ?? ''),
      }));
  }

  /**
   * A session uploaded as it was at `seq`; nothing for one that is gone (deleted while its batches were landing: its
   * tombstone already owes the back-office its delete).
   */
  markUploaded(traceId: string, seq: number, at: number): void {
    this.db.prepare(`INSERT INTO uploads (trace_id, uploaded_seq, uploaded_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM traces WHERE trace_id = ?)
      ON CONFLICT(trace_id) DO UPDATE SET uploaded_seq = MAX(uploaded_seq, excluded.uploaded_seq), uploaded_at = excluded.uploaded_at`).run(traceId, seq, at, traceId);
  }

  /**
   * Before a session's first upload call: the back-office may hold it from now on, whole or in part, so a delete at
   * any moment owes it one (the Audit's M1 at 98e921347). An upload row at sequence 0: the queue still sends the
   * session, and the sent count leaves it out. Nothing for a session that is gone, or one already marked.
   */
  markSending(traceId: string, at: number): void {
    this.db.prepare(`INSERT INTO uploads (trace_id, uploaded_seq, uploaded_at) SELECT ?, 0, ? WHERE EXISTS (SELECT 1 FROM traces WHERE trace_id = ?)
      ON CONFLICT(trace_id) DO NOTHING`).run(traceId, at, traceId);
  }

  /** The install the deletes were owed to is gone (forgotten by the back-office, or its file removed): none can go. */
  forgetOwedDeletes(): void {
    this.db.prepare('UPDATE tombstones SET owed = 0 WHERE owed = 1').run();
  }

  /** A session's change sequence: what an upload of it now is keyed on. */
  seqOf(traceId: string): number | undefined {
    const r = this.db.prepare('SELECT updated_seq FROM traces WHERE trace_id = ?').get(traceId) as { updated_seq?: number } | undefined;
    return r?.updated_seq;
  }

  /**
   * The numbers a session's upload gave its masked values (trace-scrub.ts MaskSession), each value by a hash, never
   * as written: loaded at each build of it, so they hold as the session grows (the Audit's M2 at 38ccde8cb).
   */
  maskNumbers(traceId: string): MaskNumber[] {
    return (this.db.prepare('SELECT type, key_hash, n FROM mask_numbers WHERE trace_id = ?').all(traceId) as Array<{ type: MaskType; key_hash: string; n: number }>)
      .map(r => ({ type: r.type, keyHash: r.key_hash, n: r.n }));
  }

  /** Keeps the numbers a build gave; those already kept stay as they are. */
  keepMaskNumbers(traceId: string, rows: MaskNumber[]): void {
    if (!rows.length || !this.hasTrace(traceId)) return;
    const put = this.db.prepare('INSERT OR IGNORE INTO mask_numbers (trace_id, type, key_hash, n) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => { for (const r of rows) put.run(traceId, r.type, r.keyHash, r.n); })();
  }

  /** The project folder a session was recorded in, if there is such a session. */
  projectOf(traceId: string): string | undefined {
    const r = this.db.prepare('SELECT project_path FROM traces WHERE trace_id = ?').get(traceId) as { project_path?: string } | undefined;
    return r?.project_path;
  }

  /** The start of the newest session in the store, if any. */
  newestStartedAt(): number | undefined {
    const r = this.db.prepare('SELECT MAX(started_at) AS m FROM traces').get() as { m: number | null };
    return r.m ?? undefined;
  }

  /**
   * Forget every upload (the back-office deleted them, or a new install registered), and with them the per-session
   * deletes owed to the install they went to: a whole deletion covered them, or that install's token is gone.
   */
  resetUploads(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM uploads').run();
      this.db.prepare('UPDATE tombstones SET owed = 0 WHERE owed = 1').run();
    })();
  }

  /**
   * The tombstones after a cursor, oldest first, a page at a time: the back-office's deletions feed's shape and cursor
   * rules (backoffice/API.md § 6.4), `nextCursor` even on an empty page, `more` when the page was cut at its limit
   * (1 to 500, 100 by default). No `install`: the loopback is one install.
   */
  deletions(q: { cursor?: string; limit?: number } = {}): { deletions: TraceDeletion[]; nextCursor: string; more: boolean } {
    const after = decodeCursor(q.cursor, 'd');
    const asked = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : 100;
    const limit = Math.min(500, Math.max(1, asked));
    const rows = this.db.prepare('SELECT seq, trace_id, reason, at FROM tombstones WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(after, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    const last = page.length ? num(page[page.length - 1].seq) : after;
    return {
      deletions: page.map(r => ({ sessionId: String(r.trace_id), reason: String(r.reason) as TraceDeletionReason, at: num(r.at) })),
      nextCursor: encodeCursor(last, 'd'),
      more: rows.length > limit,
    };
  }

  /** The per-session deletes owed to the back-office, oldest first. */
  owedDeletes(limit: number): Array<{ seq: number; traceId: string }> {
    return (this.db.prepare('SELECT seq, trace_id FROM tombstones WHERE owed = 1 ORDER BY seq ASC LIMIT ?').all(limit) as Row[])
      .map(r => ({ seq: num(r.seq), traceId: String(r.trace_id) }));
  }

  /** The back-office took this delete: owed no more, and still in the reader's feed. */
  deleteSent(seq: number): void {
    this.db.prepare('UPDATE tombstones SET owed = 0 WHERE seq = ?').run(seq);
  }

  /**
   * `sent`: the sessions marked sent, only those started after `since` when a deletion set it, since the back-office
   * deleted the ones before it (their marks may outlive a deletion on a full disk). `pending`: every session with a
   * change not sent, opted in or not; the uploader counts what it would really send (TraceUploader.state).
   */
  uploadCounts(since?: number): { sent: number; pending: number; lastAt?: number } {
    // A session marked before its first upload call (markSending, sequence 0) is not sent yet.
    const sent = this.db.prepare('SELECT COUNT(*) AS n, MAX(uploaded_at) AS at FROM uploads u JOIN traces t ON t.trace_id = u.trace_id WHERE t.started_at > ? AND u.uploaded_seq > 0')
      .get(since ?? Number.MIN_SAFE_INTEGER) as { n: number; at: number | null };
    const pending = this.db.prepare('SELECT COUNT(*) AS n FROM traces t LEFT JOIN uploads u ON u.trace_id = t.trace_id WHERE t.updated_seq > COALESCE(u.uploaded_seq, 0)').get() as { n: number };
    return { sent: sent.n, pending: pending.n, lastAt: sent.at ?? undefined };
  }

  /**
   * How many of a session's requests were held while the endpoint paused, how many ended in an error, and how many
   * the harness gave up while held, which are no error of the endpoint's.
   */
  requestCounts(traceId: string): { held: number; errors: number; abandoned: number } {
    // A cut by the harness or by Tars is no error of the endpoint's; one by the proxy (its hold's ceiling) or the
    // endpoint (a stream cut) is (trace feature B3). Abandoned while held: A3's cause, or a cut by the harness or Tars
    // of a request held and never answered.
    const r = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END), 0) AS held,
      COALESCE(SUM(CASE WHEN (cancel_json IS NULL OR json_extract(cancel_json, '$.by') IN ('proxy', 'endpoint'))
        AND (error IS NOT NULL OR status >= 400) THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(${GIVEN_UP_WHILE_HELD_SQL}), 0) AS abandoned FROM requests WHERE trace_id = ?`).get(traceId) as { held: number; errors: number; abandoned: number };
    return r;
  }

  /**
   * Whether this request, as it arrives, opens a turn of the session: ingest()'s own rule (not a side request, and
   * the first of the session or a new instruction), read before the response, for the turn's workspace snapshot.
   */
  opensTurnAt(traceId: string, surface: Surface, body: Buffer): boolean {
    try {
      const trace = this.db.prepare('SELECT main_system_hash FROM traces WHERE trace_id = ?').get(traceId) as Row | undefined;
      if (!trace) return false;
      const req = parseRequest(surface, body);
      if (!req || sideOf(trace.main_system_hash, req).side) return false;
      const any = this.db.prepare('SELECT 1 FROM turns WHERE trace_id = ? LIMIT 1').get(traceId);
      return !any || opensTurn(surface, req.input);
    } catch {
      return false;
    }
  }

  /** A workspace snapshot's place in the session (turn-workspace.ts). */
  addWorkspacePoint(traceId: string, p: WorkspacePoint): void {
    this.db.prepare(`INSERT OR REPLACE INTO workspace_points (trace_id, idx, at, kind, head, tree, ms, failed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(traceId, p.index, p.at, p.kind, p.head, p.tree, p.ms, p.failed ? 1 : 0);
  }

  workspacePoints(traceId: string): WorkspacePoint[] {
    return (this.db.prepare('SELECT * FROM workspace_points WHERE trace_id = ? ORDER BY idx').all(traceId) as Row[]).map(r => ({
      index: num(r.idx), at: num(r.at), kind: String(r.kind) as WorkspacePoint['kind'], head: optStr(r.head) ?? null,
      tree: optStr(r.tree) ?? null, ms: num(r.ms), failed: r.failed === 1,
    }));
  }

  /**
   * A file's version at a boundary, kept to measure survival: compressed, local only, counted against the cap and
   * deleted with the session. Past WORKSPACE_KEPT_BYTES for the session its text is not kept (unknown, never 0).
   */
  addWorkspaceVersion(traceId: string, index: number, filePath: string, v: StoredVersion | null): void {
    let data: Buffer | null = null;
    if (v?.text !== undefined) {
      const kept = (this.db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM workspace_versions WHERE trace_id = ?').get(traceId) as { n: number }).n;
      const packed = compress(Buffer.from(v.text, 'utf8'));
      if (kept + packed.length <= WORKSPACE_KEPT_BYTES) data = packed;
    }
    const before = (this.db.prepare('SELECT length(data) AS n FROM workspace_versions WHERE trace_id = ? AND idx = ? AND path = ?').get(traceId, index, filePath) as { n: number | null } | undefined)?.n ?? 0;
    this.db.prepare(`INSERT OR REPLACE INTO workspace_versions (trace_id, idx, path, id, binary, codec, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(traceId, index, filePath, v?.id ?? null, v?.binary ? 1 : 0, data ? CODEC : null, data);
    this.db.prepare('UPDATE traces SET bytes = bytes + ? WHERE trace_id = ?').run((data?.length ?? 0) - before, traceId);
  }

  /**
   * Each file a turn changed and its version at every boundary of the session: a boundary before its first change
   * holds the version from before it, one between two changes the latest. Absent is null, bytes not kept undefined.
   */
  workspaceHistories(traceId: string): Array<{ path: string; versions: Array<StoredVersion | null> }> {
    const points = (this.db.prepare('SELECT COUNT(*) AS n FROM workspace_points WHERE trace_id = ?').get(traceId) as { n: number }).n;
    const rows = this.db.prepare('SELECT idx, path, id, binary, codec, data FROM workspace_versions WHERE trace_id = ? ORDER BY path, idx').all(traceId) as Row[];
    const byPath = new Map<string, Row[]>();
    for (const r of rows) { const list = byPath.get(String(r.path)) ?? []; list.push(r); byPath.set(String(r.path), list); }
    const versionOfRow = (r: Row): StoredVersion | null => {
      if (r.id === null || r.id === undefined) return null;
      if (r.binary === 1) return { id: String(r.id), binary: true };
      if (r.data) return { id: String(r.id), text: decompress(String(r.codec), r.data as Buffer).toString('utf8') };
      return { id: String(r.id) };
    };
    return [...byPath.entries()].map(([p, list]) => {
      const length = Math.max(points, num(list[list.length - 1].idx) + 1);
      const versions: Array<StoredVersion | null> = [];
      let at = 0;
      for (let i = 0; i < length; i++) {
        while (at + 1 < list.length && num(list[at + 1].idx) <= i) at++;
        versions.push(versionOfRow(list[at]));
      }
      return { path: p, versions };
    });
  }

  /** Writes the fields given of the turn that began at `startedAt` (null included: unknown), the others untouched. */
  setTurnWorkspace(traceId: string, startedAt: number, fields: Partial<TurnWorkspaceView>): void {
    const keys = Object.keys(fields).filter(k => k in WORKSPACE_COLUMNS) as Array<keyof TurnWorkspaceView>;
    const value = (k: keyof TurnWorkspaceView) => { const v = fields[k]; return typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null; };
    this.db.prepare(`INSERT INTO workspace_turns (trace_id, started_at) VALUES (?, ?) ON CONFLICT(trace_id, started_at) DO NOTHING`).run(traceId, startedAt);
    if (!keys.length) return;
    this.db.prepare(`UPDATE workspace_turns SET ${keys.map(k => `${WORKSPACE_COLUMNS[k]} = ?`).join(', ')} WHERE trace_id = ? AND started_at = ?`)
      .run(...keys.map(value), traceId, startedAt);
  }

  /** The turns' repository records, by turn start. */
  workspaceTurns(traceId: string): Array<TurnWorkspaceView & { startedAt: number }> {
    return (this.db.prepare('SELECT * FROM workspace_turns WHERE trace_id = ? ORDER BY started_at').all(traceId) as Row[]).map(r => ({ startedAt: num(r.started_at), ...workspaceViewOf(r) }));
  }

  /**
   * Each turn's survival, measured at the session's end, or again at its branch's merge or deletion: written, and
   * the session's change sequence moved, only when something changed (a reader and the uploader see it again).
   */
  setSurvival(traceId: string, rows: Array<{ startedAt: number; changedLines: number | null; survivedLines: number | null; reverted: boolean | null }>, basis: 'session_end' | 'merged' | 'deleted', at: number): boolean {
    return this.db.transaction(() => {
      let moved = false;
      for (const r of rows) {
        const cur = this.db.prepare('SELECT changed_lines, survived_lines, reverted, survival_basis FROM workspace_turns WHERE trace_id = ? AND started_at = ?').get(traceId, r.startedAt) as Row | undefined;
        const reverted = r.reverted === null ? null : r.reverted ? 1 : 0;
        if (cur && cur.changed_lines === r.changedLines && cur.survived_lines === r.survivedLines && cur.reverted === reverted && cur.survival_basis === basis) continue;
        this.setTurnWorkspace(traceId, r.startedAt, { changedLines: r.changedLines, survivedLines: r.survivedLines, reverted: r.reverted, survivalBasis: basis, survivalAt: at });
        moved = true;
      }
      if (moved) this.db.prepare('UPDATE traces SET updated_seq = ? WHERE trace_id = ?').run(this.nextSeq(), traceId);
      return moved;
    })();
  }

  /**
   * Ended sessions whose survival was measured at their end only, with a branch in their outcome: those a merge or a
   * deletion of that branch may still measure again (turn-workspace.ts finalize). Never one checked for good (on the
   * default branch, no branch, measured), never one waiting for its next check, never one ended more than
   * WORKSPACE_FINAL_DAYS ago; the least recently checked first, then the oldest (the Audit's M1 at 08e5b439d: ten that
   * could never be measured used to hold the line for good).
   */
  workspaceToFinalize(limit: number, now = Date.now()): Array<{ traceId: string; agentId: string; projectPath: string }> {
    return (this.db.prepare(`SELECT t.trace_id, t.agent_id, t.project_path FROM traces t
      LEFT JOIN workspace_final f ON f.trace_id = t.trace_id
      WHERE t.ended_at IS NOT NULL AND t.ended_at >= ? AND t.outcome_json LIKE '%"branch"%'
        AND EXISTS (SELECT 1 FROM workspace_turns w WHERE w.trace_id = t.trace_id AND w.survival_basis = 'session_end')
        AND NOT EXISTS (SELECT 1 FROM workspace_turns w WHERE w.trace_id = t.trace_id AND w.survival_basis IN ('merged', 'deleted'))
        AND (f.trace_id IS NULL OR (f.state = 'waiting' AND f.next_at <= ?))
      ORDER BY COALESCE(f.checked_at, 0) ASC, t.ended_at ASC LIMIT ?`).all(now - WORKSPACE_FINAL_DAYS * 86_400_000, now, limit) as Row[])
      .map(r => ({ traceId: String(r.trace_id), agentId: String(r.agent_id), projectPath: String(r.project_path) }));
  }

  /**
   * What a check of a session's branch found: measured ('done'), never measurable ('never': on the default branch, no
   * branch), or to ask again ('waiting': still open, or git could not tell), an hour on, doubling to a day.
   */
  noteFinalCheck(traceId: string, result: string, now: number): void {
    const state = result === 'merged' || result === 'deleted' || result === 'done' ? 'done'
      : result === 'default-branch' || result === 'no-branch' ? 'never' : 'waiting';
    const tries = ((this.db.prepare('SELECT tries FROM workspace_final WHERE trace_id = ?').get(traceId) as { tries?: number } | undefined)?.tries ?? 0) + 1;
    const next = now + Math.min(86_400_000, 3_600_000 * 2 ** (tries - 1));
    this.db.prepare(`INSERT INTO workspace_final (trace_id, state, checked_at, next_at, tries) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trace_id) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at, next_at = excluded.next_at, tries = excluded.tries`)
      .run(traceId, state, now, next, tries);
  }

  /**
   * The turns of a project's sessions that ended on a known head, with their session's branch: what a gate's verdict
   * may link to (gate-verdicts.ts).
   */
  /**
   * `until`: when the turn's work ends, as its end head is read: the next turn's start, else its session's end; null
   * for the last turn of a session still running.
   */
  verdictCandidates(projectPath: string): Array<{ traceId: string; agentId: string; startedAt: number; until: number | null; turnIndex: number; startHead: string | null; endHead: string; branch: string | null }> {
    return (this.db.prepare(`SELECT w.trace_id, tr.agent_id, w.started_at, t.turn_index, w.start_head, w.end_head, json_extract(tr.outcome_json, '$.branch') AS branch,
      COALESCE((SELECT MIN(t2.started_at) FROM turns t2 WHERE t2.trace_id = w.trace_id AND t2.started_at > w.started_at), tr.ended_at) AS until
      FROM workspace_turns w JOIN turns t ON t.trace_id = w.trace_id AND t.started_at = w.started_at
      JOIN traces tr ON tr.trace_id = w.trace_id
      WHERE tr.project_path = ? AND w.end_head IS NOT NULL ORDER BY w.trace_id, t.turn_index`).all(projectPath) as Row[])
      .map(r => ({
        traceId: String(r.trace_id), agentId: String(r.agent_id), startedAt: num(r.started_at), until: optNum(r.until) ?? null,
        turnIndex: num(r.turn_index), startHead: optStr(r.start_head) ?? null, endHead: String(r.end_head), branch: optStr(r.branch) ?? null,
      }));
  }

  /** A project's verdicts: what a session's end links again (gate-verdicts.ts relinkSession). */
  projectVerdicts(projectPath: string): Array<{ id: number; head: string; branch: string | null }> {
    return (this.db.prepare('SELECT id, head, branch FROM verdicts WHERE project_path = ? ORDER BY id').all(projectPath) as Row[])
      .map(r => ({ id: num(r.id), head: String(r.head), branch: optStr(r.branch) ?? null }));
  }

  /** Turns of one session added to a verdict's links (none taken away); how many were new. */
  addVerdictLinks(verdictId: number, traceId: string, startedAts: number[]): number {
    const add = this.db.prepare('INSERT OR IGNORE INTO verdict_links (verdict_id, trace_id, turn_started_at) VALUES (?, ?, ?)');
    let added = 0;
    for (const at of startedAts) added += add.run(verdictId, traceId, at).changes;
    return added;
  }

  /**
   * A gate's verdict on a pull request's head, one per project, gate, pull request and head: the latest stands. Not
   * changed when the same verdict, counts and recorder come again (its first moment kept).
   */
  putVerdict(v: {
    projectPath: string; gate: string; pr: number; head: string; verdict: string; at: number; by: string; byName?: string; byRole?: string;
    branch?: string; testCommand?: string; passed?: number; failed?: number; skipped?: number; report?: string;
  }): { id: number; changed: boolean } {
    const cur = this.db.prepare('SELECT * FROM verdicts WHERE project_path = ? AND gate = ? AND pr = ? AND head = ?').get(v.projectPath, v.gate, v.pr, v.head) as Row | undefined;
    const nul = <T>(x: T | undefined) => (x === undefined ? null : x);
    const same = !!cur && cur.verdict === v.verdict && cur.by_agent === v.by && cur.by_name === nul(v.byName) && cur.by_role === nul(v.byRole)
      && cur.branch === nul(v.branch) && cur.test_command === nul(v.testCommand)
      && cur.passed === nul(v.passed) && cur.failed === nul(v.failed) && cur.skipped === nul(v.skipped) && cur.report === nul(v.report);
    if (cur && same) return { id: num(cur.id), changed: false };
    this.db.prepare(`INSERT INTO verdicts (project_path, gate, pr, head, verdict, at, by_agent, by_name, by_role, branch, test_command, passed, failed, skipped, report)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path, gate, pr, head) DO UPDATE SET verdict = excluded.verdict, at = excluded.at, by_agent = excluded.by_agent,
        by_name = excluded.by_name, by_role = excluded.by_role, branch = excluded.branch,
        test_command = excluded.test_command, passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped, report = excluded.report`)
      .run(v.projectPath, v.gate, v.pr, v.head, v.verdict, v.at, v.by, nul(v.byName), nul(v.byRole), nul(v.branch), nul(v.testCommand), nul(v.passed), nul(v.failed), nul(v.skipped), nul(v.report));
    const row = this.db.prepare('SELECT id FROM verdicts WHERE project_path = ? AND gate = ? AND pr = ? AND head = ?').get(v.projectPath, v.gate, v.pr, v.head) as { id: number };
    return { id: row.id, changed: true };
  }

  /** The turns a verdict covers, replaced; the sessions whose links moved (before or after). */
  setVerdictLinks(verdictId: number, links: Array<{ traceId: string; startedAt: number }>): string[] {
    const before = this.db.prepare('SELECT trace_id, turn_started_at FROM verdict_links WHERE verdict_id = ?').all(verdictId) as Row[];
    const key = (t: string, s: number) => `${t}\0${s}`;
    const old = new Set(before.map(r => key(String(r.trace_id), num(r.turn_started_at))));
    const next = new Set(links.map(l => key(l.traceId, l.startedAt)));
    const moved = new Set<string>();
    for (const k of old) if (!next.has(k)) moved.add(k.split('\0')[0]);
    for (const k of next) if (!old.has(k)) moved.add(k.split('\0')[0]);
    if (!moved.size) return [];
    this.db.prepare('DELETE FROM verdict_links WHERE verdict_id = ?').run(verdictId);
    const add = this.db.prepare('INSERT OR IGNORE INTO verdict_links (verdict_id, trace_id, turn_started_at) VALUES (?, ?, ?)');
    for (const l of links) add.run(verdictId, l.traceId, l.startedAt);
    return [...moved];
  }

  /** The sessions a verdict covers now. */
  verdictTraces(verdictId: number): string[] {
    return (this.db.prepare('SELECT DISTINCT trace_id FROM verdict_links WHERE verdict_id = ?').all(verdictId) as Row[]).map(r => String(r.trace_id));
  }

  verdictLinksOf(traceId: string): Array<{ verdictId: number; startedAt: number }> {
    return (this.db.prepare('SELECT verdict_id, turn_started_at FROM verdict_links WHERE trace_id = ? ORDER BY verdict_id, turn_started_at').all(traceId) as Row[])
      .map(r => ({ verdictId: num(r.verdict_id), startedAt: num(r.turn_started_at) }));
  }

  /**
   * The session's outcome.gates, rebuilt from the verdicts linked to its turns: written, and its change sequence
   * moved, only when they changed.
   */
  refreshGates(traceId: string): boolean {
    const trace = this.db.prepare('SELECT outcome_json FROM traces WHERE trace_id = ?').get(traceId) as { outcome_json: string | null } | undefined;
    if (!trace) return false;
    const verdicts = this.db.prepare(`SELECT DISTINCT v.* FROM verdicts v JOIN verdict_links l ON l.verdict_id = v.id
      WHERE l.trace_id = ? ORDER BY v.gate, v.pr, v.at, v.id`).all(traceId) as Row[];
    const turnsOf = this.db.prepare(`SELECT t.turn_index FROM verdict_links l JOIN turns t ON t.trace_id = l.trace_id AND t.started_at = l.turn_started_at
      WHERE l.verdict_id = ? AND l.trace_id = ? ORDER BY t.turn_index`);
    const all = verdicts.map(v => ({
      kind: String(v.gate), verdict: String(v.verdict), at: num(v.at), pr: num(v.pr), head: String(v.head),
      turns: ranges((turnsOf.all(v.id, traceId) as Row[]).map(r => num(r.turn_index))), by: String(v.by_agent),
      ...(optStr(v.by_name) ? { byName: String(v.by_name) } : {}), ...(optStr(v.by_role) ? { byRole: String(v.by_role) } : {}),
      ...(optStr(v.test_command) ? { testCommand: String(v.test_command) } : {}),
      ...(typeof v.passed === 'number' ? { passed: v.passed } : {}), ...(typeof v.failed === 'number' ? { failed: v.failed } : {}),
      ...(typeof v.skipped === 'number' ? { skipped: v.skipped } : {}), ...(optStr(v.report) ? { report: String(v.report) } : {}),
    }));
    const outcome = trace.outcome_json ? JSON.parse(trace.outcome_json) as TraceOutcome : {};
    const { gates: _was, gatesOmitted: _omitted, ...rest } = outcome;
    // The newest gates while the outcome stays within the budget (the back office takes 16 KiB), in their order.
    const build = (kept: typeof all): TraceOutcome => {
      const omitted = all.length - kept.length;
      return { ...rest, ...(kept.length ? { gates: kept } : {}), ...(omitted ? { gatesOmitted: omitted } : {}) };
    };
    const newestFirst = [...all].sort((a, b) => b.at - a.at);
    const keptOf = (n: number) => { const set = new Set(newestFirst.slice(0, n)); return all.filter(g => set.has(g)); };
    let total = Buffer.byteLength(JSON.stringify(build([]))) + '"gates":[],'.length;
    let count = 0;
    for (const g of newestFirst) {
      const size = Buffer.byteLength(JSON.stringify(g)) + 1;
      if (total + size > GATES_BUDGET_BYTES) break;
      total += size;
      count++;
    }
    while (count > 0 && Buffer.byteLength(JSON.stringify(build(keptOf(count)))) > GATES_BUDGET_BYTES) count--;
    const next = build(keptOf(count));
    if (JSON.stringify(next) === JSON.stringify(outcome)) return false;
    this.db.prepare('UPDATE traces SET outcome_json = ?, updated_seq = ? WHERE trace_id = ?').run(JSON.stringify(next), this.nextSeq(), traceId);
    return true;
  }

  /** Runs `fn` in one transaction of the store. */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** A file renamed whole at a boundary (the same blob under another path): its lines are followed through it. */
  addWorkspaceRename(traceId: string, index: number, from: string, to: string): void {
    this.db.prepare('INSERT OR REPLACE INTO workspace_renames (trace_id, idx, from_path, to_path) VALUES (?, ?, ?, ?)').run(traceId, index, from, to);
  }

  workspaceRenames(traceId: string): Array<{ index: number; from: string; to: string }> {
    return (this.db.prepare('SELECT idx, from_path, to_path FROM workspace_renames WHERE trace_id = ? ORDER BY idx').all(traceId) as Row[])
      .map(r => ({ index: num(r.idx), from: String(r.from_path), to: String(r.to_path) }));
  }

  /** What Tars typed into an agent's terminal, and from whom: the authorship a turn is matched to. */
  noteTypedInput(t: TypedInput): void {
    const text = norm(t.text);
    if (!text) return;
    this.db.prepare('INSERT INTO typed_inputs (agent_id, at, author, author_detail, text_norm, closed, task_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.agentId, t.at, t.author, t.authorDetail ?? null, text, t.closed ? 1 : 0, t.taskRef ?? null);
    this.db.prepare('DELETE FROM typed_inputs WHERE at < ?').run(t.at - 7 * 86_400_000);
  }

  private putBlob(value: unknown): { hash: string; added: number } {
    const hash = hashOf(value);
    if (this.db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(hash)) return { hash, added: 0 };
    const raw = Buffer.from(JSON.stringify(value ?? null));
    const data = compress(raw);
    this.db.prepare('INSERT INTO blobs (hash, size, stored, codec, data) VALUES (?, ?, ?, ?, ?)').run(hash, raw.length, data.length, CODEC, data);
    return { hash, added: data.length };
  }

  private getBlob(hash: string | null | undefined): unknown {
    if (!hash) return undefined;
    const row = this.db.prepare('SELECT codec, data FROM blobs WHERE hash = ?').get(hash) as { codec: string; data: Buffer } | undefined;
    if (!row) return undefined;
    return JSON.parse(decompress(row.codec, row.data).toString('utf8'));
  }

  private authorFor(agentId: string, instruction: string, at: number): { author: string; detail?: string; closed: boolean; id?: number; taskRef?: string; typedAt?: number } {
    const said = norm(instruction);
    if (!said) return { author: 'unknown', closed: false };
    const rows = this.db.prepare(`SELECT id, at, author, author_detail, text_norm, closed, task_ref FROM typed_inputs
      WHERE agent_id = ? AND used_by IS NULL AND at <= ? AND at >= ? ORDER BY at DESC`).all(agentId, at + 1000, at - TYPED_INPUT_WINDOW_MS) as Row[];
    for (const r of rows) {
      const typed = String(r.text_norm);
      const head = typed.slice(0, 200);
      if (said.includes(head) || typed.includes(said)) {
        return { author: String(r.author), detail: optStr(r.author_detail), closed: r.closed === 1, id: num(r.id), taskRef: optStr(r.task_ref), typedAt: num(r.at) };
      }
    }
    return { author: 'unknown', closed: false };
  }

  /**
   * The session of an agent a tool call happened in: the newest whose span holds the call's time, a little slack
   * either side. A line read late, after its request or after the session ended, still finds it; a line of another
   * session (an earlier terminal's, a log that is not this one's) does not.
   */
  traceForToolCall(agentId: string, part: ToolCallPart): string | undefined {
    const at = toolCallAt(part);
    if (at === undefined) return undefined;
    const row = this.db.prepare(`SELECT trace_id FROM traces WHERE agent_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
      ORDER BY started_at DESC LIMIT 1`).get(agentId, at + TOOL_CALL_SLACK_MS, at - TOOL_CALL_SLACK_MS) as Row | undefined;
    return row ? String(row.trace_id) : undefined;
  }

  /**
   * One line's word on a tool call, merged with what the session already holds of it: a fact said first is kept, a
   * later line only adds. The session's change sequence moves when something was added, so the upload takes it again;
   * the same line read twice changes nothing.
   */
  addToolCall(traceId: string, part: ToolCallPart): boolean {
    const row = this.db.prepare('SELECT part_json FROM tool_calls WHERE trace_id = ? AND tool_call_id = ?').get(traceId, part.callId) as Row | undefined;
    const before = row ? String(row.part_json) : undefined;
    const next = mergeToolCall(before ? JSON.parse(before) as ToolCallPart : undefined, part);
    // Keys in one order, so the same facts always read as the same text.
    const merged = JSON.stringify(next, Object.keys(next).sort());
    if (merged === before) return false;
    this.db.prepare(`INSERT INTO tool_calls (trace_id, tool_call_id, part_json) VALUES (?, ?, ?)
      ON CONFLICT(trace_id, tool_call_id) DO UPDATE SET part_json = excluded.part_json`).run(traceId, part.callId, merged);
    // The row weighs in the session's bytes as it weighs in the store's size (stats): what it adds, once.
    const grew = toolCallRowBytes(part.callId, merged) - (before === undefined ? 0 : toolCallRowBytes(part.callId, before));
    this.db.prepare('UPDATE traces SET bytes = bytes + ?, updated_seq = ? WHERE trace_id = ?').run(grew, this.nextSeq(), traceId);
    return true;
  }

  /** One request and its response, into the store. Never throws. */
  ingest(rec: WireRecord): string | undefined {
    try {
      return this.db.transaction(() => this.ingestNow(rec))();
    } catch (err) {
      console.error(`[traces] a request of ${rec.traceId} was not recorded: ${(err as Error).message}`);
      return undefined;
    }
  }

  private ingestNow(rec: WireRecord): string {
    const trace = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(rec.traceId) as Row | undefined;
    if (!trace) throw new Error('no such trace');
    // Given up while held: the one cut that never reached the endpoint (counted in no request count, model time or
    // first request). Every other cut request did, and counts.
    const heldOnly = givenUpWhileHeld({ cancel: rec.cancel, status: rec.status, attempts: rec.attempts, heldMs: rec.heldMs });
    const req = parseRequest(rec.surface, rec.requestBody);
    const resp = parseResponse(rec.surface, rec.status, rec.contentType, rec.responseBody);
    const { side, systemHash, mainSystem } = sideOf(trace.main_system_hash, req);

    const lastTurn = this.db.prepare('SELECT * FROM turns WHERE trace_id = ? ORDER BY turn_index DESC LIMIT 1').get(rec.traceId) as Row | undefined;
    const lastEnd = optNum(trace.last_end_at);
    // A history rewritten since the last main request (trace feature C2): a compaction or a truncation stays in its
    // turn, whatever its last message looks like; only a new task someone typed through Tars opens one (kind new).
    const seen = side || !req ? undefined : this.rewriteOf(rec, req, resp.usage.input, String(trace.harness));
    let reset = seen?.reset;
    // The same history sent again (a retry) is the request before it: never a turn of its own.
    let opens = !side && !seen?.again && (!lastTurn || (!!req && opensTurn(rec.surface, req.input)));
    let typedBy: ReturnType<TraceStore['authorFor']> | undefined;
    if (reset && opens && req) {
      typedBy = this.authorFor(rec.agentId, instructionText(rec.surface, req.input), rec.startedAt);
      if (typedBy.author === 'unknown') opens = false;
      // Typed through Tars, a new task: after a cleared history, a reset of kind new; with the history kept at its head
      // (an answer cut short, then typed words), the history went on, and nothing was reset (the Audit's I-2 on #687).
      else if (seen?.kept) reset = undefined;
      else reset.kind = 'new';
    }
    let turnId = optStr(lastTurn?.turn_id);
    let mixed = trace.mixed === 1;
    let unknownTurns = num(trace.unknown_turns);
    let turnCount = num(trace.turn_count);
    if (opens) {
      const who = typedBy ?? (req ? this.authorFor(rec.agentId, instructionText(rec.surface, req.input), rec.startedAt) : { author: 'unknown', closed: false } as ReturnType<TraceStore['authorFor']>);
      turnId = id('turn_');
      // The task the turn serves: the one its words handed over, or, for a session's first turn, the one it started on
      // (its prompt goes in with the CLI's launch, typed by nobody).
      const startRef = !lastTurn && trace.start_json ? optStr((JSON.parse(String(trace.start_json)) as TraceStart).taskRef) : undefined;
      this.db.prepare(`INSERT INTO turns (turn_id, trace_id, turn_index, started_at, gap_before_ms, author, author_detail, task_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(turnId, rec.traceId, lastTurn ? num(lastTurn.turn_index) + 1 : 0, rec.startedAt,
        lastEnd !== undefined ? Math.max(0, rec.startedAt - lastEnd) : null, who.author, who.detail ?? null, who.taskRef ?? startRef ?? null);
      if (who.id !== undefined) this.db.prepare('UPDATE typed_inputs SET used_by = ? WHERE id = ?').run(turnId, who.id);
      // When its words were typed: a correction's delay runs from the turn before's end to them (trace feature B3).
      if (who.typedAt !== undefined) this.db.prepare('UPDATE turns SET instructed_at = ? WHERE turn_id = ?').run(who.typedAt, turnId);
      if (who.closed) mixed = true;
      if (who.author === 'unknown') unknownTurns++;
      turnCount++;
    }

    const seqRow = this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE turn_id IS ? AND side = ?').get(turnId ?? null, side ? 1 : 0) as { n: number };
    const requestId = id('treq_');
    let added = 0;
    let newMessages = 0;
    const dropped = this.bodiesDropped;
    let toolsHash: string | undefined;
    if (req && !dropped) {
      if (req.system !== undefined) added += this.putBlob(req.system).added;
      if (req.tools) { const t = this.putBlob(req.tools); toolsHash = t.hash; added += t.added; }
      const link = this.db.prepare('INSERT INTO request_messages (request_id, position, message_hash, direction) VALUES (?, ?, ?, ?)');
      req.input.forEach((m, i) => {
        const b = this.putBlob(m);
        if (b.added) newMessages++;
        added += b.added;
        link.run(requestId, i, b.hash, 'input');
      });
      if (resp.output !== null) {
        const b = this.putBlob(resp.output);
        added += b.added;
        link.run(requestId, req.input.length, b.hash, 'output');
      }
    } else if (req?.tools) {
      toolsHash = hashOf(req.tools);
    }
    let toolErrors = 0;
    if (req && rec.surface === 'anthropic_messages' && !opens) {
      const last = req.input[req.input.length - 1] as Row | undefined;
      for (const b of Array.isArray(last?.content) ? last!.content as Row[] : []) if (b.type === 'tool_result' && b.is_error === true) toolErrors++;
    }

    const total = rec.endedAt - rec.startedAt;
    const cutByCaller = rec.cancel?.by === 'harness' || rec.cancel?.by === 'tars';
    // TTFT measures the model (the owner's decision of 26/11): a stream's first token, never its first byte, which
    // may be a chunk with only a role; none when it carried no content. A response that is not streamed: its first byte.
    const ttft = rec.firstContentAt !== undefined ? rec.firstContentAt - rec.startedAt
      : isStreamed(rec.contentType, rec.responseBody.subarray(0, 64).toString('utf8')) ? null
        : rec.firstByteAt !== undefined ? rec.firstByteAt - rec.startedAt : null;
    this.db.prepare(`INSERT INTO requests (request_id, upstream_request_id, trace_id, turn_id, seq, side, surface, model_requested,
      model_served, params_json, system_hash, tools_hash, started_at, ttft_ms, total_ms, tokens_in, tokens_cached, tokens_out, status, error,
      finish_reason, streamed, req_bytes, resp_bytes, new_messages, attempts, held_ms, bodies_dropped, live_sessions,
      rtt_ms, clock_offset_ms, queue_ms, upstream_ms, cancel_json, context_reset_json, history_keys)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId, rec.upstreamRequestId ?? null, rec.traceId, turnId ?? null, seqRow.n, side ? 1 : 0, rec.surface, req?.model ?? null,
      resp.modelServed ?? null, req ? JSON.stringify(req.params) : null, systemHash ?? null, toolsHash ?? null, rec.startedAt,
      ttft, total, resp.usage.input, resp.usage.cached, resp.usage.output,
      // A request the harness or Tars cut is no error of the endpoint's: its cancel says what happened. One the
      // endpoint or the proxy cut keeps its error (trace feature B3).
      rec.status, cutByCaller ? null : rec.error ?? resp.error ?? null, resp.finishReason ?? null, req?.stream ? 1 : 0, rec.requestBody.length, rec.responseBody.length,
      newMessages, rec.attempts, rec.heldMs, dropped ? 1 : 0, typeof rec.liveSessions === 'number' ? rec.liveSessions : null,
      rec.timing?.rttMs ?? null, rec.timing?.clockOffsetMs ?? null, rec.timing?.queueMs ?? null, rec.timing?.upstreamMs ?? null,
      rec.cancel ? JSON.stringify(rec.cancel) : null, reset ? JSON.stringify(reset) : null,
      !side && req ? JSON.stringify(historyKeys(req.input).map(c => c.key)) : null);
    // The harness's own session id: the first it sent stays (a resumed session keeps the id it began with).
    if (rec.nativeSessionId) {
      this.db.prepare('UPDATE traces SET native_session_id = ? WHERE trace_id = ? AND native_session_id IS NULL').run(rec.nativeSessionId, rec.traceId);
    }
    // The calls whose results it newly carries: what its gap's tool time is read from (trace feature C1). Apart from the
    // insert above, which other work adds columns to.
    const resultIds = req ? newToolResultIds(rec.surface, req.input) : [];
    if (resultIds.length) this.db.prepare('UPDATE requests SET tool_result_ids = ? WHERE request_id = ?').run(JSON.stringify(resultIds), requestId);

    if (turnId) {
      const failed = !!(rec.error || resp.error) || rec.cancel?.by === 'proxy' || rec.cancel?.by === 'endpoint';
      // Cut by the harness (given up, an Esc) or by Tars: the turn ends there, neither done nor failed at the endpoint.
      const status = cutByCaller ? 'abandoned' : failed ? 'failed' : resp.toolCalls > 0 ? 'open' : 'done';
      if (!side) {
        const toolMs = !opens && lastEnd !== undefined ? Math.max(0, rec.startedAt - lastEnd) : 0;
        // A request given up while held never reached the endpoint: no request of the turn, no model time. Any other
        // cut one did, and counts (an Esc mid-answer, a cut stream, a Tars stop...).
        this.db.prepare(`UPDATE turns SET ended_at = ?, request_count = request_count + ?, tool_call_count = tool_call_count + ?,
          tool_error_count = tool_error_count + ?, tool_ms = tool_ms + ?, model_ms = model_ms + ?, tokens_in = tokens_in + ?,
          tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ?, final_status = ?, final_finish_reason = ? WHERE turn_id = ?`)
          .run(rec.endedAt, heldOnly ? 0 : 1, resp.toolCalls, toolErrors, toolMs, heldOnly ? 0 : total, resp.usage.input, resp.usage.cached,
            resp.usage.output, status, resp.finishReason ?? null, turnId);
      } else {
        this.db.prepare('UPDATE turns SET tokens_in = tokens_in + ?, tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ? WHERE turn_id = ?')
          .run(resp.usage.input, resp.usage.cached, resp.usage.output, turnId);
      }
    }
    this.db.prepare(`UPDATE traces SET request_count = request_count + ?, turn_count = ?, tokens_in = tokens_in + ?,
      tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ?, mixed = ?, unknown_turns = ?, main_system_hash = ?,
      last_end_at = CASE WHEN ? THEN last_end_at ELSE ? END, bytes = bytes + ?, updated_seq = ? WHERE trace_id = ?`).run(
      heldOnly ? 0 : 1, turnCount, resp.usage.input, resp.usage.cached, resp.usage.output, mixed ? 1 : 0, unknownTurns, mainSystem ?? null,
      side ? 1 : 0, rec.endedAt, added + ROW_BYTES, this.nextSeq(), rec.traceId);
    // A compaction or a truncation the wire saw, until the harness's log names it (applyHarnessCompactions).
    if (reset && reset.kind !== 'new') {
      const list = jsonOf<TraceCompaction[]>(trace.compactions_json) ?? [];
      list.push({ at: rec.startedAt, kind: reset.kind as TraceCompaction['kind'], requestId, source: 'wire' });
      const kept = capped(list, num(trace.compactions_omitted));
      this.db.prepare('UPDATE traces SET compactions_json = ?, compactions_omitted = ? WHERE trace_id = ?').run(JSON.stringify(kept.list), kept.omitted, rec.traceId);
    }
    return requestId;
  }

  /**
   * How this request's history rewrites the last main request's (trace-wire.ts historyRewrite), or nothing: never for a
   * history kept server-side (`previous_response_id`, only the new items sent), nor when either request's bodies were
   * not kept (past the cap: nothing to compare). The tokens it dropped: the earlier prompt less this one, as the
   * endpoint counted them, when both are known and it shrank.
   */
  private rewriteOf(rec: WireRecord, req: NonNullable<ReturnType<typeof parseRequest>>, promptTokens: number, harness: string): { reset?: ContextReset; kept?: boolean; again: boolean } | undefined {
    if (this.bodiesDropped || req.params.previous_response_id !== undefined) return undefined;
    const prev = this.db.prepare(`SELECT request_id, tokens_in, history_keys FROM requests WHERE trace_id = ? AND side = 0 AND bodies_dropped = 0
      AND history_keys IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(rec.traceId) as Row | undefined;
    const keys = jsonOf<string[]>(prev?.history_keys) ?? [];
    if (!prev || !keys.length) return undefined;
    // The same history sent again (its keys, the harness's reminders aside): a retry, whatever the harness.
    const cur = historyKeys(req.input).map(c => c.key);
    if (cur.length === keys.length && cur.every((k, i) => k === keys[i])) return { again: true };
    // A harness whose history is not measured is never marked on the wire's guess (the Audit's I-1 on #687).
    if (!REWRITE_MEASURED.has(harness)) return { again: false };
    const out = this.db.prepare(`SELECT message_hash FROM request_messages WHERE request_id = ? AND direction = 'output'`).get(prev.request_id) as Row | undefined;
    const output = out ? this.getBlob(String(out.message_hash)) : undefined;
    const askedTool = (Array.isArray(output) ? output : output === undefined ? [] : [output]).flatMap(i => partsOf(i)).some(p => p.kind === 'tool_call');
    const rewrite = historyRewrite(rec.surface, { keys, askedTool }, req.input);
    if (!rewrite) return { again: false };
    const dropped = num(prev.tokens_in) - promptTokens;
    return {
      reset: { kind: rewrite.kind, ...(promptTokens > 0 && num(prev.tokens_in) > 0 && dropped > 0 ? { droppedTokens: dropped } : {}) },
      kept: rewrite.kept, again: false,
    };
  }

  private where(f: TraceFilter): { sql: string; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (f.traceId) { clauses.push('trace_id = ?'); args.push(f.traceId); }
    if (f.project) { clauses.push('project_path = ?'); args.push(f.project); }
    if (f.agentId) { clauses.push('agent_id = ?'); args.push(f.agentId); }
    if (f.harness) { clauses.push('harness = ?'); args.push(f.harness); }
    if (f.model) { clauses.push('model = ?'); args.push(f.model); }
    if (f.endpointId) { clauses.push('endpoint_id = ?'); args.push(f.endpointId); }
    if (typeof f.from === 'number') { clauses.push('started_at >= ?'); args.push(f.from); }
    if (typeof f.to === 'number') { clauses.push('started_at <= ?'); args.push(f.to); }
    return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', args };
  }

  private limitOf(f: TraceFilter): number {
    return Math.min(200, Math.max(1, Math.floor(f.limit ?? 50)));
  }

  /** For the window: newest first; the cursor is the offset of the next page. The totals are the whole filter's. */
  list(f: TraceFilter): { sessions: TraceSessionSummary[]; nextCursor?: string; totals: TraceTotals; byProject: Array<TraceTotals & { projectPath: string }> } {
    const w = this.where(f);
    const limit = this.limitOf(f);
    const offset = f.cursor ? Math.max(0, Number(Buffer.from(f.cursor, 'base64url').toString().replace(/^o:/, '')) || 0) : 0;
    const rows = this.db.prepare(`SELECT * FROM traces WHERE ${w.sql} ORDER BY started_at DESC, trace_id DESC LIMIT ? OFFSET ?`).all(...w.args, limit + 1, offset) as Row[];
    const more = rows.length > limit;
    const sums = `COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(tokens_in), 0) AS tokensIn,
      COALESCE(SUM(tokens_cached), 0) AS tokensCached, COALESCE(SUM(tokens_out), 0) AS tokensOut`;
    const totals = this.db.prepare(`SELECT ${sums} FROM traces WHERE ${w.sql}`).get(...w.args) as TraceTotals;
    const byProject = this.db.prepare(`SELECT project_path AS projectPath, ${sums} FROM traces WHERE ${w.sql} GROUP BY project_path ORDER BY project_path`).all(...w.args) as Array<TraceTotals & { projectPath: string }>;
    return { sessions: rows.slice(0, limit).map(r => summaryOf(r, this.trainable)), nextCursor: more ? Buffer.from(`o:${offset + limit}`).toString('base64url') : undefined, totals, byProject };
  }

  /** For an external trace reader: every session new or grown since the cursor, in the order it changed. */
  changes(f: TraceFilter): { sessions: TraceSessionSummary[]; nextCursor: string } {
    const w = this.where(f);
    const since = decodeCursor(f.cursor);
    const rows = this.db.prepare(`SELECT * FROM traces WHERE updated_seq > ? AND ${w.sql} ORDER BY updated_seq ASC LIMIT ?`).all(since, ...w.args, this.limitOf(f)) as Row[];
    const last = rows.length ? num(rows[rows.length - 1].updated_seq) : since;
    return { sessions: rows.map(r => summaryOf(r, this.trainable)), nextCursor: encodeCursor(last) };
  }

  session(traceId: string): { session: TraceSessionSummary; outcome?: TraceOutcome; start?: TraceStart; lostDemand?: LostDemand[]; lostDemandOmitted?: number; turns: TraceTurnView[] } | null {
    const trace = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId) as Row | undefined;
    if (!trace) return null;
    const firstRequestAt = this.firstRequestAt(traceId);
    const start = trace.start_json
      ? { ...JSON.parse(String(trace.start_json)) as TraceStart, ...(firstRequestAt !== undefined ? { firstRequestAt } : {}) }
      : undefined;
    const turns = this.db.prepare('SELECT * FROM turns WHERE trace_id = ? ORDER BY turn_index').all(traceId) as Row[];
    const workspace = new Map(this.workspaceTurns(traceId).map(({ startedAt, ...w }) => [startedAt, w as TurnWorkspaceView]));
    const requests = this.db.prepare('SELECT * FROM requests WHERE trace_id = ? ORDER BY started_at, side, seq').all(traceId) as Row[];
    const gaps = this.requestGaps(traceId, turns, requests);
    const view = (r: Row): TraceRequestView => ({
      requestId: String(r.request_id), upstreamRequestId: optStr(r.upstream_request_id), seq: num(r.seq), surface: String(r.surface), side: r.side === 1,
      startedAt: num(r.started_at), ttftMs: optNum(r.ttft_ms), totalMs: optNum(r.total_ms), status: num(r.status),
      finishReason: optStr(r.finish_reason), error: optStr(r.error), tokensIn: optNum(r.tokens_in), tokensCached: optNum(r.tokens_cached),
      tokensOut: optNum(r.tokens_out), reqBytes: num(r.req_bytes), respBytes: num(r.resp_bytes), newMessages: num(r.new_messages),
      attempts: num(r.attempts), heldMs: num(r.held_ms), bodiesDropped: r.bodies_dropped === 1, liveSessions: optNum(r.live_sessions),
      rttMs: optNum(r.rtt_ms), clockOffsetMs: optNum(r.clock_offset_ms), queueMs: optNum(r.queue_ms), upstreamMs: optNum(r.upstream_ms),
      ...(r.cancel_json ? { cancel: JSON.parse(String(r.cancel_json)) as RequestCancel } : {}),
      ...gaps.get(String(r.request_id)),
      contextReset: jsonOf<ContextReset>(r.context_reset_json),
    });
    const timing = sessionTiming(requests.map(r => ({ rttMs: optNum(r.rtt_ms) ?? null, clockOffsetMs: optNum(r.clock_offset_ms) ?? null })));
    const interventions = this.turnInterventions(traceId, trace, turns);
    return {
      session: { ...summaryOf(trace, this.trainable), rttMedianMs: timing.rttMedianMs ?? undefined, clockOffsetMs: timing.clockOffsetMs ?? undefined },
      outcome: trace.outcome_json ? JSON.parse(String(trace.outcome_json)) : undefined,
      ...(start ? { start } : {}),
      ...demandOf(trace.demand_json),
      turns: turns.map((t, i) => ({
        turnId: String(t.turn_id), index: num(t.turn_index), startedAt: num(t.started_at), endedAt: optNum(t.ended_at),
        gapBeforeMs: optNum(t.gap_before_ms), author: String(t.author), authorDetail: optStr(t.author_detail), finalStatus: optStr(t.final_status),
        toolCalls: num(t.tool_call_count), toolErrors: num(t.tool_error_count), modelMs: num(t.model_ms), toolMs: num(t.tool_ms),
        requests: requests.filter(r => r.turn_id === t.turn_id).map(view),
        ...(optStr(t.task_ref) ? { taskRef: String(t.task_ref) } : {}),
        ...(interventions[i] ? { interventions: interventions[i] } : {}),
        ...(workspace.has(num(t.started_at)) ? { workspace: workspace.get(num(t.started_at)) } : {}),
      })),
    };
  }

  /**
   * Each main request's gap and tool calls (trace feature C1), read from what the session holds, so a log line read late
   * fills them in. The previous reply is the previous main request that reached the endpoint: a side request and a
   * request given up while held (it never reached it, by the one rule every count reads, givenUpWhileHeld) are no
   * reply, and have no gap.
   */
  private requestGaps(traceId: string, turns: Row[], requests: Row[]): Map<string, Pick<TraceRequestView, 'gap' | 'toolCalls'>> {
    const out = new Map<string, Pick<TraceRequestView, 'gap' | 'toolCalls'>>();
    const parts = new Map((this.db.prepare('SELECT tool_call_id, part_json FROM tool_calls WHERE trace_id = ?').all(traceId) as Row[])
      .map(r => [String(r.tool_call_id), JSON.parse(String(r.part_json)) as ToolCallPart]));
    const turnOf = new Map(turns.map(t => [String(t.turn_id), t]));
    let prevEnd: number | undefined;
    for (const r of requests) {
      if (r.side === 1) continue;
      const cancel = r.cancel_json ? JSON.parse(String(r.cancel_json)) as RequestCancel : undefined;
      if (givenUpWhileHeld({ cancel, status: optNum(r.status), attempts: optNum(r.attempts), heldMs: optNum(r.held_ms) })) continue;
      const startedAt = num(r.started_at);
      const ids = r.tool_result_ids ? JSON.parse(String(r.tool_result_ids)) as string[] : [];
      const known = ids.filter(id => parts.has(id));
      const entry: Pick<TraceRequestView, 'gap' | 'toolCalls'> = known.length ? { toolCalls: known.map(id => toolCallRecordOf(parts.get(id)!)) } : {};
      if (prevEnd !== undefined) {
        const from = prevEnd;
        const client = Math.max(0, startedAt - from);
        // Its tools' run: the union of its calls, each cut to the gap; unknown while any of them is.
        const spans = ids.map(id => (parts.has(id) ? toolCallSpan(parts.get(id)!) : undefined));
        const toolMs = spans.every(s => s !== undefined)
          ? unionMs(spans.map(s => [Math.max(from, s!.start), Math.min(startedAt, s!.start + s!.ms)]))
          : null;
        // The wait for typed words: only before the request that opens a turn, until they were typed.
        const turn = r.turn_id ? turnOf.get(String(r.turn_id)) : undefined;
        const opens = !!turn && num(r.seq) === 0;
        const typedAt = opens ? optNum(turn!.instructed_at) : undefined;
        const inputWaitMs = !opens ? 0 : typedAt === undefined ? null : Math.min(client, Math.max(0, typedAt - from));
        const inputBy: TurnAuthor | undefined = opens && typedAt !== undefined ? (isOneOf(TURN_AUTHORS, turn!.author) ? turn!.author : 'unknown') : undefined;
        let harnessMs = toolMs === null || inputWaitMs === null ? null : client - toolMs - inputWaitMs;
        if (harnessMs !== null && harnessMs < 0) harnessMs = harnessMs >= -GAP_TOLERANCE_MS ? 0 : null;
        const heldMs = num(r.held_ms);
        entry.gap = { ms: client + heldMs, toolMs, inputWaitMs, ...(inputBy ? { inputBy } : {}), heldMs, harnessMs };
      }
      if (entry.gap || entry.toolCalls) out.set(String(r.request_id), entry);
      prevEnd = startedAt + num(r.total_ms);
    }
    return out;
  }

  /**
   * Each turn's interventions, read from what the session holds (trace feature B3), nothing of it stored twice: its
   * interruptions and restarts, each on the last turn begun at or before it; the instruction after each turn, its
   * author and its delay from the turn's end to the words typed (else to the next turn's first request); and the later
   * session that took this session's task, A3's link read from that session's start, on the last turn.
   */
  private turnInterventions(traceId: string, trace: Row, turns: Row[]): Array<TurnInterventions | undefined> {
    const out: Array<TurnInterventions | undefined> = turns.map(() => undefined);
    const of = (i: number): TurnInterventions => (out[i] ??= {});
    const events = trace.interventions_json ? (JSON.parse(String(trace.interventions_json)) as InterventionEvent[]) : [];
    for (const e of [...events].sort((a, b) => a.at - b.at)) {
      let i = -1;
      turns.forEach((t, k) => { if (num(t.started_at) <= e.at) i = k; });
      if (i < 0) continue;
      // Only values of the closed lists: a store an older or edited build wrote may hold others, which never leave.
      if (e.kind === 'interrupted' && isOneOf(INTERRUPTED_BY, e.by) && isOneOf(INTERVENTION_DURING, e.during)) {
        const iv = of(i);
        if (!iv.interrupted) iv.interrupted = { at: e.at, by: e.by, during: e.during };
      }
      if (e.kind === 'restarted' && isOneOf(RESTARTED_BY, e.by)) {
        const iv = of(i);
        if (!iv.restarted) iv.restarted = { at: e.at, by: e.by };
      }
    }
    for (let i = 0; i + 1 < turns.length; i++) {
      const ended = optNum(turns[i].ended_at);
      if (ended === undefined) continue;
      const next = turns[i + 1];
      const delayMs = Math.max(0, (optNum(next.instructed_at) ?? num(next.started_at)) - ended);
      const iv = of(i);
      const by: TurnAuthor = isOneOf(TURN_AUTHORS, next.author) ? next.author : 'unknown';
      // The raw delay, a fraction of seconds: never rounded.
      iv.next = { by, delaySec: delayMs / 1000 };
      if (turns[i].final_status === 'done' && CORRECTORS.has(by) && delayMs <= CORRECTION_WINDOW_MS) iv.corrected = true;
    }
    const later = this.db.prepare(`SELECT trace_id, started_at, json_extract(start_json, '$.handedAt') AS handed FROM traces
      WHERE json_extract(start_json, '$.redelegatedFrom') = ? ORDER BY started_at LIMIT 1`).get(traceId) as Row | undefined;
    if (later && turns.length) of(turns.length - 1).redelegated = { to: String(later.trace_id), at: optNum(later.handed) ?? num(later.started_at) };
    return out;
  }

  /** One request's messages, decoded: the window's parts, and the raw shapes for an export. */
  requestMessages(requestId: string): {
    system?: unknown; tools?: unknown[]; input: TraceMessageView[]; output: TraceMessageView[];
    raw: { system?: unknown; tools?: unknown[]; input: unknown[]; output?: unknown };
  } | null {
    const r = this.db.prepare('SELECT system_hash, tools_hash FROM requests WHERE request_id = ?').get(requestId) as Row | undefined;
    if (!r) return null;
    const links = this.db.prepare('SELECT message_hash, direction FROM request_messages WHERE request_id = ? ORDER BY position').all(requestId) as Row[];
    const system = this.getBlob(optStr(r.system_hash));
    const tools = this.getBlob(optStr(r.tools_hash)) as unknown[] | undefined;
    const inputRaw: unknown[] = [];
    let outputRaw: unknown;
    const input: TraceMessageView[] = [];
    const output: TraceMessageView[] = [];
    for (const l of links) {
      const value = this.getBlob(String(l.message_hash));
      const items = l.direction === 'output' && Array.isArray(value) ? value : [value];
      const views = items.map(v => ({ hash: String(l.message_hash), role: roleOf(v), parts: partsOf(v) }));
      if (l.direction === 'output') { outputRaw = value; output.push(...views); } else { inputRaw.push(value); input.push(...views); }
    }
    return { system, tools, input, output, raw: { system, tools, input: inputRaw, output: outputRaw } };
  }

  /**
   * The store's size (its blobs, a fixed cost per request for the rows, and the tool calls' rows by what they hold), counts, and per project the sessions and
   * the bytes they wrote first. A blob shared by two projects counts for the one that wrote it.
   */
  stats(): { bytes: number; sessions: number; requests: number; blobs: number; oldest?: number; bodiesDropped: boolean; byProject: Array<{ projectPath: string; sessions: number; bytes: number }> } {
    const b = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stored), 0) AS s FROM blobs').get() as { n: number; s: number };
    const t = this.db.prepare('SELECT COUNT(*) AS n, MIN(started_at) AS oldest FROM traces').get() as { n: number; oldest: number | null };
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    // The tool calls' rows, by what they hold (trace feature C1): as toolCallRowBytes counts them for their session.
    const c = this.db.prepare('SELECT COALESCE(SUM(length(CAST(tool_call_id AS BLOB)) + length(CAST(part_json AS BLOB))), 0) AS s FROM tool_calls').get() as { s: number };
    // The file versions kept to measure survival count against the cap too.
    const kept = (this.db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM workspace_versions').get() as { n: number }).n;
    const byProject = this.db.prepare('SELECT project_path AS projectPath, COUNT(*) AS sessions, COALESCE(SUM(bytes), 0) AS bytes FROM traces GROUP BY project_path ORDER BY project_path').all() as Array<{ projectPath: string; sessions: number; bytes: number }>;
    return { bytes: b.s + r.n * ROW_BYTES + c.s + kept, sessions: t.n, requests: r.n, blobs: b.n, oldest: t.oldest ?? undefined, bodiesDropped: this.bodiesDropped, byProject };
  }

  private dropOrphanBlobs(): void {
    this.db.prepare(`DELETE FROM blobs WHERE hash NOT IN (SELECT message_hash FROM request_messages)
      AND hash NOT IN (SELECT system_hash FROM requests WHERE system_hash IS NOT NULL)
      AND hash NOT IN (SELECT tools_hash FROM requests WHERE tools_hash IS NOT NULL)`).run();
  }

  /**
   * Deletes the sessions, and buries each one that was there: its tombstone, owed to the back-office when the session
   * had been sent there and the reason is the user's or retention's. Called inside a transaction.
   */
  private deleteTraces(ids: string[], reason: TraceDeletionReason, at: number): number {
    let deleted = 0;
    for (const traceId of ids) {
      const sent = !!this.db.prepare('SELECT 1 FROM uploads WHERE trace_id = ?').get(traceId);
      this.db.prepare('DELETE FROM request_messages WHERE request_id IN (SELECT request_id FROM requests WHERE trace_id = ?)').run(traceId);
      this.db.prepare('DELETE FROM requests WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM typed_inputs WHERE used_by IN (SELECT turn_id FROM turns WHERE trace_id = ?)').run(traceId);
      this.db.prepare('DELETE FROM turns WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM tool_calls WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM uploads WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM mask_numbers WHERE trace_id = ?').run(traceId);
      for (const table of ['workspace_points', 'workspace_turns', 'workspace_versions', 'workspace_renames', 'workspace_final']) this.db.prepare(`DELETE FROM ${table} WHERE trace_id = ?`).run(traceId);
      this.db.prepare('DELETE FROM verdict_links WHERE trace_id = ?').run(traceId);
      const gone = this.db.prepare('DELETE FROM traces WHERE trace_id = ?').run(traceId).changes;
      if (gone) {
        this.db.prepare('INSERT INTO tombstones (trace_id, reason, at, owed) VALUES (?, ?, ?, ?)')
          .run(traceId, reason, at, sent && reason !== 'cap' ? 1 : 0);
      }
      deleted += gone;
    }
    return deleted;
  }

  /** Deletes the sessions named, or every session a filter selects; what they alone used goes with them. */
  remove(sel: { traceIds: string[] } | { filter: TraceFilter }, now = Date.now()): { deleted: number; bytesFreed: number } {
    return this.db.transaction(() => {
      const before = this.stats().bytes;
      let ids: string[];
      if ('traceIds' in sel) ids = Array.isArray(sel.traceIds) ? sel.traceIds.filter(x => typeof x === 'string') : [];
      else {
        const w = this.where(sel.filter ?? {});
        ids = (this.db.prepare(`SELECT trace_id FROM traces WHERE ${w.sql}`).all(...w.args) as Row[]).map(r => String(r.trace_id));
      }
      const deleted = this.deleteTraces(ids, 'user', now);
      this.dropOrphanBlobs();
      return { deleted, bytesFreed: Math.max(0, before - this.stats().bytes) };
    })();
  }

  /**
   * Retention, then the cap, oldest ended session first. Past the cap with only open sessions, bodies stop. Then the
   * tombstones past TOMBSTONE_DAYS go, but for those still owed to the back-office.
   */
  sweep(o: { capBytes: number; retentionDays: number; now: number }): { deleted: number; bodiesDropped: boolean } {
    return this.db.transaction(() => {
      const expired = (this.db.prepare('SELECT trace_id FROM traces WHERE ended_at IS NOT NULL AND ended_at < ?')
        .all(o.now - o.retentionDays * 86_400_000) as Row[]).map(r => String(r.trace_id));
      let deleted = this.deleteTraces(expired, 'retention', o.now);
      this.dropOrphanBlobs();
      const candidates = (this.db.prepare('SELECT trace_id FROM traces WHERE ended_at IS NOT NULL ORDER BY started_at ASC').all() as Row[]).map(r => String(r.trace_id));
      while (this.stats().bytes > o.capBytes && candidates.length) {
        deleted += this.deleteTraces([candidates.shift()!], 'cap', o.now);
        this.dropOrphanBlobs();
      }
      this.db.prepare('DELETE FROM tombstones WHERE owed = 0 AND at < ?').run(o.now - TOMBSTONE_DAYS * 86_400_000);
      this.bodiesDropped = this.stats().bytes > o.capBytes;
      return { deleted, bodiesDropped: this.bodiesDropped };
    })();
  }
}
