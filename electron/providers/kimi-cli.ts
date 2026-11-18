import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where Kimi Code keeps its data, and whether it still has a session: below the providers and the services, so the
 * resume check (utils/resume-session.ts), the provider and the session reader (services/kimi-sessions.ts) share it.
 * Measured on kimi-code 2.6.3 (docs/en/configuration/data-locations.md): `$KIMI_CODE_HOME`, else `~/.kimi-code`;
 * every session listed in `session_index.jsonl` as `{sessionId, sessionDir, workDir}`.
 */

/** A session id as kimi writes it, the only form that reaches a command line. */
export const KIMI_SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function kimiHome(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  return env.KIMI_CODE_HOME || path.join(homeDir, '.kimi-code');
}

/** The session's folder when kimi lists it and its main wire is still on disk; null otherwise. */
export function kimiSessionDir(sessionId: string, home = kimiHome()): string | null {
  if (!KIMI_SESSION_ID.test(sessionId)) return null;
  let text: string;
  try { text = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.includes(sessionId)) continue;
    try {
      const e = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown };
      if (e.sessionId === sessionId && typeof e.sessionDir === 'string' && fs.existsSync(path.join(e.sessionDir, 'agents', 'main', 'wire.jsonl'))) return e.sessionDir;
    } catch { /* a line being written */ }
  }
  return null;
}
