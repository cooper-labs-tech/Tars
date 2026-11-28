import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TraceStore, type TraceMeta, type WireRecord } from '../../electron/services/trace-store';
import { sessionDocument, traceExportLines } from '../../electron/services/trace-export';
import { TraceUploader } from '../../electron/services/trace-upload';
import { codexCompactions, qwenCompactions, readHarnessCompactions } from '../../electron/services/harness-compactions';

/**
 * A harness's compactions, and the requests after which its prompt was rewritten (trace feature C2). Measured on 27/11
 * (reports of trace-c2, fenced real binaries): codex 0.163 compacts with one request of its own (no tools), then sends
 * a history whose end is a new user message ("Another language model started to solve this problem and produced a
 * summary..."), and writes a `compacted` line in its rollout, with `token_usage_record` lines around it; Qwen Code
 * 0.25.2 compacts with one request of its own (no tools) and writes a `chat_compression` line in its transcript with
 * the prompt's tokens before and after. Real codex keeps its whole history at the head of every next request (the
 * 0.170 capture of 26/11): a history that does not is a rewrite.
 *
 * How it fails, written before the code (27/11):
 * C1. A history rewritten after a compaction is read as a new turn: the summary message at its end is taken for a new
 *     instruction, by an unknown author. Or the request is not marked (`contextReset`), or its dropped tokens (the
 *     previous request's prompt less this one's, as the endpoint counted them) are not said.
 * C2. A truncation that looks like a new task (the oldest messages dropped, the same instruction last) opens a new
 *     turn, or is called a compaction.
 * C3. Two compactions in one turn: the second is lost, or opens a turn.
 * C4. A new task Tars typed after the history was cleared is not a new turn, or is called a compaction.
 * C5. The compaction's own request (no tools, a side request) counts as a rewrite, or as a turn.
 * C6. A harness that keeps its history server-side (`previous_response_id`, only the new items sent) is read as
 *     rewriting it at every request; a request whose bodies were dropped (past the cap) is called a rewrite.
 * C7. The harness's log is not read: codex's `compacted` line and its prompt tokens before and after, Qwen Code's
 *     `chat_compression` line and its counts. A malformed line throws.
 * C8. A compaction that is not logged is lost (the wire saw it: it stays, its source `wire`); a logged one the wire did
 *     not see (bodies dropped) is lost; reading the log twice counts it twice; the harness's kind does not replace the
 *     wire's guess.
 * C9. The logs are read beyond the agent's own: another session's codex rollout, a Qwen Code transcript when two of
 *     the project's sessions overlap the session (which is this one's cannot be told), or a file over the bound.
 * From the Audit of #687 (28/11), written before the fixes:
 * C12. (I-2) An answer cut short (Esc), then words typed through Tars: the history went on, only the cut answer is
 *     missing, and it is called a reset of kind `new`, as if the history had been cleared.
 * C13. (I-1, measured on Qwen Code 0.25.2, 28/11) Qwen Code moves its `<system-reminder>` blocks between requests (one
 *     appended to the first user message moves into a trailing reminder-only message, which the next request drops):
 *     every request is called a rewrite. The task, the answers and the tool results stay in place.
 * C14. (I-1) A harness whose history is not measured (pi, opencode) is marked on the wire's guess: a harness that
 *     rewrites an item on every request would have every request marked and no instruction opening a turn.
 * C15. (I-1) The compactions list grows past what the back-office takes (1,000): the whole session is refused. It
 *     keeps the newest 200, and counts the rest (`compactionsOmitted`).
 * C16. (I-3) Qwen Code's transcripts are taken in the order the folder lists them, 64 at most: in a folder of more,
 *     this session's (the newest) is missed.
 * C17. (I-4) The logs are read synchronously at a session's end: the main process waits on a file of up to 8 MiB.
 * From the Audit of #678 (28/11, its I-1), written before the fix:
 * C18. A count leaves the machine as a fraction (a harness log's `before` or `after`, a request's `droppedTokens` from
 *     an endpoint's fractional usage): the back-office takes them as whole numbers, and the whole batch is refused.
 * C11. (Found by C1's run, 27/11.) A request sent again with the same history, whose last message is the summary (or
 *     any instruction), opens a turn of its own.
 * C10. What the harness was given (`contextWindowGiven`, `outputCapGiven`, `autoCompaction`), the compactions and each
 *     request's `contextReset` are not in the export or the upload's preview; an unknown is made up.
 */

let dir: string;
let store: TraceStore;
const T0 = Date.UTC(2026, 10, 27, 16, 0, 0);

const meta = (traceId: string, more: Partial<TraceMeta> = {}): TraceMeta => ({
  traceId, projectPath: '/p/demo', agentId: 'a1', agentName: 'C', harness: 'qwen-code', endpointId: 'ep-000001', model: 'open-coder', startedAt: T0, ...more,
});
const SYS = { role: 'system', content: 'You are a coding agent.' };
const TOOLS = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }];
const user = (text: string) => ({ role: 'user', content: text });
const call = (id: string) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] });
const result = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'a.txt' });

/** One chat request: its history after the system prompt, the prompt tokens the endpoint counted, tools unless side. */
function rec(at: number, history: unknown[], promptTokens: number, more: { tools?: boolean; params?: Record<string, unknown>; answer?: unknown } = {}): WireRecord {
  const body = { model: 'open-coder', stream: false, messages: [SYS, ...history], ...(more.tools === false ? {} : { tools: TOOLS }), ...(more.params ?? {}) };
  const answer = more.answer ?? { role: 'assistant', content: 'ok' };
  return {
    traceId: 't1', agentId: 'a1', surface: 'openai_chat', startedAt: at, firstByteAt: at + 10, endedAt: at + 100, status: 200,
    contentType: 'application/json', attempts: 1, heldMs: 0, requestBody: Buffer.from(JSON.stringify(body)),
    responseBody: Buffer.from(JSON.stringify({ model: 'open-coder', choices: [{ index: 0, message: answer, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 10 } })),
  };
}

const requestsOf = (s: TraceStore) => s.session('t1')!.turns.flatMap(t => t.requests).sort((a, b) => a.startedAt - b.startedAt);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-compactions-'));
  store = new TraceStore(path.join(dir, 'traces.db'));
  store.openTrace(meta('t1'));
  store.noteTypedInput({ agentId: 'a1', at: T0 - 1000, author: 'orchestrator', text: 'Fix the parser.', closed: false });
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a rewritten history on the wire', () => {
  it('C1, C3, C5: two compactions in one turn, each marked, no new turn, the compaction calls left as side requests', () => {
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 7000, { answer: call('c1') }));
    store.ingest(rec(T0 + 1000, [u1, call('c1'), result('c1')], 7800, { answer: call('c2') }));
    // The compaction's own call: no tools.
    store.ingest(rec(T0 + 2000, [u1, call('c1'), result('c1'), user('Summarize the conversation.')], 7900, { tools: false }));
    const bridge1 = user('Another language model started to solve this problem and produced a summary of its thinking process: SUMMARY 1');
    store.ingest(rec(T0 + 3000, [u1, bridge1], 600, { answer: call('c3') }));
    store.ingest(rec(T0 + 4000, [u1, bridge1, call('c3'), result('c3')], 7700, { answer: call('c4') }));
    store.ingest(rec(T0 + 5000, [u1, bridge1, call('c3'), result('c3'), user('Summarize the conversation.')], 7750, { tools: false }));
    const bridge2 = user('Another language model started to solve this problem and produced a summary of its thinking process: SUMMARY 2');
    store.ingest(rec(T0 + 6000, [u1, bridge2], 650));
    const s = store.session('t1')!;
    expect(s.session.turnCount).toBe(1);
    expect(s.session.unknownTurns).toBe(0);
    const reqs = requestsOf(store);
    expect(reqs.map(r => r.contextReset ?? null)).toEqual([
      null, null, null, { kind: 'compact', droppedTokens: 7200 }, null, null, { kind: 'compact', droppedTokens: 7050 },
    ]);
    expect(reqs.filter(r => r.side).map(r => r.startedAt)).toEqual([T0 + 2000, T0 + 5000]);
    expect(s.session.compactions).toEqual([
      { at: T0 + 3000, kind: 'compact', requestId: reqs[3].requestId, source: 'wire' },
      { at: T0 + 6000, kind: 'compact', requestId: reqs[6].requestId, source: 'wire' },
    ]);
  });

  it('C1: codex\'s own shape: the history kept at the head, the tool\'s result never sent, the summary added', () => {
    // Measured on 0.163: the model asked for a tool, codex compacted before sending its result, and the next history
    // is the old one with the summary at its end.
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 7800, { answer: call('c1') }));
    store.ingest(rec(T0 + 1000, [u1, call('c1'), result('c1'), user('Summarize the conversation.')], 7900, { tools: false }));
    store.ingest(rec(T0 + 2000, [u1, user('Another language model started to solve this problem... SUMMARY')], 600, { answer: call('c2') }));
    // And the same history sent again is no rewrite, and no turn (C11).
    store.ingest(rec(T0 + 3000, [u1, user('Another language model started to solve this problem... SUMMARY')], 600));
    expect(store.session('t1')!.session.turnCount).toBe(1);
    expect(requestsOf(store).map(r => r.contextReset ?? null)).toEqual([null, null, { kind: 'compact', droppedTokens: 7200 }, null]);
  });

  it('C2: a truncation that looks like a new task is a truncation, in the same turn', () => {
    const u0 = user('Fix the parser.');
    store.ingest(rec(T0, [u0], 5000, { answer: call('c1') }));
    store.ingest(rec(T0 + 1000, [u0, call('c1'), result('c1')], 6000));
    // The oldest messages dropped: what is left ends on the tool result, and nothing new came in before it.
    store.ingest(rec(T0 + 2000, [call('c1'), result('c1')], 2000));
    const reqs = requestsOf(store);
    expect(store.session('t1')!.session.turnCount).toBe(1);
    expect(reqs[2].contextReset).toEqual({ kind: 'truncate', droppedTokens: 4000 });
  });

  it('C2: the same instruction left last after a truncation does not open a turn', () => {
    const u0 = user('Look at the logs.');
    store.noteTypedInput({ agentId: 'a1', at: T0 - 500, author: 'user', text: 'Look at the logs.', closed: false });
    store.ingest(rec(T0, [u0], 3000));
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0 + 1000, [u0, { role: 'assistant', content: 'done' }, u1], 3500));
    expect(store.session('t1')!.session.turnCount).toBe(2);
    store.ingest(rec(T0 + 2000, [u1], 900));
    expect(store.session('t1')!.session.turnCount).toBe(2);
    expect(requestsOf(store)[2].contextReset).toEqual({ kind: 'truncate', droppedTokens: 2600 });
  });

  it('C4: a new task Tars typed after the history was cleared is a new turn, and a reset of kind new', () => {
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 4000));
    store.noteTypedInput({ agentId: 'a1', at: T0 + 1500, author: 'orchestrator', text: 'Now write the release notes.', closed: false });
    store.ingest(rec(T0 + 2000, [user('Now write the release notes.')], 800));
    const s = store.session('t1')!;
    expect(s.session.turnCount).toBe(2);
    expect(s.turns[1].author).toBe('orchestrator');
    expect(requestsOf(store)[1].contextReset).toEqual({ kind: 'new', droppedTokens: 3200 });
    expect(s.session.compactions ?? []).toEqual([]);
  });

  it('C6: a history kept server-side, or bodies dropped, is never called rewritten', () => {
    store.ingest(rec(T0, [user('Fix the parser.')], 4000, { params: { previous_response_id: 'resp_1' } }));
    store.ingest(rec(T0 + 1000, [result('c1')], 4100, { params: { previous_response_id: 'resp_2' } }));
    store.setBodiesDropped(true);
    store.ingest(rec(T0 + 2000, [user('anything')], 300));
    expect(requestsOf(store).map(r => r.contextReset ?? null)).toEqual([null, null, null]);
  });
});

describe('the harness\'s own log', () => {
  const codexRollout = [
    { timestamp: '2026-11-27T16:23:30.090Z', type: 'session_meta', payload: { id: 'sess-1' } },
    { timestamp: '2026-11-27T16:23:30.339Z', type: 'token_usage_record', payload: { response_id: 'resp_a', usage: { input_tokens: 7800 } } },
    { timestamp: '2026-11-27T16:23:30.684Z', type: 'token_usage_record', payload: { response_id: 'resp_compact', usage: { input_tokens: 7900 } } },
    { timestamp: '2026-11-27T16:23:30.718Z', type: 'compacted', payload: { message: 'Another language model...', compaction_response_id: 'resp_compact' } },
    { timestamp: '2026-11-27T16:23:30.812Z', type: 'token_usage_record', payload: { response_id: 'resp_b', usage: { input_tokens: 600 } } },
  ].map(l => JSON.stringify(l)).join('\n');
  const qwenTranscript = [
    { timestamp: '2026-11-27T16:24:07.400Z', type: 'assistant', usageMetadata: { promptTokenCount: 7800 } },
    { timestamp: '2026-11-27T16:24:07.579Z', type: 'system', subtype: 'chat_compression', systemPayload: { info: { originalTokenCount: 7868, newTokenCount: 1086, compressionStatus: 1, triggerReason: 'token_limit' } } },
    { timestamp: '2026-11-27T16:24:09.000Z', type: 'system', subtype: 'chat_compression', systemPayload: { info: { originalTokenCount: 7000, newTokenCount: 7100, compressionStatus: 2 } } },
  ].map(l => JSON.stringify(l)).join('\n');

  it('C7: codex\'s compacted line, with the prompt before (not the compaction call\'s) and after', () => {
    expect(codexCompactions(codexRollout)).toEqual([{ at: Date.parse('2026-11-27T16:23:30.718Z'), kind: 'compact', before: 7800, after: 600 }]);
    expect(codexCompactions(`${codexRollout}\n{not json\n\n`)).toHaveLength(1);
  });

  it('C7: Qwen Code\'s chat_compression line, only when it compressed', () => {
    expect(qwenCompactions(qwenTranscript)).toEqual([{ at: Date.parse('2026-11-27T16:24:07.579Z'), kind: 'summarize', before: 7868, after: 1086 }]);
    expect(qwenCompactions('garbage\n{"type":"system"}')).toEqual([]);
  });

  it('C8: the log names the wire\'s resets, keeps what the wire did not see, and is read once', () => {
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 7000, { answer: call('c1') }));
    store.ingest(rec(T0 + 3000, [u1, user('Another language model started... SUMMARY')], 600));
    store.ingest(rec(T0 + 9000, [u1, user('Another language model started... SUMMARY'), call('x'), result('x')], 700));
    const reset = requestsOf(store)[1];
    const events = [
      { at: T0 + 2500, kind: 'summarize' as const, before: 7868, after: 1086 },
      // Logged, but the wire saw no rewrite after it.
      { at: T0 + 20_000, kind: 'summarize' as const, before: 5000, after: 900 },
    ];
    const seq = store.seqOf('t1')!;
    store.applyHarnessCompactions('t1', events);
    expect(store.seqOf('t1')!).toBeGreaterThan(seq);
    store.applyHarnessCompactions('t1', events);
    const s = store.session('t1')!;
    expect(s.session.compactions).toEqual([
      { at: T0 + 2500, kind: 'summarize', before: 7868, after: 1086, requestId: reset.requestId, source: 'harness' },
      { at: T0 + 20_000, kind: 'summarize', before: 5000, after: 900, source: 'harness' },
    ]);
    expect(requestsOf(store)[1].contextReset).toEqual({ kind: 'summarize', droppedTokens: 6400 });
  });

  it('C8: a compaction the log does not have stays, from the wire', () => {
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 7000));
    store.ingest(rec(T0 + 3000, [u1, user('Summary so far: SUMMARY')], 600));
    store.applyHarnessCompactions('t1', []);
    expect(store.session('t1')!.session.compactions).toEqual([{ at: T0 + 3000, kind: 'compact', requestId: requestsOf(store)[1].requestId, source: 'wire' }]);
  });
});

describe('reading the logs, from the agent\'s own folders only', () => {
  const day = new Date(T0);
  const ymd = [String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')];
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const compactedAt = new Date(T0 + 60_000).toISOString();

  it('C9: codex\'s rollout of this session only', async () => {
    const codexHome = path.join(dir, 'codex');
    const days = path.join(codexHome, 'sessions', ...ymd);
    fs.mkdirSync(days, { recursive: true });
    fs.writeFileSync(path.join(days, 'rollout-2026-11-27T20-00-00-sess-1.jsonl'), line({ timestamp: compactedAt, type: 'compacted', payload: {} }));
    fs.writeFileSync(path.join(days, 'rollout-2026-11-27T20-00-00-sess-2.jsonl'), line({ timestamp: compactedAt, type: 'compacted', payload: {} }) + line({ timestamp: compactedAt, type: 'compacted', payload: {} }));
    const read = (id: string | undefined) => readHarnessCompactions({ harness: 'codex', codexHome, nativeSessionId: id, startedAt: T0, endedAt: T0 + 3_600_000 });
    expect(await read('sess-1')).toHaveLength(1);
    expect(await read(undefined)).toEqual([]);
    expect(await read('../sess-2')).toEqual([]);
  });

  it('C9: Qwen Code\'s transcript when it alone overlaps the session, and none past the bound', async () => {
    const qwenHome = path.join(dir, 'qwen');
    const cwd = '/work/project-a';
    const chats = path.join(qwenHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
    fs.mkdirSync(chats, { recursive: true });
    const one = path.join(chats, 'one.jsonl');
    fs.writeFileSync(one, line({ timestamp: new Date(T0 + 1000).toISOString(), type: 'user' }) + line({ timestamp: compactedAt, type: 'system', subtype: 'chat_compression', systemPayload: { info: { originalTokenCount: 100, newTokenCount: 10, compressionStatus: 1 } } }));
    // A transcript of an earlier session: it ended before this one began.
    const old = path.join(chats, 'old.jsonl');
    fs.writeFileSync(old, line({ timestamp: new Date(T0 - 7_200_000).toISOString(), type: 'user' }));
    fs.utimesSync(old, new Date(T0 - 7_000_000), new Date(T0 - 7_000_000));
    const read = (over: Record<string, unknown> = {}) => readHarnessCompactions({ harness: 'qwen-code', qwenHome, cwd, startedAt: T0, endedAt: T0 + 3_600_000, ...over });
    expect(await read()).toHaveLength(1);
    expect(await read({ maxBytes: 10 })).toEqual([]);
    // Another session of the project overlapping this one: which transcript is this session's cannot be told.
    fs.writeFileSync(path.join(chats, 'two.jsonl'), line({ timestamp: new Date(T0 + 2000).toISOString(), type: 'user' }));
    expect(await read()).toEqual([]);
  });
});

describe('what the harness was given, in the export and the preview', () => {
  it('C10: the given limits, the compactions and the resets go out; an unknown stays unknown', () => {
    store.setContextGiven('t1', { contextWindow: 65_536, outputCap: 16_384, autoCompaction: 'on' });
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 7000));
    store.ingest(rec(T0 + 3000, [u1, user('Another language model started... SUMMARY')], 600));
    const trace = [...traceExportLines(store, {})].map(l => JSON.parse(l)).find(l => l.table === 'traces');
    expect(trace).toMatchObject({ context_window_given: 65_536, output_cap_given: 16_384, auto_compaction: 'on' });
    expect(trace.compactions).toHaveLength(1);
    const doc = sessionDocument(store, 't1')!;
    expect(doc.requests.map(r => r.context_reset)).toEqual([null, { kind: 'compact', droppedTokens: 6400 }]);
    const preview = new TraceUploader({
      store, installFile: path.join(dir, 'private', 'install.json'), settings: () => ({ url: '' }), setDeletion: () => {}, eligible: () => true,
      scrubContext: () => ({ homeDirs: ['/Users/someone'], knownSecrets: [], envValues: [] }), client: { name: 'tars', version: 't', platform: 'darwin' },
      withdrawConsent: () => {},
    }).preview('t1')!;
    const body = preview.document.batches[0].body as { sessions: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> };
    expect(body.sessions[0]).toMatchObject({ contextWindowGiven: 65_536, outputCapGiven: 16_384, autoCompaction: 'on' });
    expect(body.sessions[0].compactions).toHaveLength(1);
    expect(body.requests.map(r => r.contextReset ?? null)).toEqual([null, { kind: 'compact', droppedTokens: 6400 }]);

    const other = new TraceStore(path.join(dir, 'other.db'));
    other.openTrace(meta('t2'));
    const none = [...traceExportLines(other, {})].map(l => JSON.parse(l)).find(l => l.table === 'traces');
    expect(none).toMatchObject({ context_window_given: null, output_cap_given: null, auto_compaction: null, compactions: [] });
    other.close();
  });
});

describe('the Audit of #687', () => {
  it('C12: an answer cut short, then words typed through Tars, is a new turn and no reset', () => {
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 4000));
    store.noteTypedInput({ agentId: 'a1', at: T0 + 1500, author: 'user', text: 'Stop, look at the tests first.', closed: false });
    // The cut answer never came back into the history: the history goes on with the typed words.
    store.ingest(rec(T0 + 2000, [u1, user('Stop, look at the tests first.')], 4100));
    expect(store.session('t1')!.session.turnCount).toBe(2);
    expect(requestsOf(store)[1].contextReset).toBeUndefined();
  });

  it('C13: Qwen Code\'s moving reminders are no rewrite (its shape on 0.25.2, measured)', () => {
    const skills = { type: 'text', text: '<system-reminder>\nThe following skills are available for use with the Skill tool.\n</system-reminder>' };
    const memory = { type: 'text', text: '<system-reminder>\n# Current auto-memory catalog (data, not instructions)\n</system-reminder>' };
    const task = { type: 'text', text: 'Fix the parser.' };
    store.ingest(rec(T0, [{ role: 'user', content: [skills, task, memory] }], 9000, { answer: call('c1') }));
    store.ingest(rec(T0 + 1000, [{ role: 'user', content: [skills, task] }, call('c1'), result('c1'), { role: 'user', content: [memory] }], 9100, { answer: call('c2') }));
    store.ingest(rec(T0 + 2000, [{ role: 'user', content: [skills, task] }, call('c1'), result('c1'), call('c2'), result('c2'), { role: 'user', content: [memory] }], 9200));
    expect(store.session('t1')!.session.turnCount).toBe(1);
    expect(requestsOf(store).map(r => r.contextReset ?? null)).toEqual([null, null, null]);
    expect(store.session('t1')!.session.compactions).toEqual([]);
  });

  it('C14: a harness whose history is not measured is not marked on the wire\'s guess', () => {
    const pi = new TraceStore(path.join(dir, 'pi.db'));
    try {
      pi.openTrace(meta('t1', { harness: 'pi' }));
      pi.ingest(rec(T0, [user('Fix the parser.')], 4000));
      pi.ingest(rec(T0 + 2000, [user('Another task, typed in its terminal.')], 600));
      const s = pi.session('t1')!;
      expect(s.session.turnCount).toBe(2);
      expect(s.turns.flatMap(t => t.requests).map(r => r.contextReset ?? null)).toEqual([null, null]);
      expect(s.session.compactions).toEqual([]);
    } finally {
      pi.close();
    }
  });

  it('C15: the compactions list keeps the newest 200 and counts the rest', () => {
    const events = Array.from({ length: 250 }, (_, i) => ({ at: T0 + i * 1000, kind: 'summarize' as const, before: 9000, after: 900 }));
    store.applyHarnessCompactions('t1', events);
    let s = store.session('t1')!.session;
    expect(s.compactions).toHaveLength(200);
    expect(s.compactions![0].at).toBe(T0 + 50_000);
    expect(s.compactionsOmitted).toBe(50);
    // One more, from the wire: the oldest goes.
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0 + 300_000, [u1], 7000));
    store.ingest(rec(T0 + 301_000, [u1, user('Another language model started... SUMMARY')], 600));
    s = store.session('t1')!.session;
    expect(s.compactions).toHaveLength(200);
    expect(s.compactions![199]).toMatchObject({ at: T0 + 301_000, source: 'wire' });
    expect(s.compactionsOmitted).toBe(51);
    // The log read again (C8's "read twice, counted once", with the cap): what was left out is not counted twice.
    store.applyHarnessCompactions('t1', events);
    expect(store.session('t1')!.session.compactionsOmitted).toBe(51);
    expect(store.session('t1')!.session.compactions).toHaveLength(200);
    const trace = [...traceExportLines(store, {})].map(l => JSON.parse(l)).find(l => l.table === 'traces');
    expect(trace).toMatchObject({ compactions_omitted: 51 });
    expect(trace.compactions).toHaveLength(200);
    const preview = new TraceUploader({
      store, installFile: path.join(dir, 'private', 'install.json'), settings: () => ({ url: '' }), setDeletion: () => {}, eligible: () => true,
      scrubContext: () => ({ homeDirs: ['/Users/someone'], knownSecrets: [], envValues: [] }), client: { name: 'tars', version: 't', platform: 'darwin' },
      withdrawConsent: () => {},
    }).preview('t1')!;
    expect((preview.document.batches[0].body as { sessions: Array<Record<string, unknown>> }).sessions[0]).toMatchObject({ compactionsOmitted: 51 });
  });

  it('C16: Qwen Code\'s newest transcript is read, however the folder lists its names', async () => {
    const qwenHome = path.join(dir, 'qwen-many');
    const cwd = '/work/project-b';
    const chats = path.join(qwenHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
    fs.mkdirSync(chats, { recursive: true });
    for (let i = 0; i < 70; i++) {
      const old = path.join(chats, `a${String(i).padStart(2, '0')}.jsonl`);
      fs.writeFileSync(old, `${JSON.stringify({ timestamp: new Date(T0 - 7_200_000).toISOString(), type: 'user' })}\n`);
      fs.utimesSync(old, new Date(T0 - 7_000_000), new Date(T0 - 7_000_000));
    }
    fs.writeFileSync(path.join(chats, 'zz-this-session.jsonl'), `${JSON.stringify({ timestamp: new Date(T0 + 1000).toISOString(), type: 'user' })}\n${JSON.stringify({ timestamp: new Date(T0 + 60_000).toISOString(), type: 'system', subtype: 'chat_compression', systemPayload: { info: { originalTokenCount: 100, newTokenCount: 10, compressionStatus: 1 } } })}\n`);
    expect(await readHarnessCompactions({ harness: 'qwen-code', qwenHome, cwd, startedAt: T0, endedAt: T0 + 3_600_000 })).toHaveLength(1);
  });

  it('C17: the logs are read without holding the main process: the reader answers a promise', async () => {
    const reading = readHarnessCompactions({ harness: 'codex', codexHome: path.join(dir, 'none'), nativeSessionId: 'sess-1', startedAt: T0, endedAt: T0 + 1000 });
    expect(reading).toBeInstanceOf(Promise);
    expect(await reading).toEqual([]);
  });
});

describe('the Audit of #678', () => {
  it('C18: a fractional count from a log or from the endpoint goes out whole', () => {
    // From the logs: a harness that writes its counts with a fraction.
    const qwen = JSON.stringify({ timestamp: '2026-11-27T16:24:07.579Z', type: 'system', subtype: 'chat_compression', systemPayload: { info: { originalTokenCount: 7868.6, newTokenCount: 1086.4, compressionStatus: 1 } } });
    expect(qwenCompactions(qwen)).toEqual([{ at: Date.parse('2026-11-27T16:24:07.579Z'), kind: 'summarize', before: 7869, after: 1086 }]);
    const codex = [
      { timestamp: '2026-11-27T16:23:30.339Z', type: 'token_usage_record', payload: { response_id: 'resp_a', usage: { input_tokens: 7800.5 } } },
      { timestamp: '2026-11-27T16:23:30.718Z', type: 'compacted', payload: { compaction_response_id: 'resp_c' } },
      { timestamp: '2026-11-27T16:23:30.812Z', type: 'token_usage_record', payload: { response_id: 'resp_b', usage: { input_tokens: 600.2 } } },
    ].map(l => JSON.stringify(l)).join('\n');
    expect(codexCompactions(codex)).toEqual([{ at: Date.parse('2026-11-27T16:23:30.718Z'), kind: 'compact', before: 7801, after: 600 }]);

    // In the batch: the endpoint counted fractions, and a compaction kept from before carries them.
    const u1 = user('Fix the parser.');
    store.ingest(rec(T0, [u1], 7000.7));
    store.ingest(rec(T0 + 3000, [u1, user('Another language model started... SUMMARY')], 600.2));
    store.applyHarnessCompactions('t1', [{ at: T0 + 20_000, kind: 'summarize', before: 5000.5, after: 900.4 }]);
    const preview = new TraceUploader({
      store, installFile: path.join(dir, 'private', 'install.json'), settings: () => ({ url: '' }), setDeletion: () => {}, eligible: () => true,
      scrubContext: () => ({ homeDirs: ['/Users/someone'], knownSecrets: [], envValues: [] }), client: { name: 'tars', version: 't', platform: 'darwin' },
      withdrawConsent: () => {},
    }).preview('t1')!;
    const body = preview.document.batches[0].body as { sessions: Array<{ compactions: Array<Record<string, unknown>> }>; requests: Array<Record<string, unknown>> };
    const counts = [
      ...body.sessions[0].compactions.flatMap(c => [c.at, c.before, c.after]),
      ...body.requests.map(r => (r.contextReset as { droppedTokens?: number } | undefined)?.droppedTokens),
    ].filter(v => v !== undefined);
    expect(counts.length).toBeGreaterThanOrEqual(5);
    expect(counts.filter(v => !Number.isInteger(v)), 'a count that is not whole').toEqual([]);
    expect(body.requests.map(r => r.contextReset ?? null)).toEqual([null, { kind: 'compact', droppedTokens: 6401 }]);
    expect(body.sessions[0].compactions.find(c => c.source === 'harness')).toMatchObject({ before: 5001, after: 900 });
  });
});
