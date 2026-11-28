import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { HermesConnection, resolveHermesBaseUrl, sessionToken } from '../types/hermes';
import { DATA_DIR, privatePath } from '../constants';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';
import { moveOutOfAgentReach } from './settings-secrets';

/**
 * Minimal Hermes gateway client.
 *
 * Hermes gateways come in two auth flavours, advertised on the public
 * GET /api/status:
 *  - open / token: no sign-in, or a static `X-Hermes-Session-Token` header.
 *  - cookie (auth_flows: ['cookie']): a real sign-in. We POST
 *    /auth/password-login {provider, username, password} and keep the
 *    returned session cookies for subsequent calls. The gateway rotates a
 *    fresh access-token cookie transparently while the refresh cookie lives,
 *    so we simply keep whatever it hands back.
 *
 * The cookie jar lives in the main process only. It must never reach the
 * renderer.
 */

interface HermesResponse {
  status: number;
  body: unknown;
  setCookies: string[];
}

/**
 * Where the session lives between runs.
 *
 * The jar used to be memory-only, so signing in lasted exactly as long as the
 * process: every relaunch - and every crash - came back signed out, with the
 * Kanban and Schedules pages showing "Unauthorized" for a gateway the user had
 * authenticated against days ago. hermes-connection.json holds the URL and the
 * auth mode but deliberately never held the cookies, so nothing on disk could
 * restore the session.
 *
 * It is a credential, so it gets the same 0600 atomic write as api-token, and
 * it stays in the main process - `hermesRequest` reads it, the renderer has no
 * channel that returns it.
 */
const SESSION_FILE = privatePath('hermes-session.json');
// In ~/.dorothy, every agent's --add-dir, until 2.0.4 (services/settings-secrets.ts).
moveOutOfAgentReach(path.join(DATA_DIR, 'hermes-session.json'), SESSION_FILE);

const cookieJars = new Map<string, Map<string, string>>();

function loadJars(): void {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as Record<string, Record<string, string>>;
    for (const [baseUrl, cookies] of Object.entries(raw)) {
      if (!cookies || typeof cookies !== 'object') continue;
      // Jars written before storeCookies could recognise a cleared cookie hold
      // `""` entries, and prefixed names an insecure origin should never have
      // kept. Restoring them would send revoked tokens back and go on reporting
      // a session that died a week ago, so they do not survive the load. The
      // cleaned jar reaches disk on the next write.
      const jar = new Map<string, string>();
      for (const [name, stored] of Object.entries(cookies)) {
        if (!isSecureOrigin(baseUrl) && prefixedForSecureOriginOnly(name)) continue;
        const value = cookieValue(String(stored));
        if (value) jar.set(name, value);
      }
      if (jar.size > 0) cookieJars.set(baseUrl, jar);
    }
  } catch (err) {
    // A corrupt session file must not stop the app booting - the worst case is
    // one sign-in.
    // The error itself is not logged: Node's JSON.parse message quotes the
    // start of the file back, and this one is a jar of session cookies.
    console.error(`[hermes] could not restore the session jar: ${describeSecretFileError(err)}`);
  }
}

function persistJars(): void {
  try {
    const plain: Record<string, Record<string, string>> = {};
    for (const [baseUrl, jar] of cookieJars) {
      if (jar.size > 0) plain[baseUrl] = Object.fromEntries(jar);
    }
    writeSecretFileSync(SESSION_FILE, JSON.stringify(plain, null, 2));
  } catch (err) {
    console.error('[hermes] could not persist the session jar:', err);
  }
}

loadJars();

function jarFor(baseUrl: string): Map<string, string> {
  let jar = cookieJars.get(baseUrl);
  if (!jar) { jar = new Map(); cookieJars.set(baseUrl, jar); }
  return jar;
}

function cookieHeader(baseUrl: string): string | undefined {
  const jar = jarFor(baseUrl);
  if (jar.size === 0) return undefined;
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * A cookie value with one RFC 6265 pair of surrounding quotes removed.
 *
 * cookie-value is `*cookie-octet / ( DQUOTE *cookie-octet DQUOTE )`, so a
 * gateway clearing a cookie may write `name=""` rather than `name=`. That is
 * two characters, not zero, and testing it for emptiness without unquoting
 * calls it a real value. Nine of them sat in a jar for a week while every
 * authenticated call came back 401, because Tars kept sending them back.
 */
function cookieValue(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Whether a Set-Cookie's attributes say "delete this", rather than its value.
 *
 * An empty value is the common way; these are the other two, and they can
 * carry any value at all, so a jar that only looks at the value keeps a dead
 * cookie forever. Handled here rather than left out because it is the same
 * failure with a different spelling, and the one that got us cost a week.
 *
 * Max-Age wins over Expires when both are present, per RFC 6265 section 5.3.
 */
function attributesClearCookie(attributes: string[]): boolean {
  let expiresAt: number | undefined;
  for (const attr of attributes) {
    const eq = attr.indexOf('=');
    if (eq < 0) continue;
    const key = attr.slice(0, eq).trim().toLowerCase();
    const value = attr.slice(eq + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(value);
      // A malformed Max-Age is ignored, as a browser would, and Expires below
      // is then the only thing left to read.
      if (Number.isFinite(seconds)) return seconds <= 0;
    } else if (key === 'expires' && expiresAt === undefined) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) expiresAt = parsed;
    }
  }
  return expiresAt !== undefined && expiresAt <= Date.now();
}

/**
 * Whether this cookie name only means anything over https.
 *
 * A browser refuses to store `__Secure-` unless the response came over https
 * with the Secure attribute, and `__Host-` on top of that requires Path=/ and
 * no Domain. Tars was keeping both over plain http and sending them back,
 * which no browser would do: it turned three session cookies into nine, and
 * made the jar three times harder to read at exactly the moment someone
 * needed to read it. They are dropped on an insecure origin instead.
 */
function prefixedForSecureOriginOnly(name: string): boolean {
  return name.startsWith('__Host-') || name.startsWith('__Secure-');
}

function isSecureOrigin(baseUrl: string): boolean {
  return baseUrl.startsWith('https://');
}

function storeCookies(baseUrl: string, setCookies: string[]): void {
  const jar = jarFor(baseUrl);
  const secure = isSecureOrigin(baseUrl);
  for (const raw of setCookies) {
    const parts = raw.split(';');
    const pair = parts[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    if (!secure && prefixedForSecureOriginOnly(name)) continue;
    const value = cookieValue(pair.slice(idx + 1));
    // Cleared, by an empty value or by an attribute saying so: drop it from
    // the jar rather than storing a token the gateway has already revoked.
    if (!value || attributesClearCookie(parts.slice(1))) jar.delete(name);
    else jar.set(name, value);
  }
  persistJars();
}

export function clearHermesSession(baseUrl: string): void {
  cookieJars.delete(baseUrl);
  persistJars();
}

/**
 * Whether the jar holds a session cookie that still carries something.
 *
 * This read the NAMES and never the values, so a jar full of cookies the
 * gateway had cleared answered yes: the Settings page said signed in, the
 * Schedules page said Unauthorized, and both were reading the same jar. A
 * cookie with no value is not a session.
 *
 * Values are unquoted on the way in now, so a bare length check is enough;
 * cookieValue is applied anyway because this is the function everything else
 * trusts, and it should not depend on who filled the jar.
 */
export function hasHermesSession(baseUrl: string): boolean {
  const jar = cookieJars.get(baseUrl);
  if (!jar) return false;
  for (const [name, value] of jar) {
    if (name.includes('hermes_session') && cookieValue(value).length > 0) return true;
  }
  return false;
}

/**
 * The errors hermesRequest rejected with because the gateway gave no answer
 * (nothing listening, no answer in time, an answer that is not HTTP, a
 * connection cut, a URL it cannot call), with the gateway each one concerns,
 * and the wait for its own timeout or its deadline. Their messages are left as
 * they are: the Kanban board (describeHermesFailure), the agents' kanban
 * (kanban-board.ts) and the probe read the transport's own words.
 */
type Unanswered = { baseUrl: string; waitedMs?: number; deadlineMs?: number };
const unanswered = new WeakMap<object, Unanswered>();

function noAnswer(err: unknown, baseUrl: string, wait: Omit<Unanswered, 'baseUrl'> = {}): unknown {
  if (err && typeof err === 'object') unanswered.set(err, { baseUrl, ...wait });
  return err;
}

/** What the probe and the sign-in answer for a value that is not such an address: the save's refusal, less its "nothing was saved". */
const NOT_AN_ADDRESS_TARS_CALLS = 'Tars calls a gateway only at an http:// or https:// address.';

/** A gateway's address as Tars calls it, an http: or https: URL; null for anything else, which Tars never calls. */
export function gatewayUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * What the window shows for a call the gateway gave no answer to: the gateway's
 * address, never its user name, password or query, and the reason. Undefined
 * for any other error, which is not the network's and is not dressed as such.
 */
export function noAnswerSentence(err: unknown): string | undefined {
  const seen = err && typeof err === 'object' ? unanswered.get(err) : undefined;
  if (!seen) return undefined;
  // Quoted only as an http(s) URL, the two schemes hermesRequest calls. Anything
  // else may be a token pasted in the wrong field, and one shaped name:secret
  // parses as a URL (scheme "name:", path "secret"): quoted, it printed the
  // secret (the Audit's L1 on #663).
  const url = gatewayUrl(seen.baseUrl);
  if (!url) return 'Tars could not reach Hermes: the gateway URL saved in Settings, Hermes is not one it can call.';
  const where = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  const { message, code } = err as { message?: unknown; code?: unknown };
  const said = typeof message === 'string' ? message : String(err);
  const reason = seen.waitedMs !== undefined
    ? `no answer within ${Math.round(seen.waitedMs / 1000)} s`
    : seen.deadlineMs !== undefined
      ? `its answer did not end within ${Math.round(seen.deadlineMs / 1000)} s`
    : typeof code === 'string' && code.startsWith('HPE_')
      ? `its answer is not HTTP (${said})`
      : said;
  return `Tars could not reach Hermes at ${where}: ${reason.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/**
 * A call to the gateway for a window that reads `{ success: false, error }`: a
 * call that got no answer is that refusal, never a throw through IPC, which
 * Electron hands the page as "Error invoking remote method ..." (Schedules,
 * 27/11). Any other failure still throws.
 */
export async function reachingHermes<T>(call: () => Promise<T>): Promise<T | { success: false; error: string }> {
  try {
    return await call();
  } catch (err) {
    const error = noAnswerSentence(err);
    if (error === undefined) throw err;
    return { success: false, error };
  }
}

/**
 * One request to the gateway.
 *
 * `timeoutMs` is an idle timeout: it fires when the socket says nothing for that
 * long. A gateway that trickles its answer, a byte within each wait, held a call
 * for good, so the whole request also has a deadline (the Audit's I-2 on #660):
 * three times the idle timeout, 30 s at least, unless the caller names one. The
 * calls of the pages, the overseer, the relay, the probe and the sign-in wait
 * 10 s idle, so 30 s whole; the reasoning effort's write 20 s, so 60 s; an
 * upload 120 s, so 6 minutes. The overseer's turn is many short requests, each
 * with its own deadline, inside the turn's own bound (its 60 s poll and the live
 * conversation's 180 s, over a WebSocket, not here).
 */
export function hermesRequest(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown; token?: string; timeoutMs?: number; deadlineMs?: number } = {},
): Promise<HermesResponse> {
  const { method = 'GET', body, token, timeoutMs = 10000 } = options;
  const deadlineMs = options.deadlineMs ?? Math.max(30_000, 3 * timeoutMs);
  return new Promise((settle, fail) => {
    const deadline: { timer?: NodeJS.Timeout } = {};
    const resolve = (answer: HermesResponse) => { clearTimeout(deadline.timer); settle(answer); };
    const reject = (err: unknown) => { clearTimeout(deadline.timer); fail(err); };
    let target: URL;
    try { target = new URL(baseUrl + pathname); } catch { reject(noAnswer(new Error('Invalid gateway URL'), baseUrl)); return; }

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (token) headers['X-Hermes-Session-Token'] = token;
    const cookie = cookieHeader(baseUrl);
    if (cookie) headers['Cookie'] = cookie;

    const mod = target.protocol === 'https:' ? https : http;
    let req: http.ClientRequest;
    try {
      req = mod.request(target, { method, headers, timeout: timeoutMs }, res => {
        // An answer cut off once it has begun: the request's error never comes, and
        // its timeout cannot fire on a socket that is gone, so it never settled and an
        // overseer turn awaiting it held every later one "busy" (the Audit's M1 on #660).
        const cut = () => reject(noAnswer(new Error('its answer was cut off before the end'), baseUrl));
        res.on('error', cut);
        res.on('close', () => { if (!res.complete) cut(); });
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          const setCookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
          if (setCookies.length) storeCookies(baseUrl, setCookies);
          let parsed: unknown = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed, setCookies });
        });
      });
    } catch (err) {
      // A request Node will not make (a scheme it cannot call, a header it will not send): no answer either.
      reject(noAnswer(err, baseUrl));
      return;
    }
    req.on('error', err => reject(noAnswer(err, baseUrl)));
    req.on('timeout', () => { req.destroy(); reject(noAnswer(new Error('timeout'), baseUrl, { waitedMs: timeoutMs })); });
    // In words, as the sentence says it: the agents' kanban quotes this message, and the board reads it (I-b on #660).
    deadline.timer = setTimeout(() => {
      reject(noAnswer(new Error(`its answer did not end within ${Math.round(deadlineMs / 1000)} s`), baseUrl, { deadlineMs }));
      req.destroy();
    }, deadlineMs);
    if (payload) req.write(payload);
    req.end();
  });
}

/** One request to the gateway `conn` points at, carrying its token in token mode. */
function gatewayCall(
  conn: HermesConnection,
  pathname: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<HermesResponse> {
  return hermesRequest(resolveHermesBaseUrl(conn), pathname, { ...options, token: sessionToken(conn) });
}

/** A call the gateway refused, flagged when signing in is what would fix it. */
function refused(status: number, error: string) {
  return { success: false as const, error, needsSignIn: status === 401 || status === 403 };
}

/**
 * A 2xx answer whose body is not the JSON a reader needs: a proxy's sign-in
 * page, a web server on the gateway's port. hermesRequest keeps such a body as
 * its raw text, and the readers of the pages took it for an answer with nothing
 * in it, a success with no rows (#660). `what` is what Tars was reading.
 */
function unexpectedAnswer(what: string) {
  return { success: false as const, error: `Tars could not read ${what} Hermes sent: its answer is not what Tars expected.` };
}

/** A body a list or a record can be read from: JSON's object or array, never raw text or null. */
function readable(body: unknown): body is object {
  return typeof body === 'object' && body !== null;
}

/**
 * Whether every entry of a list the gateway answered is a record named by
 * `key`: a non-empty string, or for an id a number too. A null among them
 * threw a TypeError through IPC, in the readers below or in the page; a
 * number, or a record without the key, was dropped without a word (#660).
 * Either is an answer that is not what Tars expected.
 */
function rowsNamedBy(list: unknown[], key: string, id = false): boolean {
  return list.every(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const name = (entry as Record<string, unknown>)[key];
    return (typeof name === 'string' && name !== '') || (id && typeof name === 'number' && Number.isFinite(name));
  });
}

/** A read the gateway refused: the sign-in prompt when that is the reason,
 *  the status otherwise. */
function failedRead(status: number, signInPrompt: string) {
  return status === 401 || status === 403
    ? { success: false as const, error: signInPrompt, needsSignIn: true }
    : { success: false as const, error: `HTTP ${status}` };
}

export interface HermesStatus {
  reachable: boolean;
  status?: number;
  version?: string;
  gatewayState?: string;
  authRequired: boolean;
  authFlows: string[];
  authProviders: string[];
  signedIn: boolean;
  error?: string;
}

/**
 * Whether the credentials we hold are actually accepted, asked of the gateway.
 *
 * Reading the jar only tells us what we are holding, not whether it works, and
 * those two answers were different for a week: the cookies were there and the
 * gateway had revoked them. So this spends one request on the endpoint the
 * Schedules page uses, which is the one that was answering Unauthorized while
 * the Settings page said the connection was fine.
 *
 * A status other than 2xx/401/403 says nothing about the session (a gateway
 * too old for this route answers 404, a broken one 500), so the jar is the
 * fallback rather than a guess in either direction.
 */
async function verifyHermesSession(baseUrl: string, token?: string): Promise<boolean> {
  // Nothing to present means not signed in, and no request worth making.
  if (!hasHermesSession(baseUrl) && !token) return false;
  try {
    const { status } = await hermesRequest(baseUrl, '/api/cron/jobs?profile=all', { token });
    if (status >= 200 && status < 300) return true;
    if (status === 401 || status === 403) return false;
    return hasHermesSession(baseUrl);
  } catch {
    return hasHermesSession(baseUrl);
  }
}

export async function probeHermes(conn: HermesConnection): Promise<HermesStatus & { baseUrl: string }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  if (!baseUrl) {
    return { baseUrl: '', reachable: false, authRequired: false, authFlows: [], authProviders: [], signedIn: false, error: 'No gateway URL for this mode.' };
  }
  // Not an address Tars calls: said in the save's words, not called, and the value not handed back, where
  // Settings printed it beside Node's "Protocol "user:" not supported" (the Audit's I-1 on #660).
  if (!gatewayUrl(baseUrl)) {
    return { baseUrl: '', reachable: false, authRequired: false, authFlows: [], authProviders: [], signedIn: false, error: NOT_AN_ADDRESS_TARS_CALLS };
  }
  try {
    const { status, body } = await hermesRequest(baseUrl, '/api/status', { token: sessionToken(conn) });
    const info = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const authRequired = info.auth_required === true;
    return {
      baseUrl,
      reachable: status > 0 && status < 500,
      status,
      version: typeof info.version === 'string' ? info.version : undefined,
      gatewayState: typeof info.gateway_state === 'string' ? info.gateway_state : undefined,
      authRequired,
      authFlows: Array.isArray(info.auth_flows) ? info.auth_flows as string[] : [],
      authProviders: Array.isArray(info.auth_providers) ? info.auth_providers as string[] : [],
      // Asked of the gateway rather than of the jar: holding a cookie and
      // being accepted are different things, and this is where they parted.
      signedIn: !authRequired || await verifyHermesSession(baseUrl, sessionToken(conn)),
    };
  } catch (err) {
    return { baseUrl, reachable: false, authRequired: false, authFlows: [], authProviders: [], signedIn: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The version the gateway names on its public /api/status, undefined when it names none or does not answer. */
export async function hermesVersion(conn: HermesConnection): Promise<string | undefined> {
  const baseUrl = resolveHermesBaseUrl(conn);
  if (!baseUrl) return undefined;
  try {
    const { status, body } = await hermesRequest(baseUrl, '/api/status', { token: sessionToken(conn) });
    const version = status === 200 ? (body as { version?: unknown } | null)?.version : undefined;
    return typeof version === 'string' && version ? version : undefined;
  } catch {
    return undefined;
  }
}

export async function signInHermes(
  conn: HermesConnection,
  credentials: { provider?: string; username: string; password: string },
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = resolveHermesBaseUrl(conn);
  if (!baseUrl) return { success: false, error: 'No gateway URL for this mode.' };
  if (!gatewayUrl(baseUrl)) return { success: false, error: NOT_AN_ADDRESS_TARS_CALLS };
  try {
    const provider = credentials.provider || 'basic';
    const { status, body } = await hermesRequest(baseUrl, '/auth/password-login', {
      method: 'POST',
      body: { provider, username: credentials.username, password: credentials.password, next: '/' },
    });
    if (status === 200 && hasHermesSession(baseUrl)) return { success: true };
    return { success: false, error: status === 200 ? 'Gateway accepted the login but set no session cookie.' : errorDetail(status, body) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Kanban plugin ─────────────────────────────────────────────────────────
// The board itself (columns, tasks, runs, workers) lives in Hermes: Tars
// is only a client. Endpoints are mounted at /api/plugins/kanban.

export const HERMES_KANBAN_COLUMNS = [
  'triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done',
] as const;

const KANBAN = '/api/plugins/kanban';

/**
 * The gateway returns FastAPI-style validation errors as
 * `{ detail: "title is required" }` or `{ detail: [{ msg, loc, ... }] }`. Every
 * kanban call used to collapse that to a bare `HTTP 422`, so a task created
 * with no title told the user nothing they could act on. Read `detail` the
 * same way for every Hermes call, here and in hermes-session.ts: eight more
 * here, and the Chat's effort picker there, turned the array into a string,
 * and the Schedules page, the model picker, a memory write and the Chat said
 * "[object Object],[object Object]" instead.
 */
export function errorDetail(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const msgs = detail.map(d => (d && typeof d === 'object' && 'msg' in d) ? String((d as { msg: unknown }).msg) : String(d));
      if (msgs.length) return msgs.join('; ');
    }
  }
  return `HTTP ${status}`;
}

/** The board, or one tenant of it: the agents' kanban files each project as a tenant. */
export async function fetchHermesBoard(conn: HermesConnection, board?: string, tenant?: string) {
  const params = new URLSearchParams();
  if (board) params.set('board', board);
  if (tenant) params.set('tenant', tenant);
  const query = params.size ? `?${params.toString()}` : '';
  const { status, body } = await gatewayCall(conn, `${KANBAN}/board${query}`);
  if (status !== 200) return refused(status, errorDetail(status, body));
  if (!readable(body)) return unexpectedAnswer('the board');
  // Its columns and their tasks go to the page as they are: a row it cannot read is refused here.
  const columns = (body as { columns?: unknown }).columns;
  if (Array.isArray(columns) && (!rowsNamedBy(columns, 'name')
    || columns.some(c => { const tasks = (c as { tasks?: unknown }).tasks; return Array.isArray(tasks) && !rowsNamedBy(tasks, 'id', true); }))) {
    return unexpectedAnswer('the board');
  }
  return { success: true as const, board: body };
}

export async function getHermesTask(conn: HermesConnection, taskId: string) {
  const { status, body } = await gatewayCall(conn, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`);
  if (status !== 200) return refused(status, errorDetail(status, body));
  if (!readable(body)) return unexpectedAnswer('the task');
  return { success: true as const, detail: body };
}

export async function createHermesTask(conn: HermesConnection, task: Record<string, unknown>) {
  const { status, body } = await gatewayCall(conn, `${KANBAN}/tasks`, { method: 'POST', body: task });
  return status < 300 ? { success: true as const, task: body } : refused(status, errorDetail(status, body));
}

export async function updateHermesTask(conn: HermesConnection, taskId: string, patch: Record<string, unknown>) {
  const { status, body } = await gatewayCall(conn, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patch });
  return status < 300 ? { success: true as const, task: body } : refused(status, errorDetail(status, body));
}

export async function deleteHermesTask(conn: HermesConnection, taskId: string) {
  const { status, body } = await gatewayCall(conn, `${KANBAN}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
  return status < 300 ? { success: true as const } : refused(status, errorDetail(status, body));
}

export async function addHermesTaskComment(conn: HermesConnection, taskId: string, body_: string) {
  const { status, body } = await gatewayCall(conn, `${KANBAN}/tasks/${encodeURIComponent(taskId)}/comments`, { method: 'POST', body: { body: body_ } });
  return status < 300 ? { success: true as const } : refused(status, errorDetail(status, body));
}

// ── Cron / automations ────────────────────────────────────────────────────
// Schedules live in Hermes (per-profile jobs.json); Tars lists and drives
// them. Unit routes need the job's own `profile`, otherwise the gateway scans
// every profile to find it.

export async function fetchHermesCrons(conn: HermesConnection) {
  const { status, body } = await gatewayCall(conn, '/api/cron/jobs?profile=all');
  if (status !== 200) return refused(status, errorDetail(status, body));
  if (!readable(body)) return unexpectedAnswer('the schedules');
  // Its jobs go to the page as they are, found as Schedules finds them (asJobs): a row it cannot read is refused here.
  const jobs = Array.isArray(body) ? body
    : ['jobs', 'items', 'results'].map(k => (body as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined;
  if (jobs && !rowsNamedBy(jobs, 'id', true)) return unexpectedAnswer('the schedules');
  return { success: true as const, jobs: body };
}

export async function hermesCronAction(
  conn: HermesConnection,
  action: 'pause' | 'resume' | 'trigger',
  jobId: string,
  profile?: string,
) {
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status, body } = await gatewayCall(conn, `/api/cron/jobs/${encodeURIComponent(jobId)}/${action}${q}`, { method: 'POST' });
  return status < 300 ? { success: true as const, job: body } : { success: false as const, error: `HTTP ${status}` };
}

/**
 * Edit a job in place.
 *
 * The Schedules page shipped with run/pause/delete only, so a job's expression
 * or prompt could not be changed from Tars at all - the gateway does support
 * it, we simply never called the route. It is PUT (not PATCH like Kanban), and
 * the body wraps the changed fields in `updates`; keys left out stay as they
 * are. Verified against Hermes 0.20.0: `name`, `prompt`, `schedule` (a plain
 * expression string - cron, `every 30m`, `2h`, an ISO timestamp) and `enabled`
 * all take. `profile` is a locator, not a field: the gateway accepts it in the
 * body and ignores it, so a job cannot be moved between profiles this way.
 *
 * A bad expression comes back 400 with the gateway's own `detail` listing the
 * accepted forms - pass that through verbatim, it is better copy than anything
 * we would write here.
 */
export async function updateHermesCron(
  conn: HermesConnection,
  jobId: string,
  updates: Record<string, unknown>,
  profile?: string,
) {
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status, body } = await gatewayCall(conn, `/api/cron/jobs/${encodeURIComponent(jobId)}${q}`, { method: 'PUT', body: { updates } });
  if (status < 300) return { success: true as const, job: body };
  return refused(status, errorDetail(status, body));
}

export async function deleteHermesCron(conn: HermesConnection, jobId: string, profile?: string) {
  const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const { status } = await gatewayCall(conn, `/api/cron/jobs/${encodeURIComponent(jobId)}${q}`, { method: 'DELETE' });
  return status < 300 ? { success: true as const } : { success: false as const, error: `HTTP ${status}` };
}

/**
 * Create a cron job.
 *
 * Used by the Overseer (electron/services/overseer.ts) to provision its own
 * permanent job, which it then drives entirely by hand: it PUTs a fresh
 * prompt and POSTs /trigger on every turn rather than waiting on `schedule`.
 *
 * `enabled` is forced to true. A job created with enabled:false answers 200
 * to both the creation call and every later /trigger, and then does nothing
 * at all - no run, no session, no error. That silence cost an hour to track
 * down against the live gateway, so there is no way to call this with the
 * job disabled.
 */
/**
 * The models the gateway can actually run, and which it is running now.
 *
 * The overseer was pinned to whatever the gateway happened to have selected,
 * which on the author's install is deepseek-v4-flash. That is a real choice a
 * user should get to make: it decides how good the fleet briefings are and what
 * they cost. `GET /api/model/options` answers with every provider the gateway
 * has credentials for and their model lists, so the picker offers what will
 * actually work rather than a table compiled into Tars.
 */
export interface HermesModelProvider {
  slug: string;
  name: string;
  models: string[];
  isCurrent: boolean;
}

export async function fetchHermesModelOptions(
  conn: HermesConnection,
): Promise<
  | { success: true; provider: string; model: string; providers: HermesModelProvider[] }
  | { success: false; error: string; needsSignIn?: boolean }
> {
  const { status, body } = await gatewayCall(conn, '/api/model/options');
  if (status >= 300) return failedRead(status, 'Sign in to Hermes to list its models');
  if (!readable(body)) return unexpectedAnswer('the models');

  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.providers) ? b.providers : [];
  if (!rowsNamedBy(raw, 'slug')) return unexpectedAnswer('the models');
  return {
    success: true,
    provider: typeof b.provider === 'string' ? b.provider : '',
    model: typeof b.model === 'string' ? b.model : '',
    providers: raw.map(entry => {
      const p = entry as Record<string, unknown>;
      return {
        slug: typeof p.slug === 'string' ? p.slug : '',
        name: typeof p.name === 'string' ? p.name : String(p.slug ?? ''),
        models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string') : [],
        isCurrent: p.is_current === true,
      };
    }).filter(p => p.slug),
  };
}

/**
 * Point the gateway at a model.
 *
 * Measured against the live gateway rather than assumed, because two other
 * mechanisms look like they should work and do not: `provider` and `model` on
 * a cron job are accepted and echoed back but ignored at run time, and a job
 * run under a non-default profile never produces an answer at all. Only this
 * changes what actually replies.
 *
 * `scope: "main"` is the gateway's own wording for the primary slot. It is a
 * gateway-wide setting, not a Tars one, which is why the screen that calls
 * this says so.
 */
export async function setHermesModel(
  conn: HermesConnection,
  choice: { provider: string; model: string },
) {
  const { status, body } = await gatewayCall(conn, '/api/model/set', {
    method: 'POST',
    body: { scope: 'main', provider: choice.provider, model: choice.model },
  });
  if (status < 300) return { success: true as const };
  return refused(status, errorDetail(status, body).slice(0, 200));
}

export async function createHermesCron(
  conn: HermesConnection,
  job: { name: string; schedule: string; prompt: string; deliver?: string; model?: string; provider?: string },
) {
  const { status, body } = await gatewayCall(conn, '/api/cron/jobs', {
    method: 'POST',
    // `model` and `provider` are accepted here and echoed back on the created
    // job, but measurement against the live gateway showed they are ignored at
    // run time: a job pinned to anthropic never answered, while the same job
    // on the gateway's own current model did. They are still sent because a
    // later gateway may honour them; what actually selects the model is
    // setHermesModel above.
    body: {
      name: job.name,
      schedule: job.schedule,
      prompt: job.prompt,
      deliver: job.deliver ?? 'local',
      enabled: true,
      ...(job.model ? { model: job.model } : {}),
      ...(job.provider ? { provider: job.provider } : {}),
    },
  });
  if (status < 300) return { success: true as const, job: body as { id?: string; [key: string]: unknown } };
  return refused(status, errorDetail(status, body));
}

/** A file that now lives on the gateway, ready to be named in a prompt. */
export interface HermesAttachment {
  /** What the chip shows: the name the user picked it under. */
  name: string;
  /** Where it landed on the gateway. This is what the prompt references, and
   *  it is the only part the model needs. */
  path: string;
  bytes: number;
  isImage: boolean;
}

/**
 * Big enough for a screenshot or a PDF, small enough that the whole thing can
 * sit in memory as base64 on both sides without trouble. The gateway takes a
 * JSON data URL rather than multipart, so the encoded form is roughly a third
 * larger again.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** The name is used to build a path on the gateway, so it must not be able to
 *  climb out of the upload directory or contain a separator. */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  // Controls (C0, DEL, C1) and direction marks and overrides: a name is shown
  // to a person and typed at an agent, and U+202E turns what follows around.
  const cleaned = base.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'file';
}

/**
 * Put a file on the gateway and get back the path to name in a prompt.
 *
 * Two endpoints, because the gateway has two: images go through
 * /api/chat/image-upload, which names the file itself and refuses anything
 * that is not an image ("Upload payload must be an image"), and everything
 * else goes through /api/files/upload, which takes the destination path and
 * insists it be absolute or `~`-rooted.
 *
 * Nothing is inlined into the message. The gateway's agent has file tools, so
 * a path is both smaller and more useful than a base64 blob: it can read the
 * file more than once, and a 4MB screenshot does not have to survive a round
 * trip through the prompt.
 */
export async function uploadHermesAttachment(
  conn: HermesConnection,
  file: { name: string; mimeType: string; base64: string; bytes: number },
): Promise<
  | { success: true; attachment: HermesAttachment }
  | { success: false; error: string; needsSignIn?: boolean }
> {
  const name = safeUploadName(file.name);
  const isImage = file.mimeType.startsWith('image/');
  const dataUrl = `data:${file.mimeType || 'application/octet-stream'};base64,${file.base64}`;

  const { status, body } = isImage
    ? await gatewayCall(conn, '/api/chat/image-upload', {
      method: 'POST',
      // An upload is not a status poll: a few megabytes over a home
      // connection outlasts the 10s default several times over.
      timeoutMs: 120_000,
      body: { data_url: dataUrl, filename: name },
    })
    : await gatewayCall(conn, '/api/files/upload', {
      method: 'POST',
      timeoutMs: 120_000,
      body: { path: `~/.hermes/uploads/${name}`, data_url: dataUrl, overwrite: true },
    });

  if (status >= 300) return refused(status, errorDetail(status, body).slice(0, 200));

  const payload = (body ?? {}) as { path?: unknown; name?: unknown; bytes?: unknown };
  const remotePath = typeof payload.path === 'string' ? payload.path : '';
  if (!remotePath) return { success: false, error: 'The gateway accepted the file but returned no path.' };

  return {
    success: true,
    attachment: {
      name,
      path: remotePath,
      bytes: typeof payload.bytes === 'number' ? payload.bytes : file.bytes,
      isImage,
    },
  };
}

export interface HermesCronRun {
  id: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Recent runs of one job, newest first (the gateway's own order). */
export async function fetchHermesCronRuns(
  conn: HermesConnection,
  jobId: string,
  opts: { limit?: number; profile?: string } = {},
): Promise<{ success: true; runs: HermesCronRun[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.profile) params.set('profile', opts.profile);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const { status, body } = await gatewayCall(conn, `/api/cron/jobs/${encodeURIComponent(jobId)}/runs${qs}`);
  if (status >= 300) return failedRead(status, 'Sign in to Hermes');

  const raw = Array.isArray(body) ? body : (body as { runs?: unknown[] } | null)?.runs ?? [];
  const runs = raw.map(entry => {
    const r = (entry ?? {}) as Record<string, unknown>;
    return {
      id: typeof r.id === 'string' ? r.id : '',
      status: typeof r.status === 'string' ? r.status : undefined,
      startedAt: typeof r.started_at === 'string' ? r.started_at : typeof r.startedAt === 'string' ? r.startedAt : undefined,
      finishedAt: typeof r.finished_at === 'string' ? r.finished_at : typeof r.finishedAt === 'string' ? r.finishedAt : undefined,
    };
  }).filter(r => r.id);
  return { success: true, runs };
}

export interface HermesSessionMessage {
  role: string;
  content: string;
}

/** The transcript of one run/session: what the overseer actually answered. */
export async function fetchHermesSessionMessages(
  conn: HermesConnection,
  sessionId: string,
): Promise<{ success: true; messages: HermesSessionMessage[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const { status, body } = await gatewayCall(conn, `/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (status >= 300) return failedRead(status, 'Sign in to Hermes');

  const raw = Array.isArray(body) ? body : (body as { messages?: unknown[] } | null)?.messages ?? [];
  const messages = raw.map(entry => {
    const m = (entry ?? {}) as Record<string, unknown>;
    return {
      role: typeof m.role === 'string' ? m.role : '',
      content: typeof m.content === 'string' ? m.content : '',
    };
  });
  return { success: true, messages };
}

/* ── Memory ────────────────────────────────────────────────
 * Hermes exposes no HTTP API for memory *content*: /api/memory only
 * administers which provider is active. The content lives in two markdown
 * files the gateway will hand over through /api/files/read, and past sessions
 * are searchable through the FTS index behind /api/sessions/search.
 */

export interface HermesMemoryFile {
  name: string;
  content: string;
}

function decodeDataUrl(dataUrl: unknown): string {
  if (typeof dataUrl !== 'string') return '';
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return '';
  try {
    return Buffer.from(dataUrl.slice(comma + 1), 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * MEMORY.md (agent notes) and USER.md (user profile) from the gateway.
 *
 * These were read as `memories/MEMORY.md`, a relative path, and /api/files/read
 * rejects those with `400 {"detail":"Path must be absolute"}`. Every call
 * therefore failed, and because the Brain page only counts the files it got
 * back, a signed-in gateway holding a real MEMORY.md reported "0 files
 * readable" and the digest injected into every new session carried no Hermes
 * memory at all. The gateway expands `~` to its own home, so this stays correct
 * whatever account Hermes runs as.
 */
const HERMES_MEMORY_DIR = '~/.hermes/memories';

/** Hermes's two memory files, in the order they are shown. */
export const HERMES_MEMORY_FILES = ['MEMORY.md', 'USER.md'] as const;

/** One of them: `file` is null when the gateway has not written it yet, or it is empty. */
export async function fetchHermesMemoryFile(conn: HermesConnection, name: string): Promise<
  { success: true; file: HermesMemoryFile | null } | { success: false; error: string; needsSignIn?: boolean }
> {
  const { status, body } = await gatewayCall(conn, `/api/files/read?path=${encodeURIComponent(`${HERMES_MEMORY_DIR}/${name}`)}`);
  if (status === 404) return { success: true, file: null }; // the gateway simply has not written it yet
  if (status >= 300) return failedRead(status, 'Sign in to Hermes to read its memory');

  const content = decodeDataUrl((body as Record<string, unknown> | null)?.data_url);
  return { success: true, file: content.trim() ? { name, content } : null };
}

export async function fetchHermesMemoryFiles(conn: HermesConnection): Promise<
  { success: true; files: HermesMemoryFile[] } | { success: false; error: string; needsSignIn?: boolean }
> {
  const files: HermesMemoryFile[] = [];

  for (const name of HERMES_MEMORY_FILES) {
    const read = await fetchHermesMemoryFile(conn, name);
    if (!read.success) return read;
    if (read.file) files.push(read.file);
  }

  return { success: true, files };
}

/**
 * Append to one of the gateway's memory files.
 *
 * Tars could read Hermes' memory but never write to it: `memory_write` only
 * ever touched the project's own notes, so an agent told "remember this in
 * Hermes" had nowhere to put it. There is no append route, so this is
 * read-modify-upload against `/api/files/upload`, which takes a data URL and
 * overwrites. Verified against Hermes 0.20.0: upload, read back and delete all
 * answer 200 on `~/.hermes/memories/`.
 *
 * Last-write-wins, deliberately. A lock would need a route the gateway does not
 * have, and two agents appending to a memory file in the same instant is not
 * worth a second round trip on every write. The read immediately precedes the
 * upload, so the window is one request wide.
 */
export async function appendHermesMemory(
  conn: HermesConnection,
  content: string,
  file = 'MEMORY.md',
): Promise<{ success: true; path: string } | { success: false; error: string; needsSignIn?: boolean }> {
  const trimmed = content.trim();
  if (!trimmed) return { success: false, error: 'Nothing to write' };

  // Only the gateway's own memory directory, and only a plain filename: a
  // caller-supplied `../` would otherwise reach anywhere the gateway can write.
  const name = file.replace(/[^A-Za-z0-9._-]/g, '');
  if (!name || name.startsWith('.')) return { success: false, error: `Invalid memory file "${file}"` };

  const path = `${HERMES_MEMORY_DIR}/${name}`;

  const read = await gatewayCall(conn, `/api/files/read?path=${encodeURIComponent(path)}`);
  if (read.status === 401 || read.status === 403) {
    return { success: false, error: 'Sign in to Hermes to write to its memory', needsSignIn: true };
  }
  // 404 is the first write to a file that does not exist yet, not a failure.
  if (read.status >= 300 && read.status !== 404) {
    return { success: false, error: `Could not read ${name}: HTTP ${read.status}` };
  }

  const existing = read.status === 404
    ? ''
    : decodeDataUrl((read.body as Record<string, unknown> | null)?.data_url);
  const separator = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  const next = `${existing}${separator}${trimmed}\n`;

  const { status, body } = await gatewayCall(conn, '/api/files/upload', {
    method: 'POST',
    body: {
      path,
      data_url: `data:text/markdown;base64,${Buffer.from(next, 'utf-8').toString('base64')}`,
      overwrite: true,
    },
  });
  if (status >= 300) return refused(status, errorDetail(status, body));

  const written = (body && typeof body === 'object' && 'path' in body)
    ? String((body as { path: unknown }).path) : path;
  return { success: true, path: written };
}

/**
 * The MCP servers the gateway has registered.
 *
 * Why Tars asks: gbrain and Honcho are configured in Settings by pasting an MCP
 * URL, and nobody remembers one. The gateway already knows them, so Tars can
 * offer what it finds instead of an empty field. The catch worth reporting is
 * that a gateway-side `localhost` URL is the gateway's own loopback: Tars
 * cannot reach it from here, which is exactly the case that used to show up as
 * a silently unreachable backend.
 */
export interface HermesMcpServer {
  name: string;
  url: string | null;
  transport: string | null;
  enabled: boolean;
  /** True when the URL only resolves on the gateway's own machine. */
  gatewayLocal: boolean;
}

export async function fetchHermesMcpServers(
  conn: HermesConnection,
): Promise<{ success: true; servers: HermesMcpServer[] } | { success: false; error: string; needsSignIn?: boolean }> {
  const { status, body } = await gatewayCall(conn, '/api/mcp/servers');
  if (status >= 300) return failedRead(status, 'Sign in to Hermes to list its MCP servers');
  if (!readable(body)) return unexpectedAnswer('the MCP servers');

  const raw = (body as { servers?: unknown[] } | null)?.servers;
  if (!Array.isArray(raw)) return { success: true, servers: [] };
  if (!rowsNamedBy(raw, 'name')) return unexpectedAnswer('the MCP servers');

  const servers = raw.map(entry => {
    const s = entry as Record<string, unknown>;
    const url = typeof s.url === 'string' ? s.url : null;
    return {
      name: typeof s.name === 'string' ? s.name : '',
      url,
      transport: typeof s.transport === 'string' ? s.transport : null,
      enabled: s.enabled !== false,
      gatewayLocal: !!url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url),
    };
  }).filter(s => s.name);

  return { success: true, servers };
}

/**
 * Which memory provider the gateway itself is running, and which it could.
 *
 * Distinct from the `~/.hermes/memories/*.md` files: those are always there,
 * this is Hermes' pluggable long-term store (holographic, mem0, hindsight and
 * so on). `active: ""` means none is selected, which is worth saying out loud
 * because it looks from the outside like the gateway has no memory at all.
 */
export interface HermesMemoryProvider {
  name: string;
  description: string;
  available: boolean;
  configured: boolean;
  status: string;
}

export async function fetchHermesMemoryProviders(
  conn: HermesConnection,
): Promise<
  | { success: true; active: string; providers: HermesMemoryProvider[]; builtinBytes: number }
  | { success: false; error: string; needsSignIn?: boolean }
> {
  const { status, body } = await gatewayCall(conn, '/api/memory');
  if (status >= 300) return failedRead(status, 'Sign in to Hermes to read its memory settings');
  if (!readable(body)) return unexpectedAnswer('the memory providers');

  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.providers) ? b.providers : [];
  if (!rowsNamedBy(raw, 'name')) return unexpectedAnswer('the memory providers');
  const builtin = (b.builtin_files ?? {}) as Record<string, unknown>;

  return {
    success: true,
    active: typeof b.active === 'string' ? b.active : '',
    builtinBytes: Object.values(builtin).reduce<number>(
      (sum, v) => sum + (typeof v === 'number' ? v : 0), 0,
    ),
    providers: raw.map(entry => {
      const p = entry as Record<string, unknown>;
      return {
        name: typeof p.name === 'string' ? p.name : '',
        // The gateway writes its own descriptions with em dashes. Tars does not
        // print those, so they are normalised on the way in rather than at
        // every place this is rendered.
        description: typeof p.description === 'string' ? p.description.replace(/\s*[–—]\s*/g, ': ') : '',
        available: p.available === true,
        configured: p.configured === true,
        status: typeof p.status === 'string' ? p.status : 'unknown',
      };
    }).filter(p => p.name),
  };
}

/** Switch the gateway's active memory provider. */
export async function setHermesMemoryProvider(conn: HermesConnection, provider: string) {
  const { status, body } = await gatewayCall(conn, '/api/memory/provider', { method: 'PUT', body: { provider } });
  if (status < 300) return { success: true as const, body };
  return refused(status, errorDetail(status, body));
}

export interface HermesSessionHit {
  /** The lineage's newest session: after a compression, the child, not the session that was opened. */
  sessionId?: string;
  /** The lineage's first session (`lineage_root`), the one that was opened. */
  lineageRoot?: string;
  /** The session this one was split from (`parent_session_id`). */
  parentSessionId?: string;
  title?: string;
  snippet?: string;
  timestamp?: string;
  source?: string;
}

/** Full-text search over every past Hermes session. */
export async function searchHermesSessions(
  conn: HermesConnection,
  query: string,
  limit = 10,
): Promise<{ success: true; hits: HermesSessionHit[] } | { success: false; error: string; needsSignIn?: boolean }> {
  // Up to 100, the gateway's own cap: a caller that filters asks for more than it keeps.
  const q = `?q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 100)}`;
  const { status, body } = await gatewayCall(conn, `/api/sessions/search${q}`);
  if (status >= 300) return failedRead(status, 'Sign in to Hermes to search its history');
  if (!readable(body)) return unexpectedAnswer('the search results');

  const payload = body as Record<string, unknown> | null;
  const raw = Array.isArray(payload)
    ? payload
    : (payload?.results as unknown[] | undefined) ?? (payload?.sessions as unknown[] | undefined) ?? [];

  const hits = raw.slice(0, limit).map(item => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      sessionId: typeof r.session_id === 'string' ? r.session_id : typeof r.id === 'string' ? r.id : undefined,
      lineageRoot: typeof r.lineage_root === 'string' ? r.lineage_root : undefined,
      parentSessionId: typeof r.parent_session_id === 'string' ? r.parent_session_id : undefined,
      title: typeof r.title === 'string' ? r.title : undefined,
      snippet: typeof r.snippet === 'string' ? r.snippet
        : typeof r.content === 'string' ? r.content.slice(0, 400) : undefined,
      timestamp: typeof r.timestamp === 'string' ? r.timestamp
        : typeof r.created_at === 'string' ? r.created_at : undefined,
      source: typeof r.source === 'string' ? r.source : undefined,
    };
  });

  return { success: true, hits };
}

/**
 * A session's parent, from GET /api/sessions/{id}: null for a root. The
 * search walks a hit's parents only up to a branch or a delegate edge, so a
 * caller that must know a session's whole ancestry reads it further up, one
 * parent at a time (memory-hub.ts). A session the gateway cannot give, or an
 * answer that is not a session, is a failure, never a root.
 */
export async function fetchHermesSessionParent(
  conn: HermesConnection,
  sessionId: string,
): Promise<{ success: true; parentSessionId: string | null } | { success: false; error: string; needsSignIn?: boolean }> {
  const { status, body } = await gatewayCall(conn, `/api/sessions/${encodeURIComponent(sessionId)}`);
  if (status >= 300) return failedRead(status, 'Sign in to Hermes');
  const session = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const parent = session?.parent_session_id;
  if (!session || (parent !== undefined && parent !== null && typeof parent !== 'string')) {
    return { success: false, error: 'Hermes answered something that is not a session' };
  }
  return { success: true, parentSessionId: typeof parent === 'string' && parent ? parent : null };
}

/** Which memory provider the gateway has active, and how big its files are. */
export async function fetchHermesMemoryState(conn: HermesConnection) {
  const { status, body } = await gatewayCall(conn, '/api/memory');
  if (status >= 300) return failedRead(status, 'Sign in to Hermes');
  if (!readable(body)) return unexpectedAnswer('the memory settings');
  return { success: true as const, state: body as Record<string, unknown> };
}
