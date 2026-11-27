import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { HermesTurnWatch, type HookPost } from '../../../electron/services/hermes-agent-turns';

/**
 * A Hermes agent's turns, read from its profile's `state.db` and told to Tars the way Claude Code's hooks tell it.
 * Measured on Hermes Agent 0.23.4 (27/11): each profile has a `state.db` of its own (SQLite, WAL), one `messages` row per
 * message as it ends (`role` user, assistant or tool; an assistant's `finish_reason` `tool_calls` while the turn goes
 * on, `stop` at its end, with the answer as its `content`), and a hook in a profile's turn has no token of its agent's,
 * so it cannot be the way Tars hears of it. The fixture is two sessions Hermes itself wrote in a profile, through a
 * stand-in endpoint (scrubbed of paths and of its system prompt): __tests__/fixtures/hermes-agent/profile-state.sql.
 *
 * How it fails, written before the code (27/11):
 * 1. Rows from before the launch are posted: a profile's history replayed as turns of the new terminal.
 * 2. A tool call's assistant row (finish_reason tool_calls) ends the turn before the turn ends.
 * 3. The answer posted is a tool's output, or nothing, or it is posted twice because rows are read twice.
 * 4. Another agent's turns are posted as this one's: each agent reads its own profile's database, and nothing else.
 * 5. A database not there yet (Hermes still setting up), or being written while Tars reads (WAL, a writer open), throws
 *    out of the watch or blocks Hermes.
 * 6. The session is registered with the wrong source: one begun after the launch is a start, one begun before it and
 *    written to again is a resume.
 * 7. A new session in the same terminal (Hermes's /new) is not followed.
 */

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'hermes-agent', 'profile-state.sql'), 'utf8');
const [S1, S2] = [...FIXTURE.matchAll(/INSERT INTO sessions VALUES\('(local-[0-9a-f]+)'/g)].map(m => m[1]);

let tmp: string;
let posts: Array<{ agent: string } & HookPost>;
let clock: number;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sessions-'));
  posts = [];
  clock = 1_795_725_900_000;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dbOf = (agent: string) => path.join(tmp, agent, 'state.db');
const watch = () => new HermesTurnWatch({ dbOf, now: () => clock, post: async (agent, p) => { posts.push({ agent, ...p }); } });

/** A profile's database with Hermes's schema, in WAL as Hermes keeps it, and the writer left open as Hermes does. */
function profileDb(agent: string): Database.Database {
  fs.mkdirSync(path.dirname(dbOf(agent)), { recursive: true });
  const db = new Database(dbOf(agent));
  db.pragma('journal_mode = WAL');
  db.exec(FIXTURE.split('\n').filter(l => !l.startsWith('INSERT')).join('\n'));
  return db;
}
/** The fixture's rows for one session, as Hermes inserted them, the messages from `fromId` on. */
function insert(db: Database.Database, session: string, { messagesFrom = 0, messagesTo = 99, renumber = false } = {}): void {
  for (const raw of FIXTURE.split('\n')) {
    // Numbered by the database, as Hermes's rows are (AUTOINCREMENT), after whatever it holds already.
    const line = renumber ? raw.replace(/^INSERT INTO messages VALUES\((\d+),/, 'INSERT INTO messages VALUES(NULL,') : raw;
    if (line.startsWith(`INSERT INTO sessions VALUES('${session}'`) && messagesFrom <= 1) db.exec(line);
    const m = /^INSERT INTO messages VALUES\((\d+),'(local-[0-9a-f]+)'/.exec(raw);
    if (m && m[2] === session) {
      const order = [...FIXTURE.matchAll(new RegExp(`INSERT INTO messages VALUES\\((\\d+),'${session}'`, 'g'))].map(x => Number(x[1]));
      const n = order.indexOf(Number(m[1])) + 1;
      if (n >= messagesFrom && n <= messagesTo) db.exec(line);
    }
  }
}
const bodies = () => posts.map(p => ({ agent: p.agent, path: p.path, ...p.body }));

describe('a turn', () => {
  it('2 and 3: the user row starts it, a tool call does not end it, the stop row ends it with its answer, once', async () => {
    const db = profileDb('a');
    const w = watch();
    w.noteLaunch('a');
    insert(db, S1, { messagesTo: 3 });
    await w.tick();
    expect(bodies()).toEqual([
      { agent: 'a', path: '/api/hooks/status', agent_id: 'a', session_id: S1, status: 'running', source: 'startup' },
      { agent: 'a', path: '/api/hooks/status', agent_id: 'a', session_id: S1, status: 'running', event: 'UserPromptSubmit', current_task: expect.stringContaining('Use your shell tool') },
    ]);
    insert(db, S1, { messagesFrom: 4 });
    await w.tick();
    await w.tick();
    expect(bodies().slice(2)).toEqual([
      { agent: 'a', path: '/api/hooks/output', agent_id: 'a', session_id: S1, hook: 'Stop', output: 'PROBE-OK TARS-PROBE-4dd7b05f' },
      { agent: 'a', path: '/api/hooks/status', agent_id: 'a', session_id: S1, hook: 'Stop', status: 'idle' },
      { agent: 'a', path: '/api/hooks/agent-stopped', agent_id: 'a', session_id: S1, hook: 'Stop' },
    ]);
    db.close();
  });

  it('1: what the profile held before the launch is not posted', async () => {
    const db = profileDb('a');
    insert(db, S1);
    const w = watch();
    w.noteLaunch('a');
    await w.tick();
    expect(posts).toEqual([]);
    db.close();
  });

  it('6 and 7: a session begun before the launch is a resume; a new one in the same terminal is followed as a start', async () => {
    const db = profileDb('a');
    insert(db, S1, { messagesTo: 4 });
    clock = 1_795_725_970_000; // after S1 began, before S2
    const w = watch();
    w.noteLaunch('a');
    // Hermes's --resume of S1 writes to it again: its next turn's rows, numbered after the launch.
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'again', ?)").run(S1, 1795725971);
    db.prepare("INSERT INTO messages (session_id, role, content, finish_reason, timestamp) VALUES (?, 'assistant', 'done again', 'stop', ?)").run(S1, 1795725972);
    await w.tick();
    expect(bodies()[0]).toMatchObject({ session_id: S1, status: 'running', source: 'resume' });
    expect(bodies().find(b => b.path === '/api/hooks/output')).toMatchObject({ session_id: S1, output: 'done again' });
    posts = [];
    insert(db, S2, { renumber: true });
    await w.tick();
    expect(bodies()[0]).toMatchObject({ session_id: S2, status: 'running', source: 'startup' });
    expect(bodies().filter(b => b.path === '/api/hooks/output')).toEqual([expect.objectContaining({ session_id: S2, output: 'PROBE-OK TARS-PROBE-4dd7b05f' })]);
    db.close();
  });
});

describe('two agents', () => {
  it('4: each reads its own profile only', async () => {
    const a = profileDb('a');
    const b = profileDb('b');
    const w = watch();
    w.noteLaunch('a');
    w.noteLaunch('b');
    insert(b, S2);
    await w.tick();
    expect(new Set(posts.map(p => p.agent))).toEqual(new Set(['b']));
    expect(posts.every(p => p.body.agent_id === 'b' && p.body.session_id === S2)).toBe(true);
    a.close();
    b.close();
  });
});

describe('the database', () => {
  it('5: not there yet, then there: nothing thrown, then followed from its first row', async () => {
    const w = watch();
    w.noteLaunch('a');
    await expect(w.tick()).resolves.toBeUndefined();
    expect(posts).toEqual([]);
    const db = profileDb('a');
    insert(db, S1);
    await w.tick();
    expect(bodies().map(b => b.path)).toEqual(['/api/hooks/status', '/api/hooks/status', '/api/hooks/output', '/api/hooks/status', '/api/hooks/agent-stopped']);
    db.close();
  });

  it('5: read while Hermes holds a write transaction open, without waiting on it or throwing', async () => {
    const db = profileDb('a');
    const w = watch();
    w.noteLaunch('a');
    db.exec('BEGIN IMMEDIATE');
    insert(db, S1);
    const started = Date.now();
    await w.tick();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(posts).toEqual([]);
    db.exec('COMMIT');
    await w.tick();
    expect(posts.length).toBe(5);
    db.close();
  });

  it('5: a file that is not a database is skipped', async () => {
    fs.mkdirSync(path.join(tmp, 'a'), { recursive: true });
    fs.writeFileSync(dbOf('a'), 'not sqlite');
    const w = watch();
    w.noteLaunch('a');
    await expect(w.tick()).resolves.toBeUndefined();
    expect(posts).toEqual([]);
  });
});
