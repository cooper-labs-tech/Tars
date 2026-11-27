import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as os from 'node:os';
import type { AddressInfo } from 'node:net';

/**
 * The API follows the role's MCP list. A worker's CLI is started without the X server (services/mcp-roles.ts, the
 * owner's decision of 28/10). The route that does that server's work, POST /api/x/request, must not do it for that
 * worker either. The same goes for any route that does the work of a server the list withholds from a role.
 *
 * Every way it can fail, written before the code (27/11):
 *  1. A worker's own token gets the X server's work done through the route, which its MCP list does not give it.
 *  2. A worker's delegated run token (not its terminal's) passes where its terminal's token is refused.
 *  3. An agent no longer in the fleet, whose token outlived it, is taken for one with the powers.
 *  4. The refusal tells a worker more than the door does: whether posting is on, whether the keys are set, what X
 *     answered. It must come before all of them, in the door's own words and status, and nothing goes out.
 *  5. The project's orchestrator, or a chat's runner (a worker with the orchestrator's powers), is refused: the check
 *     reads the stored role rather than the powers the role list is applied with.
 *  6. The shared token (no agent) or Tars's own pass loses what it had: for them, posting still depends on the switch
 *     alone.
 *  7. A second list: the route, the door or mcp-shared reads a copy of the role list, and the copy drifts from what the
 *     CLIs are started with.
 *  8. The door and the route answer a worker differently for the same server.
 *  9. The E2E stand-in of X's API is read by a packaged build, without DOROTHY_E2E, or at an address that is not a
 *     loopback http:// one. The user's signed call would then go elsewhere. Set as the spec sets it, the call goes to
 *     the stand-in, signed as X gets it.
 * 10. SocialData's route, a server a worker's role keeps, is refused to a worker.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.6' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
const { fleet } = vi.hoisted(() => ({
  fleet: new Map<string, Record<string, unknown>>([
    ['w', { id: 'w', name: 'Writer', role: 'worker', projectPath: '/work/harbor' }],
    ['lead', { id: 'lead', name: 'Harbor Lead', role: 'orchestrator', projectPath: '/work/harbor' }],
    ['runner', { id: 'runner', name: 'Chat runner', role: 'worker', kind: 'chat', projectPath: '/work/harbor' }],
  ]),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: fleet }));
vi.mock('../../../../electron/core/chat-inbox', () => ({ chatsReadEnv: () => ({}) }));

const out = vi.hoisted(() => ({ calls: [] as Array<{ host?: string; method?: string; path?: string; auth?: string; body?: string }>, status: 201, body: '{"data":{"id":"7"}}' }));
vi.mock('https', () => {
  const request = (options: { hostname?: string; method?: string; path?: string; headers?: Record<string, string> }, onResponse: (res: EventEmitter & { statusCode: number }) => void) => {
    const call = { host: options.hostname, method: options.method, path: options.path, auth: options.headers?.Authorization, body: '' };
    out.calls.push(call);
    const req = Object.assign(new EventEmitter(), {
      write: (b: string) => { call.body += b; },
      end: () => {
        const res = Object.assign(new EventEmitter(), { statusCode: out.status, setEncoding: () => {} });
        onResponse(res);
        res.emit('data', out.body);
        res.emit('end');
      },
      setTimeout: () => req, destroy: () => {},
    });
    return req;
  };
  return { default: { request }, request };
});

import * as integration from '../../../../electron/services/api-routes/integration-routes';
import { registerMcpRoutes } from '../../../../electron/services/api-routes/mcp-routes';
import * as roles from '../../../../electron/services/mcp-roles';
import * as shared from '../../../../electron/services/mcp-shared';
import type { AppSettings } from '../../../../electron/types';

type Answer = { data: Record<string, unknown>; status: number };
type Handler = (req: Record<string, unknown>, sendJson: (data: unknown, status?: number) => void) => Promise<void> | void;
const handlers = new Map<string, Handler>();
const CREDS = { xApiKey: 'ck', xApiSecret: 'cs', xAccessToken: 'at', xAccessTokenSecret: 'ats' };
let live: Partial<AppSettings>;
const POST = { method: 'POST', endpoint: '/2/tweets', body: { text: 'hi' } };

/** A call as the API server hands it to the route: the caller resolveCaller named from the token, never a header. */
async function call(route: string, body: Record<string, unknown>, caller: { agent?: string; terminal?: boolean; internal?: boolean } = {}): Promise<Answer> {
  let answer: Answer = { data: {}, status: 0 };
  await handlers.get(route)!({ body, callerAgentId: caller.agent, callerTerminal: caller.terminal, internal: caller.internal },
    (data, status = 200) => { answer = { data: data as Record<string, unknown>, status }; });
  return answer;
}

/** The shared MCP door's answer to the same caller for a server, as mcp-routes.ts gives it. */
async function door(server: string, agent: string): Promise<Answer> {
  let answer: Answer = { data: {}, status: 0 };
  const routes: Array<{ handler: Handler }> = [];
  registerMcpRoutes({ add: (_m: string, _p: RegExp, handler: Handler) => routes.push({ handler }) } as never);
  await routes[0].handler({ method: 'POST', params: { id: server }, callerAgentId: agent, body: {} },
    (data, status = 200) => { answer = { data: data as Record<string, unknown>, status }; });
  return answer;
}

beforeEach(() => {
  handlers.clear();
  out.calls.length = 0;
  live = { ...CREDS, xPostingEnabled: true, socialDataApiKey: 'sd-key' };
  const app = { post: (route: string, h: Handler) => handlers.set(route, h), get: () => {} } as never;
  integration.registerIntegrationRoutes(app, { getAppSettings: () => live } as never);
});

describe('POST /api/x/request follows the role\'s MCP list', () => {
  it('1, 2. a worker\'s own token is refused, its terminal\'s and a delegated run\'s alike, and nothing goes to X', async () => {
    for (const terminal of [true, false]) {
      const r = await call('/api/x/request', POST, { agent: 'w', terminal });
      expect(r.status, `terminal ${terminal}`).toBe(403);
    }
    expect(out.calls).toEqual([]);
  });

  it('3. an agent no longer in the fleet is refused', async () => {
    expect((await call('/api/x/request', POST, { agent: 'gone', terminal: true })).status).toBe(403);
    expect(out.calls).toEqual([]);
  });

  it('4, 8. the refusal comes first and says what the door says, whatever the switch and the keys', async () => {
    const atDoor = await door('dorothy-x', 'w');
    expect(atDoor.status).toBe(403);
    for (const settings of [{ ...CREDS, xPostingEnabled: true }, { ...CREDS, xPostingEnabled: false }, { xPostingEnabled: true }, {}]) {
      live = settings;
      const r = await call('/api/x/request', POST, { agent: 'w', terminal: true });
      expect(r, JSON.stringify(settings)).toEqual(atDoor);
    }
    expect(await call('/api/x/request', { method: 'GET', endpoint: '/2/dm_events' }, { agent: 'w', terminal: true })).toEqual(atDoor);
    expect(out.calls).toEqual([]);
  });

  it('5. the project\'s orchestrator and a chat\'s runner post', async () => {
    for (const agent of ['lead', 'runner']) {
      const r = await call('/api/x/request', POST, { agent, terminal: true });
      expect(r, agent).toEqual({ status: 200, data: { status: 201, data: out.body } });
    }
    expect(out.calls.map(c => c.path)).toEqual(['/2/tweets', '/2/tweets']);
  });

  it('6. the shared token and Tars\'s own pass keep what they had: the switch decides', async () => {
    for (const caller of [{}, { internal: true }]) {
      live = { ...CREDS, xPostingEnabled: true };
      expect((await call('/api/x/request', POST, caller)).status, JSON.stringify(caller)).toBe(200);
      live = { ...CREDS, xPostingEnabled: false };
      expect(String((await call('/api/x/request', POST, caller)).data.error)).toMatch(/^Posting is off/);
    }
    expect(out.calls).toHaveLength(2);
  });

  it('10. SocialData, which a worker keeps, answers a worker', async () => {
    expect((await call('/api/socialdata/request', { endpoint: '/twitter/search', query: { query: 'tars' } }, { agent: 'w', terminal: true })).status).toBe(200);
    expect(out.calls).toEqual([expect.objectContaining({ host: 'api.socialdata.tools' })]);
  });
});

describe('one role list', () => {
  it('7. mcp-shared reads mcp-roles\'s own list, and the roles each get the server through one function', () => {
    expect(shared.ORCHESTRATOR_ONLY_MCP).toBe(roles.ORCHESTRATOR_ONLY_MCP);
    expect(roles.roleGetsServer(false, 'dorothy-x')).toBe(false);
    expect(roles.roleGetsServer(true, 'dorothy-x')).toBe(true);
    expect(roles.roleGetsServer(false, 'dorothy-socialdata')).toBe(true);
    for (const name of roles.ORCHESTRATOR_ONLY_MCP) expect(roles.roleGetsServer(false, name), name).toBe(false);
  });
});

describe('the E2E stand-in of X\'s API', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    integration.useTestXApi(null);
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
  });

  it('9. read under DOROTHY_E2E only, never by a packaged build, and only at a loopback http:// address', () => {
    const at = 'http://127.0.0.1:40123';
    expect(integration.xApiTestUrl({ DOROTHY_E2E: '1', DOROTHY_X_API_URL: at }, false)?.href).toBe(`${at}/`);
    expect(integration.xApiTestUrl({ DOROTHY_E2E: '1', DOROTHY_X_API_URL: at }, true)).toBeNull();
    expect(integration.xApiTestUrl({ DOROTHY_X_API_URL: at }, false)).toBeNull();
    for (const raw of ['https://127.0.0.1:40123', 'http://example.com:40123', 'http://192.0.2.1', 'http://127.0.0.1.example.com', 'not a url', '', undefined]) {
      expect(integration.xApiTestUrl({ DOROTHY_E2E: '1', DOROTHY_X_API_URL: raw }, false), String(raw)).toBeNull();
    }
  });

  it('9. set, an orchestrator\'s post reaches the stand-in, signed as X gets it', async () => {
    const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"data":{"id":"9"}}');
      });
    });
    servers.push(s);
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
    integration.useTestXApi(integration.xApiTestUrl({ DOROTHY_E2E: '1', DOROTHY_X_API_URL: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }, false));
    const r = await call('/api/x/request', POST, { agent: 'lead', terminal: true });
    expect(r).toEqual({ status: 200, data: { status: 201, data: '{"data":{"id":"9"}}' } });
    expect(seen).toEqual([expect.objectContaining({ method: 'POST', url: '/2/tweets', body: '{"text":"hi"}' })]);
    expect(seen[0].auth).toMatch(/^OAuth .*oauth_consumer_key="ck".*oauth_token="at"/);
    expect(out.calls).toEqual([]);
  });
});
