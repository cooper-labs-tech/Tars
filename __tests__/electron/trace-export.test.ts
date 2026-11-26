import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TraceStore } from '../../electron/services/trace-store';
import { traceExportLines, sessionDocument } from '../../electron/services/trace-export';

/**
 * The export and the read API's session document in the reader's trace format tables: traces, turns,
 * requests, request_messages and messages, with `copy: "console"` and `masking_version: "none"` where v0 asks for
 * them, `mixed` and `unknown_turns` on the trace (an external reader asked for it), `upstream_request_id` for the 1:1 join.
 *
 * How it fails, written before the code (19/11):
 * 1. A message shared by several requests is written once per request instead of once.
 * 2. A row of one table misses the keys that link it (trace_id, turn_id, request_id, message_hash).
 * 3. A session outside the filter is exported.
 * 4. The system prompt or the tools are lost from the export.
 * 5. A line is not one JSON object (a newline inside a value breaks the JSONL).
 * 6. The session document misses mixed, unknown_turns or upstream_request_id.
 */

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function seeded(): TraceStore {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-export-'));
  const store = new TraceStore(path.join(dir, 't.db'));
  const meta = { projectPath: '/p/a', agentId: 'a1', harness: 'pi', endpointId: 'ep-000001', model: 'GLM', startedAt: 1000 };
  store.openTrace({ traceId: 't1', ...meta });
  store.openTrace({ traceId: 't2', ...meta, projectPath: '/p/b', startedAt: 2000 });
  const req = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: 'GLM', messages: [{ role: 'system', content: 'SYS\nline two' }, ...messages], tools: [{ type: 'function', function: { name: 'bash' } }] }));
  const resp = (message: unknown, finish: string) => Buffer.from(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{}' } }] };
  const base = { traceId: 't1', agentId: 'a1', surface: 'openai_chat' as const, status: 200, contentType: 'application/json', attempts: 1, heldMs: 0 };
  store.ingest({ ...base, startedAt: 1000, endedAt: 1100, requestBody: req([{ role: 'user', content: 'go' }]), responseBody: resp(call, 'tool_calls'), upstreamRequestId: 'req_a' });
  store.ingest({ ...base, startedAt: 1200, endedAt: 1300, requestBody: req([{ role: 'user', content: 'go' }, call, { role: 'tool', tool_call_id: 'c', content: 'ok' }]), responseBody: resp({ role: 'assistant', content: 'done' }, 'stop'), upstreamRequestId: 'req_b' });
  store.ingest({ ...base, traceId: 't2', startedAt: 2000, endedAt: 2100, requestBody: req([{ role: 'user', content: 'other' }]), responseBody: resp({ role: 'assistant', content: 'x' }, 'stop') });
  return store;
}

describe('the trace format export', () => {
  it('1, 2, 4 and 5: one object per line, each message once, every row linked', () => {
    const store = seeded();
    const lines = [...traceExportLines(store, { project: '/p/a' })];
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const rows = lines.map(l => JSON.parse(l));
    const of = (t: string) => rows.filter(r => r.table === t);
    expect(of('traces')).toHaveLength(1);
    expect(of('traces')[0]).toMatchObject({ trace_id: 't1', copy: 'console', masking_version: 'none', client: 'pi', mixed: false, unknown_turns: 1 });
    expect(of('turns')).toHaveLength(1);
    expect(of('turns')[0]).toMatchObject({ trace_id: 't1', turn_index: 0, request_count: 2 });
    expect(of('requests').map(r => r.upstream_request_id)).toEqual(['req_a', 'req_b']);
    for (const r of of('requests')) expect(r).toMatchObject({ trace_id: 't1', turn_id: of('turns')[0].turn_id });
    const hashes = of('messages').map(m => m.message_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const link of of('request_messages')) expect(hashes).toContain(link.message_hash);
    expect(of('messages').some(m => m.role === 'system' && JSON.stringify(m.content).includes('SYS'))).toBe(true);
    expect(of('messages').some(m => m.role === 'tools')).toBe(true);
    store.close();
  });

  it('3: a session outside the filter is not exported', () => {
    const store = seeded();
    const rows = [...traceExportLines(store, { project: '/p/b' })].map(l => JSON.parse(l));
    expect(rows.filter(r => r.table === 'traces').map(r => r.trace_id)).toEqual(['t2']);
    expect(JSON.stringify(rows)).not.toContain('"go"');
    store.close();
  });

  it('6: the session document carries mixed, unknown_turns and the request ids', () => {
    const store = seeded();
    const doc = sessionDocument(store, 't1')!;
    expect(doc.trace).toMatchObject({ trace_id: 't1', mixed: false, unknown_turns: 1 });
    expect(doc.requests.map(r => r.upstream_request_id)).toEqual(['req_a', 'req_b']);
    expect(sessionDocument(store, 'nope')).toBeNull();
    store.close();
  });
});
