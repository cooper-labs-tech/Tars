import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import TelegramBot from 'node-telegram-bot-api';
import { App as SlackApp } from '@slack/bolt';
import { AgentStatus, AppSettings } from '../types';
import { API_PORT, API_TOKEN_FILE } from '../constants';
import { RouteApp, RouteContext, RouteRequest } from './api-routes';
import { registerAllRoutes } from './api-routes';
import { callerHeaderFrom } from './api-routes/utils';
import { agentForToken, isInternalToken, isTerminalToken } from '../core/agent-tokens';
import { isWebhookSecret } from './hermes-webhook-secret';

/** Enough for a prompt or a webhook payload, far short of a memory attack. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How long an idle kept-alive connection stays open past the `Keep-Alive:
 * timeout=5` the server advertises, which is unchanged. Node's default is one
 * second: a local client (an MCP server, a hook, a test) whose event loop was
 * held for longer than that, by a synchronous call or a starved machine, did
 * not get to run its own keep-alive timer, found the connection still in its
 * pool after the server had closed it at 6 s, and its next request was reset:
 * ECONNRESET for a request the server never saw (8 resets in 30 held POSTs,
 * measured in an E2E spec while porting Tars to Windows). A minute in all
 * now. Clients still close their end on the five seconds they are told, and
 * the quit still ends idle connections at once.
 */
const KEEP_ALIVE_GRACE_MS = 55_000;

// The event bus lives in its own module: the overseer listens to it and must
// not have to import the HTTP server, the Telegram bot and the Slack app to do
// so. Re-exported here because callers reach it through this file.
export { emitAgentStatus } from './agent-events';
import { agentStatusEmitter } from './agent-events';
export { agentStatusEmitter };

let apiServer: http.Server | null = null;
let apiToken: string | null = null;

/**
 * How long the local API keeps trying to bind before it gives up.
 *
 * The usual cause of EADDRINUSE here is not a permanent squatter: it is the
 * previous Tars still shutting down and holding the port for a second or two.
 * A single attempt was enough to lose the whole local API for the life of the
 * process, so the schedule front-loads fast retries and then backs off. Eight
 * attempts spread over about ninety seconds, then a loud, final give-up.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const RETRY_WINDOW_MS = RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

/** Where the local API is in its lifecycle. */
export type ApiServerPhase = 'stopped' | 'starting' | 'listening' | 'retrying' | 'failed';

export interface ApiServerState {
  phase: ApiServerPhase;
  /** The port it is serving, or the one it keeps failing to bind. */
  port: number;
  /** Bind attempts made so far, including the one in flight. */
  attempts: number;
  maxAttempts: number;
  /** Message of the last bind failure, null while healthy. */
  lastError: string | null;
  /** Milliseconds until the next attempt while retrying, null otherwise. */
  nextRetryInMs: number | null;
  /** Epoch ms of the moment it started listening, null when it is not. */
  listeningSince: number | null;
}

let apiServerState: ApiServerState = {
  phase: 'stopped',
  port: API_PORT,
  attempts: 0,
  maxAttempts: MAX_ATTEMPTS,
  lastError: null,
  nextRetryInMs: null,
  listeningSince: null,
};
let retryTimer: NodeJS.Timeout | null = null;

/**
 * Emits 'state' with the new ApiServerState on every transition.
 *
 * The port is a contract: CLAUDE_MGR_API_URL, the shell hooks and the bundled
 * MCP servers all assume something is listening on it. When nothing is, every
 * one of them fails with a connection refused that nobody in the app sees. So
 * the state is published rather than logged and forgotten, and anything in the
 * main process that needs to know whether delegation can work at all can ask
 * getApiServerState() or subscribe here.
 */
export const apiServerEmitter = new EventEmitter();

/** The local API's real state. Safe to call at any time, including before start. */
export function getApiServerState(): ApiServerState {
  return { ...apiServerState };
}

function setApiServerState(patch: Partial<ApiServerState>): void {
  apiServerState = { ...apiServerState, ...patch };
  apiServerEmitter.emit('state', getApiServerState());
}

function initApiToken(): string {
  try {
    if (fs.existsSync(API_TOKEN_FILE)) {
      const existing = fs.readFileSync(API_TOKEN_FILE, 'utf-8').trim();
      if (existing.length >= 32) {
        apiToken = existing;
        return existing;
      }
    }
  } catch { /* regenerate */ }

  const token = crypto.randomBytes(32).toString('hex');
  const dir = path.dirname(API_TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(API_TOKEN_FILE, token, { mode: 0o600 });
  apiToken = token;
  return token;
}

export function getApiToken(): string {
  if (!apiToken) {
    return initApiToken();
  }
  return apiToken;
}

/** Authorised, and who by: an agent when its own token says so, Tars itself
 *  when it is the main process calling its own API, Hermes when it presents
 *  the webhook secret on the webhook. */
export type CallerResolution =
  | { ok: true; agentId?: string; internal?: boolean; hermes?: boolean;
    /** The token is the agent's terminal's, as it is now: not a delegated run's. */
    terminal?: boolean }
  | { ok: false; status: number; error: string };

/** The one route published off this machine, and the only one the webhook secret opens. */
const HERMES_WEBHOOK_PATH = '/api/webhooks/hermes';

/**
 * Who this call is from, decided by what it presents rather than what it says.
 *
 * - An **agent's token**, minted when its process was started: the caller is
 *   that agent, and nothing it writes in a header can change that. An
 *   X-Tars-Caller-Id naming somebody else alongside it is not a mistake any
 *   honest caller makes, since the id and the token come from the same
 *   environment, so the call is refused rather than quietly re-labelled.
 * - The **shared token**, `~/.dorothy/api-token`: authorised, and nobody. No
 *   header is read with it, neither the id nor the project. Every agent can
 *   read that file, so a name that comes with it proves nothing, and believing
 *   the name was how any agent could be any other. Who presents it: a curl run
 *   by hand, and an MCP server whose process was started
 *   without a token of its own. The super chat and Hermes did too, measured
 *   before 1.7.6; each holds a credential of its own now. Not the renderer: it
 *   only ever calls /api/local-file, which is exempt, and presents no token.
 * - **Tars's own pass**, minted in this process's memory and written nowhere:
 *   the caller is the main process itself, which is no agent either but is not
 *   refused where an agent is required. The super chat holds it; nothing else
 *   can, since it never reaches a file or a child's environment.
 * - The **Hermes webhook secret**, `~/.tars-private/hermes-webhook-secret`:
 *   Hermes, on `/api/webhooks/hermes` and nowhere else. It is the only
 *   credential Tars publishes off the machine. Read here, at the door, because
 *   the door used to know only the other secrets, and Hermes presenting the
 *   one Tars minted for it was refused 401 before the route it was aimed at
 *   could run (measured on b17db0f). On any other path it is nothing, and the
 *   401 below.
 * - Anything else: unauthorised, with the same flat message as before, which
 *   tells a prober nothing about which of the two it got wrong.
 *
 * Nobody is not the same as refused, and the difference is per route. The bus
 * refuses a call with no agent behind it before looking at any room, and since
 * this lot the routes that drive an agent do the same: the shared token opens
 * no room and starts, stops, messages and deletes nothing. Nor does it reach
 * the webhook, which is Hermes's alone; it used to, as a fallback, and that
 * was the whole fleet, nor the hook routes, which take an agent's own token.
 * It still reads: the listing and the per-agent reads stay open to it.
 */
export function resolveCaller(
  headers: http.IncomingHttpHeaders,
  pathname: string,
): CallerResolution {
  const auth = headers.authorization;
  const presented = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : '';

  if (pathname === HERMES_WEBHOOK_PATH && isWebhookSecret(presented)) {
    return { ok: true, hermes: true };
  }

  const agentId = presented ? agentForToken(presented) : undefined;
  if (agentId) {
    const claimed = callerHeaderFrom(headers, 'id');
    if (claimed && claimed !== agentId) {
      return {
        ok: false,
        status: 403,
        error: 'This call carries the token of one agent and the identity of another. '
          + 'An agent speaks as itself.',
      };
    }
    return { ok: true, agentId, terminal: isTerminalToken(presented) };
  }

  if (presented && isInternalToken(presented)) {
    return { ok: true, internal: true };
  }

  if (apiToken && presented === apiToken) {
    return { ok: true };
  }

  return { ok: false, status: 401, error: 'Unauthorized' };
}

function createRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

function matchRoute(pattern: string | RegExp, pathname: string): Record<string, string> | null {
  if (typeof pattern === 'string') {
    return pathname === pattern ? {} : null;
  }
  const m = pathname.match(pattern);
  if (!m) return null;
  // Map positional captures to 'id' (first group): all parameterized routes use a single :id param
  return m[1] ? { id: m[1] } : {};
}

export function startApiServer(
  mainWindow: BrowserWindow | null,
  appSettings: AppSettings,
  getTelegramBot: () => TelegramBot | null,
  getSlackApp: () => SlackApp | null,
  slackResponseChannel: string | null,
  slackResponseThreadTs: string | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  sendNotificationCallback: (
    title: string,
    body: string,
    agentId?: string,
    notificationSettings?: { notificationsEnabled: boolean; notificationSounds?: Record<string, string> },
  ) => void,
  initAgentPtyCallback: (agent: AgentStatus) => Promise<string>,
  getAppSettings?: () => AppSettings
) {
  if (apiServer) {
    // A server that gave up on the port is still a live object, and the old
    // guard made that permanent: nothing could ever start the API again for
    // the life of the process. A caller retrying after a give-up gets a fresh
    // server and a fresh attempt budget.
    if (apiServerState.phase !== 'failed') return;
    const abandoned = apiServer;
    apiServer = null;
    abandoned.close();
    // A fresh server gets a fresh attempt budget, or the retry schedule would
    // still be exhausted and the first EADDRINUSE would give up at once.
    setApiServerState({ attempts: 0, lastError: null, nextRetryInMs: null, listeningSince: null });
  }

  initApiToken();

  const routeApp = createRouteApp();
  const ctx: RouteContext = {
    mainWindow,
    appSettings,
    getAppSettings: getAppSettings || (() => appSettings),
    getTelegramBot,
    getSlackApp,
    slackResponseChannel,
    slackResponseThreadTs,
    handleStatusChangeNotificationCallback,
    sendNotificationCallback,
    initAgentPtyCallback,
    agentStatusEmitter,
  };
  registerAllRoutes(routeApp, ctx);

  apiServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
    const pathname = url.pathname;

    // Auth check: two local-only endpoints are exempt, and nothing else.
    // /api/kanban/complete was one and had no caller at all: unauthenticated,
    // it marked any task done and deleted the agent the task had created. The
    // hooks were another until 2026-09-23: they post an agent's status and
    // register its session, and with no credential anybody could do either for
    // any agent. The Audit registered one agent's session for another and read
    // its conversation back through a restart, and a killed CLI's late
    // SessionStart took the agent from its live session. They present the
    // agent's own token now (below).
    const authExempt = pathname === '/api/local-file'
      || pathname === '/api/health';

    // A browser tab on any site can reach 127.0.0.1. CORS hides the response
    // but not the side effect, so reject cross-origin callers outright: our
    // own renderer is app://- in production and localhost:3000 in dev, and
    // the shell hooks send no Origin at all.
    const origin = req.headers.origin;
    if (origin && origin !== 'app://-' && origin !== 'http://localhost:3000') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }

    // Resolved once, before routing, so no route has to decide for itself who
    // it is talking to. The two exempt paths keep their own guards.
    let caller: CallerResolution = { ok: true };
    if (!authExempt) {
      caller = resolveCaller(req.headers, pathname);
      if (!caller.ok) {
        res.writeHead(caller.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: caller.error }));
        return;
      }
    }

    // Parse body for POST and PUT requests
    let body: Record<string, unknown> = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        // Bounded: this reads before routing, and on the auth-exempt hook
        // paths, so an unbounded stream was a way to exhaust the main
        // process's memory without any credential at all.
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of req) {
          received += (chunk as Buffer).length;
          if (received > MAX_BODY_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const data = Buffer.concat(chunks).toString();
        if (data) {
          const parsed = JSON.parse(data);
          // Reject the two keys that would let a request write onto
          // Object.prototype once the body is spread or merged downstream.
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const clean = parsed as Record<string, unknown>;
            delete clean['__proto__'];
            delete clean['constructor'];
            body = clean;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    const sendJson = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // A hook runs inside an agent's CLI, whose environment carries that
    // terminal's own token (CLAUDE_MGR_API_TOKEN, minted per spawn), and posts
    // for that agent and no other. The shared token, which every agent can
    // read, names nobody and is refused here, as are Tars's pass and the
    // webhook secret. A CLI whose terminal was replaced or has ended holds a
    // token that no longer maps to anyone: its late posts get the 401 above.
    // A delegated ACP run's token names its agent but is not its terminal's:
    // a hook in that run posting a SessionStart took the agent from its live
    // terminal (the Audit, gate of #135), so it is refused here too.
    if (pathname.startsWith('/api/hooks/')) {
      const posted = typeof body.agent_id === 'string' ? body.agent_id : undefined;
      const agentId = caller.ok ? caller.agentId : undefined;
      const fromTerminal = caller.ok && caller.terminal === true;
      if (!agentId || posted !== agentId || !fromTerminal) {
        sendJson({
          error: !agentId
            ? 'Hook posts take the token of the agent\'s own CLI (CLAUDE_MGR_API_TOKEN).'
            : !fromTerminal
              ? 'A delegated run does not post hook events for its agent: only the CLI in the agent\'s terminal does.'
              : 'A hook posts for the agent whose CLI it runs in, with that CLI\'s own token.',
        }, 403);
        return;
      }
    }

    try {
      // Dispatch to first matching route
      for (const route of routeApp.routes) {
        if (route.method !== req.method) continue;
        const params = matchRoute(route.pattern, pathname);
        if (params === null) continue;

        const routeReq: RouteRequest = {
          method: req.method!,
          pathname,
          url,
          body,
          raw: req,
          res,
          params,
          callerAgentId: caller.ok ? caller.agentId : undefined,
          callerTerminal: caller.ok ? caller.terminal === true : false,
          internal: caller.ok ? caller.internal === true : false,
          hermes: caller.ok ? caller.hermes === true : false,
        };
        await route.handler(routeReq, sendJson, ctx);
        return;
      }

      sendJson({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('API error:', error);
      sendJson({ error: 'Internal server error' }, 500);
    }
  });

  // In the Node 22 the tests run and the Node 24 of Electron 44, not yet in
  // the @types/node 20 this repo pins.
  (apiServer as http.Server & { keepAliveTimeoutBuffer: number }).keepAliveTimeoutBuffer = KEEP_ALIVE_GRACE_MS;

  const server = apiServer;
  const resolveSettings = getAppSettings || (() => appSettings);

  const attemptBind = () => {
    if (apiServer !== server) return;
    const attempts = apiServerState.attempts + 1;
    setApiServerState({
      phase: attempts === 1 ? 'starting' : 'retrying',
      attempts,
      nextRetryInMs: null,
    });
    server.listen(API_PORT, '127.0.0.1');
  };

  const giveUp = (err: NodeJS.ErrnoException) => {
    setApiServerState({
      phase: 'failed',
      lastError: err.message,
      nextRetryInMs: null,
      listeningSince: null,
    });
    // Loud on purpose. The window stays perfectly healthy-looking while every
    // path back into the app is dead, which is exactly how this went unnoticed
    // the last time: hooks, the seven MCP servers, /dispatch and /delegate all
    // speak to this port and nothing else reports that it is gone.
    console.error(
      `[api] FATAL: could not bind the local API to 127.0.0.1:${API_PORT} after ` +
      `${MAX_ATTEMPTS} attempts over ${Math.round(RETRY_WINDOW_MS / 1000)}s.`,
    );
    console.error(
      '[api] Delegation is offline: the CLI hooks, the bundled MCP servers, /dispatch and /delegate all call back on this port.',
    );
    console.error(
      `[api] Another process holds it. Find it with: lsof -nP -iTCP:${API_PORT} -sTCP:LISTEN`,
    );
    console.error('[api] Quit it (most often a second Tars), then restart Tars.');

    const settings = resolveSettings();
    if (settings?.notificationsEnabled) {
      sendNotificationCallback(
        'Tars API error: port in use',
        `Port ${API_PORT} is held by another process, so delegation, hooks and MCP servers are offline. Quit the other instance and restart Tars.`,
        undefined,
        settings,
      );
    }
  };

  server.on('listening', () => {
    if (apiServer !== server) return;
    setApiServerState({
      phase: 'listening',
      lastError: null,
      nextRetryInMs: null,
      listeningSince: Date.now(),
    });
    const retried = apiServerState.attempts > 1 ? ` after ${apiServerState.attempts} attempts` : '';
    console.log(`Agent API server running on http://127.0.0.1:${API_PORT}${retried}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // This listener is never detached. A bind that fails after stopApiServer()
    // has already dropped the reference is not news, but leaving it unhandled
    // would take the main process down with it.
    if (apiServer !== server) return;

    if (err.code !== 'EADDRINUSE') {
      console.error('API server error:', err);
      // An error raised while it is serving does not mean the bind is lost, so
      // only a server that is not listening is reported as down.
      if (!server.listening) {
        setApiServerState({
          phase: 'failed',
          lastError: err.message,
          nextRetryInMs: null,
          listeningSince: null,
        });
      }
      return;
    }

    if (apiServerState.attempts >= MAX_ATTEMPTS) {
      giveUp(err);
      return;
    }
    const delay = RETRY_DELAYS_MS[apiServerState.attempts - 1];

    console.warn(
      `[api] Port ${API_PORT} is in use (attempt ${apiServerState.attempts}/${MAX_ATTEMPTS}). ` +
      `Retrying in ${Math.round(delay / 1000)}s.`,
    );
    setApiServerState({
      phase: 'retrying',
      lastError: err.message,
      nextRetryInMs: delay,
      listeningSince: null,
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attemptBind();
    }, delay);
    // A pending retry must never be the reason the app cannot quit.
    retryTimer.unref();
  });

  attemptBind();
}

export function stopApiServer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (apiServer) {
    const stopping = apiServer;
    apiServer = null;
    stopping.close();
  }
  setApiServerState({
    phase: 'stopped',
    attempts: 0,
    lastError: null,
    nextRetryInMs: null,
    listeningSince: null,
  });
}
