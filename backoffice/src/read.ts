// The readers' side (API.md § 6): read only, by cursor, for any reader the operator trusts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { type Ctx, json, authReader, ms } from './http.ts';
import { HttpError } from './body.ts';
import { encodeCursor, decodeCursor } from './cursor.ts';
import { LIMITS } from './config.ts';
import { inTx } from './db.ts';
import type { QueryResultRow } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;

const SESSION_SELECT = `install_id, session_id, agent_id, project_key, harness, harness_version, native_session_id,
  endpoint_key, endpoint_name, model, started_at, ended_at, final_status, turn_count, request_count, tokens_in, tokens_cached,
  tokens_out, mixed, unknown_turns, outcome, environment, events, start, lost_demand, lost_demand_omitted, masking_version, mask_counts, rtt_median_ms, clock_offset_ms, consent, context_window_given, output_cap_given, auto_compaction, compactions, compactions_omitted, received_at,
  (SELECT consent_training FROM installs i WHERE i.id = sessions.install_id) AS install_consent_training,
  (SELECT consent_at FROM installs i WHERE i.id = sessions.install_id) AS install_consent_at`;

function session(r: QueryResultRow) {
  return {
    install: r.install_id, sessionId: r.session_id, agentId: r.agent_id ?? undefined,
    projectKey: r.project_key ?? undefined, harness: r.harness, harnessVersion: r.harness_version ?? undefined,
    nativeSessionId: r.native_session_id ?? undefined, endpointKey: r.endpoint_key ?? undefined, endpointName: r.endpoint_name ?? undefined,
    model: r.model, startedAt: ms(r.started_at), endedAt: ms(r.ended_at), finalStatus: r.final_status, turnCount: r.turn_count,
    requestCount: r.request_count, tokensIn: r.tokens_in, tokensCached: r.tokens_cached, tokensOut: r.tokens_out, mixed: r.mixed,
    unknownTurns: r.unknown_turns, outcome: r.outcome ?? undefined, receivedAt: ms(r.received_at),
    // Always present: null is "the uploading Tars did not send it" (one before the field, or one that could not read it).
    environment: r.environment ?? null, events: r.events ?? null, start: r.start ?? null, lostDemand: r.lost_demand ?? null, lostDemandOmitted: r.lost_demand_omitted ?? null,
    maskingVersion: r.masking_version ?? null, maskCounts: r.mask_counts ?? null,
    // The session's own consent as it was recorded, and its install's current one (PUT /v1/installs/me/consent).
    consent: r.consent ?? null,
    contextWindowGiven: r.context_window_given ?? null, outputCapGiven: r.output_cap_given ?? null,
    autoCompaction: r.auto_compaction ?? null, compactions: r.compactions ?? null, compactionsOmitted: r.compactions_omitted ?? null,
    installConsent: r.install_consent_training === null || r.install_consent_training === undefined ? null : { training: r.install_consent_training, at: ms(r.install_consent_at) },
    rttMedianMs: r.rtt_median_ms ?? null, clockOffsetMs: r.clock_offset_ms ?? null,
  };
}

function q(url: URL, k: string, re?: RegExp): string | undefined {
  const v = url.searchParams.get(k);
  if (v === null || v === '') return undefined;
  if (re && !re.test(v)) throw new HttpError(400, 'bad_request', `${k} is malformed`);
  return v;
}

function cursorOf(url: URL): bigint {
  const c = decodeCursor(url.searchParams.get('cursor'));
  if (c === null) throw new HttpError(400, 'bad_request', 'cursor is malformed');
  return c;
}

function limitOf(url: URL): number {
  const l = url.searchParams.get('limit');
  if (l === null) return 100;
  const n = Number(l);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.readPage) throw new HttpError(400, 'bad_request', `limit is 1 to ${LIMITS.readPage}`);
  return n;
}

/**
 * A page of changes after the cursor, and where to start next. When the page is not full, the next
 * cursor is the highest change committed when the page was read: under the lock of db.ts, no change
 * numbered at or below it can still be on its way, so a filtered reader never rescans.
 */
async function page(ctx: Ctx, table: 'sessions' | 'tombstones' | 'install_consent_changes', seqCol: string, select: string, where: string[], args: unknown[], cursor: bigint, limit: number) {
  return inTx(ctx.db, async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const top = (await tx.query<{ n: string | null }>(`SELECT max(${seqCol})::text AS n FROM ${table}`)).rows[0]!.n;
    const all = [`${seqCol} > $1`, ...where];
    const rows = (await tx.query(`SELECT ${select}, ${seqCol}::text AS seq_text FROM ${table} WHERE ${all.join(' AND ')} ORDER BY ${seqCol} LIMIT ${limit + 1}`,
      [cursor.toString(), ...args])).rows;
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const next = more ? BigInt(shown.at(-1)!.seq_text) : [cursor, top ? BigInt(top) : 0n, shown.length ? BigInt(shown.at(-1)!.seq_text) : 0n].reduce((a, b) => (b > a ? b : a));
    return { rows: shown, nextCursor: encodeCursor(next), more };
  });
}

export async function listSessions(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  await authReader(ctx, req);
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length + 1}`)); };
  const harness = q(url, 'harness', /^.{1,40}$/), model = q(url, 'model', /^.{1,200}$/), install = q(url, 'install', UUID);
  const project = q(url, 'project', /^[0-9a-f]{1,64}$/), agent = q(url, 'agent', ID), from = q(url, 'from', /^\d{1,15}$/), to = q(url, 'to', /^\d{1,15}$/);
  if (harness) add('harness = ?', harness);
  if (model) add('model = ?', model);
  if (install) add('install_id = ?', install);
  if (project) add('project_key = ?', project);
  if (agent) add('agent_id = ?', agent);
  if (from) add('started_at >= to_timestamp(?::float8 / 1000)', from);
  if (to) add('started_at < to_timestamp(?::float8 / 1000)', to);
  const p = await page(ctx, 'sessions', 'changed_seq', SESSION_SELECT, where, args, cursorOf(url), limitOf(url));
  json(res, 200, { sessions: p.rows.map(session), nextCursor: p.nextCursor, more: p.more });
}

export async function listDeletions(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  await authReader(ctx, req);
  const p = await page(ctx, 'tombstones', 'seq', 'install_id, session_id, reason, at', [], [], cursorOf(url), limitOf(url));
  json(res, 200, {
    deletions: p.rows.map((r) => ({ install: r.install_id, sessionId: r.session_id, reason: r.reason, at: ms(r.at) })),
    nextCursor: p.nextCursor, more: p.more,
  });
}

/**
 * Every change of an install's training consent, oldest first, by the same cursor as the deletions: a reader learns
 * of an install that turned training off and then sent nothing more. A deleted install's changes go with it.
 */
export async function listConsentChanges(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  await authReader(ctx, req);
  const p = await page(ctx, 'install_consent_changes', 'seq', 'install_id, training, at', [], [], cursorOf(url), limitOf(url));
  json(res, 200, {
    changes: p.rows.map((r) => ({ install: r.install_id, training: r.training, at: ms(r.at) })),
    nextCursor: p.nextCursor, more: p.more,
  });
}

export async function getSession(ctx: Ctx, req: IncomingMessage, res: ServerResponse, install: string, sessionId: string): Promise<void> {
  await authReader(ctx, req);
  if (!UUID.test(install) || !ID.test(sessionId)) throw new HttpError(404, 'not_found');
  const s = (await ctx.db.query(`SELECT ${SESSION_SELECT} FROM sessions WHERE install_id = $1 AND session_id = $2`, [install, sessionId])).rows[0];
  if (!s) throw new HttpError(404, 'not_found');
  const args = [install, sessionId];
  const [turns, requests, refs, messages] = await Promise.all([
    ctx.db.query('SELECT * FROM turns WHERE install_id = $1 AND session_id = $2 ORDER BY turn_index', args),
    ctx.db.query('SELECT * FROM requests WHERE install_id = $1 AND session_id = $2 ORDER BY seq', args),
    ctx.db.query(`SELECT rm.request_id, rm.position, rm.hash, rm.direction FROM request_messages rm
                    JOIN requests r USING (install_id, request_id) WHERE r.install_id = $1 AND r.session_id = $2 ORDER BY rm.request_id, rm.position`, args),
    ctx.db.query(`SELECT m.* FROM messages m WHERE m.install_id = $1 AND m.hash IN (
                    SELECT rm.hash FROM request_messages rm JOIN requests r USING (install_id, request_id) WHERE r.install_id = $1 AND r.session_id = $2)
                  ORDER BY m.created_at, m.hash`, args),
  ]);
  const byRequest = new Map<string, unknown[]>();
  for (const r of refs.rows) {
    const list = byRequest.get(r.request_id) ?? [];
    list.push({ position: r.position, hash: r.hash, direction: r.direction });
    byRequest.set(r.request_id, list);
  }
  json(res, 200, {
    session: session(s),
    turns: turns.rows.map((t) => ({
      turnId: t.turn_id, sessionId: t.session_id, index: t.turn_index, startedAt: ms(t.started_at), endedAt: ms(t.ended_at),
      gapBeforeMs: t.gap_before_ms ?? undefined, requestCount: t.request_count, toolCallCount: t.tool_call_count,
      toolErrorCount: t.tool_error_count, toolMs: t.tool_ms ?? undefined, modelMs: t.model_ms ?? undefined, tokensIn: t.tokens_in,
      tokensCached: t.tokens_cached, tokensOut: t.tokens_out, finalStatus: t.final_status ?? undefined,
      finalFinishReason: t.final_finish_reason ?? undefined, author: t.author ?? undefined, authorDetail: t.author_detail ?? undefined,
      taskRef: t.task_ref ?? null, interventions: t.interventions ?? null,
      startHead: t.start_head ?? null, endHead: t.end_head ?? null, startTree: t.start_tree ?? null, endTree: t.end_tree ?? null,
      filesChanged: t.files_changed ?? null, linesAdded: t.lines_added ?? null, linesRemoved: t.lines_removed ?? null,
      changedLines: t.changed_lines ?? null, survivedLines: t.survived_lines ?? null, reverted: t.reverted ?? null,
      survivalBasis: t.survival_basis ?? null,
    })),
    requests: requests.rows.map((r) => ({ ...request(r), messages: byRequest.get(r.request_id) ?? [] })),
    messages: messages.rows.map((m) => ({
      hash: m.hash, role: m.role, createdAt: ms(m.created_at), size: m.size, toolCallCount: m.tool_call_count ?? undefined, hasThinking: m.has_thinking ?? undefined,
    })),
  });
}

function request(r: QueryResultRow) {
  return {
    requestId: r.request_id, sessionId: r.session_id, turnId: r.turn_id, seq: r.seq, upstreamRequestId: r.upstream_request_id ?? undefined,
    surface: r.surface, modelRequested: r.model_requested ?? undefined, modelServed: r.model_served ?? undefined, params: r.params ?? undefined,
    toolsHash: r.tools_hash ?? undefined, startedAt: ms(r.started_at), ttftMs: r.ttft_ms ?? undefined, totalMs: r.total_ms ?? undefined,
    tokensIn: r.tokens_in ?? undefined, tokensCached: r.tokens_cached ?? undefined, tokensOut: r.tokens_out ?? undefined,
    status: r.status ?? undefined, error: r.error ?? undefined, finishReason: r.finish_reason ?? undefined, streamed: r.streamed ?? undefined,
    side: r.side ?? null, // always present: null is "the uploading Tars did not say", which readers treat as side
    liveSessions: r.live_sessions ?? null, cancel: r.cancel ?? null,
    rttMs: r.rtt_ms ?? null, clockOffsetMs: r.clock_offset_ms ?? null, queueMs: r.queue_ms ?? null, upstreamMs: r.upstream_ms ?? null,
    contextReset: r.context_reset ?? null, gap: r.gap ?? null, toolCalls: r.tool_calls ?? null, toolCallsOmitted: r.tool_calls_omitted ?? null,
    reqBytes: r.req_bytes ?? undefined, respBytes: r.resp_bytes ?? undefined,
  };
}

export async function findRequests(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  await authReader(ctx, req);
  const up = q(url, 'upstreamRequestId', /^.{1,128}$/);
  if (!up) throw new HttpError(400, 'bad_request', 'upstreamRequestId is required');
  const rows = (await ctx.db.query('SELECT * FROM requests WHERE upstream_request_id = $1 ORDER BY started_at LIMIT 100', [up])).rows;
  json(res, 200, { requests: rows.map((r) => ({ install: r.install_id, ...request(r) })) });
}

export async function getBlob(ctx: Ctx, req: IncomingMessage, res: ServerResponse, hash: string): Promise<void> {
  await authReader(ctx, req);
  if (!HASH.test(hash)) throw new HttpError(404, 'not_found');
  const held = await ctx.db.query('SELECT 1 FROM install_blobs WHERE hash = $1 LIMIT 1', [hash]);
  const packed = held.rowCount ? ctx.blobs.get(hash) : null;
  if (!packed) throw new HttpError(404, 'not_found');
  const zstdOk = /(^|,)\s*zstd\s*(;|,|$)/i.test(String(req.headers['accept-encoding'] ?? ''));
  const body = zstdOk ? packed : zstdDecompressSync(packed);
  res.writeHead(200, {
    'content-type': 'application/octet-stream', 'content-length': String(body.length), etag: `"${hash}"`,
    'cache-control': 'private, max-age=31536000, immutable', ...(zstdOk ? { 'content-encoding': 'zstd' } : {}),
  });
  res.end(body);
}
