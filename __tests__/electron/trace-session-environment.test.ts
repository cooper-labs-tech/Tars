import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { TraceStore, type TraceMeta, type WireRecord } from '../../electron/services/trace-store';
import { sessionDocument, traceExportLines } from '../../electron/services/trace-export';
import { TraceUploader } from '../../electron/services/trace-upload';
import { createEndpointProxy, type ProxyDeps, type ProxySession } from '../../electron/services/endpoint-proxy';
import { withoutInstallIds } from '../../electron/services/trace-wire';
import type { SessionEnvironment } from '../../electron/services/session-environment';

/**
 * Each traced session's environment, as the store keeps it, the export writes it and the upload sends it: the harness's
 * exact version and its own session id, the machine and the system (session-environment.ts), the power events during
 * the session, and on each request the traced sessions live on this computer when it was sent. And one thing never
 * kept: codex's installation id, a stable id of the computer, which codex 0.170 sends in its request body
 * (client_metadata, as its own key and inside its turn metadata, a JSON string) and in its x-codex-turn-metadata
 * header (measured on the capture of 26/11), which goes on to the endpoint as the harness sent it.
 *
 * How it fails, written before the code (27/11):
 * S1. A store the previous version wrote (no environment, events or live count columns) fails to open, loses its
 *     rows, or never gets the new columns.
 * S2. A fact set after the session opened (its version, its environment, an event) does not count as a change: a
 *     session already uploaded is never sent again with it.
 * S3. An event is stamped on a session that has ended.
 * S4. The harness's own session id is not kept, or a later request's id replaces the first.
 * S5. The live count is not on the request's row, or an unknown count is stored as 0.
 * S6. Codex's installation id is kept somewhere: the request's params (its own key, or inside the turn metadata
 *     string), any row or blob of the database, the export, the upload's preview.
 * S7. Taking the installation id away takes anything else with it: the effort, the rest of client_metadata (the
 *     session and turn ids), a string param that only looks like JSON.
 * S8. The export or the upload's preview lacks the environment, the events, the harness's session id or the live
 *     count.
 * S9. The proxy counts the live sessions at the end of a request rather than when it was sent; it does not take the
 *     harness's session id from codex's session-id header, or keeps a value that is not an id (too long, control
 *     characters); codex's installation id header does not reach the endpoint, or reaches the record.
 */

const INSTALL_ID = '6f1c2b7e-0d3a-4e5f-9a8b-7c6d5e4f3a2b';
const SESSION_ID = '019a0b1c-2d3e-7f40-8a9b-0c1d2e3f4a5b';

const ENV: SessionEnvironment = {
  osName: 'macOS', osVersion: '15.7.2', kernel: '24.6.0', arch: 'arm64', machineModel: 'Mac15,3', chip: 'Apple M3',
  cpuCores: 8, ramBytes: 34_359_738_368, tarsVersion: '2.0.7', tarsArch: 'arm64', locale: 'de-DE', timeZone: 'Europe/Berlin',
  utcOffsetMinutes: 60, onBattery: false,
};

let dir: string;
let store: TraceStore;

const meta = (traceId: string, more: Partial<TraceMeta> = {}): TraceMeta => ({
  traceId, projectPath: '/p/demo', agentId: 'a1', agentName: 'C', harness: 'codex', endpointId: 'ep-000001',
  endpointName: 'Remote host', model: 'open-coder', startedAt: 1_000_000, ...more,
});

/** Codex 0.170's Responses request, as the capture of 26/11 shows it (ids replaced). */
function codexBody(extra: Record<string, unknown> = {}): Buffer {
  const turnMetadata = JSON.stringify({
    installation_id: INSTALL_ID, session_id: SESSION_ID, thread_id: SESSION_ID, turn_id: 'turn-1', window_id: `${SESSION_ID}:0`,
    request_kind: 'turn', sandbox: 'none', model: 'open-coder', reasoning_effort: 'medium',
  });
  return Buffer.from(JSON.stringify({
    model: 'open-coder', stream: false, instructions: 'You are Codex.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] }],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], tool_choice: 'auto', parallel_tool_calls: false,
    reasoning: { effort: 'medium' }, store: false, include: [], prompt_cache_key: SESSION_ID,
    client_metadata: {
      'x-codex-installation-id': INSTALL_ID, thread_id: SESSION_ID, root_turn_id: 'turn-1', 'x-codex-turn-metadata': turnMetadata,
      turn_id: 'turn-1', 'x-codex-window-id': `${SESSION_ID}:0`, session_id: SESSION_ID,
    },
    ...extra,
  }));
}
const responsesReply = Buffer.from(JSON.stringify({
  id: 'resp_1', model: 'open-coder', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a.txt' }] }],
  usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
}));

function rec(traceId: string, startedAt: number, more: Partial<WireRecord> = {}): WireRecord {
  return {
    traceId, agentId: 'a1', surface: 'openai_responses', startedAt, firstByteAt: startedAt + 10, endedAt: startedAt + 100,
    status: 200, contentType: 'application/json', requestBody: codexBody(), responseBody: responsesReply, attempts: 1, heldMs: 0, ...more,
  };
}

/** Every value of every row of every table, blobs decompressed: what the database holds, as text. */
function everythingIn(file: string): string {
  const db = new Database(file, { readonly: true });
  const out: string[] = [];
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) {
      for (const v of Object.values(row)) {
        if (Buffer.isBuffer(v)) {
          const codec = String(row.codec ?? '');
          const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
          out.push((codec === 'zstd' && z.zstdDecompressSync ? z.zstdDecompressSync(v) : codec === 'br' ? zlib.brotliDecompressSync(v) : v).toString('utf8'));
        } else out.push(String(v));
      }
    }
  }
  db.close();
  return out.join('\n');
}

function uploader(s: TraceStore) {
  return new TraceUploader({
    store: s, installFile: path.join(dir, 'private', 'traces-install.json'),
    settings: () => ({ url: '' }), setDeletion: () => {}, eligible: () => true,
    scrubContext: () => ({ homeDirs: ['/Users/someone'], knownSecrets: [], envValues: [] }),
    client: { name: 'tars', version: 'test', platform: 'darwin' }, withdrawConsent: () => {},
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-session-env-'));
  store = new TraceStore(path.join(dir, 'traces.db'));
});
afterEach(() => {
  try { store.close(); } catch { /* closed by the test */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('codex\'s installation id', () => {
  it('S7: is taken out, and nothing else is', () => {
    const body = JSON.parse(codexBody({ note: '{not json', text: { verbosity: 'low' } }).toString());
    const kept = withoutInstallIds(body) as Record<string, any>;
    expect(JSON.stringify(kept)).not.toContain(INSTALL_ID);
    expect(kept.client_metadata['x-codex-installation-id']).toBeUndefined();
    expect(kept.client_metadata.session_id).toBe(SESSION_ID);
    expect(kept.client_metadata.turn_id).toBe('turn-1');
    expect(kept.reasoning).toEqual({ effort: 'medium' });
    expect(kept.note).toBe('{not json');
    expect(kept.text).toEqual({ verbosity: 'low' });
    const turn = JSON.parse(kept.client_metadata['x-codex-turn-metadata']);
    expect(turn.installation_id).toBeUndefined();
    expect(turn).toMatchObject({ session_id: SESSION_ID, request_kind: 'turn', reasoning_effort: 'medium' });
    // The value it was given is not changed under it.
    expect(body.client_metadata['x-codex-installation-id']).toBe(INSTALL_ID);
  });

  it('S6: is in no row or blob of the store, nor in the export or the preview', () => {
    store.openTrace(meta('t1'));
    store.ingest(rec('t1', 1_000_100, { nativeSessionId: SESSION_ID, liveSessions: 1 }));
    const params = JSON.parse(String((new Database(path.join(dir, 'traces.db'), { readonly: true })
      .prepare('SELECT params_json FROM requests').get() as { params_json: string }).params_json));
    expect(params.reasoning).toEqual({ effort: 'medium' });
    expect(params.client_metadata.session_id).toBe(SESSION_ID);
    const exported = [...traceExportLines(store, {})].join('\n');
    const preview = JSON.stringify(uploader(store).preview('t1'));
    store.close();
    const all = everythingIn(path.join(dir, 'traces.db'));
    expect(all).toContain(SESSION_ID);
    expect(all).not.toContain(INSTALL_ID);
    expect(exported).not.toContain(INSTALL_ID);
    expect(preview).not.toContain(INSTALL_ID);
    for (const f of fs.readdirSync(dir).filter(f => f.startsWith('traces.db'))) {
      expect(fs.readFileSync(path.join(dir, f)).includes(INSTALL_ID), f).toBe(false);
    }
  });
});

describe('a session\'s environment in the store', () => {
  it('S1: a store the previous version wrote opens, keeps its rows and gets the new columns', () => {
    store.close();
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE traces (trace_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT,
      harness TEXT NOT NULL, harness_version TEXT, native_session_id TEXT, endpoint_id TEXT NOT NULL, endpoint_name TEXT,
      endpoint_base_url TEXT, model TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, last_end_at INTEGER,
      turn_count INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_cached INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, final_status TEXT NOT NULL DEFAULT 'open',
      outcome_json TEXT, mixed INTEGER NOT NULL DEFAULT 0, unknown_turns INTEGER NOT NULL DEFAULT 0, main_system_hash TEXT,
      bytes INTEGER NOT NULL DEFAULT 0, updated_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE requests (request_id TEXT PRIMARY KEY, upstream_request_id TEXT, trace_id TEXT NOT NULL, turn_id TEXT,
      seq INTEGER NOT NULL, side INTEGER NOT NULL DEFAULT 0, surface TEXT NOT NULL, model_requested TEXT, model_served TEXT,
      params_json TEXT, system_hash TEXT, tools_hash TEXT, started_at INTEGER NOT NULL, ttft_ms INTEGER, total_ms INTEGER,
      tokens_in INTEGER, tokens_cached INTEGER, tokens_out INTEGER, status INTEGER, error TEXT, finish_reason TEXT, streamed INTEGER,
      req_bytes INTEGER, resp_bytes INTEGER, new_messages INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 1,
      held_ms INTEGER NOT NULL DEFAULT 0, bodies_dropped INTEGER NOT NULL DEFAULT 0);
      INSERT INTO traces (trace_id, project_path, agent_id, harness, endpoint_id, model, started_at, updated_seq)
        VALUES ('old1', '/p/demo', 'a1', 'qwen-code', 'ep-000001', 'open-coder', 500, 1);`);
    old.close();
    store = new TraceStore(file);
    expect(store.session('old1')?.session.harness).toBe('qwen-code');
    store.setEnvironment('old1', ENV);
    store.ingest(rec('old1', 600, { liveSessions: 2 }));
    expect(store.session('old1')?.session.environment).toEqual(ENV);
    expect(store.session('old1')?.turns[0].requests[0].liveSessions).toBe(2);
    store.close();
    // Opened again: the columns are there once, not added twice.
    store = new TraceStore(file);
    expect(store.session('old1')?.session.environment).toEqual(ENV);
  });

  it('S2: a version, an environment and an event set after the start count as changes', () => {
    store.openTrace(meta('t1'));
    const seq = () => store.seqOf('t1')!;
    let before = seq();
    store.setHarnessVersion('t1', '0.170.0');
    expect(seq()).toBeGreaterThan(before);
    expect(store.session('t1')?.session.harnessVersion).toBe('0.170.0');
    before = seq();
    store.setHarnessVersion('t1', '0.170.0');
    expect(seq()).toBe(before);
    store.setEnvironment('t1', ENV);
    expect(seq()).toBeGreaterThan(before);
    before = seq();
    store.addEvent('t1', { at: 1_000_500, kind: 'sleep' });
    store.addEvent('t1', { at: 1_900_000, kind: 'wake' });
    expect(seq()).toBeGreaterThan(before);
    expect(store.session('t1')?.session.events).toEqual([{ at: 1_000_500, kind: 'sleep' }, { at: 1_900_000, kind: 'wake' }]);
  });

  it('S3: an ended session takes no event', () => {
    store.openTrace(meta('t1'));
    store.endTrace('t1', 1_000_900);
    const before = store.seqOf('t1');
    store.addEvent('t1', { at: 1_001_000, kind: 'battery' });
    expect(store.session('t1')?.session.events ?? []).toEqual([]);
    expect(store.seqOf('t1')).toBe(before);
  });

  it('S4: the harness\'s own session id is the first one it sent', () => {
    store.openTrace(meta('t1'));
    store.ingest(rec('t1', 1_000_100));
    expect(store.session('t1')?.session.nativeSessionId).toBeUndefined();
    store.ingest(rec('t1', 1_000_300, { nativeSessionId: SESSION_ID }));
    store.ingest(rec('t1', 1_000_500, { nativeSessionId: 'another-id' }));
    expect(store.session('t1')?.session.nativeSessionId).toBe(SESSION_ID);
  });

  it('S5: each request carries the live count it was sent with; an unknown one is null', () => {
    store.openTrace(meta('t1'));
    store.ingest(rec('t1', 1_000_100, { liveSessions: 3 }));
    store.ingest(rec('t1', 1_000_300));
    const reqs = store.session('t1')!.turns.flatMap(t => t.requests);
    expect(reqs.map(r => r.liveSessions)).toEqual([3, undefined]);
    const doc = sessionDocument(store, 't1')!;
    expect(doc.requests.map(r => r.live_sessions)).toEqual([3, null]);
  });

  it('S8: the export and the upload\'s preview carry all of it', () => {
    store.openTrace(meta('t1'));
    store.setHarnessVersion('t1', '0.170.0');
    store.setEnvironment('t1', ENV);
    store.ingest(rec('t1', 1_000_100, { nativeSessionId: SESSION_ID, liveSessions: 2 }));
    store.addEvent('t1', { at: 1_000_500, kind: 'battery' });
    const lines = [...traceExportLines(store, {})].map(l => JSON.parse(l));
    const trace = lines.find(l => l.table === 'traces');
    expect(trace).toMatchObject({ client_version: '0.170.0', native_session_id: SESSION_ID, environment: ENV, events: [{ at: 1_000_500, kind: 'battery' }] });
    expect(lines.find(l => l.table === 'requests')).toMatchObject({ live_sessions: 2 });

    const preview = uploader(store).preview('t1')!;
    const body = preview.document.batches[0].body as { sessions: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> };
    expect(body.sessions[0]).toMatchObject({
      harnessVersion: '0.170.0', nativeSessionId: SESSION_ID, environment: ENV, events: [{ at: 1_000_500, kind: 'battery' }],
    });
    expect(body.requests[0]).toMatchObject({ liveSessions: 2 });
  });

  it('S8: a session with none of it says so plainly in the export (null and empty), and sends nothing made up', () => {
    store.openTrace(meta('t1'));
    store.ingest(rec('t1', 1_000_100));
    const trace = [...traceExportLines(store, {})].map(l => JSON.parse(l)).find(l => l.table === 'traces');
    expect(trace).toMatchObject({ client_version: null, native_session_id: null, environment: null, events: [] });
    const body = uploader(store).preview('t1')!.document.batches[0].body as { sessions: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> };
    expect(body.sessions[0].environment).toBeUndefined();
    expect(body.sessions[0].nativeSessionId).toBeUndefined();
    expect(body.sessions[0].events).toEqual([]);
    expect(body.requests[0].liveSessions).toBeUndefined();
  });
});

describe('the proxy', () => {
  const SESSION: ProxySession = { token: 'tok-agent-1', traceId: 'trace-01', agentId: 'agent-1', endpointId: 'ep-000001', traced: true };
  let up: http.Server;
  let seen: http.IncomingHttpHeaders[];
  let proxy: http.Server;
  let base: string;
  let records: WireRecord[];
  let live: number;
  let release: (() => void) | undefined;

  beforeEach(async () => {
    seen = []; records = []; live = 2; release = undefined;
    up = http.createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      const answer = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(responsesReply); };
      if (req.headers['x-hold'] === '1') release = answer; else answer();
    });
    await new Promise<void>(r => up.listen(0, '127.0.0.1', () => r()));
    const upBase = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`;
    const deps: ProxyDeps = {
      sessionOf: (t) => (t === SESSION.token ? SESSION : undefined),
      targetOf: () => ({ baseUrl: upBase, key: 'real-key', holdMaxSeconds: 0 }),
      record: (r) => { records.push(r); },
      liveSessions: () => live,
    };
    proxy = createEndpointProxy(deps);
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise(r => proxy.close(() => r(undefined)));
    await new Promise(r => up.close(() => r(undefined)));
  });

  const send = (headers: Record<string, string>) => fetch(`${base}/v1/responses`, {
    method: 'POST', body: codexBody(),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION.token}`, ...headers },
  }).then(r => r.text());
  const settle = () => new Promise(r => setTimeout(r, 40));

  it('S9: counts the live sessions when the request is sent, and takes codex\'s session id', async () => {
    const pending = send({ 'x-hold': '1', 'session-id': SESSION_ID, 'x-codex-installation-id': INSTALL_ID });
    while (!release) await new Promise(r => setTimeout(r, 5));
    live = 5;
    release();
    await pending;
    await settle();
    expect(records).toHaveLength(1);
    expect(records[0].liveSessions).toBe(2);
    expect(records[0].nativeSessionId).toBe(SESSION_ID);
  });

  it('S9: codex\'s headers that carry its installation id reach the endpoint as sent, and never the record', async () => {
    // Measured on codex 0.170 (26/11): the id travels in x-codex-turn-metadata, a JSON header; any header of its own
    // name would pass the same way.
    const turnMetadata = JSON.stringify({ installation_id: INSTALL_ID, session_id: SESSION_ID, turn_id: 'turn-1' });
    await send({ 'session-id': SESSION_ID, 'x-codex-turn-metadata': turnMetadata, 'x-codex-installation-id': INSTALL_ID });
    await settle();
    expect(seen[0]['x-codex-turn-metadata']).toBe(turnMetadata);
    expect(seen[0]['x-codex-installation-id']).toBe(INSTALL_ID);
    const { requestBody, responseBody, ...rest } = records[0];
    void requestBody; void responseBody;
    expect(JSON.stringify(rest)).not.toContain(INSTALL_ID);
  });

  it('S9: a session-id that is not an id is not kept', async () => {
    await send({ 'session-id': 'x'.repeat(300) });
    await send({ 'session-id': 'two words' });
    await send({});
    await settle();
    expect(records.map(r => r.nativeSessionId)).toEqual([undefined, undefined, undefined]);
  });
});
