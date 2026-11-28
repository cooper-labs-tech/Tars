// The install side of the API (API.md §§ 3 to 5): register, blobs, batches, delete.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { type Ctx, json, clientAddr, smallJson, readJson, authInstall, assertRoom, type Install } from './http.ts';
import { HttpError, readRaw, decodeBody } from './body.ts';
import { validateBatch, type Batch } from './batch.ts';
import { inTx, nextChange, type Tx } from './db.ts';
import { mintToken } from './tokens.ts';
import { LIMITS } from './config.ts';
import { deleteInstall, deleteSession } from './purge.ts';

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function limitsOf(s: Awaited<ReturnType<Ctx['settings']>>, install?: Install) {
  return {
    ratePerMinute: s.ratePerMinute, burst: s.burst,
    maxBatchBytes: LIMITS.batchWire, maxBatchDecodedBytes: LIMITS.batchDecoded,
    maxBlobBytes: LIMITS.blobWire, maxBlobDecodedBytes: LIMITS.blobDecoded,
    maxStoredBytes: install?.maxStoredBytes ?? s.maxStoredBytes,
  };
}

async function addrSalt(ctx: Ctx): Promise<Buffer> {
  await ctx.db.query(`INSERT INTO settings (k, v) VALUES ('addrSalt', $1) ON CONFLICT (k) DO NOTHING`, [JSON.stringify(randomBytes(32).toString('base64'))]);
  const r = await ctx.db.query<{ v: string }>(`SELECT v FROM settings WHERE k = 'addrSalt'`);
  return Buffer.from(r.rows[0]!.v, 'base64');
}

export async function register(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const s = await ctx.settings();
  if (s.registration !== 'open') throw new HttpError(403, 'registration_closed');
  await assertRoom(ctx);
  const { value } = await smallJson(req);
  const client = isRecord(value) && isRecord(value.client) ? value.client : {};
  const field = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._+-]{1,40}$/.test(v) ? v : null);
  const addrHash = createHmac('sha256', await addrSalt(ctx)).update(clientAddr(ctx, req)).digest();
  const counts = await ctx.db.query<{ mine: number; all: number }>(
    `SELECT count(*) FILTER (WHERE addr_hash = $1)::int AS mine, count(*)::int AS all FROM registrations WHERE at > now() - interval '1 hour'`, [addrHash]);
  const c = counts.rows[0]!;
  if (c.mine >= s.registrationsPerHourPerAddress || c.all >= s.registrationsPerHour) throw new HttpError(429, 'rate_limited', undefined, { retryAfter: 3600 });
  const consent = isRecord(value) && value.consent !== undefined ? consentOf(value.consent) : null;
  const id = randomUUID();
  const { token, hash } = mintToken('install');
  await inTx(ctx.db, async (tx) => {
    await tx.query('INSERT INTO installs (id, token_hash, client_name, client_version, platform) VALUES ($1, $2, $3, $4, $5)',
      [id, hash, field(client.name), field(client.version), field(client.platform)]);
    await tx.query('INSERT INTO registrations (addr_hash) VALUES ($1)', [addrHash]);
    if (consent) await recordConsent(tx, id, consent.training);
  });
  json(res, 201, { installId: id, token, limits: limitsOf(s), retentionDays: s.retentionDays });
}

/** `{training: boolean}` and nothing else, or a 400. */
function consentOf(v: unknown): { training: boolean } {
  if (!isRecord(v) || typeof v.training !== 'boolean' || Object.keys(v).some((k) => k !== 'training')) {
    throw new HttpError(400, 'bad_request', 'consent must be {training: boolean}');
  }
  return { training: v.training };
}

/**
 * An install's current training consent, and one row of the readers' consent feed for the change, numbered under
 * the change lock (db.ts) so the feed's cursor misses nothing. The rows go with the install (a foreign key).
 */
async function recordConsent(tx: Tx, installId: string, training: boolean): Promise<Date> {
  const seq = await nextChange(tx);
  const at = (await tx.query<{ at: Date }>('INSERT INTO install_consent_changes (seq, install_id, training) VALUES ($1, $2, $3) RETURNING at',
    [seq, installId, training])).rows[0]!.at;
  await tx.query('UPDATE installs SET consent_training = $2, consent_at = $3 WHERE id = $1', [installId, training, at]);
  return at;
}

export async function putConsent(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const inst = await authInstall(ctx, req);
  const { value } = await smallJson(req);
  const { training } = consentOf(value);
  const at = await inTx(ctx.db, (tx) => recordConsent(tx, inst.id, training));
  json(res, 200, { training, at: at.getTime() });
}

export async function me(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const inst = await authInstall(ctx, req);
  const r = await ctx.db.query(
    `SELECT i.created_at, i.last_seen_at, i.stored_bytes,
            (SELECT count(*)::int FROM sessions WHERE install_id = i.id) AS sessions,
            (SELECT count(*)::int FROM requests WHERE install_id = i.id) AS requests,
            (SELECT count(*)::int FROM install_blobs WHERE install_id = i.id) AS blobs
       FROM installs i WHERE i.id = $1`, [inst.id]);
  const row = r.rows[0];
  const s = await ctx.settings();
  json(res, 200, {
    installId: inst.id, createdAt: row.created_at.getTime(), lastSeenAt: row.last_seen_at?.getTime(),
    usage: { storedBytes: row.stored_bytes, sessions: row.sessions, requests: row.requests, blobs: row.blobs },
    limits: limitsOf(s, inst), retentionDays: s.retentionDays,
  });
}

export async function deleteMe(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const inst = await authInstall(ctx, req);
  const out = await deleteInstall(ctx, inst.id, 'install_deleted');
  json(res, 200, out);
}

/** One session the install sent, deleted on its word (API.md § 3): 200 whether it held it or not. */
export async function deleteOneSession(ctx: Ctx, req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
  const inst = await authInstall(ctx, req);
  if (!ID.test(sessionId)) throw new HttpError(400, 'bad_id');
  json(res, 200, await deleteSession(ctx, inst.id, sessionId));
}

export async function missingBlobs(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const inst = await authInstall(ctx, req);
  const { value } = await smallJson(req);
  const hashes: unknown = isRecord(value) ? value.hashes : undefined;
  if (!Array.isArray(hashes) || hashes.length > LIMITS.missingHashes || !hashes.every((h): h is string => typeof h === 'string' && HASH.test(h))) {
    throw new HttpError(400, 'bad_hash', `hashes: an array of at most ${LIMITS.missingHashes} sha256`);
  }
  json(res, 200, { missing: await missingFor(ctx.db, inst.id, hashes) });
}

async function missingFor(db: Ctx['db'] | Tx, installId: string, hashes: string[]): Promise<string[]> {
  if (!hashes.length) return [];
  const r = await db.query<{ h: string }>(
    `SELECT DISTINCT h FROM unnest($2::text[]) AS h
      WHERE NOT EXISTS (SELECT 1 FROM install_blobs ib WHERE ib.install_id = $1 AND ib.hash = h) ORDER BY h`, [installId, hashes]);
  return r.rows.map((x) => x.h);
}

function quota(inst: Install, s: Awaited<ReturnType<Ctx['settings']>>) {
  return inst.maxStoredBytes ?? s.maxStoredBytes;
}

export async function putBlob(ctx: Ctx, req: IncomingMessage, res: ServerResponse, hash: string): Promise<void> {
  if (!HASH.test(hash)) throw new HttpError(400, 'bad_hash');
  const inst = await authInstall(ctx, req);
  await assertRoom(ctx);
  const raw = await readRaw(req, LIMITS.blobWire);
  const data = decodeBody(raw, req.headers['content-encoding'], { wire: LIMITS.blobWire, decoded: LIMITS.blobDecoded });
  if (createHash('sha256').update(data).digest('hex') !== hash) throw new HttpError(422, 'hash_mismatch', 'the decoded body does not hash to the name it was sent under');
  const s = await ctx.settings();
  const stored = await inTx(ctx.db, async (tx) => {
    // One writer per hash at a time, across processes: the purge takes the same lock (purge.ts).
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [hash]);
    const mine = await tx.query('SELECT 1 FROM install_blobs WHERE install_id = $1 AND hash = $2', [inst.id, hash]);
    if (mine.rowCount) return null;
    const known = await tx.query<{ stored_size: number }>('SELECT stored_size FROM blobs WHERE hash = $1', [hash]);
    let size = known.rows[0]?.stored_size;
    const packed = size === undefined || !ctx.blobs.has(hash) ? zstdCompressSync(data) : null;
    if (size === undefined) size = packed!.length;
    const cur = await tx.query<{ stored_bytes: number }>('SELECT stored_bytes FROM installs WHERE id = $1 FOR UPDATE', [inst.id]);
    if (cur.rows[0]!.stored_bytes + size > quota(inst, s)) throw new HttpError(429, 'quota_exceeded', 'the install is at its stored-bytes quota', { retryAfter: 3600 });
    if (packed) ctx.blobs.put(hash, packed);
    await tx.query('INSERT INTO blobs (hash, size, stored_size) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING', [hash, data.length, size]);
    await tx.query('INSERT INTO install_blobs (install_id, hash) VALUES ($1, $2)', [inst.id, hash]);
    await tx.query('UPDATE installs SET stored_bytes = stored_bytes + $2, first_upload_at = coalesce(first_upload_at, now()) WHERE id = $1', [inst.id, size]);
    return size;
  });
  if (stored === null) json(res, 200, { stored: false });
  else json(res, 201, { stored: true, size: data.length });
}

// Column maps: JSON field, column, Postgres type of the JSON value. Times arrive as ms.
type Col = [string, string, string];
const T = (f: string, c: string): Col => [f, c, 'time'];
const SESSION_COLS: Col[] = [
  ['agentId', 'agent_id', 'text'], ['projectKey', 'project_key', 'text'], ['harness', 'harness', 'text'],
  ['harnessVersion', 'harness_version', 'text'], ['nativeSessionId', 'native_session_id', 'text'], ['endpointKey', 'endpoint_key', 'text'],
  ['endpointName', 'endpoint_name', 'text'], ['model', 'model', 'text'], T('startedAt', 'started_at'), T('endedAt', 'ended_at'),
  ['finalStatus', 'final_status', 'text'], ['turnCount', 'turn_count', 'int'], ['requestCount', 'request_count', 'int'],
  ['tokensIn', 'tokens_in', 'bigint'], ['tokensCached', 'tokens_cached', 'bigint'], ['tokensOut', 'tokens_out', 'bigint'],
  ['mixed', 'mixed', 'bool'], ['unknownTurns', 'unknown_turns', 'int'], ['outcome', 'outcome', 'jsonb'],
  ['environment', 'environment', 'jsonb'], ['events', 'events', 'jsonb'], ['start', 'start', 'jsonb'], ['lostDemand', 'lost_demand', 'jsonb'], ['lostDemandOmitted', 'lost_demand_omitted', 'int'],
  ['maskingVersion', 'masking_version', 'text'], ['maskCounts', 'mask_counts', 'jsonb'],
  ['rttMedianMs', 'rtt_median_ms', 'float8'], ['clockOffsetMs', 'clock_offset_ms', 'float8'], ['consent', 'consent', 'jsonb'],
  ['contextWindowGiven', 'context_window_given', 'int'], ['outputCapGiven', 'output_cap_given', 'int'], ['autoCompaction', 'auto_compaction', 'text'],
  ['compactions', 'compactions', 'jsonb'],
];
// What a turn changed in the repository: the heads and trees, the counts, and the survival of its lines.
const TURN_WORKSPACE: Col[] = [
  ['startHead', 'start_head', 'text'], ['endHead', 'end_head', 'text'], ['startTree', 'start_tree', 'text'], ['endTree', 'end_tree', 'text'],
  ['filesChanged', 'files_changed', 'int'], ['linesAdded', 'lines_added', 'int'], ['linesRemoved', 'lines_removed', 'int'],
  ['changedLines', 'changed_lines', 'int'], ['survivedLines', 'survived_lines', 'int'], ['reverted', 'reverted', 'bool'],
  ['survivalBasis', 'survival_basis', 'text'],
];
const TURN_COLS: Col[] = [
  ['sessionId', 'session_id', 'text'], ['index', 'turn_index', 'int'], T('startedAt', 'started_at'), T('endedAt', 'ended_at'),
  ['gapBeforeMs', 'gap_before_ms', 'bigint'], ['requestCount', 'request_count', 'int'], ['toolCallCount', 'tool_call_count', 'int'],
  ['toolErrorCount', 'tool_error_count', 'int'], ['toolMs', 'tool_ms', 'bigint'], ['modelMs', 'model_ms', 'bigint'],
  ['tokensIn', 'tokens_in', 'bigint'], ['tokensCached', 'tokens_cached', 'bigint'], ['tokensOut', 'tokens_out', 'bigint'],
  ['finalStatus', 'final_status', 'text'], ['finalFinishReason', 'final_finish_reason', 'text'], ['author', 'author', 'text'],
  ['authorDetail', 'author_detail', 'text'], ['taskRef', 'task_ref', 'text'], ['interventions', 'interventions', 'jsonb'],
  ...TURN_WORKSPACE,
];
const REQUEST_COLS: Col[] = [
  ['sessionId', 'session_id', 'text'], ['turnId', 'turn_id', 'text'], ['seq', 'seq', 'int'], ['upstreamRequestId', 'upstream_request_id', 'text'],
  ['surface', 'surface', 'text'], ['modelRequested', 'model_requested', 'text'], ['modelServed', 'model_served', 'text'],
  ['params', 'params', 'jsonb'], ['toolsHash', 'tools_hash', 'text'], T('startedAt', 'started_at'), ['ttftMs', 'ttft_ms', 'bigint'],
  ['totalMs', 'total_ms', 'bigint'], ['tokensIn', 'tokens_in', 'bigint'], ['tokensCached', 'tokens_cached', 'bigint'],
  ['tokensOut', 'tokens_out', 'bigint'], ['status', 'status', 'int'], ['error', 'error', 'text'], ['finishReason', 'finish_reason', 'text'],
  ['streamed', 'streamed', 'bool'], ['side', 'side', 'bool'], ['liveSessions', 'live_sessions', 'int'], ['cancel', 'cancel', 'jsonb'], ['rttMs', 'rtt_ms', 'float8'], ['clockOffsetMs', 'clock_offset_ms', 'float8'],
  ['queueMs', 'queue_ms', 'float8'], ['upstreamMs', 'upstream_ms', 'float8'],
  ['contextReset', 'context_reset', 'jsonb'], ['gap', 'gap', 'jsonb'], ['toolCalls', 'tool_calls', 'jsonb'], ['toolCallsOmitted', 'tool_calls_omitted', 'int'], ['reqBytes', 'req_bytes', 'bigint'], ['respBytes', 'resp_bytes', 'bigint'],
];

/** One INSERT ... SELECT FROM jsonb_to_recordset ... ON CONFLICT per table: a batch is a few queries, never one per row. */
function upsertSql(table: string, keyField: string, keyCol: string, cols: Col[], extra: { cols: string[]; vals: string[] } = { cols: [], vals: [] }): string {
  const rec = [`"${keyField}" text`, ...cols.map(([f, , t]) => `"${f}" ${t === 'time' ? 'bigint' : t}`)].join(', ');
  const val = (f: string, t: string) => (t === 'time' ? `to_timestamp(x."${f}"::float8 / 1000)` : `x."${f}"`);
  const names = ['install_id', keyCol, ...cols.map(([, c]) => c), ...extra.cols].join(', ');
  const values = ['$1', `x."${keyField}"`, ...cols.map(([f, , t]) => val(f, t)), ...extra.vals].join(', ');
  const updates = cols.map(([, c]) => `${c} = EXCLUDED.${c}`).join(', ');
  return `INSERT INTO ${table} (${names}) SELECT ${values} FROM jsonb_to_recordset($2::jsonb) AS x(${rec})
          ON CONFLICT (install_id, ${keyCol}) DO UPDATE SET ${updates}`;
}
/**
 * Columns a row sent again without keeps as they were: a client before them (or one that has not read them yet)
 * leaves them out, and that must not erase what a newer one sent. Only a value replaces a value.
 */
function keepWhenAbsent(sql: string, table: string, columns: string[]): string {
  let out = sql;
  for (const c of columns) {
    const next = out.replace(`${c} = EXCLUDED.${c}`, `${c} = coalesce(EXCLUDED.${c}, ${table}.${c})`);
    if (next === out) throw new Error(`${table}.${c} is not an updated column`);
    out = next;
  }
  return out;
}
const SQL = {
  sessions: keepWhenAbsent(upsertSql('sessions', 'sessionId', 'session_id', SESSION_COLS, { cols: ['changed_seq'], vals: [`nextval('change_seq')`] }).replace(
    /DO UPDATE SET /, 'DO UPDATE SET received_at = now(), '), 'sessions', ['environment', 'events', 'start', 'lost_demand', 'lost_demand_omitted', 'masking_version', 'mask_counts', 'rtt_median_ms', 'clock_offset_ms', 'consent', 'context_window_given', 'output_cap_given', 'auto_compaction', 'compactions']),
  turns: keepWhenAbsent(upsertSql('turns', 'turnId', 'turn_id', TURN_COLS), 'turns', ['task_ref', 'interventions', ...TURN_WORKSPACE.map(([, c]) => c)]),
  // A request sent again without its side mark keeps the one it had: only true or false replaces it.
  requests: keepWhenAbsent(upsertSql('requests', 'requestId', 'request_id', REQUEST_COLS), 'requests', ['side', 'live_sessions', 'cancel', 'rtt_ms', 'clock_offset_ms', 'queue_ms', 'upstream_ms', 'context_reset', 'gap', 'tool_calls', 'tool_calls_omitted']),
};

/** The last row of each id wins, as it would had the rows come in separate batches. */
function lastById<R extends Record<string, unknown>>(rows: R[], key: keyof R & string): R[] {
  const m = new Map<unknown, R>();
  for (const r of rows) m.set(r[key], r);
  return [...m.values()];
}

export async function putBatch(ctx: Ctx, req: IncomingMessage, res: ServerResponse, batchId: string): Promise<void> {
  if (!ID.test(batchId)) throw new HttpError(400, 'bad_id');
  const inst = await authInstall(ctx, req);
  await assertRoom(ctx);
  const { value, bytes } = await readJson(req, LIMITS.batchWire, LIMITS.batchDecoded);
  const v = validateBatch(value);
  if ('errors' in v) throw new HttpError(422, 'invalid_batch', 'the batch does not match API.md § 5', { details: v.errors });
  const b: Batch = { sessions: lastById(v.sessions, 'sessionId'), turns: lastById(v.turns, 'turnId'), requests: lastById(v.requests, 'requestId'), messages: lastById(v.messages, 'hash') };
  for (const r of b.requests) {
    const pos = new Set(r.messages.map((m) => m.position));
    if (pos.size !== r.messages.length) throw new HttpError(422, 'invalid_batch', undefined, { details: [`requests ${r.requestId}: positions repeat`] });
  }
  const bodySha = createHash('sha256').update(bytes).digest();
  const named = [...new Set([...b.requests.flatMap((r) => r.messages.map((m) => m.hash)), ...b.requests.flatMap((r) => (r.toolsHash ? [r.toolsHash] : []))])];
  const counts = { sessions: b.sessions.length, turns: b.turns.length, requests: b.requests.length, messages: b.messages.length };
  const s = await ctx.settings();

  const out = await inTx(ctx.db, async (tx) => {
    const fresh = await tx.query('INSERT INTO batches (install_id, batch_id, body_sha256, counts, bytes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING 1',
      [inst.id, batchId, bodySha, JSON.stringify(counts), bytes.length]);
    if (!fresh.rowCount) {
      const prev = await tx.query<{ body_sha256: Buffer; counts: typeof counts }>('SELECT body_sha256, counts FROM batches WHERE install_id = $1 AND batch_id = $2', [inst.id, batchId]);
      if (!prev.rows[0]!.body_sha256.equals(bodySha)) throw new HttpError(409, 'batch_conflict', 'this batchId was applied with a different body');
      return { replayed: true, applied: prev.rows[0]!.counts };
    }
    const cur = await tx.query<{ stored_bytes: number }>('SELECT stored_bytes FROM installs WHERE id = $1 FOR UPDATE', [inst.id]);
    if (cur.rows[0]!.stored_bytes + bytes.length > quota(inst, s)) throw new HttpError(429, 'quota_exceeded', undefined, { retryAfter: 3600 });
    if (b.sessions.length) await tx.query(SQL.sessions, [inst.id, JSON.stringify(b.sessions)]);
    const touched = [...new Set([...b.sessions, ...b.turns, ...b.requests].map((r) => r.sessionId))];
    if (touched.length) {
      const unknown = await tx.query<{ s: string }>(
        `SELECT s FROM unnest($2::text[]) AS s WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE install_id = $1 AND session_id = s)`, [inst.id, touched]);
      if (unknown.rowCount) throw new HttpError(422, 'unknown_session', 'rows name sessions this install never sent', { sessions: unknown.rows.map((r) => r.s) });
    }
    if (b.turns.length) await tx.query(SQL.turns, [inst.id, JSON.stringify(b.turns)]);
    if (b.requests.length) {
      // jsonb_to_recordset reads only the columns it names, so the messages array is simply not read here.
      await tx.query(SQL.requests, [inst.id, JSON.stringify(b.requests)]);
      await tx.query('DELETE FROM request_messages WHERE install_id = $1 AND request_id = ANY($2::text[])', [inst.id, b.requests.map((r) => r.requestId)]);
      const refs = b.requests.flatMap((r) => r.messages.map((m) => ({ ...m, requestId: r.requestId })));
      await tx.query(`INSERT INTO request_messages (install_id, request_id, position, hash, direction)
                      SELECT $1, x."requestId", x.position, x.hash, x.direction
                        FROM jsonb_to_recordset($2::jsonb) AS x("requestId" text, position int, hash text, direction text)`, [inst.id, JSON.stringify(refs)]);
    }
    if (b.messages.length) {
      await tx.query(`INSERT INTO messages (install_id, hash, role, created_at, size, tool_call_count, has_thinking)
                      SELECT $1, x.hash, x.role, to_timestamp(x."createdAt"::float8 / 1000), x.size, x."toolCallCount", x."hasThinking"
                        FROM jsonb_to_recordset($2::jsonb) AS x(hash text, role text, "createdAt" bigint, size bigint, "toolCallCount" int, "hasThinking" boolean)
                      ON CONFLICT (install_id, hash) DO NOTHING`, [inst.id, JSON.stringify(b.messages)]);
    }
    await tx.query('UPDATE installs SET stored_bytes = stored_bytes + $2, first_upload_at = coalesce(first_upload_at, now()) WHERE id = $1', [inst.id, bytes.length]);
    // Last, and briefly: the sessions' places in the readers' order (db.ts, nextChange).
    if (touched.length) {
      await tx.query('SELECT pg_advisory_xact_lock(7243001)');
      await tx.query(`UPDATE sessions SET changed_seq = nextval('change_seq') WHERE install_id = $1 AND session_id = ANY($2::text[])`, [inst.id, touched]);
    }
    return { replayed: false, applied: counts };
  });
  json(res, 200, { batchId, ...out, missingBlobs: await missingFor(ctx.db, inst.id, named) });
}
