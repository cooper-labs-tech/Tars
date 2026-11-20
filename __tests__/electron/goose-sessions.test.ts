import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Goose's turns, read from the database its TUI writes, and told to Tars as Claude Code's hooks tell it: so
 * delegate_task, task_status and get_agent_output work on a Goose agent as on the others, with its tokens.
 *
 * Measured on Goose 1.60.1 (20/11/2026, its TUI in a PTY against a loopback endpoint): `$XDG_DATA_HOME/goose/sessions/
 * sessions.db` (SQLite). A `sessions` row (`YYYYMMDD_N`, its `working_dir`, `created_at` in whole seconds, UTC) is
 * written at the TUI's start. Each message is a `messages` row (an autoincremented `id`, `role`, `content_json`: a list
 * of `text`, `toolRequest`, `toolResponse` or `error` items, `created_timestamp` in whole seconds, `metadata_json`: its
 * `userVisible`, and `turnContext` on the turn context Goose adds under each prompt). Each model call is a
 * `usage_ledger` row (its `model`, input, output and cache-read tokens). No row says a turn ended: an assistant message
 * with text and no tool request is its end; an endpoint's failure is an assistant message whose content is an `error`;
 * a Ctrl+C mid-turn leaves the turn's user rows and no assistant row. A fork (`--resume --session-id S --fork`) is a
 * new session with no `parent_session_id`, every message of S copied with its own time.
 *
 * How it fails, written before the code:
 * 1. A session taken that is not the agent's: one in another folder, one there before the launch, one whose first
 *    prompt names another agent, one whose first prompt holds nothing this terminal was sent.
 * 2. No database yet, or a file that is not one: a throw, or a session never bound once the database appears.
 * 3. A turn's end missed, or its answer, its usage: an assistant message with text and no tool request ends it; its
 *    answer is the turn's text; its tokens are the turn's model calls summed, under their model.
 * 4. A step that asked for a tool taken for the end, or a tool's response or the turn context taken for a prompt.
 * 5. An endpoint's failure not said: the agent's status is an error, in Goose's words.
 * 6. A turn cut by Ctrl+C left open for good: the next prompt closes it, said interrupted, before its own turn.
 * 7. Goose's session id posted: the hook routes take a UUID only. Posted under a UUID made from it, the same each time.
 * 8. A resumed session (`--resume --session-id <id>`) read from its start, or bound while another live launch holds it.
 * 9. A fork bound to the session it copies, or its copies posted again as new turns.
 * 10. A row whose content does not parse stops its session.
 * 11. A launch never forgotten: read every second after its terminal is gone.
 */

import { GooseSessionWatch, type HookPost } from '../../electron/services/goose-sessions';
import { gooseUuidOf } from '../../electron/providers/goose-cli';

const DDL = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, parent_session_id TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT);
CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL);
`;
const AGENT = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';
const SES = '20261120_1';
/** The launch's clock, in milliseconds; Goose writes whole seconds. */
const LAUNCH = 1_795_192_200_000;
const sec = (ms: number) => Math.floor(ms / 1000);

let root: string;
let project: string;
let dbFile: string;
let clock: number;
let posts: Array<{ agentId: string; post: HookPost }>;
let interrupted: string[];
let db: Database.Database | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-goose-sessions-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  dbFile = path.join(root, 'goose', 'sessions', 'sessions.db');
  clock = LAUNCH;
  posts = [];
  interrupted = [];
  db = undefined;
});
afterEach(() => {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function watch(): GooseSessionWatch {
  return new GooseSessionWatch({
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
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function session(id: string, dir: string, atMs: number): void {
  open().prepare('INSERT INTO sessions (id, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, dir, utc(atMs), utc(atMs));
}
function message(sessionId: string, atMs: number, role: string, content: unknown[], meta: Record<string, unknown> = { userVisible: true, agentVisible: true }): void {
  open().prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`msg_${Math.random().toString(16).slice(2)}`, sessionId, role, JSON.stringify(content), sec(atMs), JSON.stringify(meta));
}
function usage(sessionId: string, atMs: number, input: number, output: number, cacheRead = 0): void {
  open().prepare('INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, sec(atMs), 'stand-in-coder', input, output, input + output, cacheRead);
}
const text = (t: string) => ({ type: 'text', text: t });
const prompt = (s: string, atMs: number, t: string) => {
  message(s, atMs, 'user', [text(t)]);
  message(s, atMs, 'user', [text('<turn-context>\n<current-time>...</current-time>\n</turn-context>')], { userVisible: false, agentVisible: true, turnContext: true });
};
const toolCall = (s: string, atMs: number) => {
  message(s, atMs, 'assistant', [{ type: 'toolRequest', id: 'call_1', toolCall: { status: 'success', value: { name: 'shell', arguments: { command: 'echo X' } } } }]);
  message(s, atMs, 'user', [{ type: 'toolResponse', id: 'call_1', toolResult: { status: 'success', value: { content: [text('X')] } } }]);
};
const identity = (agentId: string) => `[Tars: you are agent "Worker" (id ${agentId}), worker of project /x.]\nRun the probe.`;
const paths = () => posts.map((p) => `${p.post.path}${p.post.body.event ? `:${p.post.body.event}` : ''}${p.post.body.status ? `:${p.post.body.status}` : ''}`);

describe("a Goose agent's turns, from its database", () => {
  it("3, 4 and 7: a turn, its prompt, a tool round, then its end with the answer and its tokens, under a UUID made from the session", async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, LAUNCH + 500);
    prompt(SES, LAUNCH + 2_000, identity(AGENT));
    usage(SES, LAUNCH + 3_000, 120, 12, 100);
    toolCall(SES, LAUNCH + 3_000);
    usage(SES, LAUNCH + 4_000, 120, 12, 100);
    message(SES, LAUNCH + 4_000, 'assistant', [text('PROBE-OK TARS-PROBE-1234abcd')]);
    await w.tick();
    expect(paths()).toEqual([
      '/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running',
      '/api/hooks/output', '/api/hooks/status:idle', '/api/hooks/agent-stopped', '/api/hooks/turn-usage',
    ]);
    const uuid = gooseUuidOf(SES)!;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const p of posts) expect(p.post.body.session_id).toBe(uuid);
    expect(gooseUuidOf(SES)).toBe(uuid);
    expect(posts[1].post.body.current_task).toBe(identity(AGENT));
    expect(posts[2].post.body.output).toBe('PROBE-OK TARS-PROBE-1234abcd');
    expect(posts[5].post.body.usage).toEqual({ model: 'stand-in-coder', input_tokens: 240, output_tokens: 24, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 });
  });

  it('4: a step that asked for a tool ends nothing; each message is posted once, across reads', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, LAUNCH + 500);
    prompt(SES, LAUNCH + 2_000, identity(AGENT));
    toolCall(SES, LAUNCH + 3_000);
    await w.tick();
    await w.tick();
    expect(paths()).toEqual(['/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running']);
    message(SES, LAUNCH + 4_000, 'assistant', [text('done')]);
    await w.tick();
    await w.tick();
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['done']);
  });

  it("5: an endpoint's failure makes the agent's status an error, in Goose's words", async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, LAUNCH + 500);
    prompt(SES, LAUNCH + 2_000, identity(AGENT));
    message(SES, LAUNCH + 3_000, 'assistant', [{ type: 'error', kind: 'other', message: 'Network error: Could not connect to 127.0.0.1:9' }]);
    await w.tick();
    expect(posts.at(-1)?.post.body).toMatchObject({ status: 'error', error_kind: 'goose_turn_failed', error_message: 'Network error: Could not connect to 127.0.0.1:9' });
    expect(posts.some((p) => p.post.path === '/api/hooks/output')).toBe(false);
  });

  it('6: a turn cut by Ctrl+C is said interrupted when the next prompt comes, before that prompt', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, LAUNCH + 500);
    prompt(SES, LAUNCH + 2_000, identity(AGENT));
    await w.tick();
    prompt(SES, LAUNCH + 9_000, 'and now this instead');
    message(SES, LAUNCH + 10_000, 'assistant', [text('the second answer')]);
    await w.tick();
    expect(interrupted).toEqual([`${AGENT}:${gooseUuidOf(SES)}`]);
    expect(paths()).toEqual([
      '/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running',
      '/api/hooks/status:idle',
      '/api/hooks/status:UserPromptSubmit:running', '/api/hooks/output', '/api/hooks/status:idle', '/api/hooks/agent-stopped',
    ]);
  });
});

describe('whose session it is (1)', () => {
  it('another folder, one there before the launch, one naming another agent, one with nothing sent here: never bound', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    session('20261120_7', project, LAUNCH - 60_000);
    prompt('20261120_7', LAUNCH - 59_000, identity(AGENT));
    const w = watch();
    w.noteLaunch(AGENT, project);
    session('20261120_8', elsewhere, LAUNCH + 1_000);
    prompt('20261120_8', LAUNCH + 2_000, identity(AGENT));
    session('20261120_9', project, LAUNCH + 1_000);
    prompt('20261120_9', LAUNCH + 2_000, identity(OTHER));
    session('20261120_10', project, LAUNCH + 1_000);
    prompt('20261120_10', LAUNCH + 2_000, 'a prompt nobody typed here, long enough to count');
    await w.tick();
    expect(posts).toEqual([]);
  });

  it('with no identity line, the text this terminal was sent binds it', async () => {
    const typed = 'Message from agent "Lead": run the shell command that prints the probe marker';
    const w = watch();
    w.noteLaunch(AGENT, project);
    w.noteTyped(AGENT, typed);
    session(SES, project, LAUNCH + 1_000);
    prompt(SES, LAUNCH + 2_000, typed);
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
    session(SES, project, LAUNCH + 1_000);
    prompt(SES, LAUNCH + 2_000, identity(AGENT));
    await w.tick();
    expect(paths()).toEqual(['/api/hooks/status:running', '/api/hooks/status:UserPromptSubmit:running']);
  });
});

describe('a resumed session, and a fork (8, 9)', () => {
  it('8: resumed by its id, read from the launch on; refused while another live launch holds it', async () => {
    session(SES, project, LAUNCH - 60_000);
    prompt(SES, LAUNCH - 59_000, identity(AGENT));
    message(SES, LAUNCH - 58_000, 'assistant', [text('the first answer')]);
    const first = {};
    const w = watch();
    w.noteLaunch(AGENT, project, { resume: SES, terminal: first });
    w.noteLaunch(OTHER, project, { resume: SES, terminal: {} });
    await w.tick();
    expect(posts).toEqual([]);
    prompt(SES, LAUNCH + 2_000, 'and go on');
    message(SES, LAUNCH + 3_000, 'assistant', [text('the second answer')]);
    await w.tick();
    expect(posts.every((p) => p.agentId === AGENT)).toBe(true);
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['the second answer']);
    expect(posts[0].post.body).toMatchObject({ status: 'running', source: 'resume' });
  });

  it("9: a fork is bound by its copy of S's first prompt, never S; the copies are not posted again", async () => {
    const FORK = '20261120_2';
    session(SES, project, LAUNCH - 60_000);
    prompt(SES, LAUNCH - 59_000, 'a first prompt long ago, with no identity line in it');
    message(SES, LAUNCH - 58_000, 'assistant', [text('the first answer')]);
    const w = watch();
    w.noteLaunch(AGENT, project, { forkOf: SES });
    session(FORK, project, LAUNCH + 1_000);
    prompt(FORK, LAUNCH - 59_000, 'a first prompt long ago, with no identity line in it');
    message(FORK, LAUNCH - 58_000, 'assistant', [text('the first answer')]);
    await w.tick();
    expect(posts.map((p) => p.post.body.session_id)).toEqual([gooseUuidOf(FORK)]);
    prompt(FORK, LAUNCH + 2_000, 'and go on');
    message(FORK, LAUNCH + 3_000, 'assistant', [text('the second answer')]);
    await w.tick();
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['the second answer']);
    expect(posts.every((p) => p.post.body.session_id === gooseUuidOf(FORK))).toBe(true);
  });
});

describe('what would stop a session, and a launch whose terminal is gone (10, 11)', () => {
  it('10: a row whose content does not parse is passed over', async () => {
    const w = watch();
    w.noteLaunch(AGENT, project);
    session(SES, project, LAUNCH + 500);
    prompt(SES, LAUNCH + 2_000, identity(AGENT));
    open().prepare("INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, 'assistant', '{not json', ?, '{}')").run(SES, sec(LAUNCH + 3_000));
    message(SES, LAUNCH + 4_000, 'assistant', [text('the answer after it')]);
    await w.tick();
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['the answer after it']);
  });

  it('11: forgotten with its own terminal only', async () => {
    const old = {};
    const current = {};
    const w = watch();
    w.noteLaunch(AGENT, project, { terminal: old });
    w.noteLaunch(AGENT, project, { terminal: current });
    w.forgetTerminal(old);
    expect(w.watching).toBe(true);
    w.forgetTerminal(current);
    expect(w.watching).toBe(false);
  });
});
