import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { RouteApp, RouteContext, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { hasOrchestratorPowers } from '../../core/agent-role';
import { roleGetsServer, serverWithheldAnswer } from '../mcp-roles';

/**
 * The calls Tars makes for mcp-x and mcp-socialdata, with the user's keys
 * (2.0.4). The servers run in the agent's process tree and read the keys out
 * of app-settings.json themselves; the keys are in ~/.tars-private now, which
 * nothing handed to an agent reads, so the servers ask Tars with their agent's
 * token and the key never leaves the main process.
 *
 * Each route makes only the calls its server's tools make, so an agent holding
 * a token cannot use the keys for anything else: the X account's DMs, its
 * follows, SocialData's billing. Each answers X's or SocialData's status and
 * body as they came, for the server to read as it always has.
 */

const X_API_HOST = 'api.x.com';
/** The MCP server whose work /api/x/request does: what a role does not get there, the route does not do for it. */
const X_SERVER = 'dorothy-x';
const SOCIALDATA_HOST = 'api.socialdata.tools';
/** As long as the servers waited for X or SocialData themselves (mcp-shared/src/http.ts, API_WAIT_MS). */
const SERVICE_WAIT_MS = 60_000;

/**
 * An E2E spec's stand-in of X's API (DOROTHY_X_API_URL): read under DOROTHY_E2E only, never by a packaged build, and
 * only as a plain http:// address on 127.0.0.1; else null, and the call goes to api.x.com.
 */
export function xApiTestUrl(env: NodeJS.ProcessEnv, packaged: boolean): URL | null {
  if (packaged || env.DOROTHY_E2E !== '1' || !env.DOROTHY_X_API_URL) return null;
  try {
    const url = new URL(env.DOROTHY_X_API_URL);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? url : null;
  } catch {
    return null;
  }
}

/** Where X is reached in this run: its own host, or the stand-in main set from xApiTestUrl. */
let xApiTest: URL | null = null;
export function useTestXApi(url: URL | null): void { xApiTest = url; }

/** The three writes the X tools make: a post or a reply, and a delete of one tweet. */
function xCallAllowed(method: unknown, endpoint: unknown): boolean {
  if (method === 'POST') return endpoint === '/2/tweets';
  if (method === 'DELETE') return typeof endpoint === 'string' && /^\/2\/tweets\/\d{1,25}$/.test(endpoint);
  return false;
}

/** SocialData's Twitter reads: a path under /twitter/ of plain segments, no query of its own. */
function socialDataPathAllowed(endpoint: unknown): endpoint is string {
  return typeof endpoint === 'string' && /^\/twitter(\/[A-Za-z0-9_]+)+$/.test(endpoint);
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

interface XCredentials { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string }

/** OAuth 1.0a, as mcp-x signed it: the OAuth parameters only, a JSON body is not signed. */
function oauthHeader(method: string, url: string, creds: XCredentials): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  const key = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return `OAuth ${Object.keys(params).sort().map((k) => `${percentEncode(k)}="${percentEncode(params[k])}"`).join(', ')}`;
}

/** One https call: its status and its body as text. Rejects on a network failure or past the wait. */
function call(options: https.RequestOptions, body?: string, transport: Pick<typeof https, 'request'> = https): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      let data = '';
      res.setEncoding?.('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    // In the words every MCP server here has for a silent host (mcp-shared's noAnswerWithin).
    req.setTimeout(SERVICE_WAIT_MS);
    req.on('timeout', () => req.destroy(new Error(`no answer within ${SERVICE_WAIT_MS / 1000} s`)));
    if (body) req.write(body);
    req.end();
  });
}

const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function registerIntegrationRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/x/request { method, endpoint, body? }: mcp-x's post, reply and delete.
  app.post('/api/x/request', async (req, sendJson: SendJson) => {
    // The API follows the role's MCP list (the Audit's P-1 on #657): an agent whose CLI is started without the X server
    // does not get its work done here either, whatever process of it presents its token. First, so that it learns
    // nothing else, in the door's words. The shared token, Tars's own pass and a Hermes gateway's secret name no
    // agent, and keep what they had: the switch decides.
    if (req.callerAgentId !== undefined) {
      const caller = agents.get(req.callerAgentId);
      if (!roleGetsServer(!!caller && hasOrchestratorPowers(caller), X_SERVER)) {
        sendJson(serverWithheldAnswer(X_SERVER), 403);
        return;
      }
    }
    const { method, endpoint, body } = req.body as { method?: unknown; endpoint?: unknown; body?: unknown };
    const settings = ctx.getAppSettings();
    // Posting is on only for the switch's own true (the audit's lead #12).
    if (settings.xPostingEnabled !== true) {
      sendJson({ error: 'Posting is off in Tars Settings > X (Twitter), so nothing was sent. The user turns it on there when agents may post, reply and delete.' }, 403);
      return;
    }
    if (!xCallAllowed(method, endpoint)) {
      sendJson({ error: 'Tars makes only a post, a reply or a delete of one tweet on X.' }, 400);
      return;
    }
    const { xApiKey, xApiSecret, xAccessToken, xAccessTokenSecret } = settings;
    if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessTokenSecret) {
      sendJson({ error: 'X API credentials not configured. Please add your API keys in Tars Settings > X (Twitter).' }, 400);
      return;
    }
    const bodyStr = body && typeof body === 'object' ? JSON.stringify(body) : undefined;
    const url = `https://${X_API_HOST}${endpoint}`;
    try {
      const answer = await call({
        hostname: xApiTest?.hostname ?? X_API_HOST, port: xApiTest ? Number(xApiTest.port) || 80 : 443, path: endpoint as string, method: method as string,
        headers: {
          Authorization: oauthHeader(method as string, url, { apiKey: xApiKey, apiSecret: xApiSecret, accessToken: xAccessToken, accessTokenSecret: xAccessTokenSecret }),
          'Content-Type': 'application/json', Accept: 'application/json',
        },
      }, bodyStr, xApiTest ? http : https);
      sendJson(answer);
    } catch (err) {
      sendJson({ error: `X API request failed: ${failure(err)}` }, 502);
    }
  });

  // POST /api/socialdata/request { endpoint, query? }: mcp-socialdata's reads.
  app.post('/api/socialdata/request', async (req, sendJson: SendJson) => {
    const { endpoint, query } = req.body as { endpoint?: unknown; query?: unknown };
    if (!socialDataPathAllowed(endpoint)) {
      sendJson({ error: 'Tars makes only SocialData\'s Twitter reads.' }, 400);
      return;
    }
    const key = ctx.getAppSettings().socialDataApiKey;
    if (!key) {
      sendJson({ error: 'SocialData API key not configured. Please add your API key in Tars Settings > SocialData.' }, 400);
      return;
    }
    const params = new URLSearchParams();
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
        if (typeof v === 'string' && v !== '') params.append(k, v);
      }
    }
    const qs = params.toString();
    try {
      const answer = await call({
        hostname: SOCIALDATA_HOST, port: 443, path: qs ? `${endpoint}?${qs}` : endpoint, method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      sendJson(answer);
    } catch (err) {
      sendJson({ error: `SocialData API request failed: ${failure(err)}` }, 502);
    }
  });
}
