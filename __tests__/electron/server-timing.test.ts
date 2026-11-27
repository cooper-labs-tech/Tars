import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseServerTiming, requestTiming, sessionTiming } from '../../electron/services/server-timing';
import { createEndpointProxy, type ProxySession } from '../../electron/services/endpoint-proxy';
import { TraceStore, type WireRecord } from '../../electron/services/trace-store';
import { sessionDocument, traceExportLines } from '../../electron/services/trace-export';
import { TraceUploader } from '../../electron/services/trace-upload';

/**
 * The round trip to the endpoint and the offset between its clock and ours, from the Server-Timing header an endpoint
 * sends on every response (W3C Server Timing): `recv;desc="<epoch ms>"` when it read the request, `send;desc="<epoch
 * ms>"` when it began sending its headers, `queue;dur=<ms>` its wait for a free slot, `upstream;dur=<ms>` its wait for
 * its model server (absent when it answered by itself). With t1 when the proxy sent the request and t4 when the
 * response's headers came, on our clock: offset = ((t2 - t1) + (t3 - t4)) / 2, round trip = (t4 - t1) - (t3 - t2).
 *
 * How it fails, written before the code (27/11):
 * T1. The header is absent (an endpoint that does not send it yet) and the round trip or the offset is 0, not null.
 * T2. One metric is missing: without recv or send a round trip or an offset is made up; without queue the round trip
 *     is lost; an upstream the endpoint did not send is 0.
 * T3. A desc that is not an integer of epoch ms (a decimal, a date, a negative, an empty or unquoted word) is read as
 *     one; a dur that is not a number, or is negative, is kept.
 * T4. A negative round trip (the endpoint's recv to send longer than our t1 to t4, as rounding or a clock running at
 *     another rate makes it) is clamped to 0 or dropped: it is kept per request as measured. The session's summary
 *     leaves it out (its median and the sample its offset is taken from are those with a round trip of 0 or more).
 *     An endpoint whose send is before its recv says nothing usable: null.
 * T5. An unknown metric (a cache hit, a total, a name that only starts like a known one) changes a value; a second
 *     metric of a known name replaces the first; a quoted desc holding a comma or a semicolon splits the header.
 * T6. The header on a 429 (its queue the full wait) or on a 503 (queue 0, no upstream), passed on to the harness, is
 *     not read.
 * T7. t1 is the request's arrival at the proxy, or the first of its held attempts, so the round trip holds the time
 *     the proxy held it; t4 is the end of the body, so a streamed answer's round trip holds the whole stream.
 * T8. The session's summary is not the offset of its fastest sample and the median of its round trips (an even count
 *     takes the mean of the two middle ones); with no sample it is not null.
 * T9. The store, the export or the upload's preview lose a value, or turn an unknown one into 0.
 * Added after the mutation bench showed it missing (M19, 27/11):
 * T10. A metric whose syntax breaks after a valid parameter (`recv;desc="<ms>";dur=`) is read in part, its valid
 *      parameter kept, rather than dropped whole.
 */

const T = 1_764_243_600_000;
const header = (recv: number, send: number, more = 'queue;dur=0, upstream;dur=41.7') => `recv;desc="${recv}", ${more}, send;desc="${send}"`;

describe('the Server-Timing header', () => {
  it('reads the four metrics of the pinned shape', () => {
    expect(parseServerTiming(`recv;desc="${T + 123}", queue;dur=0, upstream;dur=41.7, send;desc="${T + 167}"`))
      .toEqual({ recv: T + 123, send: T + 167, queue: 0, upstream: 41.7 });
  });

  it('T1: absent, empty or garbage: every value null', () => {
    for (const v of [undefined, '', '   ', 'garbage', ';;;,,,', '"unterminated', 'recv;desc="1', 'recv;desc']) {
      expect(parseServerTiming(v), String(v)).toEqual({ recv: null, send: null, queue: null, upstream: null });
    }
    expect(requestTiming(undefined, T, T + 50)).toEqual({ rttMs: null, clockOffsetMs: null, queueMs: null, upstreamMs: null });
  });

  it('T2: a metric missing leaves its own value null, and a round trip needs both recv and send', () => {
    expect(requestTiming(`queue;dur=3, upstream;dur=40, send;desc="${T + 30}"`, T, T + 50))
      .toEqual({ rttMs: null, clockOffsetMs: null, queueMs: 3, upstreamMs: 40 });
    expect(requestTiming(`recv;desc="${T + 10}", queue;dur=3`, T, T + 50))
      .toEqual({ rttMs: null, clockOffsetMs: null, queueMs: 3, upstreamMs: null });
    expect(requestTiming(`recv;desc="${T + 10}", send;desc="${T + 30}"`, T, T + 50))
      .toEqual({ rttMs: 30, clockOffsetMs: -5, queueMs: null, upstreamMs: null });
  });

  it('T3: a desc that is not an integer of epoch ms, or a dur that is not a number of 0 or more, is not read', () => {
    for (const bad of ['"1764243600123.5"', '"2026-11-27T12:00:00Z"', '"-5"', '""', 'abc', '"12ab"', '"1e12"']) {
      expect(parseServerTiming(`recv;desc=${bad}, send;desc="${T}"`).recv, bad).toBeNull();
    }
    // An unquoted token of digits is a valid value in the grammar.
    expect(parseServerTiming(`recv;desc=${T}`).recv).toBe(T);
    for (const bad of ['-1', 'NaN', 'fast', '', '1e3', '"12"x']) {
      expect(parseServerTiming(`queue;dur=${bad}`).queue, bad).toBeNull();
    }
    expect(parseServerTiming('queue;dur="12.5"').queue).toBe(12.5);
  });

  it('T4: a negative round trip is kept as measured, and an endpoint whose send is before its recv gives nothing', () => {
    // Our clock saw 40 ms between sending and the headers; the endpoint says it held the request 45 ms.
    const t = requestTiming(header(T + 5000, T + 5045), T, T + 40);
    expect(t.rttMs).toBe(-5);
    expect(t.clockOffsetMs).toBe(5002.5);
    expect(requestTiming(header(T + 5045, T + 5000), T, T + 40)).toMatchObject({ rttMs: null, clockOffsetMs: null });
  });

  it('T5: unknown metrics are ignored, the first of a name counts, and a quoted desc keeps its commas', () => {
    const v = `cache;desc="hit, then miss; maybe", recvx;desc="1", total;dur=99, recv;desc="${T + 10}", recv;desc="${T + 999}", `
      + `edge;desc="a\\"b,c", send;desc="${T + 30}", queue;dur=2;desc="slot, at last"`;
    expect(parseServerTiming(v)).toEqual({ recv: T + 10, send: T + 30, queue: 2, upstream: null });
    // Two Server-Timing headers, as Node gives them.
    expect(parseServerTiming([`recv;desc="${T + 10}"`, `send;desc="${T + 30}", upstream;dur=5`])).toEqual({ recv: T + 10, send: T + 30, queue: null, upstream: 5 });
  });

  it('T10: a metric whose syntax breaks after a valid parameter is dropped whole', () => {
    for (const broken of [`recv;desc="${T + 10}";dur=, send;desc="${T + 30}"`, `send;desc="${T + 30}", recv;desc="${T + 10}";dur=`, `recv;desc="${T + 10}";dur="7, send;desc="${T + 30}"`]) {
      expect(parseServerTiming(broken).recv, broken).toBeNull();
    }
    expect(parseServerTiming(`recv;desc="${T + 10}";dur=, send;desc="${T + 30}"`).send).toBe(T + 30);
  });

  it('computes the offset and the round trip from t1 to t4', () => {
    // The endpoint's clock runs 1000 ms ahead; the network takes 10 ms each way; the endpoint holds it 20 ms.
    expect(requestTiming(header(T + 1010, T + 1030), T, T + 40)).toEqual({ rttMs: 20, clockOffsetMs: 1000, queueMs: 0, upstreamMs: 41.7 });
  });
});

describe('a session\'s summary', () => {
  it('T8: the offset of its fastest round trip and the median of its round trips, negatives left out', () => {
    expect(sessionTiming([])).toEqual({ rttMedianMs: null, clockOffsetMs: null });
    expect(sessionTiming([{ rttMs: null, clockOffsetMs: null }])).toEqual({ rttMedianMs: null, clockOffsetMs: null });
    expect(sessionTiming([
      { rttMs: 30, clockOffsetMs: 990 }, { rttMs: 12, clockOffsetMs: 1001 }, { rttMs: -4, clockOffsetMs: 1500 },
      { rttMs: 50, clockOffsetMs: 970 }, { rttMs: null, clockOffsetMs: null },
    ])).toEqual({ rttMedianMs: 30, clockOffsetMs: 1001 });
    expect(sessionTiming([{ rttMs: 10, clockOffsetMs: 5 }, { rttMs: 20, clockOffsetMs: 6 }])).toEqual({ rttMedianMs: 15, clockOffsetMs: 5 });
    expect(sessionTiming([{ rttMs: -3, clockOffsetMs: 7 }])).toEqual({ rttMedianMs: null, clockOffsetMs: null });
  });
});

describe('the proxy', () => {
  const SESSION: ProxySession = { token: 'tok-agent-1', traceId: 'trace-01', agentId: 'agent-1', endpointId: 'ep-000001', traced: true };
  let up: http.Server;
  let proxy: http.Server;
  let base: string;
  let records: WireRecord[];
  let answer: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;
  let hold: number;
  let n: number;
  let sleeps: number[];

  beforeEach(async () => {
    records = []; n = 0; hold = 0; sleeps = [];
    up = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => answer(req, res, ++n));
    });
    await new Promise<void>(r => up.listen(0, '127.0.0.1', () => r()));
    const upBase = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`;
    proxy = createEndpointProxy({
      sessionOf: (t) => (t === SESSION.token ? SESSION : undefined),
      targetOf: () => ({ baseUrl: upBase, key: 'k', holdMaxSeconds: hold }),
      record: (r) => { records.push(r); },
      sleep: async (ms) => { sleeps.push(ms); await new Promise(r => setTimeout(r, 300)); },
    });
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise(r => proxy.close(() => r(undefined)));
    await new Promise(r => up.close(() => r(undefined)));
  });

  const send = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION.token}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  }).then(async r => ({ status: r.status, timing: r.headers.get('server-timing'), body: await r.text() }));
  const settle = () => new Promise(r => setTimeout(r, 40));
  const stamp = (res: http.ServerResponse, status: number, more: string) => {
    const now = Date.now();
    res.writeHead(status, { 'Content-Type': 'application/json', 'Server-Timing': `recv;desc="${now}", ${more}, send;desc="${now}"`, 'Retry-After': '1' });
  };

  it('T1: no header from the endpoint, no round trip, never 0', async () => {
    answer = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[]}'); };
    await send();
    await settle();
    expect(records[0].timing).toEqual({ rttMs: null, clockOffsetMs: null, queueMs: null, upstreamMs: null });
  });

  it('T6: the header on a 429 and on a 503 passed on to the harness is read, and passed on too', async () => {
    answer = (_q, res, k) => {
      if (k === 1) stamp(res, 429, 'queue;dur=30000');
      else stamp(res, 503, 'queue;dur=0');
      res.end('{"error":{"type":"busy"}}');
    };
    const first = await send();
    const second = await send();
    await settle();
    expect([first.status, second.status]).toEqual([429, 503]);
    expect(first.timing).toContain('queue;dur=30000');
    expect(records.map(r => [r.status, r.timing?.queueMs, r.timing?.upstreamMs])).toEqual([[429, 30000, null], [503, 0, null]]);
    expect(records.every(r => typeof r.timing?.rttMs === 'number' && r.timing.rttMs >= 0 && r.timing.rttMs < 1000)).toBe(true);
  });

  it('T7: the round trip leaves out the time the proxy held the request, and a stream\'s body after its headers', async () => {
    hold = 600;
    answer = (_q, res, k) => {
      if (k === 1) { stamp(res, 503, 'queue;dur=0'); res.end('{}'); return; }
      stamp(res, 200, 'queue;dur=1, upstream;dur=2');
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      setTimeout(() => res.end('data: [DONE]\n\n'), 400);
    };
    await send();
    await settle();
    expect(sleeps.length).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].attempts).toBe(2);
    expect(records[0].heldMs).toBeGreaterThanOrEqual(250);
    expect(records[0].timing?.rttMs).toBeGreaterThanOrEqual(0);
    expect(records[0].timing?.rttMs).toBeLessThan(200);
    expect(records[0].timing).toMatchObject({ queueMs: 1, upstreamMs: 2 });
  });
});

describe('the store, the export and the preview', () => {
  let dir: string;
  let store: TraceStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-timing-'));
    store = new TraceStore(path.join(dir, 'traces.db'));
    store.openTrace({ traceId: 't1', projectPath: '/p/demo', agentId: 'a1', harness: 'codex', endpointId: 'ep-000001', model: 'm', startedAt: T });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rec = (startedAt: number, timing?: WireRecord['timing']): WireRecord => ({
    traceId: 't1', agentId: 'a1', surface: 'openai_chat', startedAt, firstByteAt: startedAt + 5, endedAt: startedAt + 50, status: 200,
    contentType: 'application/json', attempts: 1, heldMs: 0, timing,
    requestBody: Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `go ${startedAt}` }], tools: [{ type: 'function', function: { name: 'bash' } }] })),
    responseBody: Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })),
  });

  it('T9: each request keeps its four values, an unknown one stays unknown, and the session its summary', () => {
    store.ingest(rec(T + 100, { rttMs: 30, clockOffsetMs: 990, queueMs: 0, upstreamMs: 41.7 }));
    store.ingest(rec(T + 300, { rttMs: 12, clockOffsetMs: 1001.5, queueMs: 3, upstreamMs: null }));
    store.ingest(rec(T + 500, { rttMs: -4, clockOffsetMs: 1500, queueMs: 0, upstreamMs: 40 }));
    store.ingest(rec(T + 700));
    const s = store.session('t1')!;
    const reqs = s.turns.flatMap(t => t.requests).sort((a, b) => a.startedAt - b.startedAt);
    expect(reqs.map(r => [r.rttMs, r.clockOffsetMs, r.queueMs, r.upstreamMs])).toEqual([
      [30, 990, 0, 41.7], [12, 1001.5, 3, undefined], [-4, 1500, 0, 40], [undefined, undefined, undefined, undefined],
    ]);
    expect(s.session).toMatchObject({ rttMedianMs: 21, clockOffsetMs: 1001.5 });

    const doc = sessionDocument(store, 't1')!;
    expect(doc.trace).toMatchObject({ rtt_median_ms: 21, clock_offset_ms: 1001.5 });
    expect(doc.requests.map(r => [r.rtt_ms, r.clock_offset_ms, r.queue_ms, r.upstream_ms]).sort((a, b) => Number(a[0] ?? 99) - Number(b[0] ?? 99)))
      .toEqual([[-4, 1500, 0, 40], [12, 1001.5, 3, null], [30, 990, 0, 41.7], [null, null, null, null]]);
    expect([...traceExportLines(store, {})].join('\n')).toContain('"rtt_median_ms":21');

    const preview = new TraceUploader({
      store, installFile: path.join(dir, 'private', 'install.json'), settings: () => ({ url: '' }), setDeletion: () => {}, eligible: () => true,
      scrubContext: () => ({ homeDirs: ['/Users/someone'], knownSecrets: [], envValues: [] }), client: { name: 'tars', version: 't', platform: 'darwin' },
      withdrawConsent: () => {},
    }).preview('t1')!;
    const body = preview.document.batches[0].body as { sessions: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> };
    expect(body.sessions[0]).toMatchObject({ rttMedianMs: 21, clockOffsetMs: 1001.5 });
    const sent = body.requests.map(r => [r.rttMs, r.clockOffsetMs, r.queueMs, r.upstreamMs]);
    expect(sent).toContainEqual([-4, 1500, 0, 40]);
    expect(sent).toContainEqual([12, 1001.5, 3, undefined]);
    expect(sent).toContainEqual([undefined, undefined, undefined, undefined]);
  });

  it('T9: a session with no sample has a null summary in the export and none in the upload', () => {
    store.ingest(rec(T + 100));
    expect(sessionDocument(store, 't1')!.trace).toMatchObject({ rtt_median_ms: null, clock_offset_ms: null });
    expect(store.session('t1')!.session.rttMedianMs).toBeUndefined();
  });
});
