import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

/**
 * Where Goose keeps its sessions, and how Tars names them: below the providers and the services, so the resume check
 * (utils/resume-session.ts), the provider and the session reader (services/goose-sessions.ts) share it.
 *
 * Its folders (Goose 1.60.1, `crates/goose/src/config/paths.rs`, and the `etcetera` 0.11 crate it chooses them with):
 * - `$GOOSE_PATH_ROOT/{config,data}` when GOOSE_PATH_ROOT is an absolute path, on every system (a relative one is
 *   ignored); measured on macOS: `$GOOSE_PATH_ROOT/data/sessions/sessions.db`, XDG_DATA_HOME set or not, and an empty
 *   GOOSE_PATH_ROOT read as unset;
 * - else, on macOS and Linux, `$XDG_DATA_HOME/goose` (else `~/.local/share/goose`) and `$XDG_CONFIG_HOME/goose` (else
 *   `~/.config/goose`), measured on macOS;
 * - else, on Windows, `%APPDATA%\Block\goose\data` and `...\config` (else the home's `AppData\Roaming`), and no XDG
 *   variable read: from Goose's and etcetera's source, not measured on Windows.
 * Its sessions are `<data>/sessions/sessions.db` (SQLite); a session is a `sessions` row, `YYYYMMDD_N`, with its
 * `working_dir`.
 */

type Platform = NodeJS.Platform;
const pathsOf = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** GOOSE_PATH_ROOT, which moves every folder of Goose's under it (`config`, `data`, `state`), when absolute; or undefined. */
export function goosePathRoot(env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): string | undefined {
  const root = env.GOOSE_PATH_ROOT?.trim();
  return root && pathsOf(platform).isAbsolute(root) ? root : undefined;
}

/** Goose's own folder for `kind` on Windows: `%APPDATA%\Block\goose\<kind>`, else under the home's AppData\Roaming. */
const windowsDir = (env: NodeJS.ProcessEnv, homeDir: string, kind: 'config' | 'data'): string =>
  path.win32.join(env.APPDATA?.trim() || path.win32.join(homeDir, 'AppData', 'Roaming'), 'Block', 'goose', kind);

/** Where Goose reads its config (its config.yaml). */
export function gooseConfigDir(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir(), platform: Platform = process.platform): string {
  const root = goosePathRoot(env, platform);
  if (root) return pathsOf(platform).join(root, 'config');
  if (platform === 'win32') return windowsDir(env, homeDir, 'config');
  return path.posix.join(env.XDG_CONFIG_HOME?.trim() || path.posix.join(homeDir, '.config'), 'goose');
}

/**
 * The line a launch types before the task when the agent has skills (goose-provider.ts, typedTask), and its pattern:
 * the same for every agent with the same skills, so the session reader reads past it (services/goose-sessions.ts, the
 * Audit's M1 on #618, as #613's M2 for opencode).
 */
export function gooseSkillsLine(skills: readonly string[]): string {
  return `[IMPORTANT: Use these skills for this session: ${skills.join(', ')}. Invoke them when relevant to the task.]`;
}
export const GOOSE_SKILLS_LINE = String.raw`\[IMPORTANT: Use these skills for this session: [^\]\n]*\]`;

/** A session id as Goose writes it: the only form that reaches a command line. */
export const GOOSE_SESSION_ID = /^\d{8}_\d{1,6}$/;

export function gooseDbPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir(), platform: Platform = process.platform): string {
  const root = goosePathRoot(env, platform);
  if (root) return pathsOf(platform).join(root, 'data', 'sessions', 'sessions.db');
  if (platform === 'win32') return path.win32.join(windowsDir(env, homeDir, 'data'), 'sessions', 'sessions.db');
  const data = env.XDG_DATA_HOME?.trim() || path.posix.join(homeDir, '.local', 'share');
  return path.posix.join(data, 'goose', 'sessions', 'sessions.db');
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

/** A stdio server a Goose session was started with, as it saved it. */
export interface GooseSavedServer { name: string; cmd: string; args: string[] }

/**
 * The stdio servers the session `sessionId` was started with, which Goose starts again on every resume or fork of it
 * (`extension_data`, `enabled_extensions.v0`; measured on 1.60.1: nothing switches one off, neither --no-profile nor
 * Goose's own config). Null when it cannot be read: no database, no such session, or another shape.
 */
export function gooseSavedServers(sessionId: string, dbPath = gooseDbPath()): GooseSavedServer[] | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT extension_data FROM sessions WHERE id = ?').get(sessionId) as { extension_data?: unknown } | undefined;
    if (!row || typeof row.extension_data !== 'string') return null;
    const extensions = (JSON.parse(row.extension_data) as { 'enabled_extensions.v0'?: { extensions?: unknown } })['enabled_extensions.v0']?.extensions;
    if (!Array.isArray(extensions)) return null;
    return extensions.flatMap((e): GooseSavedServer[] => {
      const x = e as { type?: unknown; name?: unknown; cmd?: unknown; args?: unknown };
      if (x.type !== 'stdio' || typeof x.name !== 'string' || typeof x.cmd !== 'string') return [];
      return [{ name: x.name, cmd: x.cmd, args: Array.isArray(x.args) ? x.args.filter((a): a is string => typeof a === 'string') : [] }];
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
