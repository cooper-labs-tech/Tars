import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import type { AddressInfo } from 'node:net';

/**
 * The door to Tars's shared MCP servers (2.0.5, lot 3 item G, the second step): /api/mcp/<server>, under /api/ and so
 * authenticated by the agent's own token, proxied by Tars to the one process that serves that server for every
 * agent (services/mcp-shared.ts), with the caller's identity as Tars knows it.
 *
 * How it fails, written before the code (28/10):
 * R1. A caller with no agent (the shared token, Tars's pass, nothing) reaches a server: refused 403, the server
 *     never reached. A call carrying another agent's id with its own token is refused by resolveCaller before any
 *     route (api-server.ts), which the E2E drives.
 * R2. A server that is not shared (telegram, which resolves files against its agent's folder, or a name that is
 *     none) is reached: 404.
 * R3. A shared server that is not running is waited on for ever: 503, saying so.
 * R4. The identity the server reads comes from the caller: the agent's id, project, name and chats switch must be
 *     the fleet's record for the token's agent, any x-tars-agent-* header the caller sent is dropped, and the secret
 *     is Tars's. The agent's own token goes through (the server presents it to Tars on every call), and the server's
 *     answer comes back as it was: its status, its type, its body.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
const { fleet } = vi.hoisted(() => ({
  fleet: new Map<string, Record<string, unknown>>([
    ['a', { id: 'a', name: 'Harbor Worker', role: 'worker', projectPath: '/work/harbor', status: 'running' }],
    ['o', { id: 'o', name: 'Harbor Lead', role: 'orchestrator', projectPath: '/work/harbor', status: 'running' }],
  ]),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: fleet }));
vi.mock('../../../../electron/core/chat-inbox', () => ({ chatsReadEnv: (id: string) => (id === 'o' ? { TARS_CHATS_READ: '1' } : {}) }));

import { registerMcpRoutes } from '../../../../electron/services/api-routes/mcp-routes';
import { setSharedMcpTarget } from '../../../../electron/services/mcp-shared';

const SECRET = 'f'.repeat(64);
const servers: http.Server[] = [];
const listen = async (handler: http.RequestListener) => {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
};

/** The helper's stand-in: records what reached it and answers like an MCP server in JSON mode. */
async function helper() {
  const seen: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const port = await listen((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    });
  });
  return { port, seen };
}

/** Tars's stand-in: the route as the API server runs it, the caller named by a test header (resolveCaller's work). */
async function tars() {
  const routes: Array<{ method: string; pattern: RegExp | string; handler: (...a: unknown[]) => unknown }> = [];
  const app = {
    routes,
    add(method: string, pattern: RegExp | string, handler: (...a: unknown[]) => unknown) { routes.push({ method, pattern, handler }); },
    get(p: RegExp | string, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
    post(p: RegExp | string, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
    put(p: RegExp | string, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
    delete(p: RegExp | string, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
  };
  registerMcpRoutes(app as never);
  return listen(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url!, 'http://x');
    const route = routes.find(r => r.method === req.method && r.pattern instanceof RegExp && r.pattern.test(url.pathname));
    const sendJson = (data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!route) return sendJson({ error: 'Not found' }, 404);
    const m = (route.pattern as RegExp).exec(url.pathname)!;
    const caller = req.headers['x-test-caller'];
    await route.handler({
      method: req.method, pathname: url.pathname, url, body: raw ? JSON.parse(raw) : {}, raw: req, res,
      params: { id: m[1] }, callerAgentId: typeof caller === 'string' && caller ? caller : undefined,
    }, sendJson, {});
  });
}

const post = (port: number, server: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/mcp/${server}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer token-of-a', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

beforeEach(() => {
  for (const name of ['claude-mgr-kanban', 'claude-mgr-orchestrator']) setSharedMcpTarget(name, undefined);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});

describe('/api/mcp/<server>', () => {
  it('R1. refuses a caller with no agent, and never reaches the server', async () => {
    const h = await helper();
    setSharedMcpTarget('claude-mgr-kanban', { port: h.port, secret: SECRET });
    const res = await post(await tars(), 'claude-mgr-kanban', {});
    expect(res.status).toBe(403);
    expect(h.seen).toEqual([]);
  });

  it('R2. a server that is not shared, or none, is not found', async () => {
    const port = await tars();
    for (const name of ['claude-mgr-telegram', 'tasmania', 'nothing']) {
      expect((await post(port, name, { 'X-Test-Caller': 'a' })).status, name).toBe(404);
    }
  });

  it('R3. a shared server that is not running answers 503 at once, saying so', async () => {
    const res = await post(await tars(), 'claude-mgr-kanban', { 'X-Test-Caller': 'a' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/not running/);
  });

  it('R4. hands the server the fleet\'s identity, never the caller\'s, with the agent\'s token and Tars\'s secret, and its answer back', async () => {
    const h = await helper();
    setSharedMcpTarget('claude-mgr-orchestrator', { port: h.port, secret: SECRET });
    const res = await post(await tars(), 'claude-mgr-orchestrator', {
      'X-Test-Caller': 'o', 'X-Tars-Agent-Id': 'a', 'X-Tars-Agent-Project': '/elsewhere', 'X-Tars-Mcp-Secret': 'mine', 'Mcp-Protocol-Version': '2025-06-18',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    expect(h.seen).toHaveLength(1);
    const got = h.seen[0];
    expect(got.method).toBe('POST');
    expect(JSON.parse(got.body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect({
      secret: got.headers['x-tars-mcp-secret'], id: got.headers['x-tars-agent-id'], project: got.headers['x-tars-agent-project'],
      name: decodeURIComponent(String(got.headers['x-tars-agent-name'])), chats: got.headers['x-tars-chats-read'],
      auth: got.headers.authorization, version: got.headers['mcp-protocol-version'], accept: got.headers.accept,
    }).toEqual({
      secret: SECRET, id: 'o', project: '/work/harbor', name: 'Harbor Lead', chats: '1',
      auth: 'Bearer token-of-a', version: '2025-06-18', accept: 'application/json, text/event-stream',
    });
  });
});
