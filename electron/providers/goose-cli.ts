import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

/**
 * Where Goose keeps its sessions, and how Tars names them: below the providers and the services, so the resume check
 * (utils/resume-session.ts), the provider and the session reader (services/goose-sessions.ts) share it. Measured on
 * Goose 1.60.1 (20/11/2026): one SQLite database, `$XDG_DATA_HOME/goose/sessions/sessions.db`, else
 * `~/.local/share/goose/sessions/sessions.db` (macOS included), and `$GOOSE_PATH_ROOT/data/sessions/sessions.db` when
 * that is set, whatever XDG_DATA_HOME says; a session is a `sessions` row, `YYYYMMDD_N`, with its `working_dir`.
 */

/** GOOSE_PATH_ROOT, which moves every folder of Goose's under it (`config`, `data`, `state`), or undefined. */
export const goosePathRoot = (env: NodeJS.ProcessEnv = process.env): string | undefined => env.GOOSE_PATH_ROOT?.trim() || undefined;

/** A session id as Goose writes it: the only form that reaches a command line. */
export const GOOSE_SESSION_ID = /^\d{8}_\d{1,6}$/;

export function gooseDbPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const root = goosePathRoot(env);
  if (root) return path.join(root, 'data', 'sessions', 'sessions.db');
  const data = env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
  return path.join(data, 'goose', 'sessions', 'sessions.db');
}

/**
 * The UUID Tars knows a Goose session by: the hook routes take a UUID and nothing else (hooks-routes.ts,
 * SESSION_ID_SHAPE). Made from the id, the same every time (a version 8 UUID of its SHA-256). Null for anything else.
 */
export function gooseUuidOf(sessionId: string): string | null {
  if (!GOOSE_SESSION_ID.test(sessionId)) return null;
  const h = createHash('sha256').update(`goose-session:${sessionId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What a launch says of its session: the one it resumes (`--resume --session-id <id>`), or forks (`... --fork`). */
export interface GooseLaunchFrom { resume?: string; forkOf?: string }

export function gooseLaunchOf(line: string | readonly string[] | undefined): GooseLaunchFrom {
  let session: string | undefined;
  let fork = false;
  if (Array.isArray(line) && line.includes('--session-id')) {
    session = line[line.indexOf('--session-id') + 1];
    fork = line.includes('--fork');
  } else {
    const text = Array.isArray(line) ? line.join(' ') : typeof line === 'string' ? line : '';
    const m = /--resume --session-id '?(\d{8}_\d{1,6})'?( --fork)?/.exec(text);
    session = m?.[1];
    fork = !!m?.[2];
  }
  if (!session || !GOOSE_SESSION_ID.test(session)) return {};
  return fork ? { forkOf: session } : { resume: session };
}

const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sameDir = (a: string, b: string): boolean => {
  const ra = realOf(a);
  const rb = realOf(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};

/**
 * Goose's id of the session Tars knows by `uuid`, when the database still has it in one of `folders`; null otherwise,
 * and when the database cannot be read. Opened read only: Goose may be writing it.
 */
export function gooseSessionOf(uuid: string, folders: string[], dbPath = gooseDbPath()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT id, working_dir FROM sessions').all() as Array<{ id: unknown; working_dir: unknown }>;
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.working_dir !== 'string') continue;
      if (gooseUuidOf(row.id) === uuid && folders.some((f) => sameDir(f, row.working_dir as string))) return row.id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
