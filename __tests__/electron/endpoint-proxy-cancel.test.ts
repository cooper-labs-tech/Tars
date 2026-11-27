import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEndpointProxy, type ProxyDeps, type ProxySession } from '../../electron/services/endpoint-proxy';
import type { WireRecord } from '../../electron/services/trace-store';

/**
 * Every request cut before its end carries a structured cancel (trace feature B3, 27/11): `{ by, cause, at,
 * deliveredBytes }`, by `harness`, `tars`, `proxy` or `endpoint`. Until now a harness hanging up mid-stream was kept
 * as free text on the endpoint's failure path ("the endpoint closed the stream"), and one hanging up before the first
 * byte left no row. Who cut it is the proxy's to see, and why, for the harness and for Tars, the runtime's to say
 * (cutOf): an Esc or a Ctrl-C it saw from the window, or Tars ending the terminal.
 *
 * How it fails, written before the code:
 *  1. A harness that hangs up mid-stream is kept as the endpoint's error and counted as one; it must carry
 *     `by: 'harness'`, no error, and the bytes that reached it.
 *  2. The cause the runtime gives (an Esc, a Ctrl-C, Tars's stop) is not the one kept; with none, `unknown` (the
 *     harness's own timeout, a crash), never a guess.
 *  3. Hung up before the first byte and never held: no row, or one without a cancel. It is status 499, nothing
 *     delivered.
 *  4. Held, then given up: A3's `abandoned_while_held` is lost; or it wins over Tars's own stop or a key the runtime
 *     names.
 *  5. The endpoint cutting the stream: no cancel, or the error dropped. It is `by: 'endpoint'`, `stream_cut`, the
 *     error kept, the bytes delivered.
 *  6. The proxy's hold ceiling reached: no cancel; or one where the endpoint holds nothing (no hold set). It is
 *     `by: 'proxy'`, `hold_ceiling`, the endpoint's last answer passed as it came; a refused connection too.
 *  7. `deliveredBytes` counts what the endpoint sent, not what was written to the harness; `at` is not the cut's.
 *  8. A request that ends whole carries a cancel.
 *  9. The requests in flight per agent (what the runtime reads to tell an Esc into an answer from one at an idle
 *     prompt): not counted from the start, not uncounted at a hang-up, counted for a request refused at the door.
 * 10. The runtime asked about another request's time: cutOf must get this request's start and the cut's moment.
 */

type Upstream = { server: http.Server; base: string; handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void; seen: number };

async function upstream(): Promise<Upstream> {
  const u = { seen: 0 } as Upstream;
  u.handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); };
  u.server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { u.seen++; u.handler(req, res, u.seen); });
  });
  await new Promise<void>(r => u.server.listen(0, '127.0.0.1', () => r()));
  u.base = `http://127.0.0.1:${(u.server.address() as AddressInfo).port}/v1`;
  return u;
}

const SESSION: ProxySession = { token: 'tok-cancel-1', traceId: 'trace-cancel', agentId: 'agent-cancel', endpointId: 'ep-cancel', traced: true };
const BODY = '{"model":"m","stream":true,"messages":[{"role":"user","content":"go"}]}';
const CHUNK = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';

let up: Upstream;
let proxy: http.Server;
let base: string;
let records: WireRecord[];
let asked: Array<{ agentId: string; startedAt: number; at: number }>;
let flight: Map<string, number>;

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** A proxy closed with its connections, and whatever it still records dropped: the next test's records are its own. */
async function stopProxy(): Promise<void> {
  if (!proxy) return;
  const p = proxy;
  proxy = undefined as unknown as http.Server;
  p.closeAllConnections?.();
  await new Promise(r => p.close(() => r(undefined)));
}

async function startProxy(over: Partial<ProxyDeps> = {}) {
  await stopProxy();
  up.server.closeAllConnections?.();
  const into = records;
  proxy = createEndpointProxy({
    sessionOf: (t) => (t === SESSION.token ? SESSION : undefined),
    targetOf: () => ({ baseUrl: up.base, key: 'k', holdMaxSeconds: 60 }),
    record: (r) => { if (into === records) records.push(r); },
    sleep: abortableSleep,
    inFlight: (agentId, delta) => { flight.set(agentId, (flight.get(agentId) ?? 0) + delta); },
    ...over,
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

/** A streamed call whose first chunk is read, then hung up. */
async function readThenHangUp(): Promise<{ read: number; before: number; after: number }> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const first = await reader.read();
  const before = Date.now();
  ctrl.abort();
  const after = Date.now();
  return { read: first.value?.length ?? 0, before, after };
}

/** The upstream's stream: one chunk, then nothing until it is closed. */
const streamThenWait = (_q: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(CHUNK);
};

beforeEach(async () => {
  records = []; asked = []; flight = new Map();
  up = await upstream();
});
afterEach(async () => {
  await stopProxy();
  up.server.closeAllConnections?.();
  await new Promise(r => up.server.close(() => r(undefined)));
});

describe('the cancel on each request', () => {
  it('1 and 2: a harness hanging up mid-stream, with no cause the runtime knows: harness, unknown, the bytes delivered, no error', async () => {
    up.handler = streamThenWait;
    await startProxy({ cutOf: (agentId, startedAt, at) => { asked.push({ agentId, startedAt, at }); return undefined; } });
    const { before, after } = await readThenHangUp();
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    const [r] = records;
    expect(r.cancel).toMatchObject({ by: 'harness', cause: 'unknown', deliveredBytes: Buffer.byteLength(CHUNK) });
    expect(r.cancel!.at).toBeGreaterThanOrEqual(before);
    expect(r.cancel!.at).toBeLessThanOrEqual(after + 1000);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    // 10: asked about this request, at the cut.
    expect(asked).toEqual([{ agentId: SESSION.agentId, startedAt: r.startedAt, at: r.cancel!.at }]);
  });

  it('2: the cause the runtime names is kept: an Esc, a Ctrl-C, Tars\'s stop', async () => {
    up.handler = streamThenWait;
    for (const told of [{ by: 'harness', cause: 'esc' }, { by: 'harness', cause: 'ctrl_c' }, { by: 'tars', cause: 'stop' }] as const) {
      records = [];
      await startProxy({ cutOf: () => told });
      await readThenHangUp();
      await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
      expect(records[0].cancel, told.cause).toMatchObject({ ...told, deliveredBytes: Buffer.byteLength(CHUNK) });
      await stopProxy();
    }
  });

  it('3: hung up before the first byte, never held: status 499, nothing delivered', async () => {
    let reached = false;
    up.handler = () => { reached = true; /* never answers */ };
    await startProxy();
    const ctrl = new AbortController();
    const sent = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY, signal: ctrl.signal }).catch(() => undefined);
    await expect.poll(() => reached, { timeout: 3000 }).toBe(true);
    ctrl.abort();
    await sent;
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0]).toMatchObject({ status: 499, attempts: 1, cancel: { by: 'harness', cause: 'unknown', deliveredBytes: 0 } });
    expect(records[0].error).toBeUndefined();
  });

  it('4: held then given up stays A3\'s cause, unless Tars ended it or a key was seen', async () => {
    const busy = (_q: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(503, { 'Retry-After': '1' }); res.end('{"error":{"type":"endpoint_busy"}}'); };
    up.handler = busy;
    const giveUpWhileHeld = async () => {
      const ctrl = new AbortController();
      const sent = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY, signal: ctrl.signal }).catch(() => undefined);
      await expect.poll(() => up.seen, { timeout: 3000 }).toBeGreaterThan(0);
      await new Promise(r => setTimeout(r, 50));
      ctrl.abort();
      await sent;
      await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
      return records[0].cancel;
    };
    await startProxy();
    expect(await giveUpWhileHeld()).toMatchObject({ by: 'harness', cause: 'abandoned_while_held', deliveredBytes: 0 });
    await stopProxy();
    records = []; up.seen = 0;
    await startProxy({ cutOf: () => ({ by: 'tars', cause: 'restart' }) });
    expect(await giveUpWhileHeld()).toMatchObject({ by: 'tars', cause: 'restart' });
    await stopProxy();
    records = []; up.seen = 0;
    await startProxy({ cutOf: () => ({ by: 'harness', cause: 'esc' }) });
    expect(await giveUpWhileHeld()).toMatchObject({ by: 'harness', cause: 'esc' });
  });

  it('5: the endpoint cutting the stream: endpoint, stream_cut, its error kept, the bytes delivered', async () => {
    up.handler = (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(CHUNK);
      setTimeout(() => res.socket?.destroy(), 30);
    };
    await startProxy();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY });
    await res.text().catch(() => '');
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0].cancel).toMatchObject({ by: 'endpoint', cause: 'stream_cut', deliveredBytes: Buffer.byteLength(CHUNK) });
    expect(records[0].error).toBeTruthy();
  });

  it('6: the hold ceiling reached: proxy, hold_ceiling, the last answer passed; none where no hold is set', async () => {
    let t = 0;
    up.handler = (_q, res) => { res.writeHead(503, { 'Retry-After': '5' }); res.end('{"error":{"type":"endpoint_busy"}}'); };
    await startProxy({ targetOf: () => ({ baseUrl: up.base, key: 'k', holdMaxSeconds: 12 }), now: () => t, sleep: async (ms) => { t += ms; } });
    const held = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY });
    expect(held.status).toBe(503);
    await held.text();
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0]).toMatchObject({ status: 503, cancel: { by: 'proxy', cause: 'hold_ceiling', deliveredBytes: 0 } });
    expect(records[0].attempts).toBeGreaterThan(1);
    await stopProxy();

    records = [];
    await startProxy({ targetOf: () => ({ baseUrl: up.base, key: 'k', holdMaxSeconds: 0 }) });
    const plain = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY });
    expect(plain.status).toBe(503);
    await plain.text();
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0].cancel).toBeUndefined();
    await stopProxy();

    records = []; t = 0;
    await startProxy({ targetOf: () => ({ baseUrl: 'http://127.0.0.1:9/v1', key: 'k', holdMaxSeconds: 10 }), now: () => t, sleep: async (ms) => { t += ms; } });
    const refused = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY });
    expect(refused.status).toBe(502);
    await refused.text();
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0].cancel).toMatchObject({ by: 'proxy', cause: 'hold_ceiling', deliveredBytes: 0 });
  });

  it('8: a request that ends whole carries no cancel', async () => {
    up.handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(CHUNK); res.end('data: [DONE]\n\n'); };
    await startProxy();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY });
    await res.text();
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0].cancel).toBeUndefined();
    expect(records[0].error).toBeUndefined();
  });

  it('9: the requests in flight, per agent: counted from the start to the end or the hang-up, never at the door', async () => {
    up.handler = streamThenWait;
    await startProxy();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: BODY, signal: ctrl.signal });
    await res.body!.getReader().read();
    expect(flight.get(SESSION.agentId)).toBe(1);
    ctrl.abort();
    await expect.poll(() => flight.get(SESSION.agentId), { timeout: 3000 }).toBe(0);
    const refused = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer not-a-token' }, body: BODY });
    expect(refused.status).toBe(401);
    up.handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{}'); };
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` }, body: '{}' })).text();
    await expect.poll(() => flight.get(SESSION.agentId), { timeout: 3000 }).toBe(0);
    expect([...flight.keys()]).toEqual([SESSION.agentId]);
  });
});
