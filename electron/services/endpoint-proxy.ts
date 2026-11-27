import * as http from 'http';
import * as https from 'https';
import { firstContentEnd, surfaceOf, type Surface } from './trace-wire';
import type { WireRecord } from './trace-store';

/**
 * The endpoint proxy (native traces): one loopback server between every harness on an inference
 * endpoint and that endpoint.
 *
 * - A harness is pointed at `http://127.0.0.1:<port>/v1` with a token of its terminal's as its API key, minted when
 *   the terminal is spawned and dead when it exits (core/agent-pty.ts). The proxy takes it as a Bearer or as
 *   `x-api-key`, and swaps it for the endpoint's real key in the same form. The key is read from the private folder
 *   per request: it never reaches a harness, an environment, a config file, a log or a record.
 * - When the endpoint asks for them (its "send session headers" option, off by default, since they name the agent and
 *   its session to the endpoint), it adds `X-Session-Id` (the trace id) and `X-Agent-Id`, overwriting any a harness
 *   sent; off, a harness's own go through as they are. With them, and only when the owner also turned on the
 *   endpoint's install header, `X-Install-Id`: the install's back-office id, while it is registered (never after a
 *   deletion), so that a deletion of the whole install can reach the endpoint's own copy. A harness's own X-Install-Id
 *   is always dropped. The endpoint's extra headers (a small fixed map the owner
 *   sets, never a credential: agents can read it) go with every request, over a harness's header of the same name;
 *   none may name the credential, the hop, the session headers or the install header (REFUSED_EXTRA_HEADERS). Nothing else changes:
 *   unknown params and response fields go through as they are, and a stream is relayed chunk by chunk as it comes. The
 *   one header it sets besides is `Accept-Encoding: identity`, so the copy it records is readable.
 * - **Pause, not fail**: before any byte of a response has reached the harness, a 503 (endpoint_busy) or a 429
 *   (rate_limited), which an endpoint answers before the request reaches its engine, or a connection that never
 *   reached the endpoint (refused, unreachable, a name not yet resolved), is held and tried again, for any method. A
 *   502 or a reset is tried again for a GET only: either can come once a POST reached the engine (a 502 after it
 *   timed out there), and sending it again would run and bill the generation twice (the owner's decision of 26/11).
 *   The wait is as `Retry-After` says (at most 60 s a wait), up to the endpoint's `holdMaxSeconds`. Past it, the last
 *   error passes as it came. The window is told while a request is held (onHold). Once a response has started,
 *   everything passes through unchanged.
 * - Once a traced response has ended, a copy of both bodies goes to the recorder, off the response's path; a
 *   recorder that fails changes nothing for the harness. With it go the time of the first byte and the time of the
 *   first token: when the chunk holding the first stream event with text, reasoning or a tool call came (a chunk
 *   with only a role, or empty, is not one), found on the copy once the response has ended, never on the relay's
 *   path. A response that is not streamed has its first byte as its first token.
 *
 * It speaks the three protocols the endpoints serve, chat completions, Responses and Anthropic Messages (with
 * count_tokens), plus `GET /v1/models`. Nothing else is forwarded.
 */

export interface ProxySession {
  token: string;
  traceId: string;
  agentId: string;
  endpointId: string;
  /** Whether this session is recorded (trace-gate.ts decided it at spawn). */
  traced: boolean;
}

export interface ProxyTarget {
  /** The approved base URL, ending before the routes (`.../v1`). */
  baseUrl: string;
  key: string | null;
  holdMaxSeconds: number;
  /** Add X-Session-Id and X-Agent-Id (the endpoint's option, off by default). */
  sendSessionHeaders?: boolean;
  /**
   * The install's back-office id, sent as X-Install-Id with the session headers: present only when the endpoint's
   * owner turned the install header on and the install is registered (inference-endpoints.ts endpointTarget).
   */
  installId?: string;
  /** The endpoint's extra headers, sent with every request (a refused name is skipped here too). */
  extraHeaders?: Record<string, string>;
}

export type HoldEvent =
  | { agentId: string; endpointId: string; since: number; attempts: number; lastStatus?: number; lastError?: string; nextTryAt: number; giveUpAt: number }
  | { agentId: string; endpointId: string; cleared: true };

export interface ProxyDeps {
  sessionOf(token: string): ProxySession | undefined;
  targetOf(endpointId: string): ProxyTarget | { refused: { status: number; type: string; message: string } };
  record?(rec: WireRecord): void;
  onHold?(e: HoldEvent): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
  maxBodyBytes?: number;
}

/** The routes forwarded, by method. */
const ROUTES: Record<string, string> = {
  '/v1/models': 'GET',
  '/v1/chat/completions': 'POST',
  '/v1/responses': 'POST',
  '/v1/messages': 'POST',
  '/v1/messages/count_tokens': 'POST',
};

/** Statuses that mean "not now", answered before the request reaches the engine: held for any method. */
const PAUSE_STATUSES = new Set([429, 503]);
/** A 502 can come once the request reached the engine: held for a GET only, like a reset. */
const PAUSE_FOR_GET_STATUSES = new Set([502]);
/** Failures where the request never reached the endpoint: held and tried again, whatever the method. */
const NOT_SENT_ERRORS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
/**
 * Failures once the request may have reached it: tried again for a GET only. A POST could already be running, and
 * sending it again would run and bill a generation twice (the Audit's L4 on #596).
 */
const MAYBE_SENT_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const MAX_WAIT_MS = 60_000;
const BACKOFF_S = [2, 4, 8, 30];
export const DEFAULT_MAX_BODY = 16 * 1024 * 1024;

/** Request headers never forwarded as the harness sent them: the hop's own, and its credential. */
/**
 * The install's back-office id (trace feature A4): set by Tars alone, for an endpoint whose owner turned it on, while the
 * install is registered. A harness's own is always dropped, whatever the endpoint's switches: no harness names an install.
 */
export const INSTALL_HEADER = 'x-install-id';
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'authorization', 'x-api-key', 'content-length', 'accept-encoding', INSTALL_HEADER]);
/** Set by Tars when the endpoint asks for them, never a harness's then. */
const SESSION_HEADERS = new Set(['x-session-id', 'x-agent-id']);
/**
 * Never an extra header (the owner's decision of 26/11): the credential (Tars sets the key), the hop's own and the
 * framing of the body (Node and Tars set them), the encoding Tars asks for, and the session headers Tars sets. Any
 * `proxy-` header too. Checked where an endpoint is saved, and skipped here as well.
 */
export const REFUSED_EXTRA_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'host', 'content-length',
  'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect',
  'accept-encoding', ...SESSION_HEADERS, INSTALL_HEADER]);
export const isRefusedExtraHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return REFUSED_EXTRA_HEADERS.has(lower) || lower.startsWith('proxy-');
};
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade']);

/** How long to wait before the next try: Retry-After in seconds or as a date, else a backoff with jitter. */
export function retryDelayMs(retryAfter: string | undefined, attempt: number, now: number): number {
  if (retryAfter !== undefined && retryAfter.trim() !== '') {
    const raw = retryAfter.trim();
    if (/^\d+$/.test(raw)) return Math.min(MAX_WAIT_MS, Math.max(0, Number(raw) * 1000));
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.min(MAX_WAIT_MS, Math.max(0, at - now));
  }
  const base = BACKOFF_S[Math.min(BACKOFF_S.length - 1, Math.max(0, attempt - 1))] * 1000;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function presentedToken(headers: http.IncomingHttpHeaders): { token: string; form: 'bearer' | 'x-api-key' } | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7) return { token: auth.slice(7).trim(), form: 'bearer' };
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) return { token: apiKey.trim(), form: 'x-api-key' };
  return null;
}

function sendError(res: http.ServerResponse, surface: Surface | null, status: number, type: string, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  const body = surface === 'anthropic_messages'
    ? { type: 'error', error: { type, message } }
    : { error: { type, message } };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface UpstreamReply { res: http.IncomingMessage }

function sendUpstream(url: URL, method: string, headers: http.OutgoingHttpHeaders, body: Buffer, signal: AbortSignal): Promise<UpstreamReply> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, signal }, res => resolve({ res }));
    req.on('error', reject);
    req.end(body.length ? body : undefined);
  });
}

function readAll(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.on('data', c => chunks.push(c as Buffer));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.concat(chunks)));
    res.on('aborted', () => resolve(Buffer.concat(chunks)));
  });
}

export function createEndpointProxy(deps: ProxyDeps): http.Server {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return http.createServer(async (req, res) => {
    const startedAt = now();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '');
    const surface = surfaceOf(pathname);

    const presented = presentedToken(req.headers);
    const session = presented ? deps.sessionOf(presented.token) : undefined;
    if (!presented || !session) {
      sendError(res, surface, 401, 'unauthorized', 'Not a token Tars gave this terminal.');
      req.resume();
      return;
    }
    if (ROUTES[pathname] !== req.method) {
      sendError(res, surface, 404, 'not_found', `Tars forwards ${Object.keys(ROUTES).join(', ')}, not ${req.method} ${pathname}.`);
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for await (const chunk of req) {
        received += (chunk as Buffer).length;
        if (received > maxBody) {
          sendError(res, surface, 413, 'too_large', `A request body is ${maxBody} bytes at most.`);
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
    } catch {
      return;
    }
    const body = Buffer.concat(chunks);

    const target = deps.targetOf(session.endpointId);
    if ('refused' in target) {
      sendError(res, surface, target.refused.status, target.refused.type, target.refused.message);
      return;
    }

    const upstreamUrl = new URL(`${target.baseUrl.replace(/\/+$/, '')}${pathname.slice('/v1'.length)}${url.search}`);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value !== undefined && !DROP_REQUEST.has(lower) && !(target.sendSessionHeaders && SESSION_HEADERS.has(lower))) headers[name] = value;
    }
    // The endpoint's own extra headers, over a harness's header of the same name.
    for (const [name, value] of Object.entries(target.extraHeaders ?? {})) {
      if (isRefusedExtraHeader(name) || typeof value !== 'string') continue;
      for (const own of Object.keys(headers)) if (own.toLowerCase() === name.toLowerCase()) delete headers[own];
      headers[name] = value;
    }
    if (target.key) {
      if (presented.form === 'x-api-key') headers['x-api-key'] = target.key;
      else headers.authorization = `Bearer ${target.key}`;
    }
    if (target.sendSessionHeaders) {
      headers['x-session-id'] = session.traceId;
      headers['x-agent-id'] = session.agentId;
      if (target.installId) headers[INSTALL_HEADER] = target.installId;
    }
    headers['accept-encoding'] = 'identity';
    if (req.method !== 'GET') headers['content-length'] = String(body.length);

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    const giveUpAt = startedAt + Math.max(0, target.holdMaxSeconds) * 1000;
    let attempts = 0;
    let held = false;
    let heldMs = 0;
    const clearHold = () => {
      if (held) deps.onHold?.({ agentId: session.agentId, endpointId: session.endpointId, cleared: true });
      held = false;
    };

    for (;;) {
      attempts++;
      let reply: UpstreamReply | undefined;
      let failure: NodeJS.ErrnoException | undefined;
      try {
        reply = await sendUpstream(upstreamUrl, req.method!, headers, body, controller.signal);
      } catch (err) {
        failure = err as NodeJS.ErrnoException;
      }
      if (controller.signal.aborted) { reply?.res.destroy(); clearHold(); return; }

      const code = failure?.code ?? '';
      const status = reply?.res.statusCode ?? 0;
      const pausing = reply
        ? PAUSE_STATUSES.has(status) || (req.method === 'GET' && PAUSE_FOR_GET_STATUSES.has(status))
        : NOT_SENT_ERRORS.has(code) || (req.method === 'GET' && MAYBE_SENT_ERRORS.has(code));
      if (pausing) {
        const retryAfter = reply?.res.headers['retry-after'];
        const delay = retryDelayMs(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter, attempts, now());
        if (now() + delay <= giveUpAt) {
          const lastStatus = reply?.res.statusCode;
          if (reply) await readAll(reply.res);
          held = true;
          deps.onHold?.({
            agentId: session.agentId, endpointId: session.endpointId, since: startedAt, attempts,
            lastStatus, lastError: failure?.code, nextTryAt: now() + delay, giveUpAt,
          });
          const before = now();
          await sleep(delay, controller.signal);
          heldMs += now() - before;
          if (controller.signal.aborted) { clearHold(); return; }
          continue;
        }
      }
      clearHold();

      if (!reply) {
        sendError(res, surface, 502, 'endpoint_unreachable', `The endpoint could not be reached (${failure?.code ?? failure?.message ?? 'no answer'}).`);
        record(null, Buffer.alloc(0), undefined, failure?.code ?? 'unreachable');
        return;
      }

      const upstream = reply.res;
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && !DROP_RESPONSE.has(name.toLowerCase())) outHeaders[name] = value;
      }
      res.writeHead(upstream.statusCode ?? 502, outHeaders);
      // A copy of the response only for a session that is recorded: an untraced stream is relayed and not held
      // (the Audit's L3 on #596).
      const keepCopy = session.traced && !!surface && !!deps.record;
      const copy: Buffer[] = [];
      // For each chunk of the copy, where it ends in the body and when it came: the first token's time is read from
      // these once the response has ended (record), so nothing is parsed on the relay's path.
      const marks: number[] = [];
      let copied = 0;
      let firstByteAt: number | undefined;
      let broken: string | undefined;
      upstream.on('data', (chunk: Buffer) => {
        if (firstByteAt === undefined) firstByteAt = now();
        if (keepCopy) { copy.push(chunk); copied += chunk.length; marks.push(copied, now()); }
        if (!res.write(chunk)) {
          upstream.pause();
          res.once('drain', () => upstream.resume());
        }
      });
      upstream.on('aborted', () => { broken = 'the endpoint closed the stream'; });
      upstream.on('error', (err) => { broken = err.message; });
      upstream.on('close', () => {
        if (!upstream.complete && !broken) broken = 'the endpoint closed the stream';
        if (broken) res.destroy(); else res.end();
        const rid = upstream.headers['x-request-id'];
        record(upstream, Buffer.concat(copy), firstByteAt, broken, Array.isArray(rid) ? rid[0] : rid, marks);
      });
      return;
    }

    function record(upstream: http.IncomingMessage | null, responseBody: Buffer, firstByteAt: number | undefined, error?: string, upstreamRequestId?: string, marks: number[] = []): void {
      if (!session!.traced || !surface || !deps.record) return;
      const rec: WireRecord = {
        traceId: session!.traceId, agentId: session!.agentId, surface, startedAt, firstByteAt, endedAt: now(),
        status: upstream?.statusCode ?? 502, contentType: upstream?.headers['content-type'], requestBody: body, responseBody,
        upstreamRequestId, attempts, heldMs, error,
      };
      setImmediate(() => {
        try {
          // The first token: the chunk that held the end of the first event with content (trace-wire.ts).
          const end = firstContentEnd(surface, rec.contentType, responseBody);
          if (end !== null) {
            for (let i = 0; i < marks.length; i += 2) if (marks[i] >= end) { rec.firstContentAt = marks[i + 1]; break; }
          }
          deps.record!(rec);
        } catch (err) { console.error(`[endpoint-proxy] not recorded: ${(err as Error).message}`); }
      });
    }
  });
}

let running: http.Server | null = null;

/** The proxy on its loopback port, once per process. */
export function startEndpointProxy(port: number, deps: ProxyDeps): http.Server {
  if (running) return running;
  running = createEndpointProxy(deps);
  // A request may last an hour (a remote host may allow that); Node's defaults would cut it at 5 minutes.
  running.requestTimeout = 0;
  running.headersTimeout = 60_000;
  running.listen(port, '127.0.0.1', () => console.log(`Endpoint proxy on http://127.0.0.1:${port}/v1`));
  running.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use: the endpoint proxy is not started` : `Endpoint proxy error: ${err.message}`);
  });
  return running;
}

export function stopEndpointProxy(): void {
  running?.close();
  running = null;
}
