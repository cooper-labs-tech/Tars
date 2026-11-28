import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';
import {
  hashOf, instructionText, isStreamed, opensTurn, parseRequest, parseResponse, type Surface,
} from './trace-wire';

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
}

export interface TypedInput {
  agentId: string;
  at: number;
  /** user | orchestrator | chat | relay | agent | tars */
  author: string;
  authorDetail?: string;
  text: string;
  /** The words come from a closed model (a Claude agent, say): the session becomes `mixed`. */
  closed: boolean;
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
 * absent, never guessed. Filled today: branch and head (git, in the agent's folder), heldRequests and
 * requestErrors (the proxy). task, tests and gates are filled where Tars knows them (its task ledger, a gate's
 * verdict), later.
 */
export interface TraceOutcome {
  task?: { id: string; status: string; from?: string; endedAt?: number };
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
  newMessages: number; attempts: number; heldMs: number; bodiesDropped: boolean;
}

export interface TraceTurnView {
  turnId: string; index: number; startedAt: number; endedAt?: number; gapBeforeMs?: number;
  author: string; authorDetail?: string; finalStatus?: string; toolCalls: number; toolErrors: number;
  modelMs: number; toolMs: number; requests: TraceRequestView[];
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

/** How long after its end a session's branch is still watched for a merge or a deletion (as the PR watch, 14 days). */
const WORKSPACE_FINAL_DAYS = 14;

/** The file versions one session keeps to measure survival, at most: past it a version keeps its id, not its text. */
const WORKSPACE_KEPT_BYTES = 64 * 1024 * 1024;

const WORKSPACE_COLUMNS: Record<string, string> = {
  startHead: 'start_head', startTree: 'start_tree', endHead: 'end_head', endTree: 'end_tree', files: 'files',
  linesAdded: 'lines_added', linesRemoved: 'lines_removed', changedLines: 'changed_lines', survivedLines: 'survived_lines',
  reverted: 'reverted', survivalBasis: 'survival_basis', survivalAt: 'survival_at',
};

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

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: modes do not apply */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.db.exec(SCHEMA);
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
    this.db.transaction(() => {
      this.db.prepare(`UPDATE traces SET ended_at = ?, final_status = ?, outcome_json = COALESCE(?, outcome_json), updated_seq = ? WHERE trace_id = ?`)
        .run(endedAt, status, outcome === undefined ? null : JSON.stringify(outcome), this.nextSeq(), traceId);
      // The end writes a whole outcome: the gates already linked to the session's turns go back into it, budgeted
      // against what the end wrote (the Audit's M1 at a3047a696).
      this.refreshGates(traceId);
    })();
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

  /** How many of a session's requests were held while the endpoint paused, and how many ended in an error. */
  requestCounts(traceId: string): { held: number; errors: number } {
    const r = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END), 0) AS held,
      COALESCE(SUM(CASE WHEN error IS NOT NULL OR status >= 400 THEN 1 ELSE 0 END), 0) AS errors FROM requests WHERE trace_id = ?`).get(traceId) as { held: number; errors: number };
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
  verdictCandidates(projectPath: string): Array<{ traceId: string; agentId: string; startedAt: number; turnIndex: number; startHead: string | null; endHead: string; branch: string | null }> {
    return (this.db.prepare(`SELECT w.trace_id, tr.agent_id, w.started_at, t.turn_index, w.start_head, w.end_head, json_extract(tr.outcome_json, '$.branch') AS branch
      FROM workspace_turns w JOIN turns t ON t.trace_id = w.trace_id AND t.started_at = w.started_at
      JOIN traces tr ON tr.trace_id = w.trace_id
      WHERE tr.project_path = ? AND w.end_head IS NOT NULL ORDER BY w.trace_id, t.turn_index`).all(projectPath) as Row[])
      .map(r => ({
        traceId: String(r.trace_id), agentId: String(r.agent_id), startedAt: num(r.started_at), turnIndex: num(r.turn_index),
        startHead: optStr(r.start_head) ?? null, endHead: String(r.end_head), branch: optStr(r.branch) ?? null,
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
    this.db.prepare('INSERT INTO typed_inputs (agent_id, at, author, author_detail, text_norm, closed) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.agentId, t.at, t.author, t.authorDetail ?? null, text, t.closed ? 1 : 0);
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

  private authorFor(agentId: string, instruction: string, at: number): { author: string; detail?: string; closed: boolean; id?: number } {
    const said = norm(instruction);
    if (!said) return { author: 'unknown', closed: false };
    const rows = this.db.prepare(`SELECT id, author, author_detail, text_norm, closed FROM typed_inputs
      WHERE agent_id = ? AND used_by IS NULL AND at <= ? AND at >= ? ORDER BY at DESC`).all(agentId, at + 1000, at - TYPED_INPUT_WINDOW_MS) as Row[];
    for (const r of rows) {
      const typed = String(r.text_norm);
      const head = typed.slice(0, 200);
      if (said.includes(head) || typed.includes(said)) {
        return { author: String(r.author), detail: optStr(r.author_detail), closed: r.closed === 1, id: num(r.id) };
      }
    }
    return { author: 'unknown', closed: false };
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
    const req = parseRequest(rec.surface, rec.requestBody);
    const resp = parseResponse(rec.surface, rec.status, rec.contentType, rec.responseBody);
    const { side, systemHash, mainSystem } = sideOf(trace.main_system_hash, req);

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
      this.db.prepare(`INSERT INTO turns (turn_id, trace_id, turn_index, started_at, gap_before_ms, author, author_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(turnId, rec.traceId, lastTurn ? num(lastTurn.turn_index) + 1 : 0, rec.startedAt,
        lastEnd !== undefined ? Math.max(0, rec.startedAt - lastEnd) : null, who.author, who.detail ?? null);
      if (who.id !== undefined) this.db.prepare('UPDATE typed_inputs SET used_by = ? WHERE id = ?').run(turnId, who.id);
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
    // TTFT measures the model (the owner's decision of 26/11): a stream's first token, never its first byte, which
    // may be a chunk with only a role; none when it carried no content. A response that is not streamed: its first byte.
    const ttft = rec.firstContentAt !== undefined ? rec.firstContentAt - rec.startedAt
      : isStreamed(rec.contentType, rec.responseBody.subarray(0, 64).toString('utf8')) ? null
        : rec.firstByteAt !== undefined ? rec.firstByteAt - rec.startedAt : null;
    this.db.prepare(`INSERT INTO requests (request_id, upstream_request_id, trace_id, turn_id, seq, side, surface, model_requested,
      model_served, params_json, system_hash, tools_hash, started_at, ttft_ms, total_ms, tokens_in, tokens_cached, tokens_out, status, error,
      finish_reason, streamed, req_bytes, resp_bytes, new_messages, attempts, held_ms, bodies_dropped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId, rec.upstreamRequestId ?? null, rec.traceId, turnId ?? null, seqRow.n, side ? 1 : 0, rec.surface, req?.model ?? null,
      resp.modelServed ?? null, req ? JSON.stringify(req.params) : null, systemHash ?? null, toolsHash ?? null, rec.startedAt,
      ttft, total, resp.usage.input, resp.usage.cached, resp.usage.output,
      rec.status, rec.error ?? resp.error ?? null, resp.finishReason ?? null, req?.stream ? 1 : 0, rec.requestBody.length, rec.responseBody.length,
      newMessages, rec.attempts, rec.heldMs, dropped ? 1 : 0);

    if (turnId) {
      const failed = !!(rec.error || resp.error);
      const status = failed ? 'failed' : resp.toolCalls > 0 ? 'open' : 'done';
      if (!side) {
        const toolMs = !opens && lastEnd !== undefined ? Math.max(0, rec.startedAt - lastEnd) : 0;
        this.db.prepare(`UPDATE turns SET ended_at = ?, request_count = request_count + 1, tool_call_count = tool_call_count + ?,
          tool_error_count = tool_error_count + ?, tool_ms = tool_ms + ?, model_ms = model_ms + ?, tokens_in = tokens_in + ?,
          tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ?, final_status = ?, final_finish_reason = ? WHERE turn_id = ?`)
          .run(rec.endedAt, resp.toolCalls, toolErrors, toolMs, total, resp.usage.input, resp.usage.cached, resp.usage.output, status,
            resp.finishReason ?? null, turnId);
      } else {
        this.db.prepare('UPDATE turns SET tokens_in = tokens_in + ?, tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ? WHERE turn_id = ?')
          .run(resp.usage.input, resp.usage.cached, resp.usage.output, turnId);
      }
    }
    this.db.prepare(`UPDATE traces SET request_count = request_count + 1, turn_count = ?, tokens_in = tokens_in + ?,
      tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ?, mixed = ?, unknown_turns = ?, main_system_hash = ?,
      last_end_at = CASE WHEN ? THEN last_end_at ELSE ? END, bytes = bytes + ?, updated_seq = ? WHERE trace_id = ?`).run(
      turnCount, resp.usage.input, resp.usage.cached, resp.usage.output, mixed ? 1 : 0, unknownTurns, mainSystem ?? null,
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

  session(traceId: string): { session: TraceSessionSummary; outcome?: TraceOutcome; turns: TraceTurnView[] } | null {
    const trace = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId) as Row | undefined;
    if (!trace) return null;
    const turns = this.db.prepare('SELECT * FROM turns WHERE trace_id = ? ORDER BY turn_index').all(traceId) as Row[];
    const workspace = new Map(this.workspaceTurns(traceId).map(({ startedAt, ...w }) => [startedAt, w as TurnWorkspaceView]));
    const requests = this.db.prepare('SELECT * FROM requests WHERE trace_id = ? ORDER BY started_at, side, seq').all(traceId) as Row[];
    const view = (r: Row): TraceRequestView => ({
      requestId: String(r.request_id), upstreamRequestId: optStr(r.upstream_request_id), seq: num(r.seq), surface: String(r.surface), side: r.side === 1,
      startedAt: num(r.started_at), ttftMs: optNum(r.ttft_ms), totalMs: optNum(r.total_ms), status: num(r.status),
      finishReason: optStr(r.finish_reason), error: optStr(r.error), tokensIn: optNum(r.tokens_in), tokensCached: optNum(r.tokens_cached),
      tokensOut: optNum(r.tokens_out), reqBytes: num(r.req_bytes), respBytes: num(r.resp_bytes), newMessages: num(r.new_messages),
      attempts: num(r.attempts), heldMs: num(r.held_ms), bodiesDropped: r.bodies_dropped === 1,
    });
    return {
      session: summaryOf(trace),
      outcome: trace.outcome_json ? JSON.parse(String(trace.outcome_json)) : undefined,
      turns: turns.map(t => ({
        turnId: String(t.turn_id), index: num(t.turn_index), startedAt: num(t.started_at), endedAt: optNum(t.ended_at),
        gapBeforeMs: optNum(t.gap_before_ms), author: String(t.author), authorDetail: optStr(t.author_detail), finalStatus: optStr(t.final_status),
        toolCalls: num(t.tool_call_count), toolErrors: num(t.tool_error_count), modelMs: num(t.model_ms), toolMs: num(t.tool_ms),
        requests: requests.filter(r => r.turn_id === t.turn_id).map(view),
        ...(workspace.has(num(t.started_at)) ? { workspace: workspace.get(num(t.started_at)) } : {}),
      })),
    };
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
   * The store's size (its blobs, and a fixed cost per request for the rows), counts, and per project the sessions and
   * the bytes they wrote first. A blob shared by two projects counts for the one that wrote it.
   */
  stats(): { bytes: number; sessions: number; requests: number; blobs: number; oldest?: number; bodiesDropped: boolean; byProject: Array<{ projectPath: string; sessions: number; bytes: number }> } {
    const b = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stored), 0) AS s FROM blobs').get() as { n: number; s: number };
    const t = this.db.prepare('SELECT COUNT(*) AS n, MIN(started_at) AS oldest FROM traces').get() as { n: number; oldest: number | null };
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    // The file versions kept to measure survival count against the cap too.
    const kept = (this.db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM workspace_versions').get() as { n: number }).n;
    const byProject = this.db.prepare('SELECT project_path AS projectPath, COUNT(*) AS sessions, COALESCE(SUM(bytes), 0) AS bytes FROM traces GROUP BY project_path ORDER BY project_path').all() as Array<{ projectPath: string; sessions: number; bytes: number }>;
    return { bytes: b.s + r.n * ROW_BYTES + kept, sessions: t.n, requests: r.n, blobs: b.n, oldest: t.oldest ?? undefined, bodiesDropped: this.bodiesDropped, byProject };
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
      this.db.prepare('DELETE FROM uploads WHERE trace_id = ?').run(traceId);
      for (const table of ['workspace_points', 'workspace_turns', 'workspace_versions', 'workspace_renames', 'workspace_final']) this.db.prepare(`DELETE FROM ${table} WHERE trace_id = ?`).run(traceId);
      this.db.prepare('DELETE FROM verdict_links WHERE trace_id = ?').run(traceId);
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
