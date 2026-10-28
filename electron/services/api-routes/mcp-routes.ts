import * as http from 'http';
import { agents } from '../../core/agent-manager';
import { chatsReadEnv } from '../../core/chat-inbox';
import { SHARED_MCP_SERVERS, sharedMcpTarget } from '../mcp-shared';
import type { RouteApp, RouteRequest, SendJson } from './types';

/**
 * /api/mcp/<server>: an agent's CLI reaching one of Tars's shared MCP servers (services/mcp-shared.ts). Under /api/,
 * so authenticated (api-server.ts): the caller is the agent its own token names, and a different X-Tars-Caller-Id
 * beside it was refused before any route. Tars hands the server the identity it knows for that agent (its id,
 * project, name and whether it reads the other chats), never a header the CLI sent, with Tars's secret, and the
 * agent's own token, which the server presents to Tars on every call it makes. The server's answer comes back as it
 * was: its status, its type and its body.
 */

const PASSED = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id', 'authorization'];
const RETURNED = ['content-type', 'mcp-session-id', 'cache-control'];

function proxy(req: RouteRequest, sendJson: SendJson): void {
  const name = req.params.id;
  if (!SHARED_MCP_SERVERS.includes(name)) {
    sendJson({ error: `${name} is not one of Tars's shared MCP servers` }, 404);
    return;
  }
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'A shared MCP server is reached by an agent: with its own token (CLAUDE_MGR_API_TOKEN).' }, 403);
    return;
  }
  const target = sharedMcpTarget(name);
  if (!target) {
    sendJson({ error: `${name} is not running in Tars right now` }, 503);
    return;
  }
  const headers: Record<string, string> = {};
  for (const h of PASSED) {
    const v = req.raw.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  Object.assign(headers, {
    'x-tars-mcp-secret': target.secret,
    'x-tars-agent-id': agent.id,
    'x-tars-agent-project': agent.projectPath,
    'x-tars-agent-name': encodeURIComponent(agent.name || agent.id),
    'x-tars-chats-read': chatsReadEnv(agent.id).TARS_CHATS_READ === '1' ? '1' : '0',
  });
  // The body the API server read (MCP's messages are JSON objects), sent again as it was.
  const body = req.method === 'POST' ? JSON.stringify(req.body) : undefined;
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const upstream = http.request({ host: '127.0.0.1', port: target.port, path: '/', method: req.method, headers }, answer => {
    const back: Record<string, string> = {};
    for (const h of RETURNED) {
      const v = answer.headers[h];
      if (typeof v === 'string') back[h] = v;
    }
    req.res.writeHead(answer.statusCode ?? 502, back);
    answer.pipe(req.res);
  });
  upstream.on('error', err => {
    if (!req.res.headersSent) sendJson({ error: `${name} did not answer: ${err.message}` }, 502);
    else req.res.destroy();
  });
  // The CLI gone, its call goes too.
  req.res.on('close', () => { if (!req.res.writableFinished) upstream.destroy(); });
  upstream.end(body);
}

export function registerMcpRoutes(app: RouteApp): void {
  const pattern = /^\/api\/mcp\/([a-z0-9-]+)$/;
  for (const method of ['GET', 'POST', 'DELETE']) app.add(method, pattern, proxy);
}
