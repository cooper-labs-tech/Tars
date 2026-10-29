import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * How a shared MCP server answers a call (2.0.5, lot 3 item G; the Audit's M1 and L1 on #541): over an event stream,
 * so a long tool (wait_for_agent) keeps claude's request alive with its progress. In one JSON body, claude's request
 * timeout ended the wait. Only the E2E pinned it (the Audit's L1): the servers' transports were built in their own
 * index.ts, which no unit runs, so JSON mode coming back passed every unit.
 *
 * How it fails, written before the code (28/10):
 * T1. A call through sharedHandler, with the real SDK server and transport built from the options every server takes,
 *     is answered as one JSON body instead of an event stream.
 * T2. A server builds its shared transport with options of its own, so the options the unit pins are not the ones
 *     it runs with.
 */

const SDK = path.resolve('mcp-orchestrator/node_modules/@modelcontextprotocol/sdk/dist/esm/server');
const SERVERS = ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban', 'mcp-vault', 'mcp-socialdata', 'mcp-x'];
let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

describe('a shared call', () => {
  it('T1. is answered over an event stream, with the options every server takes', async () => {
    const { sharedHandler, SHARED_HEADERS, SHARED_TRANSPORT_OPTIONS } = await import('../../mcp-shared/src/shared-host');
    const { McpServer } = await import(path.join(SDK, 'mcp.js'));
    const { StreamableHTTPServerTransport } = await import(path.join(SDK, 'streamableHttp.js'));
    const secret = 's'.repeat(40);
    server = http.createServer(sharedHandler(secret, {
      createServer: () => new McpServer({ name: 'probe', version: '1.0.0' }),
      createTransport: () => new StreamableHTTPServerTransport(SHARED_TRANSPORT_OPTIONS),
    }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer tok',
        [SHARED_HEADERS.secret]: secret, [SHARED_HEADERS.agentId]: 'a1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '2.1.312' } } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(await res.text()).toMatch(/^event: message\ndata: \{"result":\{"protocolVersion"/m);
  });

  it('T2. every shared server builds its transport from those options, and from nothing else', () => {
    for (const s of SERVERS) {
      const source = fs.readFileSync(path.join(s, 'src', 'index.ts'), 'utf8');
      const built = source.match(/new StreamableHTTPServerTransport\([^)]*\)/g) ?? [];
      expect(built, s).toEqual(['new StreamableHTTPServerTransport(SHARED_TRANSPORT_OPTIONS)']);
    }
  });
});
