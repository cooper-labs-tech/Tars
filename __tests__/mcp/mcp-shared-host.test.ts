import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * One process per Tars MCP server for every agent (2.0.5, lot 3 item G, the second step): the server serves MCP over
 * HTTP to Tars alone (mcp-shared/src/shared-host.ts), Tars proxying each agent's call to it from /api/mcp/<server>
 * with that agent's identity, and every call to Tars presenting that agent's own token (mcp-shared/src/tars-api.ts).
 *
 * How it fails, written before the code (28/10):
 * H1. A process on the machine that found the server's port is answered: without the secret Tars gave the server at
 *     its start, a request is refused before any MCP server is built.
 * H2. A call runs as someone else: the identity the tools read (agent, project, name, chats) and the token they
 *     present must be the ones Tars put on that request, never the server's environment (it has none) nor a header
 *     the agent's CLI sent (X-Tars-Caller-Id is the agent's claim, not Tars's word).
 * H3. Two agents' calls in flight at once mix their identities: each keeps its own through every await.
 * H4. The per-agent copy (stdio) loses its identity: outside a shared call, the environment is read as before.
 * H5. A request from Tars without an agent or a token is served: refused, since a tool would then run as nobody.
 * H6. A request's MCP server and transport outlive it: both are closed when its answer ends.
 */

import { sharedHandler, SHARED_HEADERS } from '../../mcp-shared/src/shared-host';
import { getCallerIdentity, callerName, callerReadsChats, presentedToken } from '../../mcp-shared/src/tars-api';

type Seen = { identity: ReturnType<typeof getCallerIdentity>; name: string; chats: boolean; token: string | null };

/** A stand-in of the SDK's server and transport: the transport answers with what the call sees, after an await. */
function fakes(delayMs = 0) {
  const closed: string[] = [];
  let built = 0;
  const deps = {
    createServer: () => {
      built++;
      const id = built;
      return {
        connect: async () => undefined,
        close: async () => { closed.push(`server ${id}`); },
      };
    },
    createTransport: () => ({
      handleRequest: async (_req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => {
        await new Promise(r => setTimeout(r, delayMs));
        const seen: Seen = { identity: getCallerIdentity(), name: callerName(), chats: callerReadsChats(), token: presentedToken() };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ seen, body }));
      },
      close: async () => { closed.push('transport'); },
    }),
  };
  return { deps, closed, built: () => built };
}

let server: http.Server | undefined;
async function serve(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

async function call(port: number, headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) as { seen: Seen; body: unknown } | undefined };
}

const SECRET = 's'.repeat(64);
const tars = (agent: string, over: Record<string, string> = {}) => ({
  [SHARED_HEADERS.secret]: SECRET,
  [SHARED_HEADERS.agentId]: agent,
  [SHARED_HEADERS.project]: `/projects/${agent}`,
  [SHARED_HEADERS.name]: encodeURIComponent(`Agent ${agent.toUpperCase()}`),
  [SHARED_HEADERS.chatsRead]: agent === 'a' ? '1' : '0',
  Authorization: `Bearer token-of-${agent}`,
  ...over,
});

beforeEach(() => {
  vi.stubEnv('CLAUDE_AGENT_ID', '');
  vi.stubEnv('CLAUDE_PROJECT_PATH', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('the shared server, as Tars reaches it', () => {
  it('H1. refuses a request without the secret, or with another, before building anything', async () => {
    const f = fakes();
    const port = await serve(sharedHandler(SECRET, f.deps));
    for (const secret of [undefined, 'x'.repeat(64), SECRET.slice(1)]) {
      const headers = tars('a');
      if (secret === undefined) delete (headers as Record<string, string>)[SHARED_HEADERS.secret];
      else headers[SHARED_HEADERS.secret] = secret;
      expect((await call(port, headers)).status, String(secret)).toBe(401);
    }
    expect(f.built()).toBe(0);
  });

  it('H2. the tools read the identity and present the token Tars put on the request, not the CLI\'s claim', async () => {
    const f = fakes();
    const port = await serve(sharedHandler(SECRET, f.deps));
    const { status, json } = await call(port, tars('a', { 'X-Tars-Caller-Id': 'b' }));
    expect(status).toBe(200);
    expect(json!.seen).toEqual({ identity: { agentId: 'a', projectPath: '/projects/a' }, name: 'Agent A', chats: true, token: 'token-of-a' });
  });

  it('H3. two agents\' calls in flight at once each keep their own identity', async () => {
    const f = fakes(30);
    const port = await serve(sharedHandler(SECRET, f.deps));
    const [a, b] = await Promise.all([call(port, tars('a')), call(port, tars('b'))]);
    expect([a.json!.seen.identity.agentId, a.json!.seen.token, a.json!.seen.chats]).toEqual(['a', 'token-of-a', true]);
    expect([b.json!.seen.identity.agentId, b.json!.seen.token, b.json!.seen.chats]).toEqual(['b', 'token-of-b', false]);
  });

  it('H4. outside a shared call, the environment is read as the per-agent copy always read it', () => {
    vi.stubEnv('CLAUDE_AGENT_ID', 'env-agent');
    vi.stubEnv('CLAUDE_PROJECT_PATH', '/env/project');
    vi.stubEnv('CLAUDE_AGENT_NAME', 'Env Agent');
    vi.stubEnv('TARS_CHATS_READ', '1');
    expect([getCallerIdentity(), callerName(), callerReadsChats()]).toEqual([{ agentId: 'env-agent', projectPath: '/env/project' }, 'Env Agent', true]);
  });

  it('H5. a request without an agent or a token is refused', async () => {
    const f = fakes();
    const port = await serve(sharedHandler(SECRET, f.deps));
    expect((await call(port, tars('a', { [SHARED_HEADERS.agentId]: '' }))).status).toBe(400);
    const noToken = tars('a');
    delete (noToken as Record<string, string>).Authorization;
    expect((await call(port, noToken)).status).toBe(400);
    expect(f.built()).toBe(0);
  });

  it('H6. each request has its own server and transport, closed when its answer ends', async () => {
    const f = fakes();
    const port = await serve(sharedHandler(SECRET, f.deps));
    await call(port, tars('a'));
    await call(port, tars('b'));
    await vi.waitFor(() => expect(f.closed.sort()).toEqual(['server 1', 'server 2', 'transport', 'transport']));
  });
});
