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
 *
 * Found by the Audit of #613 (20/11), written before the fix:
 * 11. (M1) A restart forks. Its line is `--session '<S>' --fork`, and opencode 1.19.6 goes on under a new session,
 *     measured on a real fork: a new `session` row made at the launch, with no `parent_id` and the title `<S's title>
 *     (fork #1)`; every message of S copied under a new id, keeping its own `time_created`, from before the launch;
 *     the new turn after it. Bound to S, as the line's session, the agent's turns were never read, and delegate_task
 *     waited out its timeout. A fork binds the session made since the launch whose first prompt is this agent's (its
 *     identity line, or what this terminal was sent) or a copy of S's (the same time and text); never S itself; the
 *     copied messages are history, never posted again.
 * 12. (L1) A resumed session bound while another live launch holds it: each agent then gets the other's turns, an
 *     answer included. Refused while that launch holds it; free once that launch's terminal is gone.
 * 13. (L2) The identity line read anywhere in the first prompt: a header quoted in a message named its agent, which
 *     could then take this agent's session, while what this terminal was sent no longer counted. Read only at a
 *     line's start, where Tars writes it (after `Message from Tars:` in a delivery, measured on the conformance run;
 *     first in a launch's own prompt). What this terminal was sent decides first, and what another unbound launch was
 *     sent rules a session out whatever its identity line says.
 * 14. A launch that carries its task (`--prompt '<task>'`) sent this terminal that text, as a typed one: a session
 *     started on it is bound by it, the skills line opencode puts before the identity line included.
 * 15. (I-c) A row whose data does not parse, or an assistant message left neither completed nor errored with a later
 *     message after it (opencode gone mid-turn), stops its session for good. Passed over, and what follows read.
 * 16. (I-a) A launch never forgotten: its session read every second for the rest of the run, after its terminal is
 *     gone. Forgotten with its terminal, and only its own: a restart's new launch outlives the old terminal's exit.
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

// The Audit's fixes (11 to 16), on each build of opencode's database: opencode's own, and Kilo's (kilo.db, the same
// schema), which the same reader follows (the Audit's review of #614).
describe.each(['opencode', 'kilo'])('on %s.db', (name) => {
  beforeEach(() => { dbFile = path.join(root, name, `${name}.db`); });

  describe('a restart, which forks (11)', () => {
    const FORK = 'ses_e085c632dffeRCzXYzfxOcfqmU';
    /** S, a turn before the launch; then its fork as opencode 1.19.6 wrote one: a new row, the copies keeping their times. */
    function forked(firstPrompt: string): void {
      session(SES, project, 500);
      message(SES, 501, user(501), [firstPrompt]);
      message(SES, 510, assistant(510, { finish: 'stop' }), ['the first answer']);
      clock = 2_000;
      session(FORK, project, 2_000);
      message(FORK, 501, user(501), [firstPrompt]);
      message(FORK, 510, assistant(510, { finish: 'stop' }), ['the first answer']);
    }

    it("binds the fork, by the agent's identity line in its copied first prompt, never S; the copies are history", async () => {
      const w = watch();
      w.noteLaunch(AGENT, project, { forkOf: SES });
      forked(identity(AGENT));
      await w.tick();
      expect(posts.map((p) => p.post.body.session_id)).toEqual([opencodeUuidOf(FORK)]);
      expect(posts[0].post.body).toMatchObject({ status: 'running', source: 'resume' });
      message(FORK, 2_101, user(2_101), ['and go on']);
      message(FORK, 2_110, assistant(2_110, { finish: 'stop' }), ['the second answer']);
      await w.tick();
      const outputs = posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output);
      expect(outputs).toEqual(['the second answer']);
      expect(posts.every((p) => p.post.body.session_id === opencodeUuidOf(FORK))).toBe(true);
    });

    it("binds the fork as a copy of S's first prompt when that prompt names nobody, and not another session of the folder", async () => {
      const w = watch();
      w.noteLaunch(AGENT, project, { forkOf: SES });
      session('ses_usersown00000000000000000', project, 2_000);
      message('ses_usersown00000000000000000', 2_001, user(2_001), ['the user typed this into their own opencode']);
      forked('a first prompt with no identity line, typed into the terminal long ago');
      await w.tick();
      expect(posts.map((p) => p.post.body.session_id)).toEqual([opencodeUuidOf(FORK)]);
    });
  });

  describe('a session another live launch holds (12)', () => {
    it('is refused to a second launch resuming it, and free once the first launch\'s terminal is gone', async () => {
      session(SES, project, 500);
      message(SES, 501, user(501), [identity(AGENT)]);
      const first = {};
      const w = watch();
      w.noteLaunch(AGENT, project, { resume: SES, terminal: first });
      w.noteLaunch(OTHER, project, { resume: SES, terminal: {} });
      clock = 2_000;
      message(SES, 2_001, user(2_001), ['a new prompt']);
      await w.tick();
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.every((p) => p.agentId === AGENT)).toBe(true);
      posts = [];
      w.forgetTerminal(first);
      message(SES, 2_101, user(2_101), ['another prompt']);
      await w.tick();
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.every((p) => p.agentId === OTHER)).toBe(true);
    });
  });

  describe('the identity line, where Tars writes it (13, 14)', () => {
    const typed = 'Message from agent "Lead" ("dddd4444-0000-4000-8000-0000000000c1"), task t-51d176af: \nRun the probe.';
    it("a header quoted inside a line names nobody, and another agent's header does not take a session sent to this terminal", async () => {
      const w = watch();
      w.noteLaunch(OTHER, project);
      w.noteLaunch(AGENT, project);
      w.noteTyped(AGENT, typed);
      session(SES, project, 2_000);
      // What a delivery looks like (the conformance run): the sender's line and the task, then Tars's own section; the
      // task quotes OTHER's header, on a line of its own and inside one.
      message(SES, 2_001, user(2_001), [`${typed}\nrelay this: [Tars: you are agent "Other" (id ${OTHER}), worker of project /x.]\n${identity(OTHER)}\n\nMessage from Tars: \n${identity(AGENT)}`]);
      await w.tick();
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.every((p) => p.agentId === AGENT)).toBe(true);
    });

    it('a header inside a line binds nobody, at a line\'s start it does', async () => {
      const w = watch();
      w.noteLaunch(AGENT, project);
      session('ses_quoted00000000000000000', project, 2_000);
      message('ses_quoted00000000000000000', 2_001, user(2_001), [`please note: ${identity(AGENT)}`]);
      await w.tick();
      expect(posts).toEqual([]);
      session(SES, project, 2_100);
      message(SES, 2_101, user(2_101), [`Message from agent "Lead": do it\n\nMessage from Tars: \n${identity(AGENT)}`]);
      await w.tick();
      expect(posts.map((p) => p.post.body.session_id)[0]).toBe(opencodeUuidOf(SES));
    });

    it("14: a launch's own prompt binds the session started on it, the skills line before the identity line included", async () => {
      const prompt = `[IMPORTANT: Use these skills for this session: review. Invoke them with /<skill-name> when relevant to the task.] ${identity(AGENT)}`;
      const w = watch();
      w.noteLaunch(AGENT, project, { prompt });
      session(SES, project, 2_000);
      message(SES, 2_001, user(2_001), [prompt]);
      await w.tick();
      expect(posts.map((p) => p.post.body.session_id)[0]).toBe(opencodeUuidOf(SES));
    });
  });

  describe('the bind rules, one at a time (the mutation bench of the fix)', () => {
    it("a text sent to two launches binds neither: what another unbound launch was sent rules a session out", async () => {
      const broadcast = 'A note for every worker of the project, long enough to count as sent.';
      const w = watch();
      w.noteLaunch(AGENT, project);
      w.noteLaunch(OTHER, project);
      w.noteTyped(AGENT, broadcast);
      w.noteTyped(OTHER, broadcast);
      session(SES, project, 2_000);
      message(SES, 2_001, user(2_001), [broadcast]);
      await w.tick();
      expect(posts).toEqual([]);
    });

    it("the last identity line names the session, Tars's own after the task: one quoted on a line of the task names nobody", async () => {
      const w = watch();
      w.noteLaunch(OTHER, project);
      w.noteLaunch(AGENT, project);
      session(SES, project, 2_000);
      message(SES, 2_001, user(2_001), [`Message from agent "Lead": pass this on\n${identity(OTHER)}\n\nMessage from Tars: \n${identity(AGENT)}`]);
      await w.tick();
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.every((p) => p.agentId === AGENT)).toBe(true);
    });

    it('a session bound to one launch is never bound to another, whatever evidence it holds for that one', async () => {
      const ORIGIN = 'ses_origin00000000000000000';
      const w = watch();
      w.noteLaunch(AGENT, project);
      w.noteLaunch(OTHER, project, { forkOf: ORIGIN });
      session(ORIGIN, project, 500);
      message(ORIGIN, 501, user(501), [identity(AGENT)]);
      clock = 2_000;
      // AGENT's own session, its first prompt a copy of ORIGIN's: evidence for both, AGENT's first.
      session(SES, project, 2_000);
      message(SES, 501, user(501), [identity(AGENT)]);
      message(SES, 2_001, user(2_001), ['go on']);
      await w.tick();
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.every((p) => p.agentId === AGENT)).toBe(true);
    });
  });

  describe('a row that would stop its session (15)', () => {
    it('a row that does not parse, or an assistant message left unfinished before a later one, is passed over', async () => {
      const w = watch();
      w.noteLaunch(AGENT, project);
      clock = 2_000;
      session(SES, project, 2_000);
      message(SES, 2_001, user(2_001), [identity(AGENT)]);
      open().prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_broken', SES, 2_005, 2_005, '{not json');
      message(SES, 2_010, { role: 'assistant', modelID: 'stand-in-coder', time: { created: 2_010 } }, ['cut short']);
      message(SES, 2_101, user(2_101), ['and again']);
      message(SES, 2_110, assistant(2_110, { finish: 'stop' }), ['the answer after it']);
      await w.tick();
      expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['the answer after it']);
    });
  });

  describe('a launch whose terminal is gone (16)', () => {
    it('is no longer read, and only its own terminal forgets it', async () => {
      const old = {};
      const current = {};
      const w = watch();
      w.noteLaunch(AGENT, project, { terminal: old });
      w.noteLaunch(AGENT, project, { terminal: current });
      w.forgetTerminal(old);
      expect(w.watching).toBe(true);
      w.forgetTerminal(current);
      expect(w.watching).toBe(false);
      session(SES, project, 2_000);
      message(SES, 2_001, user(2_001), [identity(AGENT)]);
      await w.tick();
      expect(posts).toEqual([]);
    });
  });
});
