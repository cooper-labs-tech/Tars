import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { TraceStore, type TraceMeta } from '../../electron/services/trace-store';

/**
 * Tombstones in the trace store: a deleted session leaves its id, why it went and when, so every copy of it can follow
 * (the loopback read API's deletions feed, GET /api/traces/deletions, and the per-session delete the uploader owes the
 * back-office for a session it sent).
 *
 * How it fails, written before the code (27/11):
 * 1. A session the user deletes (by its id, or every session a filter selects) leaves no tombstone: a reader of the
 *    loopback API never learns it is gone.
 * 2. The retention sweep deletes and leaves none.
 * 3. The cap's sweep leaves none, or files it under retention.
 * 4. A tombstone carries more than the id, the reason and the time: the project path, the agent, the model, the
 *    endpoint, any of the session's content.
 * 5. A delete that removed nothing (an id the store never held, one already deleted) adds a tombstone: a reader is
 *    told of a session that was never there, or twice of one.
 * 6. The feed's cursor misses a tombstone written between two reads or gives one twice; an empty page has no
 *    nextCursor; `more` is false while a page was cut at the limit.
 * 7. Tombstones pruned down to an empty table hand out again a sequence a reader's cursor has passed: the next one is
 *    never read.
 * 8. A tombstone is kept past 365 days, or one younger goes; or one whose delete is still owed to the back-office goes
 *    at 365 days before it was sent.
 * 9. A per-session delete is owed to the back-office for a session never uploaded, or one the cap deleted (the cap
 *    frees this disk; it says nothing about the data); or it is not owed for one uploaded and then deleted by the
 *    user or by retention.
 * 10. A new install, or a whole deletion that went through (both forget what was sent), leaves deletes owed to an
 *     install that no longer exists.
 * 11. A store written before tombstones (no such table) does not open, or loses its sessions.
 * 12. A delete marked sent stays owed, or leaves the reader's feed.
 * 13. The feed's limit is unbounded, or 0 rows come back.
 */

let dir: string;
let file: string;
let store: TraceStore;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

type Tombstone = { sessionId: string; reason: string; at: number };

const meta = (traceId: string, more: Partial<TraceMeta> = {}): TraceMeta => ({
  traceId, projectPath: '/p/secret-project', agentId: 'agent-x', agentName: 'Q', harness: 'qwen-code', harnessVersion: '0.25.2',
  endpointId: 'ep-000001', endpointName: 'Remote host', endpointBaseUrl: 'http://192.0.2.10:9000/v1', model: 'open-coder-1',
  startedAt: NOW - 40 * DAY, ...more,
});

/**
 * One ended session with one request whose instruction holds `size` random bytes (which no codec shrinks), so it
 * holds a blob of its own and counts against the cap.
 */
function session(traceId: string, endedAt: number, more: Partial<TraceMeta> = {}, size = 2000): void {
  store.openTrace(meta(traceId, more));
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  store.ingest({
    traceId, agentId: 'agent-x', surface: 'openai_chat', startedAt: endedAt - 1000, endedAt: endedAt - 900, status: 200,
    contentType: 'application/json', attempts: 1, heldMs: 0,
    requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `the task of ${traceId} ${randomBytes(size).toString('base64')}` }], tools: [{ type: 'function', function: { name: 'bash' } }] }),
    responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
  });
  store.endTrace(traceId, endedAt);
}

/** Every tombstone the feed gives, page after page, in its order. */
function all(): Tombstone[] {
  const out: Tombstone[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = store.deletions({ cursor, limit: 500 });
    out.push(...page.deletions);
    cursor = page.nextCursor;
    if (!page.more) break;
  }
  return out;
}

const byId = (list: Tombstone[]) => [...list].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
const owedIds = () => store.owedDeletes(1000).map(o => o.traceId).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tombstones-'));
  file = path.join(dir, 'traces.db');
  store = new TraceStore(file);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tombstones in the trace store', () => {
  it('1: a user delete, by id or by filter, leaves one tombstone per session it deleted', () => {
    session('s-one', NOW - DAY);
    session('s-two', NOW - DAY, { projectPath: '/p/other' });
    session('s-three', NOW - DAY, { projectPath: '/p/other' });
    session('s-kept', NOW - DAY);
    expect(store.remove({ traceIds: ['s-one'] }, NOW).deleted).toBe(1);
    expect(store.remove({ filter: { project: '/p/other' } }, NOW + 1).deleted).toBe(2);
    expect(byId(all())).toEqual([
      { sessionId: 's-one', reason: 'user', at: NOW },
      { sessionId: 's-three', reason: 'user', at: NOW + 1 },
      { sessionId: 's-two', reason: 'user', at: NOW + 1 },
    ]);
  });

  it('2 and 3: the sweep files what retention deleted under retention, and what the cap deleted under cap', () => {
    session('s-new', NOW - DAY, { startedAt: NOW - 2 * DAY });
    // Room for that one session and a little: retention takes the expired one, then the cap the oldest left.
    const cap = store.stats().bytes + 500;
    session('s-expired', NOW - 31 * DAY);
    session('s-old', NOW - 3 * DAY, { startedAt: NOW - 20 * DAY });
    const r = store.sweep({ capBytes: cap, retentionDays: 30, now: NOW });
    expect(r.deleted).toBe(2);
    expect(byId(all())).toEqual([
      { sessionId: 's-expired', reason: 'retention', at: NOW },
      { sessionId: 's-old', reason: 'cap', at: NOW },
    ]);
    expect(store.hasTrace('s-new')).toBe(true);
  });

  it('4: a tombstone holds the id, the reason and the time, and nothing of the session', () => {
    session('s-one', NOW - DAY);
    store.remove({ traceIds: ['s-one'] }, NOW);
    const page = store.deletions({});
    expect(page.deletions).toHaveLength(1);
    expect(Object.keys(page.deletions[0]).sort()).toEqual(['at', 'reason', 'sessionId']);
    store.close();
    const db = new Database(file, { readonly: true });
    try {
      const rows = db.prepare('SELECT * FROM tombstones').all();
      const text = JSON.stringify(rows);
      for (const word of ['secret-project', 'agent-x', 'open-coder-1', 'ep-000001', 'Remote host', '192.0.2.10', 'qwen-code', 'the task of']) {
        expect(text, `a tombstone holds "${word}"`).not.toContain(word);
      }
    } finally {
      db.close();
      store = new TraceStore(file);
    }
  });

  it('5: a delete that removed nothing leaves no tombstone, and a session is buried once', () => {
    session('s-one', NOW - DAY);
    expect(store.remove({ traceIds: ['never-there'] }, NOW).deleted).toBe(0);
    store.remove({ traceIds: ['s-one'] }, NOW);
    store.remove({ traceIds: ['s-one'] }, NOW + 5);
    store.sweep({ capBytes: 1, retentionDays: 1, now: NOW + 10 });
    expect(all()).toEqual([{ sessionId: 's-one', reason: 'user', at: NOW }]);
  });

  it('6 and 13: the cursor gives each tombstone once, in order, across writes; an empty page keeps a cursor; more says a page was cut', () => {
    for (let i = 0; i < 5; i++) session(`s-${i}`, NOW - DAY);
    const empty = store.deletions({});
    expect(empty.deletions).toEqual([]);
    expect(empty.more).toBe(false);
    expect(typeof empty.nextCursor).toBe('string');
    store.remove({ traceIds: ['s-0'] }, NOW);
    store.remove({ traceIds: ['s-1'] }, NOW + 1);
    store.remove({ traceIds: ['s-2'] }, NOW + 2);
    const first = store.deletions({ cursor: empty.nextCursor, limit: 2 });
    expect(first.deletions.map(d => d.sessionId)).toEqual(['s-0', 's-1']);
    expect(first.more).toBe(true);
    // Written between two reads: read next, once.
    store.remove({ traceIds: ['s-3'] }, NOW + 3);
    const second = store.deletions({ cursor: first.nextCursor, limit: 2 });
    expect(second.deletions.map(d => d.sessionId)).toEqual(['s-2', 's-3']);
    expect(second.more).toBe(false);
    const third = store.deletions({ cursor: second.nextCursor, limit: 2 });
    expect(third.deletions).toEqual([]);
    expect(third.more).toBe(false);
    expect(third.nextCursor).toBe(second.nextCursor);
    store.remove({ traceIds: ['s-4'] }, NOW + 4);
    expect(store.deletions({ cursor: third.nextCursor }).deletions.map(d => d.sessionId)).toEqual(['s-4']);
    // 13: the limit is held to 1..500.
    expect(store.deletions({ limit: 0 }).deletions).toHaveLength(1);
    for (let i = 0; i < 510; i++) session(`b-${i}`, NOW - DAY, {}, 16);
    store.remove({ filter: { project: '/p/secret-project' } }, NOW + 5);
    const big = store.deletions({ limit: 1_000_000 });
    expect(big.deletions).toHaveLength(500);
    expect(big.more).toBe(true);
  });

  it('7: a table pruned to empty never hands out again a sequence a cursor has passed', () => {
    session('s-old', NOW - DAY);
    store.remove({ traceIds: ['s-old'] }, NOW - 400 * DAY);
    const read = store.deletions({});
    expect(read.deletions.map(d => d.sessionId)).toEqual(['s-old']);
    store.sweep({ capBytes: 1024 ** 3, retentionDays: 30, now: NOW });
    expect(store.deletions({}).deletions).toEqual([]);
    session('s-next', NOW - DAY);
    store.remove({ traceIds: ['s-next'] }, NOW);
    expect(store.deletions({ cursor: read.nextCursor }).deletions.map(d => d.sessionId)).toEqual(['s-next']);
  });

  it('8: kept 365 days, then pruned by the sweep; one still owed to the back-office stays until it is sent', () => {
    for (const id of ['s-400', 's-364', 's-owed']) session(id, NOW - 500 * DAY, { startedAt: NOW - 501 * DAY });
    store.markUploaded('s-owed', store.seqOf('s-owed')!, NOW - 450 * DAY);
    store.remove({ traceIds: ['s-400', 's-owed'] }, NOW - 400 * DAY);
    store.remove({ traceIds: ['s-364'] }, NOW - 364 * DAY);
    store.sweep({ capBytes: 1024 ** 3, retentionDays: 30, now: NOW });
    expect(byId(all()).map(d => d.sessionId)).toEqual(['s-364', 's-owed']);
    const owed = store.owedDeletes(10);
    expect(owed.map(o => o.traceId)).toEqual(['s-owed']);
    store.deleteSent(owed[0].seq);
    store.sweep({ capBytes: 1024 ** 3, retentionDays: 30, now: NOW });
    expect(all().map(d => d.sessionId)).toEqual(['s-364']);
  });

  it('9: a delete is owed for a session uploaded and then deleted by the user or by retention, never one not uploaded or taken by the cap', () => {
    session('kept', NOW - DAY, { startedAt: NOW - 2 * DAY });
    const cap = store.stats().bytes + 500;
    session('up-user', NOW - DAY);
    session('up-expired', NOW - 31 * DAY);
    session('up-cap', NOW - 3 * DAY, { startedAt: NOW - 20 * DAY });
    session('local-user', NOW - DAY);
    for (const id of ['up-user', 'up-expired', 'up-cap', 'kept']) store.markUploaded(id, store.seqOf(id)!, NOW - DAY);
    store.remove({ traceIds: ['up-user', 'local-user'] }, NOW);
    store.sweep({ capBytes: cap, retentionDays: 30, now: NOW });
    expect(store.hasTrace('kept')).toBe(true);
    expect(byId(all()).map(d => `${d.sessionId}:${d.reason}`)).toEqual(['local-user:user', 'up-cap:cap', 'up-expired:retention', 'up-user:user']);
    expect(owedIds()).toEqual(['up-expired', 'up-user']);
  });

  it('10: forgetting what was sent (a new install, a whole deletion) forgets the deletes owed with it', () => {
    session('up-user', NOW - DAY);
    store.markUploaded('up-user', store.seqOf('up-user')!, NOW - DAY);
    store.remove({ traceIds: ['up-user'] }, NOW);
    expect(owedIds()).toEqual(['up-user']);
    store.resetUploads();
    expect(owedIds()).toEqual([]);
    expect(all().map(d => d.sessionId)).toEqual(['up-user']);
  });

  it('11: a store written before tombstones opens with its sessions and buries the next one', () => {
    store.close();
    fs.rmSync(file);
    const old = new Database(file);
    old.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE uploads (trace_id TEXT PRIMARY KEY, uploaded_seq INTEGER NOT NULL, uploaded_at INTEGER NOT NULL);
      CREATE TABLE traces (trace_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT,
        harness TEXT NOT NULL, harness_version TEXT, native_session_id TEXT, endpoint_id TEXT NOT NULL, endpoint_name TEXT,
        endpoint_base_url TEXT, model TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, last_end_at INTEGER,
        turn_count INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_cached INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, final_status TEXT NOT NULL DEFAULT 'open',
        outcome_json TEXT, mixed INTEGER NOT NULL DEFAULT 0, unknown_turns INTEGER NOT NULL DEFAULT 0, main_system_hash TEXT,
        bytes INTEGER NOT NULL DEFAULT 0, updated_seq INTEGER NOT NULL DEFAULT 0);
      INSERT INTO traces (trace_id, project_path, agent_id, harness, endpoint_id, model, started_at, ended_at, final_status)
        VALUES ('s-before', '/p/a', 'agent-x', 'qwen-code', 'ep-000001', 'open-coder-1', 1, 2, 'done');`);
    old.close();
    store = new TraceStore(file);
    expect(store.hasTrace('s-before')).toBe(true);
    store.remove({ traceIds: ['s-before'] }, NOW);
    expect(all()).toEqual([{ sessionId: 's-before', reason: 'user', at: NOW }]);
  });

  it('12: a delete marked sent is owed no more, and stays in the reader\'s feed', () => {
    session('up-user', NOW - DAY);
    store.markUploaded('up-user', store.seqOf('up-user')!, NOW - DAY);
    store.remove({ traceIds: ['up-user'] }, NOW);
    const [owed] = store.owedDeletes(10);
    store.deleteSent(owed.seq);
    expect(owedIds()).toEqual([]);
    expect(all()).toEqual([{ sessionId: 'up-user', reason: 'user', at: NOW }]);
  });
});
