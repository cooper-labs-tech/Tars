import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash, createHmac, randomBytes } from 'crypto';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';
import { canonicalJson } from './trace-wire';
import { sessionDocument } from './trace-export';
import { partsOf, type TraceStore } from './trace-store';
import { scrubValue, SCRUB_VERSION, type ScrubContext } from './trace-scrub';

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
  settings(): { url: string; consentAt?: string; since?: number; deletionOwed?: boolean; deletionBy?: 'you' | 'start' };
  /**
   * What a deletion leaves behind, kept in the settings: `since`, the moment of the user's deletion (only sessions
   * started after it are sent again: the deletion is the user's word), and whether a DELETE is still owed (asked
   * for, not yet confirmed by the back-office).
   */
  setDeletion(d: { owed: boolean; since?: number }): void;
  /**
   * Whether a session may be sent now: the trace gate as it is at this moment (trace-gate.ts), so a revoke made after
   * the session was recorded (its project or agent opted out, its pair removed, closed models left out, its
   * endpoint's traces off or the endpoint gone) holds it back.
   */
  eligible(session: { projectPath: string; agentId: string; harness: string; model: string; endpointId: string }): boolean;
  scrubContext(projectPath: string): ScrubContext;
  client: { name: string; version: string; platform: string };
  /**
   * Takes the user's consent back. Called once everything sent was deleted: without it, the next pass would register
   * again and send it all back, undoing the deletion. Sharing starts again only when the user consents again.
   * With a deletion, its bookkeeping is kept with the withdrawal, in the same write: two writes would leave, between
   * them, either the consent standing with a deletion owed or no consent and no moment of the deletion (the Audit's
   * I-1 at 965cfced0).
   */
  withdrawConsent(deletion?: { owed: boolean; since?: number; by?: 'you' | 'start' }): void;
  /** A batch's body, compressed, at most (4 MiB: half the back-office's 8 MiB, the margin it advises). */
  maxBatchBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Install { url: string; installId: string; token: string; secret: string; registeredAt: number }

/**
 * The X-Install-Id value's contract (the orchestrator's of 27/11): a lower-case canonical uuid, 8-4-4-4-12 hex, which
 * is all the endpoint reads; it ignores any other value. The upload itself takes more (any id the back-office gives),
 * and both agree only because the back-office issues randomUUID(). A canonical uuid with capitals goes lower-cased; any
 * other id sends no header, and the log says so once, so a future id format fails where it can be seen rather than
 * silently stop install-wide deletions from reaching the endpoint's copy.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadStateView {
  configured: boolean;
  consentAt?: string;
  registered: boolean;
  /**
   * The sessions a pass would send now, by its own rule: a change not sent yet, the trace gate as it is at this
   * moment (the project and the agent opted in, the endpoint there, approved and allowing traces, the pair on the
   * list, closed models left out when that is on), and started after the latest deletion's moment. A session held
   * back by the consent, the address or an owed deletion still counts here: those stop every session alike.
   */
  pendingSessions: number;
  /** The sessions sent and still on the back-office: those started after the latest deletion's moment. */
  sentSessions: number;
  lastUploadAt?: number;
  lastError?: string;
  nextTryAt?: number;
  /**
   * - `registration_closed` or `install_blocked`: the back-office takes no new install, or blocked this one; a state
   *   to say, looked at again in 6 hours.
   * - `forgotten`: the back-office no longer knows this install (a 401: the user's deletion, or its operator's).
   *   Uploads stop, the local data stays, and only the user's consent again registers a new install.
   */
  notice?: 'registration_closed' | 'install_blocked' | 'forgotten';
  /** An owed deletion was cleared because its install file is gone: said until the window acknowledges it. */
  deletionCleared: boolean;
  /** A deletion asked for and not yet confirmed by the back-office: sharing stays off until it is done. */
  deletionOwed: boolean;
  /** Whose the latest deletion is, while there is one: 'you' or 'start' (TraceSettings.uploadDeletionBy). */
  deletionBy?: 'you' | 'start';
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
/** One pass: the queue read QUEUE_PAGE rows at a time, at most PASS_PAGES pages, at most PASS_SESSIONS sent. */
const QUEUE_PAGE = 5000;
const PASS_PAGES = 200;
const PASS_SESSIONS = 2000;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export class TraceUploader {
  private readonly now: () => number;
  private readonly http: typeof fetch;
  private nextTryAt?: number;
  private failures = 0;
  private lastError?: string;
  private notice?: UploadStateView['notice'];
  private running = false;
  /** The pass under way, which a deletion stops and waits for before it deletes anything. */
  private pass?: Promise<unknown>;
  private abort?: AbortController;
  /** Deletions in progress: a counter, so two at once never clear each other's stop. */
  private halts = 0;
  /** An owed deletion cleared by itself, not yet acknowledged by the window. */
  private clearedUnsaid = false;
  /** The ids of the installs this run deleted or forgot: never told to an endpoint again (currentInstallId). */
  private readonly retired = new Set<string>();
  /** The install ids already said not to be canonical uuids, so the log says it once per id, not at every request. */
  private readonly notUuidSaid = new Set<string>();

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

  /**
   * The install file gone, or emptied, which reads as no install: a private folder that may not be written refuses
   * its unlink and takes its truncate (measured on macOS 26, the Audit's L4 at a3c07fbfa). Null once it holds, else
   * the reason, which the log says too.
   */
  private dropInstall(): string | null {
    // Its id is never told to an endpoint again in this run, even when the file will not go (currentInstallId).
    const old = this.readInstall();
    if (old && typeof old.installId === 'string') this.retired.add(old.installId);
    try {
      fs.unlinkSync(this.deps.installFile);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    }
    try {
      fs.truncateSync(this.deps.installFile, 0);
      return null;
    } catch (err) {
      const reason = describeSecretFileError(err);
      console.error(`[traces] the install file could be neither removed nor emptied: ${reason}`);
      return reason;
    }
  }

  /**
   * Whether a deletion is still owed: only while the install it was asked for is still here. With no install file
   * left there is nothing to delete with, and an owed mark would lock sharing out for good (the re-read's L1 at
   * ee4d55975): it is cleared, the moment of the deletion kept.
   */
  private owed(): boolean {
    const s = this.deps.settings();
    if (!s.deletionOwed) return false;
    if (this.readInstall()) return true;
    this.deps.setDeletion({ owed: false, since: s.since });
    this.clearedUnsaid = true;
    return false;
  }

  /**
   * The user gives up the deletion an old back-office never confirmed (it is gone, or will not answer): its install
   * is forgotten, sharing may start again, and the moment of the deletion still holds, so what was recorded before
   * it is never sent anywhere.
   */
  abandonDeletion(): { ok: true } | { ok: false; error: string } {
    // Only an owed deletion is given up: with sharing on, forgetting the install would send everything again under
    // a new one, and leave the old copy out of reach of "delete everything sent" (the re-read at e50e78564).
    if (!this.owed()) return { ok: false, error: 'No deletion is waiting for confirmation: there is nothing to give up.' };
    const kept = this.dropInstall();
    if (kept) return { ok: false, error: `Tars could not forget this install (${kept}): the deletion is still waiting.` };
    this.forgetSent('the deletion was given up');
    this.deps.setDeletion({ owed: false, since: this.deps.settings().since });
    return { ok: true };
  }

  /**
   * The install's back-office id, which the endpoint proxy tells an endpoint whose owner turned its install header on
   * (X-Install-Id, trace feature A4), so that a deletion of the whole install can reach that endpoint's own copy. Null
   * unless sharing is on (the upload notice the user agreed to names it; a deletion and a 401 both take the consent
   * back), and this install is registered with the back-office the settings name now, with no deletion owed, and was
   * registered after the latest deletion's moment (so an install file that could not be removed after a deletion is
   * never told again, in a later run either), and not deleted or forgotten in this run. The value's contract: a
   * lower-case canonical uuid (CANONICAL_UUID). Any other id gives null, and the log says so once.
   */
  currentInstallId(): string | null {
    const s = this.deps.settings();
    if (!s.url || !s.consentAt || s.deletionOwed) return null;
    const install = this.readInstall();
    if (!install || install.url !== s.url) return null;
    if (typeof install.installId !== 'string' || !CANONICAL_UUID.test(install.installId)) {
      const said = String(install.installId);
      if (!this.notUuidSaid.has(said)) {
        this.notUuidSaid.add(said);
        console.warn('[traces] the install id is not a canonical uuid: no endpoint is told it (X-Install-Id), so an install-wide deletion cannot reach an endpoint\'s own copy');
      }
      return null;
    }
    if (this.retired.has(install.installId)) return null;
    if (s.since !== undefined && !(typeof install.registeredAt === 'number' && install.registeredAt > s.since)) return null;
    // In lower case, as the header's value is pinned: one install, one spelling at the endpoint.
    return install.installId.toLowerCase();
  }

  /** Whether a deletion is owed now: for the consent check, which must not touch what the window is told. */
  isDeletionOwed(): boolean {
    return this.owed();
  }

  /** The window has said that an owed deletion cleared by itself. */
  ackDeletionCleared(): void {
    this.clearedUnsaid = false;
  }

  /** Whether a pass would send this session now: opted in now, and started after the latest deletion's moment. */
  private sendable(q: { projectPath: string; agentId: string; startedAt: number; harness: string; model: string; endpointId: string }, since: number | undefined): boolean {
    return this.deps.eligible(q) && (since === undefined || q.startedAt > since);
  }

  state(): UploadStateView {
    const owed = this.owed();
    const s = this.deps.settings();
    const counts = this.deps.store.uploadCounts(s.since);
    // What the pass would send, by the pass's own rule. The deletion's moment is in the query, so what it holds back
    // is not read; the trace gate is not (it reads the settings and the fleet), so the rest of the queue is read in
    // full on each call: one row per session with a change not sent (the Audit's I-4 at c447c1ceb).
    const pending = this.deps.store.uploadQueue(Number.MAX_SAFE_INTEGER, { since: s.since }).filter(q => this.sendable(q, s.since)).length;
    const install = this.readInstall();
    return {
      configured: !!s.url, consentAt: s.consentAt, registered: !!install && install.url === s.url,
      pendingSessions: pending, sentSessions: counts.sent, lastUploadAt: counts.lastAt,
      lastError: this.lastError, nextTryAt: this.nextTryAt, ...(this.notice ? { notice: this.notice } : {}),
      deletionCleared: this.clearedUnsaid,
      deletionOwed: owed,
      ...(s.since !== undefined && s.deletionBy ? { deletionBy: s.deletionBy } : {}),
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
    // No redirect is followed: the install token, and the session, go to the address the user set and no other.
    const signal = this.abort ? AbortSignal.any([AbortSignal.timeout(60_000), this.abort.signal]) : AbortSignal.timeout(60_000);
    const res = await this.http(`${base.replace(/\/+$/, '')}${route}`, { method, headers, body: payload ? new Uint8Array(payload) : undefined, redirect: 'manual', signal });
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) throw new HttpError(res.status, 'redirect_refused');
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
    // The secret the preview keyed with, so the preview's keys are the keys sent.
    const install: Install = { url, installId: r.installId, token: r.token, secret: this.secret(), registeredAt: this.now() };
    fs.mkdirSync(path.dirname(this.deps.installFile), { recursive: true, mode: 0o700 });
    writeSecretFileSync(this.deps.installFile, `${JSON.stringify(install)}\n`);
    this.deps.store.resetUploads();
    return install;
  }

  /** Whether a pass may go on: not halted by a deletion, the consent and the address as they were at its start. */
  private mayGoOn(url: string): boolean {
    const now = this.deps.settings();
    return this.halts === 0 && !!now.consentAt && now.url === url;
  }

  /** One pass: what is new or grew, for sessions opted in now. Never throws. */
  async runOnce(): Promise<{ sent: number; failed: number; skipped?: 'off' | 'waiting' | 'busy' }> {
    const s = this.deps.settings();
    if (!s.url || !s.consentAt || this.owed() || this.halts > 0) return { sent: 0, failed: 0, skipped: 'off' };
    if (this.nextTryAt !== undefined && this.now() < this.nextTryAt) return { sent: 0, failed: 0, skipped: 'waiting' };
    if (this.running) return { sent: 0, failed: 0, skipped: 'busy' };
    this.running = true;
    this.abort = new AbortController();
    const pass = this.passOnce(s.url);
    this.pass = pass;
    try {
      return await pass;
    } finally {
      this.running = false;
      this.abort = undefined;
      this.pass = undefined;
    }
  }

  private async passOnce(url: string): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    try {
      // The consent is read again before a registration and before each session: a deletion, or a withdrawn
      // consent, stops the pass between two calls (the re-audit's M1 at ec6951aa5).
      if (!this.mayGoOn(url)) return { sent, failed: 0 };
      let install = this.readInstall();
      if (!install || install.url !== url) install = await this.register(url);
      // The queue a page at a time, by change: a page with nothing to send (sessions of a project opted out, say) is
      // passed over, never the end (the Audit's L2 at c447c1ceb). At most PASS_SESSIONS sent in one pass.
      let afterSeq = 0;
      for (let page = 0; page < PASS_PAGES && sent < PASS_SESSIONS; page++) {
        const since = this.deps.settings().since;
        const rows = this.deps.store.uploadQueue(QUEUE_PAGE, { afterSeq, since });
        if (!rows.length) break;
        afterSeq = rows[rows.length - 1].seq;
        for (const q of rows) {
          if (sent >= PASS_SESSIONS) break;
          if (!this.sendable(q, this.deps.settings().since)) continue;
          if (!this.mayGoOn(url)) return { sent, failed: 0 };
          await this.sendSession(install, q.traceId, q.seq);
          this.deps.store.markUploaded(q.traceId, q.seq, this.now());
          sent++;
        }
        if (rows.length < QUEUE_PAGE) break;
      }
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      this.notice = undefined;
      return { sent, failed: 0 };
    } catch (err) {
      // Stopped by a deletion: no failure, no backoff.
      if (this.halts > 0) return { sent, failed: 0 };
      const e = err as HttpError;
      // The back-office no longer knows this install: never register again on our own, which would send back what
      // a deletion took away. The local data stays; the user's consent registers a new install.
      if (e instanceof HttpError && e.status === 401) {
        // The consent first: an install file that will not go must not leave sharing on.
        this.deps.withdrawConsent();
        this.dropInstall();
        this.notice = 'forgotten';
        this.lastError = 'This back-office no longer knows this Tars. Nothing is sent until you share again.';
        this.nextTryAt = undefined;
        return { sent, failed: 1 };
      }
      this.failures++;
      const backoff = Math.min(30 * 60_000, 30_000 * 2 ** (this.failures - 1));
      // A back-office closed to new installs, or one that blocked this install, is the operator's decision: a state the
      // window says plainly, looked at again in 6 hours, not an error retried on the backoff.
      if (e instanceof HttpError && e.status === 403 && (e.code === 'registration_closed' || e.code === 'install_blocked')) {
        this.notice = e.code;
        this.nextTryAt = this.now() + 6 * 3600_000;
        this.lastError = e.code === 'registration_closed' ? 'This back-office does not take new installs.' : 'This back-office blocked this install.';
        return { sent, failed: 1 };
      }
      const blocked = e instanceof HttpError && e.status === 403;
      // Retry-After when the server gives one (429 rate_limited, 503 unavailable, 507 disk_full), else the backoff.
      this.nextTryAt = this.now() + (e instanceof HttpError && e.retryAfterMs !== undefined ? e.retryAfterMs : blocked ? 3600_000 : backoff);
      this.lastError = e instanceof HttpError ? `${e.status} ${e.code}` : (err as Error).message;
      return { sent, failed: 1 };
    }
  }

  /**
   * Exactly what a session's upload sends, at this change sequence: its blobs (hash and bytes) and its batches (id and
   * body), scrubbed and keyed with the install's secret. The upload sends it, and the preview shows it, so what the
   * user consents on is what leaves (QA's gate on #596).
   */
  private buildPayload(secret: string, traceId: string, seq: number): { blobs: Map<string, Buffer>; batches: Array<{ id: string; body: Buffer }>; counts: Record<string, number> } | null {
    const doc = sessionDocument(this.deps.store, traceId);
    if (!doc) return null;
    const t = doc.trace as Record<string, unknown>;
    const projectPath = String(t.project_path ?? '');
    const ctx = this.deps.scrubContext(projectPath);
    const counts: Record<string, number> = {};
    const key = (v: string) => createHmac('sha256', secret).update(v).digest('hex');

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
      sessionId: traceId, agentId: opt(t.agent_id as string), projectKey: key(projectPath),
      harness: String(t.client), harnessVersion: opt(t.client_version as string), endpointKey: key(String(t.endpoint_id)),
      model: String(t.model), startedAt: Number(t.started_at), endedAt: opt(t.ended_at as number),
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
        // A side request (a title, a memory call: the export's own mark) is never sent as a main one.
        requestId: String(r.request_id), sessionId: traceId, turnId: String(r.turn_id), seq: i, side: r.side === true || r.side === 1,
        upstreamRequestId: opt(r.upstream_request_id as string),
        surface: String(r.surface), toolsHash: tools?.hash, startedAt: Number(r.started_at), ttftMs: opt(r.ttft_ms as number),
        totalMs: opt(r.total_ms as number), tokensIn: Number(r.tokens_in), tokensCached: Number(r.tokens_cached), tokensOut: Number(r.tokens_out),
        status: Number(r.status), error: r.error ? String(scrub(String(r.error))).slice(0, 2000) : undefined,
        finishReason: opt(r.finish_reason as string), reqBytes: Number(r.req_bytes), respBytes: Number(r.resp_bytes), messages,
      };
    });
    const messages = [...remote.values()].filter(m => m.role !== 'tools').map(m => ({
      hash: m.hash, role: m.role, createdAt: Number(t.started_at), size: m.size, toolCallCount: m.toolCallCount, hasThinking: m.hasThinking,
    }));

    // One batch per session state, or several when it is over the limit: each request names its whole history, so
    // a long session's metadata grows with the square of its requests. Each part carries the session row (an
    // upsert), the requests of that part, the turns they name and the metadata of the messages they name.
    const bodyOf = (part: typeof requests, withAllTurns: boolean) => {
      const turnIds = new Set(part.map(q => q.turnId));
      const hashes = new Set(part.flatMap(q => [...q.messages.map(m => m.hash), ...(q.toolsHash ? [q.toolsHash] : [])]));
      return Buffer.from(JSON.stringify({
        schema: 1, sessions: [session],
        turns: withAllTurns ? turns : turns.filter(x => turnIds.has(x.turnId)),
        requests: part, messages: messages.filter(m => hashes.has(m.hash)),
      }));
    };
    const limit = this.deps.maxBatchBytes ?? 4 * 1024 * 1024;
    const split = (part: typeof requests): Array<typeof requests> => {
      if (part.length <= 1 || compress(bodyOf(part, false)).body.length <= limit) return [part];
      const half = Math.ceil(part.length / 2);
      return [...split(part.slice(0, half)), ...split(part.slice(half))];
    };
    const parts = compress(bodyOf(requests, true)).body.length <= limit ? [requests] : split(requests);
    const batches = parts.map((part, k) => ({
      id: parts.length === 1 ? `${traceId}.${seq}` : `${traceId}.${seq}.${k}`,
      body: bodyOf(part, parts.length === 1 || k === 0 && part.length === requests.length),
    }));
    // A turn no request names (none today) still goes, with the last part.
    const named = new Set(requests.map(q => q.turnId));
    const alone = turns.filter(x => !named.has(x.turnId));
    if (parts.length > 1 && alone.length) {
      batches.push({ id: `${traceId}.${seq}.turns`, body: Buffer.from(JSON.stringify({ schema: 1, sessions: [session], turns: alone, requests: [], messages: [] })) });
    }
    return { blobs, batches, counts };
  }

  /** The secret projects and endpoints are keyed with: the install's, kept from before its registration. */
  private secret(): string {
    try {
      const held = JSON.parse(fs.readFileSync(this.deps.installFile, 'utf8')) as { secret?: unknown };
      if (typeof held?.secret === 'string' && held.secret.length >= 32) return held.secret;
    } catch { /* none yet */ }
    const secret = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(this.deps.installFile), { recursive: true, mode: 0o700 });
    writeSecretFileSync(this.deps.installFile, `${JSON.stringify({ secret })}\n`);
    return secret;
  }

  /** One session as its upload would send it now: the batches' bodies and the blobs' contents, decoded. */
  preview(traceId: string): { document: { batches: Array<{ batchId: string; body: unknown }>; blobs: Record<string, unknown> }; counts: Record<string, number>; scrubVersion: string } | null {
    const seq = this.deps.store.seqOf(traceId);
    if (seq === undefined) return null;
    const payload = this.buildPayload(this.secret(), traceId, seq);
    if (!payload) return null;
    return {
      document: {
        batches: payload.batches.map(b => ({ batchId: b.id, body: JSON.parse(b.body.toString('utf8')) })),
        blobs: Object.fromEntries([...payload.blobs.entries()].map(([h, b]) => [h, JSON.parse(b.toString('utf8'))])),
      },
      counts: payload.counts,
      scrubVersion: SCRUB_VERSION,
    };
  }

  private async sendSession(install: Install, traceId: string, seq: number): Promise<void> {
    const payload = this.buildPayload(install.secret, traceId, seq);
    if (!payload) return;
    const { blobs, batches } = payload;
    const all = [...blobs.keys()];
    const missing = new Set<string>();
    for (let i = 0; i < all.length; i += 1000) {
      const r = await this.call(install, install.url, 'POST', '/v1/blobs/missing', Buffer.from(JSON.stringify({ hashes: all.slice(i, i + 1000) }))) as { missing?: string[] };
      for (const h of r.missing ?? []) missing.add(h);
    }
    for (const h of missing) await this.call(install, install.url, 'PUT', `/v1/blobs/${h}`, blobs.get(h)!, false);
    for (const b of batches) {
      const answer = await this.putBatch(install, b.id, b.body);
      for (const h of answer.missingBlobs ?? []) {
        if (blobs.has(h) && !missing.has(h)) await this.call(install, install.url, 'PUT', `/v1/blobs/${h}`, blobs.get(h)!, false);
      }
    }
  }

  /** One batch, and once more under an id of its own if that id was used before with other bytes (409). */
  private async putBatch(install: Install, id: string, body: Buffer): Promise<{ missingBlobs?: string[] }> {
    try {
      return await this.call(install, install.url, 'PUT', `/v1/batches/${id}`, body) as { missingBlobs?: string[] };
    } catch (err) {
      // The same state sent before with other bytes (a .env value changed the scrubbing in between).
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      return await this.call(install, install.url, 'PUT', `/v1/batches/${id}.${this.now()}`, body) as { missingBlobs?: string[] };
    }
  }

  /**
   * Asks the back-office to delete everything this install sent, then forgets the install and the progress, and takes
   * the consent back. A pass under way is stopped first, and waited for: nothing it sends can land after the deletion.
   */
  async deleteEverywhere(): Promise<{ ok: true; deleted?: number } | { ok: false; error: string }> {
    this.halts++;
    try {
      // The consent first, with the deletion owed in the same write (the Audit's I-1 at 965cfced0): sending stops at
      // once, and stays off if the DELETE fails or never goes (the re-audit at 36690e547). Only sessions started
      // after this moment may ever go again.
      // The moment of the deletion, never earlier than the newest session it covers: a clock moved backward since
      // those sessions must not let them through on re-consent (the re-read's L2 at ee4d55975).
      // A store that cannot be read must not stop the withdrawal: the moment is then the click, the latest one Tars
      // can stand behind, as at a start (reconcileConsent).
      let newest: number | undefined;
      try {
        newest = this.deps.store.newestStartedAt();
      } catch (err) {
        console.error(`[traces] the trace store could not be read at the deletion (${describeSecretFileError(err)}): its moment is now`);
      }
      const since = Math.max(this.now(), newest ?? 0);
      this.deps.withdrawConsent(this.readInstall() ? { owed: true, since, by: 'you' } : undefined);
      this.abort?.abort();
      await this.pass?.catch(() => undefined);
      return await this.deleteNow();
    } finally {
      this.halts--;
    }
  }

  private async deleteNow(): Promise<{ ok: true; deleted?: number } | { ok: false; error: string }> {
    const install = this.readInstall();
    if (!install) return { ok: false, error: 'This install has sent nothing: there is nothing to delete.' };
    let answer: { ok: true; deleted?: number };
    try {
      const r = await this.call(install, install.url, 'DELETE', '/v1/installs/me') as { deleted?: { sessions?: number } };
      answer = { ok: true, deleted: r.deleted?.sessions };
    } catch (err) {
      // The token already gone (a deletion that went through before its answer was lost): nothing is left there.
      if (!(err instanceof HttpError && err.status === 401)) {
        return { ok: false, error: err instanceof HttpError ? `The back-office answered ${err.status} ${err.code}.` : (err as Error).message };
      }
      answer = { ok: true };
    }
    this.forget();
    this.deps.setDeletion({ owed: false, since: this.deps.settings().since });
    return answer;
  }

  /**
   * After a DELETE that went through: what is said is that it did, even when the install file will not go, or the
   * progress cannot be forgotten (a database write, which a full disk refuses; the Audit's L2 at 965cfced0). The
   * sessions sent then stay marked sent here, so none goes again, which is the safe side.
   */
  private forget(): void {
    this.dropInstall();
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.forgetSent('the deletion went through');
  }

  /**
   * What was sent forgotten, after a deletion that went through or was given up. A full disk refuses that database
   * write: the sessions sent then stay marked sent here, so none goes again, which is the safe side (every one
   * started before the deletion's moment, which holds anyway), and the reason is logged; nothing is thrown.
   */
  private forgetSent(after: string): void {
    try {
      this.deps.store.resetUploads();
    } catch (err) {
      console.error(`[traces] ${after}, and what was sent stays marked sent here: ${describeSecretFileError(err)}`);
    }
  }
}
