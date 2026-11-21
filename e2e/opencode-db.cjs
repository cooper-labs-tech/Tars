// opencode's own database, as a stand-in writes it: since #613, Tars reads an opencode agent's turns, its answer and
// its tokens there (electron/services/opencode-sessions.ts), so a stand-in that writes nothing is never seen to begin a
// turn ("its turn has not begun yet"). Measured on opencode 1.19.6 (electron/providers/opencode-cli.ts, and the rows of
// __tests__/electron/opencode-sessions.test.ts):
// - one SQLite file, `$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db`;
// - a `session` row (`ses_` and base62, its `directory`) written at the session's first prompt;
// - each message a `message` row whose `data` holds `role` and `time.created`; an assistant's also `time.completed`,
//   `finish` (`stop` at the turn's end), `tokens` and `modelID`; its text in `part` rows of type `text`.
// One session per stand-in process, in the folder it runs in. CommonJS, so that the specs' inline stand-ins (run by
// node from a file of their own) can require it by its path, and e2e/fake-clis.mjs import it.
// Node's own modules through process.getBuiltinModule, as e2e/cli-homes.mjs takes them.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
const crypto = process.getBuiltinModule('node:crypto');

// node:sqlite says once that it is experimental; the stand-in's terminal is Tars's screen, so not there.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => (String(warning).includes('SQLite') ? undefined : emitWarning.call(process, warning, ...rest));
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const DDL = `
CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
  directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer,
  summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text,
  agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const idOf = (prefix) => prefix + Array.from(crypto.randomBytes(26), (b) => BASE62[b % 62]).join('');

function dbPath(env = process.env) {
  const data = (env.XDG_DATA_HOME || '').trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'opencode', 'opencode.db');
}

let db;
let sessionId;
function open() {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(DDL);
  return db;
}

function message(data, text, at) {
  const d = open();
  const id = idOf('msg_');
  d.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, at, at, JSON.stringify(data));
  if (text) d.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(idOf('prt_'), id, sessionId, at, at, JSON.stringify({ type: 'text', text }));
  return id;
}

/** A turn begins: the session written at its first prompt, in this folder, then the user's message. */
function beginTurn(prompt, { cwd = process.cwd() } = {}) {
  const at = Date.now();
  if (!sessionId) {
    sessionId = idOf('ses_');
    open().prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'stand-in', 'stand-in', ?, 'stand-in', '1.19.6', ?, ?)")
      .run(sessionId, cwd, at, at);
  }
  message({ role: 'user', time: { created: at } }, prompt, at);
}

/** The turn ends: the assistant's answer, its tokens and model, and `finish: stop`. */
function endTurn(answer, { model = 'stand-in-coder' } = {}) {
  const at = Date.now();
  message({ role: 'assistant', time: { created: at, completed: at }, finish: 'stop', modelID: model, providerID: 'stand-in',
    tokens: { input: 12, output: 7, reasoning: 0, cache: { read: 0, write: 0 } } }, answer, at);
}

module.exports = { dbPath, beginTurn, endTurn };
