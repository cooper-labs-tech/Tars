import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEndpointProxy, type ProxyDeps, type ProxySession, type HoldEvent } from '../../electron/services/endpoint-proxy';
import type { WireRecord } from '../../electron/services/trace-store';

/**
 * A request the harness gives up while the proxy holds it is demand that never reached the model (27/11, trace
 * feature A3): until now it left no record at all (the two returns on an aborted signal, endpoint-proxy.ts).
 *
 * How it fails, written before the code:
 *  1. Given up during a hold's wait (the endpoint paused, 503 with Retry-After): no row, or a row whose only trace of
 *     it is free text. It must carry status 499 and `cancel: { by: 'harness', cause: 'abandoned_while_held', at,
 *     deliveredBytes: 0 }`, with its attempts and the time it was held.
 *  2. Given up while the try after a hold is in flight at the endpoint: the same record.
 *  3. Over-recording: a request given up before any hold (its first try in flight) is no request given up while
 *     held (another feature's, the structured cancel of every request); an untraced session records nothing.
 *  4. The record is made on the relay's path (it must come after the harness is gone, and never throw to it).
 */

type Upstream = { server: http.Server; base: string; seen: number; handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void };

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

const TRACED: ProxySession = { token: 'tok-held-1', traceId: 'trace-held', agentId: 'agent-held', endpointId: 'ep-held', traced: true };
const BODY = '{"model":"m","stream":true,"messages":[{"role":"user","content":"go"}]}';
const busy = (res: http.ServerResponse) => { res.writeHead(503, { 'Retry-After': '1', 'Content-Type': 'application/json' }); res.end('{"error":{"type":"endpoint_busy"}}'); };

let up: Upstream;
let proxy: http.Server;
let base: string;
let records: WireRecord[];
let holds: HoldEvent[];
let session: ProxySession;

/** A wait that ends at once when the harness hangs up, as the proxy's own does. */
const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

async function startProxy(over: Partial<ProxyDeps> = {}) {
  proxy = createEndpointProxy({
    sessionOf: (t) => (t === session.token ? session : undefined),
    targetOf: () => ({ baseUrl: up.base, key: 'k', holdMaxSeconds: 60 }),
    record: (r) => { records.push(r); },
    onHold: (e) => { holds.push(e); },
    sleep: abortableSleep,
    ...over,
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

/** The harness's call, given up when `giveUp` resolves. */
async function callAndGiveUp(giveUp: () => Promise<unknown>): Promise<void> {
  const ctrl = new AbortController();
  const sent = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: BODY, signal: ctrl.signal }).catch(() => undefined);
  await giveUp();
  ctrl.abort();
  await sent;
}

beforeEach(async () => {
  records = []; holds = [];
  session = { ...TRACED };
  up = await upstream();
});
afterEach(async () => {
  await new Promise(r => proxy?.close(() => r(undefined)));
  up.server.closeAllConnections?.();
  await new Promise(r => up.server.close(() => r(undefined)));
});

describe('a request the harness gives up while the proxy holds it', () => {
  it('1: during a hold\'s wait, a row with status 499 and its cancel, its attempts and held time', async () => {
    up.handler = (_q, res) => busy(res);
    await startProxy();
    const before = Date.now();
    await callAndGiveUp(() => expect.poll(() => holds.filter(h => !('cleared' in h)).length, { timeout: 3000 }).toBeGreaterThan(0));
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    const [r] = records;
    expect(r).toMatchObject({ traceId: 'trace-held', status: 499, attempts: 1, cancel: { by: 'harness', cause: 'abandoned_while_held', deliveredBytes: 0 } });
    expect(r.cancel!.at).toBeGreaterThanOrEqual(before);
    expect(r.heldMs).toBeGreaterThanOrEqual(0);
    expect(r.requestBody.toString()).toBe(BODY);
    expect(r.responseBody.length).toBe(0);
    expect(r.error).toBeUndefined();
    // The window is told the wait is over.
    expect(holds[holds.length - 1]).toMatchObject({ agentId: 'agent-held', cleared: true });
  });

  it('2: while the try after a hold is in flight, the same row', async () => {
    let second = false;
    up.handler = (_q, res, n) => { if (n === 1) busy(res); else second = true; /* never answers */ };
    await startProxy({ sleep: async () => {} });
    await callAndGiveUp(() => expect.poll(() => second, { timeout: 3000 }).toBe(true));
    await expect.poll(() => records.length, { timeout: 3000 }).toBe(1);
    expect(records[0]).toMatchObject({ status: 499, attempts: 2, cancel: { by: 'harness', cause: 'abandoned_while_held', deliveredBytes: 0 } });
  });

  it('3: given up before any hold, or in an untraced session: no such row', async () => {
    let reached = false;
    up.handler = () => { reached = true; /* never answers */ };
    await startProxy();
    await callAndGiveUp(() => expect.poll(() => reached, { timeout: 3000 }).toBe(true));
    await new Promise(r => setTimeout(r, 200));
    // Recorded since trace feature B3, as a hang-up of unknown cause (endpoint-proxy-cancel.test.ts, 3), never as
    // given up while held.
    expect(records.filter(r => r.cancel?.cause === 'abandoned_while_held')).toEqual([]);
    expect(records.map(r => r.cancel?.cause)).toEqual(['unknown']);

    records = [];
    session = { ...TRACED, traced: false };
    up.handler = (_q, res) => busy(res);
    await callAndGiveUp(() => expect.poll(() => holds.length, { timeout: 3000 }).toBeGreaterThan(0));
    await new Promise(r => setTimeout(r, 200));
    expect(records).toEqual([]);
  });

  it('4: a recorder that throws reaches nobody', async () => {
    up.handler = (_q, res) => busy(res);
    await startProxy({ record: () => { throw new Error('disk full'); } });
    await callAndGiveUp(() => expect.poll(() => holds.length, { timeout: 3000 }).toBeGreaterThan(0));
    // Still serving.
    up.handler = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":1}'); };
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, body: '{}' });
    expect(res.status).toBe(200);
  });
});
