import * as fs from 'fs';
import Database from 'better-sqlite3';
import type { HookPost } from './codex-sessions';
import { reportOf } from './terminal-answer';

export type { HookPost };

/**
 * A Hermes agent's turns, read from its profile's `state.db` and told to Tars the way Claude Code's hooks tell it, as
 * codex's (codex-sessions.ts) and pi's (pi-sessions.ts) are read from their session logs.
 *
 * Why not Hermes's own hooks (measured on 0.23.4, 27/11): a hook runs in the gateway every Hermes agent shares, with
 * its profile's HERMES_HOME but no token of its agent's, so it could only report to Tars by reading the profile's
 * `.env`, which would widen who touches the token. The main process reads instead, and posts as the agent's terminal
 * with the token it holds in memory.
 *
 * What Hermes writes: each profile has a `state.db` of its own (SQLite, WAL), one `messages` row per message as it
 * ends: `role` user, assistant or tool, an assistant's `finish_reason` `tool_calls` while the turn goes on and `stop`
 * (or `length`) at its end, its `content` the answer. `sessions.started_at` (seconds) tells a session begun before the
 * launch (resumed) from one begun after. Whose rows are whose needs no evidence: the database is the agent's profile's.
 * Read with a connection opened read only and closed at each tick, which never waits on Hermes's writer: a reader of
 * a WAL database sees the last commit. hermes-agent-turns.test.ts says each way this goes wrong.
 */

export interface HermesTurnWatchDeps {
  /** The agent's profile's database (production: <Tars's Hermes home>/profiles/<agent id>/state.db). */
  dbOf: (agentId: string) => string;
  now: () => number;
  /** Posts as the agent's terminal (production: its own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
}

interface Row { id: number; session_id: string; role: string; content: string | null; finish_reason: string | null; timestamp: number }

interface Launch {
  /** The last row read; null while the database could not be read since the launch. */
  lastId: number | null;
  /** The launch, in seconds, as Hermes writes its times. */
  launchedAt: number;
  sessionId?: string;
  turnOpen: boolean;
  /** What the agent wrote in the open turn, in order: its answer is the report among them (reportOf). */
  said: string[];
}

const MAX_ROWS = 1000;

export class HermesTurnWatch {
  private launches = new Map<string, Launch>();

  constructor(private deps: HermesTurnWatchDeps) {}

  setDeps(deps: Partial<HermesTurnWatchDeps>): void {
    Object.assign(this.deps, deps);
  }

  /** A Hermes terminal was spawned for the agent: what its profile holds now is from before. */
  noteLaunch(agentId: string): void {
    const read = this.read(agentId, (db) => (db.prepare('SELECT max(id) AS id FROM messages').get() as { id: number | null }).id ?? 0);
    this.launches.set(agentId, { lastId: read === undefined && fs.existsSync(this.deps.dbOf(agentId)) ? null : (read ?? 0), launchedAt: this.deps.now() / 1000, turnOpen: false, said: [] });
  }

  forget(agentId: string): void {
    this.launches.delete(agentId);
  }

  get watching(): boolean {
    return this.launches.size > 0;
  }

  async tick(): Promise<void> {
    for (const [agentId, launch] of this.launches) await this.step(agentId, launch);
  }

  /** `query` on the agent's database, opened read only; undefined when there is none or it cannot be read now. */
  private read<T>(agentId: string, query: (db: Database.Database) => T): T | undefined {
    const file = this.deps.dbOf(agentId);
    if (!fs.existsSync(file)) return undefined;
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
      return query(db);
    } catch {
      return undefined;
    } finally {
      db?.close();
    }
  }

  private async step(agentId: string, launch: Launch): Promise<void> {
    const read = this.read(agentId, (db) => {
      // A launch whose database could not be read: only what was written since the launch is the agent's now.
      const rows = (launch.lastId === null
        ? db.prepare('SELECT id, session_id, role, content, finish_reason, timestamp FROM messages WHERE timestamp >= ? ORDER BY id LIMIT ?').all(launch.launchedAt, MAX_ROWS)
        : db.prepare('SELECT id, session_id, role, content, finish_reason, timestamp FROM messages WHERE id > ? ORDER BY id LIMIT ?').all(launch.lastId, MAX_ROWS)) as Row[];
      const started = new Map<string, number | null>();
      const startedAt = db.prepare('SELECT started_at FROM sessions WHERE id = ?');
      for (const id of new Set(rows.map(r => r.session_id))) {
        started.set(id, (startedAt.get(id) as { started_at: number } | undefined)?.started_at ?? null);
      }
      return { rows, started };
    });
    if (!read) return;
    for (const row of read.rows) {
      launch.lastId = row.id;
      await this.follow(agentId, launch, row, read.started.get(row.session_id) ?? null);
    }
  }

  private post(agentId: string, session: string, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(agentId, { path: route, body: { agent_id: agentId, session_id: session, ...body } });
  }

  private async follow(agentId: string, l: Launch, row: Row, startedAt: number | null): Promise<void> {
    const s = row.session_id;
    if (s !== l.sessionId) {
      // A session written to for the first time since the launch: the agent's now (Hermes's --resume, or /new).
      l.sessionId = s;
      l.turnOpen = false;
      l.said = [];
      await this.post(agentId, s, '/api/hooks/status', { status: 'running', source: startedAt !== null && startedAt < l.launchedAt ? 'resume' : 'startup' });
    }
    if (row.role === 'user') {
      l.turnOpen = true;
      l.said = [];
      await this.post(agentId, s, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: row.content ?? '' });
      return;
    }
    if (row.role !== 'assistant' || !l.turnOpen) return;
    if (row.content) l.said.push(row.content);
    const end = row.finish_reason;
    if (!end || end === 'tool_calls') return;
    l.turnOpen = false;
    const answer = end === 'stop' || end === 'length' ? reportOf(l.said) ?? (row.content || null) : null;
    l.said = [];
    if (answer) await this.post(agentId, s, '/api/hooks/output', { hook: 'Stop', output: answer });
    await this.post(agentId, s, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
    if (answer) await this.post(agentId, s, '/api/hooks/agent-stopped', { hook: 'Stop' });
  }
}

/** The one watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const hermesTurnWatch = new HermesTurnWatch({
  dbOf: () => '',
  now: () => Date.now(),
  post: async () => {},
});

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads the Hermes agents' sessions every second while one is launched. */
export function startHermesTurnWatch(deps: Pick<HermesTurnWatchDeps, 'dbOf' | 'post'>): void {
  hermesTurnWatch.setDeps(deps);
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy || !hermesTurnWatch.watching) return;
    busy = true;
    hermesTurnWatch.tick().catch((err) => console.warn('[hermes-agent-turns]', err instanceof Error ? err.message : err)).finally(() => { busy = false; });
  }, 1000);
  timer.unref?.();
}

export function stopHermesTurnWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
