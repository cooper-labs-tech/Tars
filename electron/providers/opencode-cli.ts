import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

/**
 * Where opencode keeps its sessions, and how Tars names them: below the providers and the services, so the resume
 * check (utils/resume-session.ts), the provider and the session reader (services/opencode-sessions.ts) share it.
 * Measured on opencode 1.19.6 (20/11/2026): one SQLite database, `$XDG_DATA_HOME/opencode/opencode.db`, else
 * `~/.local/share/opencode/opencode.db`; a session is a `session` row, `ses_` and base62, with its `directory`.
 */

/**
 * The line opencode's prompt begins with when the agent has skills (opencode-provider.ts writes it), and its pattern at a
 * text's start: the same for every agent with the same skills, so the session reader reads past it (services/
 * opencode-sessions.ts, the Audit's M2 on #613).
 */
export function opencodeSkillsLine(skills: readonly string[]): string {
  return `[IMPORTANT: Use these skills for this session: ${skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.]`;
}
export const OPENCODE_SKILLS_LINE = String.raw`\[IMPORTANT: Use these skills for this session: [^\]
]*\]`;

/** A session id as opencode writes it: the only form that reaches a command line. */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;

/** opencode's database, under its data folder (`name`: another build of opencode, such as Kilo, keeps its own). */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir(), name = 'opencode'): string {
  const data = env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
  return path.join(data, name, `${name}.db`);
}

/**
 * The UUID Tars knows an opencode session by: the hook routes take a UUID and nothing else (hooks-routes.ts,
 * SESSION_ID_SHAPE), and opencode's ids are not one. Made from the id, the same every time (a version 8 UUID of its
 * SHA-256). Null for anything but an opencode id.
 */
export function opencodeUuidOf(sessionId: string): string | null {
  if (!OPENCODE_SESSION_ID.test(sessionId)) return null;
  const h = createHash('sha256').update(`opencode-session:${sessionId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * What a launch says of its session: the one it resumes (`--session '<id>'`), or the one it forks (`--session '<id>'
 * --fork`: a restart's, which opencode 1.19.6 goes on with under a new id, measured), and the prompt it starts on
 * (`--prompt '<text>'`), unquoted as the shell would. From the line typed into a terminal (quoted words), or the
 * arguments a terminal runs (an exec launch, every terminal on Windows), each its own word.
 */
export interface OpencodeLaunchFrom { resume?: string; forkOf?: string; prompt?: string }

export function opencodeLaunchOf(line: string | readonly string[] | undefined): OpencodeLaunchFrom {
  const out: OpencodeLaunchFrom = {};
  let session: string | undefined;
  let fork = false;
  // A shell's `-c '<line>'` holds the whole line in one word: read as a line.
  if (Array.isArray(line) && !['--session', '--fork', '--prompt'].some((flag) => line.includes(flag))) return opencodeLaunchOf(line.join(' '));
  if (Array.isArray(line)) {
    const at = line.indexOf('--session');
    session = at >= 0 ? line[at + 1] : undefined;
    fork = line.includes('--fork');
    const p = line.indexOf('--prompt');
    if (p >= 0 && typeof line[p + 1] === 'string') out.prompt = line[p + 1];
  } else {
    const text = typeof line === 'string' ? line : '';
    const m = /--session '?(ses_[A-Za-z0-9]+)'?( --fork)?/.exec(text);
    session = m?.[1];
    fork = !!m?.[2];
    const p = /--prompt '((?:[^']|'\\'')*)'/.exec(text);
    if (p) out.prompt = p[1].replace(/'\\''/g, "'");
  }
  if (session && OPENCODE_SESSION_ID.test(session)) {
    if (fork) out.forkOf = session;
    else out.resume = session;
  }
  return out;
}

/** The session a launch line resumes (`--session '<id>'` without `--fork`), or undefined. */
export function opencodeSessionOfCommand(line: string | readonly string[] | undefined): string | undefined {
  return opencodeLaunchOf(line).resume;
}

const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sameDir = (a: string, b: string): boolean => {
  const ra = realOf(a);
  const rb = realOf(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};

/**
 * opencode's id of the session Tars knows by `uuid`, when the database still has it in one of `folders`; null
 * otherwise, and when the database cannot be read. Opened read only: opencode may be writing it.
 */
export function opencodeSessionOf(uuid: string, folders: string[], dbPath = opencodeDbPath()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT id, directory FROM session').all() as Array<{ id: unknown; directory: unknown }>;
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.directory !== 'string') continue;
      if (opencodeUuidOf(row.id) === uuid && folders.some((f) => sameDir(f, row.directory as string))) return row.id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
