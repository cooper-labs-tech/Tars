import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEndpointProxy, retryDelayMs, type ProxyDeps, type ProxySession, type HoldEvent } from '../../electron/services/endpoint-proxy';
import type { WireRecord } from '../../electron/services/trace-store';

/**
 * The endpoint proxy (native traces): a harness on an inference endpoint talks to Tars on loopback with
 * a token of its terminal's; Tars swaps it for the endpoint's real key, adds X-Session-Id and X-Agent-Id, relays
 * everything else unchanged, chunk by chunk, and hands a copy to the trace store once the response has ended. When
 * the endpoint is unavailable before any byte has reached the harness (503 endpoint_busy, 429 at its cap, 502, a refused
 * connection), it holds the request and tries again, up to the endpoint's ceiling: the agent pauses, it does not fail.
 *
 * How it fails, written before the code (19/11):
 * 1. A token Tars did not mint, or a stale one, reaches the endpoint.
 * 2. The harness's own credential is forwarded instead of the real key; the header form changes (Bearer for one
 *    that sent x-api-key); an endpoint with no key gets an empty Authorization.
 * 3. The real key ends up in a record.
 * 4. A path other than the model routes is forwarded; a GET reaches a POST route.
 * 5. A body over the cap is accepted.
 * 6. X-Session-Id or X-Agent-Id is missing upstream, or a harness can set them itself.
 * 7. A stream is buffered: the harness gets nothing until the endpoint has sent everything (TTFT skewed).
 * 8. The request or response bytes are changed (an unknown param stripped, a vendor field dropped).
 * 9. An error status the endpoint gave is changed, or held when it is not a pause (400, 401, 404).
 * 10. A harness that hangs up leaves the upstream request running.
 * 11. A session that is not traced is recorded.
 * 12. The endpoint's X-Request-Id is lost, to the harness or to the record.
 * 13. A recorder that throws breaks the response.
 * 14. 503 then 429 then 200: the harness sees the errors; Retry-After is not honoured; no hold is told to the window.
 * 15. Past the ceiling, the request is held forever, or the last error is not passed as it came.
 * 16. An error once the stream has started is retried, or rewritten.
 * 17. A refused connection is not held, or after the ceiling becomes a hang instead of a 502.
 * 18. An endpoint that is not approved is reached.
 * 19. Retry-After as an HTTP date, or absent, gives no sensible wait; a huge one is not capped.
 */

type Upstream = { server: http.Server; base: string; seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Buffer }>; handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, n: number) => void };

async function upstream(): Promise<Upstream> {
  const u = { seen: [] } as unknown as Upstream;
  u.handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_up' }); res.end('{"ok":true}'); };
  u.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      u.seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      u.handler(req, res, body, u.seen.length);
    });
  });
  await new Promise<void>(r => u.server.listen(0, '127.0.0.1', () => r()));
  u.base = `http://127.0.0.1:${(u.server.address() as AddressInfo).port}/v1`;
  return u;
}

const SESSION: ProxySession = { token: 'tok-agent-1', traceId: 'trace-01', agentId: 'agent-1', endpointId: 'ep-000001', traced: true };
const KEY = 'real-endpoint-key-123';

let up: Upstream;
let proxy: http.Server;
let base: string;
let records: WireRecord[];
let holds: HoldEvent[];
let sleeps: number[];
let deps: ProxyDeps;

async function startProxy(over: Partial<ProxyDeps> = {}) {
  deps = {
    sessionOf: (t) => (t === SESSION.token ? SESSION : undefined),
    targetOf: () => ({ baseUrl: up.base, key: KEY, holdMaxSeconds: 600 }),
    record: (r) => { records.push(r); },
    onHold: (e) => { holds.push(e); },
    sleep: async (ms) => { sleeps.push(ms); },
    maxBodyBytes: 1024 * 1024,
    ...over,
  };
  proxy = createEndpointProxy(deps);
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION.token}`, ...init.headers }, body: init.body });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const settle = () => new Promise(r => setTimeout(r, 30));

beforeEach(async () => {
  records = []; holds = []; sleeps = [];
  up = await upstream();
});
afterEach(async () => {
  await new Promise(r => proxy?.close(() => r(undefined)));
  await new Promise(r => up.server.close(() => r(undefined)));
});

describe('the endpoint proxy', () => {
  it('1: a token Tars did not mint never reaches the endpoint', async () => {
    await startProxy();
    for (const headers of [{ Authorization: 'Bearer nope' }, { Authorization: '' }, { 'x-api-key': 'nope', Authorization: '' }]) {
      const r = await call('/v1/chat/completions', { headers, body: '{}' });
      expect(r.status).toBe(401);
    }
    expect(up.seen).toHaveLength(0);
  });

  it('2 and 6: the real key replaces the token in the same header form, and the two ids are set by Tars', async () => {
    await startProxy();
    await call('/v1/chat/completions', { body: '{"model":"m"}', headers: { 'X-Session-Id': 'forged', 'X-Agent-Id': 'forged' } });
    await call('/v1/messages', { body: '{"model":"m"}', headers: { Authorization: '', 'x-api-key': SESSION.token } });
    const [bearer, apiKey] = up.seen;
    expect(bearer.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(bearer.headers['x-api-key']).toBeUndefined();
    expect(apiKey.headers['x-api-key']).toBe(KEY);
    expect(apiKey.headers.authorization).toBeUndefined();
    for (const s of up.seen) {
      expect(s.headers['x-session-id']).toBe('trace-01');
      expect(s.headers['x-agent-id']).toBe('agent-1');
      expect(JSON.stringify(s.headers)).not.toContain(SESSION.token);
    }
  });

  it('2: an endpoint with no key gets no Authorization at all', async () => {
    await startProxy({ targetOf: () => ({ baseUrl: up.base, key: null, holdMaxSeconds: 600 }) });
    await call('/v1/chat/completions', { body: '{}' });
    expect(up.seen[0].headers.authorization).toBeUndefined();
  });

  it('3 and 11: the record never holds the key or the token, and a session not traced is not recorded', async () => {
    await startProxy();
    await call('/v1/chat/completions', { body: '{"model":"m","messages":[]}' });
    await settle();
    expect(records).toHaveLength(1);
    const text = JSON.stringify({ ...records[0], requestBody: records[0].requestBody.toString(), responseBody: records[0].responseBody.toString() });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SESSION.token);
    records = [];
    await new Promise(r => proxy.close(() => r(undefined)));
    await startProxy({ sessionOf: (t) => (t === SESSION.token ? { ...SESSION, traced: false } : undefined) });
    await call('/v1/chat/completions', { body: '{}' });
    await settle();
    expect(records).toHaveLength(0);
  });

  it('4 and 5: only the model routes, with their methods, and bodies under the cap', async () => {
    await startProxy({ maxBodyBytes: 100 });
    expect((await call('/v1/embeddings', { body: '{}' })).status).toBe(404);
    expect((await call('/v1/chat/completions', { method: 'GET' })).status).toBe(404);
    expect((await call('/v2/chat/completions', { body: '{}' })).status).toBe(404);
    expect((await call('/v1/chat/completions', { body: JSON.stringify({ pad: 'x'.repeat(200) }) })).status).toBe(413);
    expect(up.seen).toHaveLength(0);
    expect((await call('/v1/models', { method: 'GET' })).status).toBe(200);
    expect(up.seen[0].url).toBe('/v1/models');
  });

  it('7: a stream reaches the harness chunk by chunk, before the endpoint has sent the last', async () => {
    let releaseLast!: () => void;
    const lastMayGo = new Promise<void>(r => { releaseLast = r; });
    up.handler = (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'req_stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n');
      void lastMayGo.then(() => res.end('data: [DONE]\n\n'));
    };
    await startProxy();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: '{"stream":true}' });
    const reader = res.body!.getReader();
    const first = await Promise.race([reader.read(), new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 2000))]);
    expect(first).not.toBe('timeout');
    expect(Buffer.from((first as { value: Uint8Array }).value).toString()).toContain('first');
    await new Promise(r => setTimeout(r, 50));
    releaseLast();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();
    // The first byte's time is the time it came, not the stream's end: the 50 ms the endpoint held the last chunk.
    expect(records[0].endedAt - records[0].firstByteAt!).toBeGreaterThanOrEqual(45);
  });

  it('8 and 12: request and response bytes go through unchanged, X-Request-Id included', async () => {
    const reply = '{"id":"x","vendor_field":{"a":[1,2]},"usage":{"prompt_tokens_details":{"cached_tokens":3}}}';
    up.handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_abc' }); res.end(reply); };
    await startProxy();
    const sent = '{"model":"m","unknown_param":{"z":1},  "stream_options":null}';
    const r = await call('/v1/responses?beta=1', { body: sent });
    expect(up.seen[0].body.toString()).toBe(sent);
    expect(up.seen[0].url).toBe('/v1/responses?beta=1');
    expect(r.text).toBe(reply);
    expect(r.headers.get('x-request-id')).toBe('req_abc');
    await settle();
    expect(records[0].upstreamRequestId).toBe('req_abc');
    expect(records[0].requestBody.toString()).toBe(sent);
  });

  it('9: an error that is not a pause passes at once, unchanged', async () => {
    for (const status of [400, 401, 404, 413]) {
      up.handler = (_q, res) => { res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': `req_${status}` }); res.end(`{"error":{"type":"t${status}"}}`); };
      if (!proxy?.listening) await startProxy();
      const r = await call('/v1/chat/completions', { body: '{}' });
      expect(r.status).toBe(status);
      expect(r.text).toBe(`{"error":{"type":"t${status}"}}`);
    }
    expect(sleeps).toEqual([]);
  });

  it('10: a harness that hangs up ends the upstream request', async () => {
    let upstreamClosed = false;
    up.handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {}\n\n');
      req.socket.on('close', () => { upstreamClosed = true; });
    };
    await startProxy();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: '{}', signal: ctrl.signal });
    await res.body!.getReader().read();
    ctrl.abort();
    await expect.poll(() => upstreamClosed, { timeout: 2000 }).toBe(true);
  });

  it('13: a recorder that throws does not break the response', async () => {
    await startProxy({ record: () => { throw new Error('disk full'); } });
    const r = await call('/v1/chat/completions', { body: '{}' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"ok":true}');
  });

  it('14: 503 then 429 then 200: the harness sees only the 200, waits as Retry-After says, and the window is told', async () => {
    up.handler = (_q, res, _b, n) => {
      if (n === 1) { res.writeHead(503, { 'Retry-After': '2', 'X-Request-Id': 'req_1' }); res.end('{"error":{"type":"endpoint_busy"}}'); return; }
      if (n === 2) { res.writeHead(429, { 'Retry-After': '1', 'X-Request-Id': 'req_2' }); res.end('{"error":{"type":"rate_limited"}}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_3' }); res.end('{"ok":3}');
    };
    await startProxy();
    const r = await call('/v1/chat/completions', { body: '{"a":1}' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"ok":3}');
    expect(up.seen.map(s => s.body.toString())).toEqual(['{"a":1}', '{"a":1}', '{"a":1}']);
    expect(sleeps).toEqual([2000, 1000]);
    expect(holds.filter(h => !('cleared' in h)).map(h => (h as { lastStatus?: number }).lastStatus)).toEqual([503, 429]);
    expect(holds[holds.length - 1]).toMatchObject({ agentId: 'agent-1', cleared: true });
    await settle();
    expect(records[0]).toMatchObject({ attempts: 3, status: 200, upstreamRequestId: 'req_3' });
    expect(records[0].heldMs).toBeGreaterThanOrEqual(0);
  });

  it('15: past the ceiling, the last error passes as it came', async () => {
    let t = 0;
    up.handler = (_q, res) => { res.writeHead(503, { 'Retry-After': '30', 'X-Request-Id': 'req_busy' }); res.end('{"error":{"type":"endpoint_busy"}}'); };
    await startProxy({ targetOf: () => ({ baseUrl: up.base, key: KEY, holdMaxSeconds: 60 }), now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    const r = await call('/v1/chat/completions', { body: '{}' });
    expect(r.status).toBe(503);
    expect(r.text).toBe('{"error":{"type":"endpoint_busy"}}');
    expect(r.headers.get('retry-after')).toBe('30');
    expect(sleeps).toEqual([30000, 30000]);
    expect(up.seen).toHaveLength(3);
  });

  it('16: an error once the stream has started passes through, and is not retried', async () => {
    up.handler = (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"part":1}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
    };
    await startProxy();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: '{}' });
    expect(res.status).toBe(200);
    await res.text().catch(() => '');
    await settle();
    expect(up.seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('17: a refused connection is held, then passes as a 502 once the ceiling is reached', async () => {
    let t = 0;
    await startProxy({ targetOf: () => ({ baseUrl: 'http://127.0.0.1:9/v1', key: KEY, holdMaxSeconds: 10 }), now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    const r = await call('/v1/chat/completions', { body: '{}' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.type).toBe('endpoint_unreachable');
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });

  it('18: an endpoint that is not approved is never reached', async () => {
    await startProxy({ targetOf: () => ({ refused: { status: 403, type: 'endpoint_not_approved', message: 'The owner has not approved this endpoint.' } }) });
    const r = await call('/v1/chat/completions', { body: '{}' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error.type).toBe('endpoint_not_approved');
    expect(up.seen).toHaveLength(0);
  });

  it('19: the wait read from Retry-After, an HTTP date, or nothing, capped at 60 s', () => {
    expect(retryDelayMs('2', 1, 0)).toBe(2000);
    expect(retryDelayMs('600', 1, 0)).toBe(60_000);
    expect(retryDelayMs(new Date(10_000).toUTCString(), 1, 0)).toBe(10_000);
    for (const attempt of [1, 2, 3, 4, 9]) {
      const d = retryDelayMs(undefined, attempt, 0);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(36_000);
    }
    expect(retryDelayMs('garbage', 1, 0)).toBeGreaterThan(0);
  });
});
