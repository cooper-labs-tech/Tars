import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TraceStore, type WireRecord, type TraceMeta } from '../../electron/services/trace-store';

/**
 * The trace store (native traces): SQLite under ~/.tars/traces, content-hashed compressed blobs,
 * turns, timing, usage, authorship, a size cap and a retention, and a cursor for an external trace reader.
 *
 * How it fails, written before the code (19/11):
 * 1. The history resent on every request stores its messages again: the blobs grow with every request.
 * 2. A tool result opens a new turn, or a new user instruction does not.
 * 3. A side request (opencode's title call with no tools, Qwen's memory call with its own system prompt, measured
 *    19/11) opens a turn or counts as a model step of the turn.
 * 4. Requests are numbered out of order within their turn.
 * 5. Usage (input, cached, output) is not summed into the turn and the session.
 * 6. Tool time (the gap from the response asking for a tool to the request carrying its result) and the gap before
 *    a turn are not measured.
 * 7. A turn's author is not the one Tars typed (orchestrator, user, chat...); a closed model's words do not set
 *    `mixed`; an instruction Tars did not type is not counted in `unknown_turns`, or sets `mixed`.
 * 8. The cap is exceeded after a sweep; a sweep drops a blob a remaining request still uses; retention deletes a
 *    session still open.
 * 9. The cursor misses a session written between two reads, or never shows a session that grew again.
 * 10. A filter (project, harness, model, endpoint, date) is ignored.
 * 11. A delete leaves turns, requests or blobs of the deleted sessions behind.
 * 12. A message read back is not the message that was stored (compression round trip).
 * 13. Past the cap, the store keeps writing bodies; or it stops recording the requests' metadata too.
 * 14. A request whose bodies cannot be parsed throws out of ingest (the proxy must never fail on the recorder).
 * Added before their code, the owner's decision of 26/11 (TTFT measures the model):
 * 17. A streamed request's ttft is its first byte, though the proxy said when the first chunk with content came; or
 *     a stream that never carried content gets a ttft; or one not streamed loses the time to its first byte.
 * Added before their code with the load window's part 3 (C3):
 * 18. A load session's tags (`load:<run>`, task, split, train_ok, diff stat, test), written once its test ended, are
 *     lost when its terminal's exit writes the outcome after them, or wipe its starting context when they come after
 *     it; or the session is not resent with them (its change number unmoved).
 */

let dir: string;
let store: TraceStore;
let clock = 1_000_000;

const meta = (traceId: string, more: Partial<TraceMeta> = {}): TraceMeta => ({
  traceId, projectPath: '/p/demo', agentId: 'a1', agentName: 'Q', harness: 'qwen-code', harnessVersion: '0.25.2',
  endpointId: 'ep-000001', endpointName: 'Remote host', model: 'open-coder-1', startedAt: clock, ...more,
});

const SYSTEM = { role: 'system', content: 'You are a coding agent.' };
const TOOLS = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }];
const chatReq = (messages: unknown[], tools: unknown[] | undefined = TOOLS, system: unknown = SYSTEM) =>
  Buffer.from(JSON.stringify({ model: 'open-coder-1', stream: false, messages: [system, ...messages], ...(tools ? { tools } : {}) }));
const chatResp = (message: unknown, finish: string, usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } }) =>
  Buffer.from(JSON.stringify({ model: 'open-coder-1', choices: [{ index: 0, message, finish_reason: finish }], usage }));

const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] };
const user = (text: string) => ({ role: 'user', content: text });
const toolResult = { role: 'tool', tool_call_id: 'c1', content: 'a.txt' };

function rec(traceId: string, requestBody: Buffer, responseBody: Buffer, startedAt: number, ms = 100, more: Partial<WireRecord> = {}): WireRecord {
  return {
    traceId, agentId: 'a1', surface: 'openai_chat', startedAt, firstByteAt: startedAt + 10, endedAt: startedAt + ms,
    status: 200, contentType: 'application/json', requestBody, responseBody, upstreamRequestId: `req_${startedAt}`, attempts: 1, heldMs: 0, ...more,
  };
}

/** One full turn: an instruction, a tool call, its result, the final answer. Returns the time it ended. */
function turn(traceId: string, history: unknown[], instruction: string, at: number): { at: number; history: unknown[] } {
  const h1 = [...history, user(instruction)];
  store.ingest(rec(traceId, chatReq(h1), chatResp(toolCall, 'tool_calls'), at, 100));
  const h2 = [...h1, toolCall, toolResult];
  store.ingest(rec(traceId, chatReq(h2), chatResp({ role: 'assistant', content: 'done' }, 'stop'), at + 400, 100));
  return { at: at + 500, history: [...h2, { role: 'assistant', content: 'done' }] };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
  clock = 1_000_000;
  store = new TraceStore(path.join(dir, 'traces.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the trace store', () => {
  it('1: the history resent on every request is stored once', () => {
    store.openTrace(meta('t1'));
    const state = turn('t1', [], 'list the files', clock);
    const after1 = store.stats().blobs;
    turn('t1', state.history, 'now count them', state.at + 1000);
    const after2 = store.stats().blobs;
    // The second turn adds its new messages (instruction, call, result, answer: the call and result are equal to the
    // first turn's, so already stored) and nothing of the history before it.
    expect(after2 - after1).toBeLessThanOrEqual(3);
    expect(store.session('t1')!.session.requestCount).toBe(4);
    // What each request added to the store: the second turn's opening request, its instruction alone.
    expect(store.session('t1')!.turns[1].requests[0].newMessages).toBe(1);
  });

  it('2 and 4: an instruction opens a turn, a tool result continues it, in order', () => {
    store.openTrace(meta('t1'));
    const s = turn('t1', [], 'list the files', clock);
    turn('t1', s.history, 'now count them', s.at + 1000);
    const view = store.session('t1')!;
    expect(view.turns.map(t => t.index)).toEqual([0, 1]);
    expect(view.turns.map(t => t.requests.map(r => r.seq))).toEqual([[0, 1], [0, 1]]);
    expect(view.turns[0].toolCalls).toBe(1);
  });

  it('3: a side request (no tools, or another system prompt) opens no turn and is no step', () => {
    store.openTrace(meta('t1'));
    const s = turn('t1', [], 'list the files', clock);
    store.ingest(rec('t1', chatReq([user('list the files'), user('Generate a title')], undefined, { role: 'system', content: 'Title generator' }), chatResp({ role: 'assistant', content: 'Listing' }, 'stop'), s.at + 10));
    store.ingest(rec('t1', chatReq([user('save memories')], TOOLS.slice(0, 1), { role: 'system', content: 'Memory manager' }), chatResp({ role: 'assistant', content: 'ok' }, 'stop'), s.at + 20));
    const view = store.session('t1')!;
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].requests.filter(r => !r.side)).toHaveLength(2);
    expect(view.turns[0].requests.filter(r => r.side)).toHaveLength(2);
  });

  it('5 and 6: usage is summed, and model time, tool time and the gap before a turn are measured', () => {
    store.openTrace(meta('t1'));
    const s = turn('t1', [], 'list the files', clock);
    turn('t1', s.history, 'count', s.at + 2000);
    const view = store.session('t1')!;
    expect(view.session.tokensIn).toBe(400);
    expect(view.session.tokensCached).toBe(240);
    expect(view.session.tokensOut).toBe(40);
    expect(view.turns[0].modelMs).toBe(200);
    expect(view.turns[0].toolMs).toBe(300);
    expect(view.turns[1].gapBeforeMs).toBe(2000);
  });

  it('7: authorship from what Tars typed; closed-model words set mixed; the untyped count as unknown', () => {
    store.openTrace(meta('t1'));
    store.noteTypedInput({ agentId: 'a1', at: clock - 5, author: 'orchestrator', authorDetail: 'Lead', text: 'list the files', closed: false });
    let s = turn('t1', [], 'list the files', clock);
    expect(store.session('t1')!.session.mixed).toBe(false);
    store.noteTypedInput({ agentId: 'a1', at: s.at + 500, author: 'agent', authorDetail: 'Claire (claude)', text: 'Please also\ncount them', closed: true });
    s = turn('t1', s.history, 'Please also count them', s.at + 1000);
    turn('t1', s.history, 'words nobody typed', s.at + 1000);
    const view = store.session('t1')!;
    expect(view.turns.map(t => t.author)).toEqual(['orchestrator', 'agent', 'unknown']);
    expect(view.turns[0].authorDetail).toBe('Lead');
    expect(view.session.mixed).toBe(true);
    expect(view.session.unknownTurns).toBe(1);
  });

  it('7: unknown alone does not set mixed', () => {
    store.openTrace(meta('t1'));
    turn('t1', [], 'nobody typed this', clock);
    expect(store.session('t1')!.session).toMatchObject({ mixed: false, unknownTurns: 1 });
  });

  it('8: a sweep brings the store under its cap from the oldest ended session, keeps shared blobs and open sessions', () => {
    for (const id of ['old', 'mid', 'new']) {
      store.openTrace(meta(id, { startedAt: clock }));
      turn(id, [user(`${id} ${randomBytes(10_000).toString('hex')}`)], 'shared instruction', clock);
      clock += 10_000;
    }
    store.endTrace('old', clock);
    store.endTrace('mid', clock);
    const before = store.stats().bytes;
    store.sweep({ capBytes: Math.floor(before * 0.8), retentionDays: 30, now: clock });
    const ids = store.list({}).sessions.map(s => s.traceId);
    expect(ids).not.toContain('old');
    expect(ids).toContain('new');
    expect(store.stats().bytes).toBeLessThanOrEqual(Math.floor(before * 0.8));
    // The instruction blob both kept sessions use is still readable.
    const req = store.session('mid')!.turns[0].requests[0];
    expect(store.requestMessages(req.requestId)!.input.some(m => JSON.stringify(m.parts).includes('shared instruction'))).toBe(true);
  });

  it('8: retention deletes ended sessions past their days, never an open one', () => {
    store.openTrace(meta('ended'));
    turn('ended', [], 'a', clock);
    store.endTrace('ended', clock + 1000);
    store.openTrace(meta('open'));
    turn('open', [], 'b', clock);
    store.sweep({ capBytes: 1e12, retentionDays: 1, now: clock + 3 * 86_400_000 });
    expect(store.list({}).sessions.map(s => s.traceId)).toEqual(['open']);
  });

  it('9: the cursor gives new and grown sessions once each, in the order they changed', () => {
    store.openTrace(meta('t1'));
    const s = turn('t1', [], 'a', clock);
    const first = store.changes({ limit: 10 });
    expect(first.sessions.map(x => x.traceId)).toEqual(['t1']);
    store.openTrace(meta('t2', { startedAt: clock + 1 }));
    turn('t2', [], 'b', clock + 1);
    turn('t1', s.history, 'c', s.at + 10);
    const second = store.changes({ cursor: first.nextCursor, limit: 10 });
    expect(second.sessions.map(x => x.traceId)).toEqual(['t2', 't1']);
    expect(store.changes({ cursor: second.nextCursor, limit: 10 }).sessions).toEqual([]);
  });

  it('10: every filter narrows the list', () => {
    store.openTrace(meta('a', { projectPath: '/p/one', harness: 'codex', model: 'm1', endpointId: 'ep-000001', startedAt: 100 }));
    store.openTrace(meta('b', { projectPath: '/p/two', harness: 'pi', model: 'm2', endpointId: 'ep-000002', startedAt: 200 }));
    const ids = (f: Parameters<TraceStore['list']>[0]) => store.list(f).sessions.map(s => s.traceId);
    expect(ids({ project: '/p/one' })).toEqual(['a']);
    expect(ids({ harness: 'pi' })).toEqual(['b']);
    expect(ids({ model: 'm1' })).toEqual(['a']);
    expect(ids({ endpointId: 'ep-000002' })).toEqual(['b']);
    expect(ids({ from: 150 })).toEqual(['b']);
    expect(ids({ to: 150 })).toEqual(['a']);
    expect(ids({})).toEqual(['b', 'a']);
    expect(ids({ traceId: 'a' })).toEqual(['a']);
  });

  it('15: the list carries its totals and its per-project sums for the whole filter, not the page', () => {
    store.openTrace(meta('a', { projectPath: '/p/one', startedAt: 1 }));
    store.openTrace(meta('b', { projectPath: '/p/one', startedAt: 2 }));
    store.openTrace(meta('c', { projectPath: '/p/two', startedAt: 3 }));
    turn('a', [], 'x', clock);
    turn('c', [], 'y', clock);
    const page = store.list({ limit: 1 });
    expect(page.sessions).toHaveLength(1);
    expect(page.totals).toMatchObject({ count: 3, tokensIn: 400, tokensCached: 240, tokensOut: 40 });
    expect(page.totals.bytes).toBeGreaterThan(0);
    expect(page.byProject.map(p => [p.projectPath, p.count])).toEqual([['/p/one', 2], ['/p/two', 1]]);
    expect(store.list({ project: '/p/two' }).totals.count).toBe(1);
    const stats = store.stats();
    expect(stats.byProject.map(p => [p.projectPath, p.sessions])).toEqual([['/p/one', 2], ['/p/two', 1]]);
    expect(stats.byProject.reduce((n, p) => n + p.bytes, 0)).toBeGreaterThan(0);
  });

  it('16: an outcome given at the end is kept and read back', () => {
    store.openTrace(meta('t1'));
    turn('t1', [], 'x', clock);
    store.endTrace('t1', clock + 1000, { branch: 'fleet/a', head: 'abc1234', heldRequests: 1, requestErrors: 0 });
    expect(store.session('t1')!.outcome).toEqual({ branch: 'fleet/a', head: 'abc1234', heldRequests: 1, requestErrors: 0 });
  });

  it('11: a delete leaves nothing of the sessions it deleted', () => {
    store.openTrace(meta('t1'));
    turn('t1', [user(`only mine ${Math.random()}`)], 'x', clock);
    const result = store.remove({ traceIds: ['t1'] });
    expect(result.deleted).toBe(1);
    expect(store.stats()).toMatchObject({ sessions: 0, requests: 0, blobs: 0 });
  });

  it('12: a message reads back as it was stored', () => {
    store.openTrace(meta('t1'));
    const odd = { role: 'user', content: [{ type: 'text', text: 'é€ 🚀 \u0000 end' }], extra: { n: 1 } };
    store.ingest(rec('t1', chatReq([odd]), chatResp({ role: 'assistant', content: 'ok' }, 'stop'), clock));
    const req = store.session('t1')!.turns[0].requests[0];
    const read = store.requestMessages(req.requestId)!;
    expect(read.raw.input).toEqual([odd]);
    expect(read.raw.system).toEqual([SYSTEM]);
    expect(read.raw.tools).toEqual(TOOLS);
    expect(read.raw.output).toEqual({ role: 'assistant', content: 'ok' });
  });

  it('13: past the cap, metadata is kept and bodies are not', () => {
    store.openTrace(meta('t1'));
    store.setBodiesDropped(true);
    turn('t1', [], 'a', clock);
    const view = store.session('t1')!;
    expect(view.session.requestCount).toBe(2);
    expect(view.turns[0].requests[0].bodiesDropped).toBe(true);
    expect(store.stats().blobs).toBe(0);
  });

  it('14: bodies that cannot be read are recorded as such, without throwing', () => {
    store.openTrace(meta('t1'));
    expect(() => store.ingest(rec('t1', Buffer.from('not json'), Buffer.from('{oops'), clock))).not.toThrow();
    expect(store.session('t1')!.session.requestCount).toBe(1);
  });

  it('17: a stream\'s ttft is its first chunk with content; one with none has none; one not streamed keeps its first byte', () => {
    store.openTrace(meta('t1'));
    const streamed = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: 'open-coder-1', stream: true, messages: [SYSTEM, ...messages], tools: TOOLS }));
    const sse = (deltas: unknown[]) => Buffer.from(deltas.map(d => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`).join('') + 'data: [DONE]\n\n');
    const t0 = clock;
    store.ingest(rec('t1', streamed([user('hello')]), sse([{ role: 'assistant' }, { content: 'Hi' }]), t0, 900,
      { contentType: 'text/event-stream', firstByteAt: t0 + 20, firstContentAt: t0 + 650 } as Partial<WireRecord>));
    store.ingest(rec('t1', streamed([user('hello'), { role: 'assistant', content: 'Hi' }, user('again')]), sse([{ role: 'assistant' }]), t0 + 2000, 300,
      { contentType: 'text/event-stream', firstByteAt: t0 + 2015 }));
    store.ingest(rec('t1', chatReq([user('once more')]), chatResp({ role: 'assistant', content: 'ok' }, 'stop'), t0 + 4000, 200, { firstByteAt: t0 + 4180 }));
    const ttft = store.session('t1')!.turns.flatMap(t => t.requests).map(r => r.ttftMs);
    expect(ttft).toEqual([650, undefined, 180]);
  });

  it('18: a load session\'s tags and its starting context are both kept, whichever comes first; the session is resent', () => {
    const startContext = { sha256: 'a'.repeat(64), files: [] };
    const tags = { tag: 'load:20261128-120000-a1b2', runId: '20261128-120000-a1b2', taskId: 'fix-retry', n: 1, split: 'train', trainOk: true, diffStat: { files: 1, insertions: 2, deletions: 0 }, test: { result: 'passed' } };
    // The terminal exits first, then the test ends.
    store.openTrace(meta('t1'));
    store.endTrace('t1', clock + 10, { branch: 'load/x', load: { startContext } });
    const before = store.seqOf('t1')!;
    store.mergeLoadOutcome('t1', tags);
    expect(store.session('t1')!.outcome).toMatchObject({ branch: 'load/x', load: { startContext, ...tags } });
    expect(store.seqOf('t1')!).toBeGreaterThan(before);
    // The test ends first, then the terminal exits.
    store.openTrace(meta('t2'));
    store.mergeLoadOutcome('t2', tags);
    store.endTrace('t2', clock + 10, { branch: 'load/y', load: { startContext } });
    expect(store.session('t2')!.outcome).toMatchObject({ branch: 'load/y', load: { startContext, ...tags } });
  });
});
