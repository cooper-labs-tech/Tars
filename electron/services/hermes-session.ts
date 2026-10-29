import { HermesConnection, resolveHermesBaseUrl, sessionToken } from '../types/hermes';
import { errorDetail, hermesRequest } from './hermes-client';

/**
 * A live Hermes conversation, instead of a cron job.
 *
 * The overseer used to talk to Hermes by rewriting a cron job's prompt,
 * triggering it, and polling for the run: about thirty seconds per turn, and a
 * Hermes session per turn, since every run of a cron job is a session of its
 * own (cron/scheduler.py: `cron_{job}_{YYYYMMDD_HHMMSS}`). The gateway has a
 * real conversation, its JSON-RPC channel, which is what Hermes's own desktop
 * app speaks:
 *
 *   1. POST /api/auth/ws-ticket           single-use, 30 seconds
 *   2. ws /api/ws?ticket=                 JSON-RPC 2.0
 *      - `session.resume {session_id: <stored id>}` -> { session_id, session_key, info }
 *      - `session.create`, the first time only -> { session_id, stored_session_id, info }
 *      - `prompt.submit {session_id, text}` -> { status }, then the turn's events
 *        as notifications, {method: 'event', params: {type, session_id, payload}},
 *        `message.complete` last, carrying the final text and how the turn ended
 *      - `session.interrupt {session_id}` stops a turn
 *
 * The session is the gateway's stored one. The overseer keeps its id
 * (overseer-store.ts) and resumes it on every new socket: after a restart, a
 * sleep, a gateway restarted. A `session_id` is only good on the socket that
 * opened it; the stored id is the conversation. Measured on 21/10 and 22/10
 * against Hermes 0.21.5 and a 0.22.2 canary, behind the basic sign-in: six turns
 * over three sockets and a gateway restart, one session. Of a stored id it no
 * longer has, 0.21.5 answers 4007 "session not found", where the canary makes
 * an empty session under that same id.
 *
 * It used to open the dashboard's terminal instead, /api/pty, and read the
 * reply off the screen. Each socket with a new attach token started a chat TUI
 * on the gateway, kept 30 minutes, and the TUI resumed the session its channel's
 * marker named or started one of its own: a session per Tars start and per
 * failed turn, and on the canary one per check-in once a terminal had been
 * reaped. The second turn on a channel was answered by the dashboard's
 * {"type":"resume"} frame, which was taken for the reply. Hundreds of sessions
 * in JeanBrasse's Hermes, his report of 21/10.
 */

/** How long a single turn may take before the caller is told it did not
 *  finish. Hermes turns are slow: a fleet question runs tools. */
const TURN_TIMEOUT_MS = 180_000;

/** How long the gateway has to answer a call that is not a turn. */
const CALL_TIMEOUT_MS = 20_000;

/** What 0.21.5 answers a `session.resume` of a stored id it does not have. */
const SESSION_NOT_FOUND = 4007;

export interface LiveSession {
  /** The session on this socket. */
  sessionId: string;
  /** The session as the gateway stores it: what the overseer keeps and resumes. */
  storedSessionId: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  cwd?: string;
  branch?: string;
}

export type LiveTurnResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** The conversation on one socket. */
export interface Conversation {
  readonly session: LiveSession;
  /** The socket is gone: the next turn opens another and resumes the session. */
  readonly closed: boolean;
  ask(prompt: string, opts?: { signal?: { aborted: boolean }; timeoutMs?: number }): Promise<LiveTurnResult>;
  close(): void;
}

/** Whether this process can open a WebSocket at all. Node 22 and Electron's
 *  main process both have one globally; if some future runtime does not, the
 *  caller falls back to the cron transport rather than failing. */
export function liveTransportAvailable(): boolean {
  return typeof WebSocket !== 'undefined';
}

/** The gateway takes no conversation socket at all: it, or a proxy before it,
 *  has none. The one failure after which a question goes to the cron job. */
export function conversationRefused(err: unknown): boolean {
  return !!err && (err as { refused?: unknown }).refused === true;
}

function refused(message: string): Error {
  return Object.assign(new Error(message), { refused: true });
}

async function mintTicket(conn: HermesConnection): Promise<string> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/auth/ws-ticket', {
    method: 'POST',
    token: sessionToken(conn),
    body: {},
  });
  // A gateway without the route has no conversation to offer.
  if (status === 404 || status === 405) throw refused(`the gateway has no WebSocket tickets (HTTP ${status})`);
  if (status >= 300) throw new Error(`the gateway refused a WebSocket ticket (HTTP ${status})`);
  const ticket = (body as { ticket?: unknown })?.ticket;
  if (typeof ticket !== 'string' || !ticket) throw new Error('the gateway returned no WebSocket ticket');
  return ticket;
}

function wsBase(conn: HermesConnection): string {
  return resolveHermesBaseUrl(conn).replace(/^http/, 'ws');
}

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; code: number; message: string };
type GatewayEvent = { type?: unknown; session_id?: unknown; payload?: Record<string, unknown> };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Open the conversation on a new socket: resume the stored session when there
 * is one, create one when there is none or the gateway no longer has it.
 *
 * `close_on_disconnect: false` so a dropped socket does not end the session on
 * the gateway, which then still holds it for the next socket.
 */
export async function openConversation(
  conn: HermesConnection,
  opts: { storedSessionId?: string; profile?: string } = {},
): Promise<Conversation> {
  const ticket = await mintTicket(conn);
  const socket = new WebSocket(`${wsBase(conn)}/api/ws?ticket=${encodeURIComponent(ticket)}`);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(refused('the gateway did not open the conversation socket')); }, CALL_TIMEOUT_MS);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(refused('could not reach the gateway conversation socket')); };
    socket.onclose = () => { clearTimeout(timer); reject(refused('the gateway closed the conversation socket')); };
  });

  let closed = false;
  let nextId = 1;
  const pending = new Map<number, (answer: Answer) => void>();
  const listeners = new Set<(event: GatewayEvent) => void>();
  const closers = new Set<() => void>();

  socket.onmessage = (message: MessageEvent) => {
    let msg: { id?: unknown; method?: unknown; params?: GatewayEvent; result?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };
    try { msg = JSON.parse(String(message.data)); } catch { return; }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const done = pending.get(msg.id)!;
      pending.delete(msg.id);
      done(msg.error
        ? { ok: false, code: Number(msg.error.code) || 0, message: str(msg.error.message) ?? 'the gateway refused the call' }
        : { ok: true, result: msg.result ?? {} });
      return;
    }
    if (msg.method === 'event' && msg.params) for (const listen of [...listeners]) listen(msg.params);
  };
  socket.onerror = () => { /* onclose follows */ };
  socket.onclose = () => {
    closed = true;
    for (const done of pending.values()) done({ ok: false, code: 0, message: 'the gateway closed the conversation' });
    pending.clear();
    for (const close of [...closers]) close();
  };

  /** The answer is handed over as the frame is read, so a turn's end that follows it in the same
   *  read is not taken for an event from before the turn. */
  const send = (method: string, params: Record<string, unknown>, onAnswer: (answer: Answer) => void): number => {
    const id = nextId++;
    if (closed) { onAnswer({ ok: false, code: 0, message: 'the gateway closed the conversation' }); return id; }
    pending.set(id, onAnswer);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  };
  const call = (method: string, params: Record<string, unknown>) => new Promise<Answer>(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, code: 0, message: `the gateway did not answer ${method}` }); }, CALL_TIMEOUT_MS);
    const id = send(method, params, answer => { clearTimeout(timer); resolve(answer); });
  });

  let opened: Record<string, unknown> | null = null;
  let stored = '';
  try {
    if (opts.storedSessionId) {
      const resumed = await call('session.resume', {
        session_id: opts.storedSessionId, source: 'tool', close_on_disconnect: false, omit_messages: true,
      });
      if (resumed.ok) {
        opened = resumed.result;
        stored = str(resumed.result.session_key) ?? opts.storedSessionId;
      } else if (resumed.code !== SESSION_NOT_FOUND) {
        throw new Error(resumed.message);
      }
    }
    if (!opened) {
      const created = await call('session.create', {
        close_on_disconnect: false, source: 'tool', ...(opts.profile ? { profile: opts.profile } : {}),
      });
      if (!created.ok) throw new Error(created.message);
      opened = created.result;
      stored = str(created.result.stored_session_id) ?? str(created.result.session_id) ?? '';
    }
  } catch (err) {
    socket.close();
    throw err;
  }

  const info = (opened.info ?? {}) as Record<string, unknown>;
  const session: LiveSession = {
    sessionId: String(opened.session_id ?? ''),
    storedSessionId: stored,
    model: str(info.model),
    provider: str(info.provider),
    reasoningEffort: str(info.reasoning_effort),
    cwd: str(info.cwd),
    branch: str(info.branch),
  };

  /**
   * One turn: the prompt submitted, and the answer read from the turn's own
   * `message.complete`. A prompt queued behind a turn still running (one this
   * socket gave up on) is answered after that turn's end, which is skipped.
   * A turn given up on, at its timeout or by a pause, is interrupted on the
   * gateway rather than left to run.
   */
  const ask = (prompt: string, askOpts: { signal?: { aborted: boolean }; timeoutMs?: number } = {}) => new Promise<LiveTurnResult>(resolve => {
    let settled = false;
    let submitted = false;
    let skip = 0;
    const finish = (value: LiveTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(abortPoll);
      listeners.delete(onEvent);
      closers.delete(onClose);
      resolve(value);
    };
    const stop = (error: string) => {
      void call('session.interrupt', { session_id: session.sessionId });
      finish({ ok: false, error });
    };
    const onClose = () => finish({ ok: false, error: 'the gateway closed the conversation' });
    const onEvent = (event: GatewayEvent) => {
      if (!submitted || event.type !== 'message.complete' || event.session_id !== session.sessionId) return;
      if (skip > 0) { skip--; return; }
      const payload = event.payload ?? {};
      const status = str(payload.status) ?? 'complete';
      if (status !== 'complete') {
        finish({ ok: false, error: str(payload.error) ?? str(payload.failure_reason) ?? `Hermes ended the turn: ${status}` });
        return;
      }
      finish({ ok: true, text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload.text ?? '') });
    };
    const timer = setTimeout(() => stop('Hermes did not finish this turn in time.'), askOpts.timeoutMs ?? TURN_TIMEOUT_MS);
    // Pause has to reach a turn already in flight, so the abort flag is read
    // here rather than only between turns.
    const abortPoll = setInterval(() => { if (askOpts.signal?.aborted) stop('aborted'); }, 500);
    if (closed) { onClose(); return; }
    listeners.add(onEvent);
    closers.add(onClose);
    send('prompt.submit', { session_id: session.sessionId, text: prompt }, answer => {
      if (!answer.ok) { finish({ ok: false, error: answer.message }); return; }
      if (answer.result.status === 'queued') skip++;
      submitted = true;
    });
  });

  return {
    session,
    get closed() { return closed; },
    ask,
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

/* ── The reasoning effort ────────────────────────────────────────────────── */

/**
 * Where the effort actually lives.
 *
 * Not on the cron job (which accepts the field and drops it), and not on
 * /api/model/set. It is `agent.reasoning_effort` in the gateway's config, which
 * is how the dashboard's own control sets it: read the config, replace that one
 * key, write the whole object back. It is a property of the gateway or the
 * profile rather than of a message, so there is no per-turn effort to offer.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export async function getReasoningEffort(conn: HermesConnection): Promise<string | null> {
  const baseUrl = resolveHermesBaseUrl(conn);
  const { status, body } = await hermesRequest(baseUrl, '/api/config', { token: sessionToken(conn) });
  if (status >= 300) return null;
  const agent = (body as { agent?: Record<string, unknown> })?.agent;
  const value = agent?.reasoning_effort;
  return typeof value === 'string' && value ? value : null;
}

export async function setReasoningEffort(
  conn: HermesConnection,
  effort: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  // Read-modify-write, because the gateway takes the whole config object. A
  // PUT built from anything but the current config would silently revert every
  // other setting on it.
  const current = await hermesRequest(baseUrl, '/api/config', { token: sessionToken(conn) });
  if (current.status >= 300) return { success: false, error: `could not read the gateway config (HTTP ${current.status})` };
  const config = (current.body ?? {}) as Record<string, unknown>;
  const agent = (config.agent && typeof config.agent === 'object' ? { ...config.agent } : {}) as Record<string, unknown>;
  agent.reasoning_effort = effort;

  const { status, body } = await hermesRequest(baseUrl, '/api/config', {
    method: 'PUT',
    token: sessionToken(conn),
    body: { ...config, agent },
    timeoutMs: 20_000,
  });
  if (status < 300) return { success: true };
  // Read as every other Hermes call reads it (errorDetail): a FastAPI list of
  // errors was stringified here, and the Chat's effort picker showed
  // "[object Object]" (the Audit, after #146).
  return { success: false, error: errorDetail(status, body).slice(0, 200) };
}
