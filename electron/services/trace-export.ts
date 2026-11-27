import { hashOf } from './trace-wire';
import type { TraceFilter, TraceStore } from './trace-store';

/**
 * Sessions in the reader's trace format tables: the export file (JSONL, one row per line, `table` naming its
 * table) and the session document the read API serves (`GET /api/traces/sessions/:id`). Tars's copy is the console
 * copy (`copy: "console"`), unmasked on the user's own machine (`masking_version: "none"`): masking and
 * pseudonyms are the relay's, on the reader's side. A message, a system prompt or a tool set shared by many
 * requests is written once, under its content hash.
 *
 * A request's `ttft_ms` is the model's first token: for a stream, the first chunk with text, reasoning or a tool call
 * (a chunk with only a role, or empty, is not one; null when the stream carried no content); for a response that is
 * not streamed, the first byte. `side` marks a side request (a title or memory call), which `request_count` leaves out.
 */

export interface SessionDocument {
  trace: Record<string, unknown>;
  turns: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  request_messages: Array<{ request_id: string; position: number; message_hash: string; direction: string }>;
  messages: Array<{ message_hash: string; role: string; content: unknown }>;
}

/** One session as v0's tables, or null when there is none. Messages are those of this session, each once. */
export function sessionDocument(store: TraceStore, traceId: string, seen: Set<string> = new Set()): SessionDocument | null {
  const s = store.session(traceId);
  if (!s) return null;
  const x = s.session;
  const doc: SessionDocument = {
    trace: {
      trace_id: x.traceId, copy: 'console', masking_version: 'none', project_path: x.projectPath, agent_id: x.agentId,
      agent_name: x.agentName ?? null, client: x.harness, client_version: x.harnessVersion ?? null, endpoint_id: x.endpointId,
      endpoint_name: x.endpointName ?? null, model: x.model, started_at: x.startedAt, ended_at: x.endedAt ?? null,
      turn_count: x.turnCount, request_count: x.requestCount, tokens_in: x.tokensIn, tokens_cached: x.tokensCached,
      tokens_out: x.tokensOut, final_status: x.finalStatus, mixed: x.mixed, unknown_turns: x.unknownTurns, outcome: s.outcome ?? null,
      // What started it and its queue times, and the tasks that left its agent's queue never to start (A3).
      start: s.start ?? null, lost_demand: s.lostDemand ?? [],
    },
    turns: [], requests: [], request_messages: [], messages: [],
  };
  const keep = (hash: string, role: string, content: unknown) => {
    if (seen.has(hash)) return;
    seen.add(hash);
    doc.messages.push({ message_hash: hash, role, content });
  };
  for (const t of s.turns) {
    const main = t.requests.filter(r => !r.side);
    doc.turns.push({
      turn_id: t.turnId, trace_id: x.traceId, turn_index: t.index, started_at: t.startedAt, ended_at: t.endedAt ?? null,
      wall_ms: t.endedAt !== undefined ? t.endedAt - t.startedAt : null, gap_before_ms: t.gapBeforeMs ?? null,
      request_count: main.length, side_request_count: t.requests.length - main.length, tool_call_count: t.toolCalls,
      tool_error_count: t.toolErrors, model_ms: t.modelMs, tool_ms: t.toolMs,
      tokens_in: t.requests.reduce((a, r) => a + (r.tokensIn ?? 0), 0), tokens_cached: t.requests.reduce((a, r) => a + (r.tokensCached ?? 0), 0),
      tokens_out: t.requests.reduce((a, r) => a + (r.tokensOut ?? 0), 0), final_status: t.finalStatus ?? null,
      author: t.author, author_detail: t.authorDetail ?? null, task_ref: t.taskRef ?? null,
    });
    for (const r of t.requests) {
      const m = store.requestMessages(r.requestId);
      const systemHash = m?.raw.system !== undefined ? hashOf(m.raw.system) : null;
      const toolsHash = m?.raw.tools !== undefined ? hashOf(m.raw.tools) : null;
      if (systemHash) keep(systemHash, 'system', m!.raw.system);
      if (toolsHash) keep(toolsHash, 'tools', m!.raw.tools);
      doc.requests.push({
        request_id: r.requestId, upstream_request_id: r.upstreamRequestId ?? null, trace_id: x.traceId, turn_id: t.turnId,
        seq: r.seq, side: r.side, surface: r.surface, started_at: r.startedAt, ttft_ms: r.ttftMs ?? null, total_ms: r.totalMs ?? null,
        tokens_in: r.tokensIn ?? 0, tokens_cached: r.tokensCached ?? 0, tokens_out: r.tokensOut ?? 0, status: r.status,
        error: r.error ?? null, finish_reason: r.finishReason ?? null, attempts: r.attempts, held_ms: r.heldMs,
        req_bytes: r.reqBytes, resp_bytes: r.respBytes, bodies_dropped: r.bodiesDropped, system_hash: systemHash, tools_hash: toolsHash,
        cancel: r.cancel ?? null,
      });
      if (!m) continue;
      const inputHashes = m.input.map(v => v.hash);
      m.raw.input.forEach((value, i) => {
        doc.request_messages.push({ request_id: r.requestId, position: i, message_hash: inputHashes[i], direction: 'input' });
        keep(inputHashes[i], m.input[i]?.role ?? 'user', value);
      });
      if (m.raw.output !== undefined && m.output.length) {
        const hash = m.output[0].hash;
        doc.request_messages.push({ request_id: r.requestId, position: m.raw.input.length, message_hash: hash, direction: 'output' });
        keep(hash, 'assistant', m.raw.output);
      }
    }
  }
  return doc;
}

/** Every session the filter selects, newest first, as JSONL lines. */
export function* traceExportLines(store: TraceStore, filter: TraceFilter): Generator<string> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = store.list({ ...filter, cursor, limit: 200 });
    for (const s of page.sessions) {
      const doc = sessionDocument(store, s.traceId, seen);
      if (!doc) continue;
      yield JSON.stringify({ table: 'traces', ...doc.trace });
      for (const t of doc.turns) yield JSON.stringify({ table: 'turns', ...t });
      for (const r of doc.requests) yield JSON.stringify({ table: 'requests', ...r });
      for (const l of doc.request_messages) yield JSON.stringify({ table: 'request_messages', ...l });
      for (const m of doc.messages) yield JSON.stringify({ table: 'messages', ...m });
    }
    cursor = page.nextCursor;
  } while (cursor);
}
