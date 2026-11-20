import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * opencode's turns, read from the database its TUI writes, and told to Tars as Claude Code's hooks tell it: so
 * delegate_task, task_status and get_agent_output work on an opencode agent as on the others, with its tokens.
 *
 * Measured on opencode 1.19.6 (20/11/2026, its TUI in a PTY against a loopback endpoint): everything is in
 * `$XDG_DATA_HOME/opencode/opencode.db` (SQLite, WAL). A session row (`ses_<base62>`, its `directory`) is written at
 * its first prompt; each message is a row (`data` JSON: `role`, `time.created`, `time.completed` once done, an
 * assistant's `finish` (`tool-calls` for a step that asked for a tool, `stop` at the turn's end), `tokens` (input
 * without the cache, output, reasoning, cache read and write), `modelID`, `providerID`, or `error`: `MessageAbortedError`
 * after an Esc, `APIError` with its message when the endpoint failed); its text is in `part` rows (`type: 'text'`).
 *
 * How it fails, written before the code:
 * 1. A session taken that is not the agent's: one in another folder, one there before the launch, one whose first
 *    prompt names another agent, one whose first prompt holds nothing this terminal was sent (or what another
 *    agent's was sent too).
 * 2. No database yet (opencode writes it at its first prompt), or a file that is not one: a throw, or a session never
 *    bound once the database appears.
 * 3. A turn's end missed, or its answer, its usage: the last assistant message, completed with `finish: stop`, ends
 *    it; its answer is the turn's text (reportOf); its tokens are the turn's assistant messages summed, under the model.
 * 4. A step that asked for a tool (`finish: tool-calls`), or a message not completed yet, taken for the end.
 * 5. An Esc taken for an answer or for an error: it is an interruption.
 * 6. An endpoint's failure not said: the agent's status is an error, in opencode's words.
 * 7. A prompt posted twice, or without its text while its parts are not written yet.
 * 8. opencode's session id posted: the hook routes take a UUID only. Posted under a UUID made from it, the same for the
 *    same session every time.
 * 9. A resumed session (`--session ses_...`) read from its start: its earlier turns posted again as new ones.
 * 10. A message read twice, across reads, posted twice.
 */

import { OpencodeSessionWatch, type HookPost } from '../../electron/services/opencode-sessions';
import { opencodeUuidOf } from '../../electron/providers/opencode-cli';

const DDL = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
  directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer,
  summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text,
  agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;
const AGENT = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';
const SES = 'ses_e0a2b2f04ffeyXxkOfD77KQMP5';

let root: string;
let project: string;
let dbFile: string;
let clock: number;
let posts: Array<{ agentId: string; post: HookPost }>;
let interrupted: string[];
let db: Database.Database | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-opencode-sessions-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  dbFile = path.join(root, 'opencode', 'opencode.db');
  clock = 1_000;
  posts = [];
  interrupted = [];
  db = undefined;
});
afterEach(() => {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function watch(): OpencodeSessionWatch {
  return new OpencodeSessionWatch({
    dbPath: () => dbFile,
    now: () => clock,
    post: async (agentId, post) => { posts.push({ agentId, post }); },
    interrupted: (agentId, sessionId) => { interrupted.push(`${agentId}:${sessionId}`); },
  });
}
function open(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.exec(DDL);
  }
  return db;
}
function session(id: string, directory: string, at: number): void {
  open().prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', 's', ?, 't', '1.19.6', ?, ?)")
    .run(id, directory, at, at);
}
let seq = 0;
function message(sessionId: string, at: number, data: Record<string, unknown>, texts: string[] = []): string {
  const id = `msg_${String(++seq).padStart(6, '0')}`;
  open().prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, at, at, JSON.stringify(data));
  texts.forEach((text, i) => part(id, sessionId, at + i, { type: 'text', text }));
  return id;
}
function part(messageId: string, sessionId: string, at: number, data: Record<string, unknown>): void {
  open().prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`prt_${String(++seq).padStart(6, '0')}`, messageId, sessionId, at, at, JSON.stringify(data));
}
function complete(messageId: string, data: Record<string, unknown>): void {
  open().prepare('UPDATE message SET data = ?, time_updated = time_updated + 1 WHERE id = ?').run(JSON.stringify(data), messageId);
}
const user = (at: number) => ({ role: 'user', time: { created: at } });
const assistant = (at: number, extra: Record<string, unknown>) => ({
  role: 'assistant', modelID: 'stand-in-coder', providerID: 'tars-endpoint', time: { created: at, completed: at + 5 },
  tokens: { input: 20, output: 12, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0, ...extra,
});
const identity = (agentId: string) => `[Tars: you are agent "Worker" (id ${agentId}), worker of project /x.]\nRun the probe.`;
const paths = () => posts.map((p) => `${p.post.path}${p.post.body.event ? `:${p.post.body.event}` : ''}${p.post.body.status ? `:${p.post.body.status}` : ''}`);

describe("an opencode agent's turns, from its database", () => {
  it('3 and 8: a turn, its prompt, then its end with the answer and the turn\'s tokens, under a UUID made from the session', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    clock = 2_000;
    session(SES, project, 2_000);
    message(SES, 2_001, user(2_001), [identity(AGENT)]);
    const step = message(SES, 2_010, assistant(2_010, { finish: 'tool-calls' }));
    message(SES, 2_020, assistant(2_020, { finish: 'stop' }), ['PROBE-OK TARS-PROBE-1234abcd']);
    await w.tick();
    expect(paths()).toEqual([
      '/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running',
      '/api/hooks/output', '/api/hooks/status:idle', '/api/hooks/agent-stopped', '/api/hooks/turn-usage',
    ]);
    const uuid = opencodeUuidOf(SES)!;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (const p of posts) expect(p.post.body.session_id).toBe(uuid);
    expect(posts[1].post.body.current_task).toBe(identity(AGENT));
    expect(posts[2].post.body.output).toBe('PROBE-OK TARS-PROBE-1234abcd');
    expect(posts[5].post.body.usage).toEqual({ model: 'stand-in-coder', input_tokens: 40, output_tokens: 24, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 });
    expect(opencodeUuidOf(SES)).toBe(uuid);
    expect(opencodeUuidOf('ses_another0000000000000000')).not.toBe(uuid);
    expect(step).toBeTruthy();
  });

  it('4 and 10: a step that asked for a tool, or a message not completed, ends nothing; each message is posted once', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, 2_000);
    message(SES, 2_001, user(2_001), [identity(AGENT)]);
    message(SES, 2_010, assistant(2_010, { finish: 'tool-calls' }));
    const last = message(SES, 2_020, { ...assistant(2_020, {}), time: { created: 2_020 } });
    await w.tick();
    await w.tick();
    expect(paths()).toEqual(['/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running']);
    part(last, SES, 2_021, { type: 'text', text: 'done' });
    complete(last, assistant(2_020, { finish: 'stop' }));
    await w.tick();
    await w.tick();
    expect(paths().filter((p) => p === '/api/hooks/output')).toHaveLength(1);
    expect(paths().filter((p) => p.includes('UserPromptSubmit'))).toHaveLength(1);
  });

  it('5: an Esc is an interruption: no answer, the turn told interrupted, the agent idle', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, 2_000);
    message(SES, 2_001, user(2_001), [identity(AGENT)]);
    message(SES, 2_010, assistant(2_010, { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }), ['half an answer']);
    await w.tick();
    expect(interrupted).toEqual([`${AGENT}:${opencodeUuidOf(SES)}`]);
    expect(paths()).toEqual(['/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running', '/api/hooks/status:idle']);
  });

  it("6: an endpoint's failure makes the agent's status an error, in opencode's words", async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, 2_000);
    message(SES, 2_001, user(2_001), [identity(AGENT)]);
    message(SES, 2_010, assistant(2_010, { error: { name: 'APIError', data: { message: 'Cannot connect to API: ECONNREFUSED', isRetryable: true } } }));
    await w.tick();
    const last = posts[posts.length - 1].post;
    expect(last.path).toBe('/api/hooks/status');
    expect(last.body.status).toBe('error');
    expect(String(last.body.error_message)).toContain('Cannot connect to API: ECONNREFUSED');
    expect(paths()).not.toContain('/api/hooks/output');
  });

  it('7: a prompt waits for its text, and is posted once with it', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, 2_000);
    const prompt = message(SES, 2_001, user(2_001));
    await w.tick();
    expect(paths()).toEqual([]);
    part(prompt, SES, 2_002, { type: 'text', text: identity(AGENT) });
    await w.tick();
    await w.tick();
    expect(paths()).toEqual(['/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running']);
    expect(posts[1].post.body.current_task).toBe(identity(AGENT));
  });
});

describe("whose session it is (1)", () => {
  it('another folder, one there before the launch, one naming another agent: never bound', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    session('ses_before0000000000000000000', project, 500);
    message('ses_before0000000000000000000', 501, user(501), [identity(AGENT)]);
    const w = watch();
    w.noteLaunch(AGENT, project);
    session('ses_elsewhere000000000000000', elsewhere, 2_000);
    message('ses_elsewhere000000000000000', 2_001, user(2_001), [identity(AGENT)]);
    session('ses_otheragent0000000000000', project, 2_000);
    message('ses_otheragent0000000000000', 2_001, user(2_001), [identity(OTHER)]);
    await w.tick();
    expect(posts).toEqual([]);
  });

  it('with no identity line, the text this terminal was sent, and no other agent\'s, binds it', async () => {
    const typed = 'Run the shell command that prints the probe marker, then tell me what it printed.';
    const w = watch();
    w.noteLaunch(AGENT, project);
    w.noteLaunch(OTHER, project);
    w.noteTyped(AGENT, `Message from agent "Lead": ${typed}`);
    session('ses_nobody00000000000000000', project, 2_000);
    message('ses_nobody00000000000000000', 2_001, user(2_001), ['a prompt nobody typed here, long enough to count']);
    await w.tick();
    expect(posts).toEqual([]);
    session(SES, project, 2_100);
    message(SES, 2_101, user(2_101), [`Message from agent "Lead": ${typed}`]);
    await w.tick();
    expect(posts.every((p) => p.agentId === AGENT)).toBe(true);
    expect(paths()).toContain('/api/hooks/status:UserPromptSubmit:running');
  });
});

describe('a database that is not there yet, or not one (2)', () => {
  it('nothing posted and nothing thrown; bound once it appears', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    await w.tick();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, 'not a database');
    await expect(w.tick()).resolves.toBeUndefined();
    fs.rmSync(dbFile);
    session(SES, project, 2_000);
    message(SES, 2_001, user(2_001), [identity(AGENT)]);
    await w.tick();
    expect(paths()).toEqual(['/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running']);
  });
});

describe('a resumed session (9)', () => {
  it('is read from where it stood at the launch: its earlier turns are not posted again', async () => {
    session(SES, project, 500);
    message(SES, 501, user(501), [identity(AGENT)]);
    message(SES, 510, assistant(510, { finish: 'stop' }), ['the first answer']);
    const w = watch();
    w.noteLaunch(AGENT, project, SES);
    clock = 2_000;
    await w.tick();
    expect(posts).toEqual([]);
    message(SES, 2_001, user(2_001), ['and go on']);
    message(SES, 2_010, assistant(2_010, { finish: 'stop' }), ['the second answer']);
    await w.tick();
    expect(posts[0].post.body).toMatchObject({ status: 'running', source: 'resume' });
    expect(posts.find((p) => p.post.path === '/api/hooks/output')?.post.body.output).toBe('the second answer');
    expect(posts.filter((p) => p.post.path === '/api/hooks/output')).toHaveLength(1);
  });
});
