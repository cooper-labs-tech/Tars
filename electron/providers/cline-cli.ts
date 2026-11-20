import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { PRIVATE_DIR } from '../constants';

/**
 * Where a Cline agent keeps its own folders, where the user's Cline keeps theirs, and how Tars names Cline's sessions:
 * below the providers and the services, so the provider and the resume check (utils/resume-session.ts) share it.
 *
 * Measured on Cline 3.0.74 (20-21/11/2026) and read in its build: its root folder is `--config`, else CLINE_DIR, else
 * `<home>/.cline`, home being HOME, else USERPROFILE, else HOMEDRIVE+HOMEPATH (the same on macOS, Linux and Windows);
 * its data `--data-dir`, else CLINE_DATA_DIR, else `<root>/data`, with `settings/providers.json` (the provider its TUI
 * reads, from there only), `settings/cline_mcp_settings.json`, `sessions/<id>/` and `db/sessions.db`. A Tars agent
 * runs Cline on a folder of its own for both, under ~/.tars-private (its provider may hold the user's key), so the
 * user's own ~/.cline is never written.
 */

/** A Cline session id, `<ms>_<5 chars>`: the only form that reaches a command line. */
export const CLINE_SESSION_ID = /^\d{10,16}_[a-z0-9]{5}$/;

/** The UUID Tars knows a Cline session by: hooks/cline-hook.mjs posts under the same one. Null for anything else. */
export function clineUuidOf(sessionId: string): string | null {
  if (!CLINE_SESSION_ID.test(sessionId)) return null;
  const h = createHash('sha256').update(`cline-session:${sessionId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The agent's own Cline folder: its --config (hooks) and, under `data`, its --data-dir. */
export function clineAgentDir(agentId: string, privateDir = PRIVATE_DIR): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(agentId)) throw new Error(`Not an agent id for a Cline folder: ${JSON.stringify(agentId)}`);
  return path.join(privateDir, 'cline', agentId);
}

/** The user's own Cline data folder, as Cline finds it: read, never written. */
export function clineUserDataDir(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const data = env.CLINE_DATA_DIR?.trim();
  if (data) return data;
  const root = env.CLINE_DIR?.trim();
  if (root) return path.join(root, 'data');
  const home = env.HOME?.trim() && env.HOME.trim() !== '~' ? env.HOME.trim()
    : env.USERPROFILE?.trim() || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : homeDir);
  return path.join(home, '.cline', 'data');
}

const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sameDir = (a: string, b: string): boolean => {
  const ra = realOf(a);
  const rb = realOf(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};

/**
 * Cline's id of the session Tars knows by `uuid`, when the agent's own sessions.db still has it in one of `folders`;
 * null otherwise, and when the database cannot be read. Opened read only: Cline may be writing it.
 */
export function clineSessionOf(uuid: string, folders: string[], agentId: string, privateDir = PRIVATE_DIR): string | null {
  const file = path.join(clineAgentDir(agentId, privateDir), 'data', 'db', 'sessions.db');
  if (!fs.existsSync(file)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT session_id, cwd FROM sessions').all() as Array<{ session_id: unknown; cwd: unknown }>;
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || typeof row.cwd !== 'string') continue;
      if (clineUuidOf(row.session_id) === uuid && folders.some((f) => sameDir(f, row.cwd as string))) return row.session_id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
