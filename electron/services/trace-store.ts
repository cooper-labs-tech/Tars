import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';
import {
  hashOf, instructionText, isStreamed, newToolResultIds, opensTurn, parseRequest, parseResponse, type Surface,
} from './trace-wire';
import { mergeToolCall, toolCallAt, toolCallRecordOf, toolCallSpan, type ToolCallPart, type ToolCallRecord } from './tool-calls';

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
  /** Cut before the endpoint answered: a request the harness gave up while the proxy held it (status 499). */
  cancel?: RequestCancel;
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
  gates?: Array<{ kind: string; verdict: string; at?: number }>;
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
}

export interface TraceRequestView {
  requestId: string; upstreamRequestId?: string; seq: number; surface: string; side: boolean;
  startedAt: number; ttftMs?: number; totalMs?: number; status: number; finishReason?: string; error?: string;
  tokensIn?: number; tokensCached?: number; tokensOut?: number; reqBytes: number; respBytes: number;
  newMessages: number; attempts: number; heldMs: number; bodiesDropped: boolean; cancel?: RequestCancel;
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
}

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
  main_system_hash TEXT, bytes INTEGER NOT NULL DEFAULT 0, updated_seq INTEGER NOT NULL DEFAULT 0
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
`;

/**
 * Columns added to a store after its first schema, each added where it is missing (a store an earlier build made):
 * a session's start and the demand it never received (trace feature A3), and a request's cancel.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type?: string]> = [
  ['traces', 'start_json'], ['traces', 'demand_json'], ['requests', 'cancel_json'], ['typed_inputs', 'task_ref'], ['turns', 'task_ref'],
  // Trace feature B3: a session's interventions, and when the words that opened a turn were typed.
  ['traces', 'interventions_json'], ['turns', 'instructed_at', 'INTEGER'],
  // Trace feature C1: the ids of the tool calls whose results a request newly carries.
  ['requests', 'tool_result_ids'],
];

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
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function summaryOf(r: Row): TraceSessionSummary {
  return {
    traceId: String(r.trace_id), projectPath: String(r.project_path), agentId: String(r.agent_id), agentName: optStr(r.agent_name),
    harness: String(r.harness), harnessVersion: optStr(r.harness_version), endpointId: String(r.endpoint_id), endpointName: optStr(r.endpoint_name),
    model: String(r.model), startedAt: num(r.started_at), endedAt: optNum(r.ended_at),
    finalStatus: (String(r.final_status) as TraceSessionSummary['finalStatus']),
    turnCount: num(r.turn_count), requestCount: num(r.request_count),
    tokensIn: num(r.tokens_in), tokensCached: num(r.tokens_cached), tokensOut: num(r.tokens_out),
    bytes: num(r.bytes), mixed: r.mixed === 1, unknownTurns: num(r.unknown_turns),
  };
}

/** A session's lost demand as it reads: its kept drops and how many older ones it left out (none: neither). */
function demandOf(raw: unknown): { lostDemand?: LostDemand[]; lostDemandOmitted?: number } {
  if (typeof raw !== 'string' || !raw) return {};
  const value = JSON.parse(raw) as StoredDemand | LostDemand[];
  const items = Array.isArray(value) ? value : value.items ?? [];
  const omitted = Array.isArray(value) ? 0 : value.omitted ?? 0;
  return { ...(items.length ? { lostDemand: items } : {}), ...(omitted ? { lostDemandOmitted: omitted } : {}) };
}

function encodeCursor(n: number): string {
  return Buffer.from(`s:${n}`).toString('base64url');
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^s:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
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

function roleOf(message: unknown): string {
  const o = (message && typeof message === 'object' ? message : {}) as Row;
  if (typeof o.role === 'string') return o.role;
  if (typeof o.type === 'string') return o.type.endsWith('_output') ? 'tool' : 'assistant';
  return 'user';
}

export class TraceStore {
  private db: Database.Database;
  private bodiesDropped = false;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: modes do not apply */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.db.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const has = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type ?? 'TEXT'}`);
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
      endpoint_id, endpoint_name, endpoint_base_url, model, started_at, updated_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.traceId, m.projectPath, m.agentId, m.agentName ?? null, m.harness,
      m.harnessVersion ?? null, m.endpointId, m.endpointName ?? null, m.endpointBaseUrl ?? null, m.model, m.startedAt, this.nextSeq());
  }

  hasTrace(traceId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM traces WHERE trace_id = ?').get(traceId);
  }

  /** The session ended (its terminal exited): its status from its last turn, and what Tars knows of the outcome. */
  endTrace(traceId: string, endedAt: number, outcome?: TraceOutcome): void {
    const last = this.db.prepare('SELECT final_status FROM turns WHERE trace_id = ? ORDER BY turn_index DESC LIMIT 1').get(traceId) as { final_status?: string } | undefined;
    const status = last?.final_status === 'done' ? 'done' : last?.final_status === 'failed' ? 'failed' : last ? 'abandoned' : 'abandoned';
    this.db.prepare(`UPDATE traces SET ended_at = ?, final_status = ?, outcome_json = COALESCE(?, outcome_json), updated_seq = ? WHERE trace_id = ?`)
      .run(endedAt, status, outcome === undefined ? null : JSON.stringify(outcome), this.nextSeq(), traceId);
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

  /** A session uploaded as it was at `seq`. */
  markUploaded(traceId: string, seq: number, at: number): void {
    this.db.prepare(`INSERT INTO uploads (trace_id, uploaded_seq, uploaded_at) VALUES (?, ?, ?)
      ON CONFLICT(trace_id) DO UPDATE SET uploaded_seq = MAX(uploaded_seq, excluded.uploaded_seq), uploaded_at = excluded.uploaded_at`).run(traceId, seq, at);
  }

  /** A session's change sequence: what an upload of it now is keyed on. */
  seqOf(traceId: string): number | undefined {
    const r = this.db.prepare('SELECT updated_seq FROM traces WHERE trace_id = ?').get(traceId) as { updated_seq?: number } | undefined;
    return r?.updated_seq;
  }

  /** The start of the newest session in the store, if any. */
  newestStartedAt(): number | undefined {
    const r = this.db.prepare('SELECT MAX(started_at) AS m FROM traces').get() as { m: number | null };
    return r.m ?? undefined;
  }

  /** Forget every upload (the back-office deleted them, or the address changed). */
  resetUploads(): void {
    this.db.prepare('DELETE FROM uploads').run();
  }

  /**
   * `sent`: the sessions marked sent, only those started after `since` when a deletion set it, since the back-office
   * deleted the ones before it (their marks may outlive a deletion on a full disk). `pending`: every session with a
   * change not sent, opted in or not; the uploader counts what it would really send (TraceUploader.state).
   */
  uploadCounts(since?: number): { sent: number; pending: number; lastAt?: number } {
    const sent = this.db.prepare('SELECT COUNT(*) AS n, MAX(uploaded_at) AS at FROM uploads u JOIN traces t ON t.trace_id = u.trace_id WHERE t.started_at > ?')
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
    const systemHash = req && req.system !== undefined ? hashOf(req.system) : undefined;
    const hasTools = !!req?.tools && req.tools.length > 0;
    let mainSystem = optStr(trace.main_system_hash);
    if (!mainSystem && hasTools) mainSystem = systemHash ?? 'none';
    const side = !!req && (!hasTools || (systemHash ?? 'none') !== mainSystem);

    const lastTurn = this.db.prepare('SELECT * FROM turns WHERE trace_id = ? ORDER BY turn_index DESC LIMIT 1').get(rec.traceId) as Row | undefined;
    const lastEnd = optNum(trace.last_end_at);
    const opens = !side && (!lastTurn || (!!req && opensTurn(rec.surface, req.input)));
    let turnId = optStr(lastTurn?.turn_id);
    let mixed = trace.mixed === 1;
    let unknownTurns = num(trace.unknown_turns);
    let turnCount = num(trace.turn_count);
    if (opens) {
      const who = req ? this.authorFor(rec.agentId, instructionText(rec.surface, req.input), rec.startedAt) : { author: 'unknown', closed: false } as ReturnType<TraceStore['authorFor']>;
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
      finish_reason, streamed, req_bytes, resp_bytes, new_messages, attempts, held_ms, bodies_dropped, cancel_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId, rec.upstreamRequestId ?? null, rec.traceId, turnId ?? null, seqRow.n, side ? 1 : 0, rec.surface, req?.model ?? null,
      resp.modelServed ?? null, req ? JSON.stringify(req.params) : null, systemHash ?? null, toolsHash ?? null, rec.startedAt,
      ttft, total, resp.usage.input, resp.usage.cached, resp.usage.output,
      // A request the harness or Tars cut is no error of the endpoint's: its cancel says what happened. One the
      // endpoint or the proxy cut keeps its error (trace feature B3).
      rec.status, cutByCaller ? null : rec.error ?? resp.error ?? null, resp.finishReason ?? null, req?.stream ? 1 : 0, rec.requestBody.length, rec.responseBody.length,
      newMessages, rec.attempts, rec.heldMs, dropped ? 1 : 0, rec.cancel ? JSON.stringify(rec.cancel) : null);
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
    return requestId;
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
    return { sessions: rows.slice(0, limit).map(summaryOf), nextCursor: more ? Buffer.from(`o:${offset + limit}`).toString('base64url') : undefined, totals, byProject };
  }

  /** For an external trace reader: every session new or grown since the cursor, in the order it changed. */
  changes(f: TraceFilter): { sessions: TraceSessionSummary[]; nextCursor: string } {
    const w = this.where(f);
    const since = decodeCursor(f.cursor);
    const rows = this.db.prepare(`SELECT * FROM traces WHERE updated_seq > ? AND ${w.sql} ORDER BY updated_seq ASC LIMIT ?`).all(since, ...w.args, this.limitOf(f)) as Row[];
    const last = rows.length ? num(rows[rows.length - 1].updated_seq) : since;
    return { sessions: rows.map(summaryOf), nextCursor: encodeCursor(last) };
  }

  session(traceId: string): { session: TraceSessionSummary; outcome?: TraceOutcome; start?: TraceStart; lostDemand?: LostDemand[]; lostDemandOmitted?: number; turns: TraceTurnView[] } | null {
    const trace = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId) as Row | undefined;
    if (!trace) return null;
    const firstRequestAt = this.firstRequestAt(traceId);
    const start = trace.start_json
      ? { ...JSON.parse(String(trace.start_json)) as TraceStart, ...(firstRequestAt !== undefined ? { firstRequestAt } : {}) }
      : undefined;
    const turns = this.db.prepare('SELECT * FROM turns WHERE trace_id = ? ORDER BY turn_index').all(traceId) as Row[];
    const requests = this.db.prepare('SELECT * FROM requests WHERE trace_id = ? ORDER BY started_at, side, seq').all(traceId) as Row[];
    const gaps = this.requestGaps(traceId, turns, requests);
    const view = (r: Row): TraceRequestView => ({
      requestId: String(r.request_id), upstreamRequestId: optStr(r.upstream_request_id), seq: num(r.seq), surface: String(r.surface), side: r.side === 1,
      startedAt: num(r.started_at), ttftMs: optNum(r.ttft_ms), totalMs: optNum(r.total_ms), status: num(r.status),
      finishReason: optStr(r.finish_reason), error: optStr(r.error), tokensIn: optNum(r.tokens_in), tokensCached: optNum(r.tokens_cached),
      tokensOut: optNum(r.tokens_out), reqBytes: num(r.req_bytes), respBytes: num(r.resp_bytes), newMessages: num(r.new_messages),
      attempts: num(r.attempts), heldMs: num(r.held_ms), bodiesDropped: r.bodies_dropped === 1,
      ...(r.cancel_json ? { cancel: JSON.parse(String(r.cancel_json)) as RequestCancel } : {}),
      ...gaps.get(String(r.request_id)),
    });
    const interventions = this.turnInterventions(traceId, trace, turns);
    return {
      session: summaryOf(trace),
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
        // Whole milliseconds, as every part of a gap (a call's times may have fractions; the back office takes none).
        const toolMs = spans.every(s => s !== undefined)
          ? Math.round(unionMs(spans.map(s => [Math.max(from, s!.start), Math.min(startedAt, s!.start + s!.ms)])))
          : null;
        // The wait for typed words: only before the request that opens a turn, until they were typed.
        const turn = r.turn_id ? turnOf.get(String(r.turn_id)) : undefined;
        const opens = !!turn && num(r.seq) === 0;
        const typedAt = opens ? optNum(turn!.instructed_at) : undefined;
        const inputWaitMs = !opens ? 0 : typedAt === undefined ? null : Math.min(client, Math.max(0, typedAt - from));
        const inputBy: TurnAuthor | undefined = opens && typedAt !== undefined ? (isOneOf(TURN_AUTHORS, turn!.author) ? turn!.author : 'unknown') : undefined;
        let harnessMs = toolMs === null || inputWaitMs === null ? null : client - toolMs - inputWaitMs;
        if (harnessMs !== null && harnessMs < 0) harnessMs = harnessMs >= -GAP_TOLERANCE_MS ? 0 : null;
        const heldMs = Math.round(num(r.held_ms));
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
    const byProject = this.db.prepare('SELECT project_path AS projectPath, COUNT(*) AS sessions, COALESCE(SUM(bytes), 0) AS bytes FROM traces GROUP BY project_path ORDER BY project_path').all() as Array<{ projectPath: string; sessions: number; bytes: number }>;
    return { bytes: b.s + r.n * ROW_BYTES + c.s, sessions: t.n, requests: r.n, blobs: b.n, oldest: t.oldest ?? undefined, bodiesDropped: this.bodiesDropped, byProject };
  }

  private dropOrphanBlobs(): void {
    this.db.prepare(`DELETE FROM blobs WHERE hash NOT IN (SELECT message_hash FROM request_messages)
      AND hash NOT IN (SELECT system_hash FROM requests WHERE system_hash IS NOT NULL)
      AND hash NOT IN (SELECT tools_hash FROM requests WHERE tools_hash IS NOT NULL)`).run();
  }

  private deleteTraces(ids: string[]): number {
    let deleted = 0;
    for (const traceId of ids) {
      this.db.prepare('DELETE FROM request_messages WHERE request_id IN (SELECT request_id FROM requests WHERE trace_id = ?)').run(traceId);
      this.db.prepare('DELETE FROM requests WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM typed_inputs WHERE used_by IN (SELECT turn_id FROM turns WHERE trace_id = ?)').run(traceId);
      this.db.prepare('DELETE FROM turns WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM tool_calls WHERE trace_id = ?').run(traceId);
      this.db.prepare('DELETE FROM uploads WHERE trace_id = ?').run(traceId);
      deleted += this.db.prepare('DELETE FROM traces WHERE trace_id = ?').run(traceId).changes;
    }
    return deleted;
  }

  /** Deletes the sessions named, or every session a filter selects; what they alone used goes with them. */
  remove(sel: { traceIds: string[] } | { filter: TraceFilter }): { deleted: number; bytesFreed: number } {
    return this.db.transaction(() => {
      const before = this.stats().bytes;
      let ids: string[];
      if ('traceIds' in sel) ids = Array.isArray(sel.traceIds) ? sel.traceIds.filter(x => typeof x === 'string') : [];
      else {
        const w = this.where(sel.filter ?? {});
        ids = (this.db.prepare(`SELECT trace_id FROM traces WHERE ${w.sql}`).all(...w.args) as Row[]).map(r => String(r.trace_id));
      }
      const deleted = this.deleteTraces(ids);
      this.dropOrphanBlobs();
      return { deleted, bytesFreed: Math.max(0, before - this.stats().bytes) };
    })();
  }

  /** Retention, then the cap, oldest ended session first. Past the cap with only open sessions, bodies stop. */
  sweep(o: { capBytes: number; retentionDays: number; now: number }): { deleted: number; bodiesDropped: boolean } {
    return this.db.transaction(() => {
      const expired = (this.db.prepare('SELECT trace_id FROM traces WHERE ended_at IS NOT NULL AND ended_at < ?')
        .all(o.now - o.retentionDays * 86_400_000) as Row[]).map(r => String(r.trace_id));
      let deleted = this.deleteTraces(expired);
      this.dropOrphanBlobs();
      const candidates = (this.db.prepare('SELECT trace_id FROM traces WHERE ended_at IS NOT NULL ORDER BY started_at ASC').all() as Row[]).map(r => String(r.trace_id));
      while (this.stats().bytes > o.capBytes && candidates.length) {
        deleted += this.deleteTraces([candidates.shift()!]);
        this.dropOrphanBlobs();
      }
      this.bodiesDropped = this.stats().bytes > o.capBytes;
      return { deleted, bodiesDropped: this.bodiesDropped };
    })();
  }
}
