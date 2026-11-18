import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash, createHmac, randomBytes } from 'crypto';
import { writeSecretFileSync } from '../utils/secret-file';
import { canonicalJson } from './trace-wire';
import { sessionDocument } from './trace-export';
import { partsOf, type TraceStore } from './trace-store';
import { scrubValue, type ScrubContext } from './trace-scrub';

/**
 * Uploading opted-in traces to a back-office (the trace back-office's HTTP API v1: register, blobs, batches,
 * delete). The address is the user's setting, empty until they set one, and nothing goes before they have read what
 * leaves the machine (the consent the window records).
 *
 * - **The install** registers once (`POST /v1/installs`) and keeps, in a 0600 file of the private folder, its token
 *   and a secret that never leaves it: projects and endpoints are sent as HMAC keys of that secret, never their
 *   paths or addresses. A new address is a new install.
 * - **Per session**, as it is now: its document (trace-export.ts), every string scrubbed (trace-scrub.ts), every
 *   message, system prompt and tool set as a blob whose hash is the SHA-256 of the scrubbed canonical JSON. The blobs
 *   the server is missing are sent first (zstd), then one batch of rows whose id is the session's id and its change
 *   sequence, so a retry of the same state is replayed, never doubled.
 * - **Resumable**: what was sent is kept in the store (`uploads`), by change sequence, so a restart sends only what
 *   is new or grew. A failure waits (backoff, or Retry-After for a 429 or 503) and the next pass goes on.
 * - **Never** a session whose project or agent is not opted in at the time of sending, a person's name as a turn's
 *   author detail, an endpoint's address or key, or anything outside the traced sessions.
 */

export interface UploaderDeps {
  store: TraceStore;
  /** `~/.tars-private/traces-install.json` (0600). */
  installFile: string;
  settings(): { url: string; consentAt?: string };
  /** Whether a session may be sent now: its project and its agent opted in at this moment. */
  eligible(session: { projectPath: string; agentId: string }): boolean;
  scrubContext(projectPath: string): ScrubContext;
  client: { name: string; version: string; platform: string };
  fetch?: typeof fetch;
  now?: () => number;
}

interface Install { url: string; installId: string; token: string; secret: string; registeredAt: number }

export interface UploadStateView {
  configured: boolean;
  consentAt?: string;
  registered: boolean;
  pendingSessions: number;
  sentSessions: number;
  lastUploadAt?: number;
  lastError?: string;
  nextTryAt?: number;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs?: number) {
    super(`HTTP ${status} ${code}`);
  }
}

const zstd = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer };
function compress(body: Buffer): { body: Buffer; encoding: string } {
  return typeof zstd.zstdCompressSync === 'function' ? { body: zstd.zstdCompressSync(body), encoding: 'zstd' } : { body: zlib.gzipSync(body), encoding: 'gzip' };
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer']);
const BATCH_SESSIONS = 50;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export class TraceUploader {
  private readonly now: () => number;
  private readonly http: typeof fetch;
  private nextTryAt?: number;
  private failures = 0;
  private lastError?: string;
  private running = false;

  constructor(private readonly deps: UploaderDeps) {
    this.now = deps.now ?? Date.now;
    this.http = deps.fetch ?? fetch;
  }

  private readInstall(): Install | null {
    try {
      const i = JSON.parse(fs.readFileSync(this.deps.installFile, 'utf8')) as Install;
      return i && typeof i.token === 'string' && typeof i.secret === 'string' ? i : null;
    } catch {
      return null;
    }
  }

  state(): UploadStateView {
    const s = this.deps.settings();
    const counts = this.deps.store.uploadCounts();
    const install = this.readInstall();
    return {
      configured: !!s.url, consentAt: s.consentAt, registered: !!install && install.url === s.url,
      pendingSessions: counts.pending, sentSessions: counts.sent, lastUploadAt: counts.lastAt,
      lastError: this.lastError, nextTryAt: this.nextTryAt,
    };
  }

  private async call(install: Install | null, base: string, method: string, route: string, body?: Buffer, json = true): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (install) headers.Authorization = `Bearer ${install.token}`;
    let payload: Buffer | undefined;
    if (body) {
      const c = compress(body);
      payload = c.body;
      headers['Content-Encoding'] = c.encoding;
      headers['Content-Type'] = json ? 'application/json' : 'application/octet-stream';
    }
    const res = await this.http(`${base.replace(/\/+$/, '')}${route}`, { method, headers, body: payload ? new Uint8Array(payload) : undefined, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    if (!res.ok) {
      const ra = res.headers.get('retry-after');
      const retry = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
      throw new HttpError(res.status, String((parsed as { error?: unknown }).error ?? 'error'), retry);
    }
    return parsed;
  }

  private async register(url: string): Promise<Install> {
    const r = await this.call(null, url, 'POST', '/v1/installs', Buffer.from(JSON.stringify({ client: this.deps.client }))) as { installId: string; token: string };
    const install: Install = { url, installId: r.installId, token: r.token, secret: randomBytes(32).toString('hex'), registeredAt: this.now() };
    fs.mkdirSync(path.dirname(this.deps.installFile), { recursive: true, mode: 0o700 });
    writeSecretFileSync(this.deps.installFile, `${JSON.stringify(install)}\n`);
    this.deps.store.resetUploads();
    return install;
  }

  /** One pass: what is new or grew, for sessions opted in now. Never throws. */
  async runOnce(): Promise<{ sent: number; failed: number; skipped?: 'off' | 'waiting' | 'busy' }> {
    const s = this.deps.settings();
    if (!s.url || !s.consentAt) return { sent: 0, failed: 0, skipped: 'off' };
    if (this.nextTryAt !== undefined && this.now() < this.nextTryAt) return { sent: 0, failed: 0, skipped: 'waiting' };
    if (this.running) return { sent: 0, failed: 0, skipped: 'busy' };
    this.running = true;
    let sent = 0;
    let reRegistered = false;
    try {
      let install = this.readInstall();
      if (!install || install.url !== s.url) install = await this.register(s.url);
      // Rounds of at most BATCH_SESSIONS sessions; the queue is read wide and filtered, so sessions not opted in
      // any more never hold the others back.
      for (let round = 0; round < 40; round++) {
        const queue = this.deps.store.uploadQueue(5000).filter(q => this.deps.eligible(q)).slice(0, BATCH_SESSIONS);
        if (!queue.length) break;
        let restarted = false;
        for (const q of queue) {
          try {
            await this.sendSession(install, q.traceId, q.seq);
          } catch (err) {
            // The back-office no longer knows this install (its data went with it): register again, once a pass,
            // and send everything again under the new install.
            if (err instanceof HttpError && err.status === 401 && !reRegistered) {
              reRegistered = true;
              install = await this.register(s.url);
              restarted = true;
              break;
            }
            throw err;
          }
          this.deps.store.markUploaded(q.traceId, q.seq, this.now());
          sent++;
        }
        if (!restarted && queue.length < BATCH_SESSIONS) break;
      }
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      return { sent, failed: 0 };
    } catch (err) {
      this.failures++;
      const e = err as HttpError;
      const backoff = Math.min(30 * 60_000, 30_000 * 2 ** (this.failures - 1));
      const blocked = e instanceof HttpError && e.status === 403;
      this.nextTryAt = this.now() + (e instanceof HttpError && e.retryAfterMs !== undefined ? e.retryAfterMs : blocked ? 3600_000 : backoff);
      this.lastError = e instanceof HttpError ? `${e.status} ${e.code}` : (err as Error).message;
      return { sent, failed: 1 };
    } finally {
      this.running = false;
    }
  }

  private async sendSession(install: Install, traceId: string, seq: number): Promise<void> {
    const doc = sessionDocument(this.deps.store, traceId);
    if (!doc) return;
    const t = doc.trace as Record<string, unknown>;
    const projectPath = String(t.project_path ?? '');
    const ctx = this.deps.scrubContext(projectPath);
    const counts: Record<string, number> = {};
    const key = (v: string) => createHmac('sha256', install.secret).update(v).digest('hex');

    // Every message, system prompt and tool set as its scrubbed blob.
    const blobs = new Map<string, Buffer>();
    const remote = new Map<string, { hash: string; role: string; size: number; toolCallCount: number; hasThinking: boolean }>();
    for (const m of doc.messages) {
      const bytes = Buffer.from(canonicalJson(scrubValue(m.content, ctx, counts)));
      const hash = sha256(bytes);
      blobs.set(hash, bytes);
      const items = Array.isArray(m.content) && m.role !== 'tools' ? m.content : [m.content];
      const parts = items.flatMap(i => partsOf(i));
      remote.set(m.message_hash, {
        hash, role: ROLES.has(m.role) ? m.role : m.role === 'tools' ? 'tools' : 'assistant', size: bytes.length,
        toolCallCount: parts.filter(p => p.kind === 'tool_call').length, hasThinking: parts.some(p => p.kind === 'thinking'),
      });
    }
    const scrub = (v: unknown) => scrubValue(v, ctx, counts);
    const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

    const session = {
      sessionId: traceId, agentId: opt(t.agent_id as string), agentName: opt(t.agent_name as string), projectKey: key(`project:${projectPath}`),
      harness: String(t.client), harnessVersion: opt(t.client_version as string), endpointKey: key(`endpoint:${String(t.endpoint_id)}`),
      endpointName: opt(t.endpoint_name as string), model: String(t.model), startedAt: Number(t.started_at), endedAt: opt(t.ended_at as number),
      finalStatus: String(t.final_status), turnCount: Number(t.turn_count), requestCount: Number(t.request_count),
      tokensIn: Number(t.tokens_in), tokensCached: Number(t.tokens_cached), tokensOut: Number(t.tokens_out),
      mixed: t.mixed === true, unknownTurns: Number(t.unknown_turns ?? 0), outcome: t.outcome ? scrub(t.outcome) : undefined,
    };
    const turns = doc.turns.map(x => ({
      turnId: String(x.turn_id), sessionId: traceId, index: Number(x.turn_index), startedAt: Number(x.started_at), endedAt: opt(x.ended_at as number),
      gapBeforeMs: opt(x.gap_before_ms as number), requestCount: Number(x.request_count), toolCallCount: Number(x.tool_call_count),
      toolErrorCount: Number(x.tool_error_count), toolMs: Number(x.tool_ms), modelMs: Number(x.model_ms), tokensIn: Number(x.tokens_in),
      tokensCached: Number(x.tokens_cached), tokensOut: Number(x.tokens_out), finalStatus: opt(x.final_status as string),
      // Who wrote the turn, by kind only: the detail holds names, which the back-office never gets.
      author: String(x.author),
    }));
    const links = new Map<string, Array<{ position: number; message_hash: string; direction: string }>>();
    for (const l of doc.request_messages) {
      const list = links.get(l.request_id) ?? [];
      list.push(l);
      links.set(l.request_id, list);
    }
    const requests = doc.requests.map((r, i) => {
      const system = r.system_hash ? remote.get(String(r.system_hash)) : undefined;
      const tools = r.tools_hash ? remote.get(String(r.tools_hash)) : undefined;
      const own = (links.get(String(r.request_id)) ?? []).sort((a, b) => a.position - b.position);
      const shift = system ? 1 : 0;
      const messages = [
        ...(system ? [{ position: 0, hash: system.hash, direction: 'input' as const }] : []),
        ...own.map(l => ({ position: l.position + shift, hash: remote.get(l.message_hash)!.hash, direction: l.direction as 'input' | 'output' })),
      ];
      return {
        requestId: String(r.request_id), sessionId: traceId, turnId: String(r.turn_id), seq: i, upstreamRequestId: opt(r.upstream_request_id as string),
        surface: String(r.surface), toolsHash: tools?.hash, startedAt: Number(r.started_at), ttftMs: opt(r.ttft_ms as number),
        totalMs: opt(r.total_ms as number), tokensIn: Number(r.tokens_in), tokensCached: Number(r.tokens_cached), tokensOut: Number(r.tokens_out),
        status: Number(r.status), error: r.error ? String(scrub(String(r.error))).slice(0, 2000) : undefined,
        finishReason: opt(r.finish_reason as string), reqBytes: Number(r.req_bytes), respBytes: Number(r.resp_bytes), messages,
      };
    });
    const messages = [...remote.values()].filter(m => m.role !== 'tools').map(m => ({
      hash: m.hash, role: m.role, createdAt: Number(t.started_at), size: m.size, toolCallCount: m.toolCallCount, hasThinking: m.hasThinking,
    }));

    const all = [...blobs.keys()];
    const missing = new Set<string>();
    for (let i = 0; i < all.length; i += 1000) {
      const r = await this.call(install, install.url, 'POST', '/v1/blobs/missing', Buffer.from(JSON.stringify({ hashes: all.slice(i, i + 1000) }))) as { missing?: string[] };
      for (const h of r.missing ?? []) missing.add(h);
    }
    for (const h of missing) await this.call(install, install.url, 'PUT', `/v1/blobs/${h}`, blobs.get(h)!, false);
    const body = Buffer.from(JSON.stringify({ schema: 1, sessions: [session], turns, requests, messages }));
    let answer: { missingBlobs?: string[] };
    try {
      answer = await this.call(install, install.url, 'PUT', `/v1/batches/${traceId}.${seq}`, body) as { missingBlobs?: string[] };
    } catch (err) {
      // The same state sent before with other bytes (a .env value changed the scrubbing in between): a batch id of its own.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      answer = await this.call(install, install.url, 'PUT', `/v1/batches/${traceId}.${seq}.${this.now()}`, body) as { missingBlobs?: string[] };
    }
    for (const h of answer.missingBlobs ?? []) {
      if (blobs.has(h) && !missing.has(h)) await this.call(install, install.url, 'PUT', `/v1/blobs/${h}`, blobs.get(h)!, false);
    }
  }

  /** Asks the back-office to delete everything this install sent, then forgets the install and the progress. */
  async deleteEverywhere(): Promise<{ ok: true; deleted?: number } | { ok: false; error: string }> {
    const install = this.readInstall();
    if (!install) return { ok: false, error: 'This install has sent nothing: there is nothing to delete.' };
    try {
      const r = await this.call(install, install.url, 'DELETE', '/v1/installs/me') as { deleted?: { sessions?: number } };
      this.forget();
      return { ok: true, deleted: r.deleted?.sessions };
    } catch (err) {
      // The token already gone (a deletion that went through before its answer was lost): nothing is left there.
      if (err instanceof HttpError && err.status === 401) { this.forget(); return { ok: true }; }
      return { ok: false, error: err instanceof HttpError ? `The back-office answered ${err.status} ${err.code}.` : (err as Error).message };
    }
  }

  private forget(): void {
    fs.rmSync(this.deps.installFile, { force: true });
    this.deps.store.resetUploads();
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
  }
}
