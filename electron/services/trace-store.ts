import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';
import {
  hashOf, instructionText, opensTurn, parseRequest, parseResponse, type Surface,
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
  gates?: Array<{ kind: string; verdict: string; at?: number }>;
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

  /** The sessions with something not yet uploaded (new, or grown since), oldest change first. */
  uploadQueue(limit: number): Array<{ traceId: string; seq: number; projectPath: string; agentId: string; startedAt: number }> {
    return (this.db.prepare(`SELECT t.trace_id, t.updated_seq, t.project_path, t.agent_id, t.started_at FROM traces t
      LEFT JOIN uploads u ON u.trace_id = t.trace_id
      WHERE t.updated_seq > COALESCE(u.uploaded_seq, 0) ORDER BY t.updated_seq ASC LIMIT ?`).all(limit) as Row[])
      .map(r => ({ traceId: String(r.trace_id), seq: num(r.updated_seq), projectPath: String(r.project_path), agentId: String(r.agent_id), startedAt: num(r.started_at) }));
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
    this.db.prepare(`INSERT INTO requests (request_id, upstream_request_id, trace_id, turn_id, seq, side, surface, model_requested,
      model_served, params_json, system_hash, tools_hash, started_at, ttft_ms, total_ms, tokens_in, tokens_cached, tokens_out, status, error,
      finish_reason, streamed, req_bytes, resp_bytes, new_messages, attempts, held_ms, bodies_dropped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId, rec.upstreamRequestId ?? null, rec.traceId, turnId ?? null, seqRow.n, side ? 1 : 0, rec.surface, req?.model ?? null,
      resp.modelServed ?? null, req ? JSON.stringify(req.params) : null, systemHash ?? null, toolsHash ?? null, rec.startedAt,
      rec.firstByteAt !== undefined ? rec.firstByteAt - rec.startedAt : null, total, resp.usage.input, resp.usage.cached, resp.usage.output,
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
    const byProject = this.db.prepare('SELECT project_path AS projectPath, COUNT(*) AS sessions, COALESCE(SUM(bytes), 0) AS bytes FROM traces GROUP BY project_path ORDER BY project_path').all() as Array<{ projectPath: string; sessions: number; bytes: number }>;
    return { bytes: b.s + r.n * ROW_BYTES, sessions: t.n, requests: r.n, blobs: b.n, oldest: t.oldest ?? undefined, bodiesDropped: this.bodiesDropped, byProject };
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
