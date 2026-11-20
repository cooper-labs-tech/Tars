import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { HookPost } from './codex-sessions';
import { reportOf } from './terminal-answer';
import { opencodeDbPath, opencodeUuidOf } from '../providers/opencode-cli';

export type { HookPost };

/**
 * opencode's turns, read from the database its TUI writes and told to Tars the way Claude Code's hooks tell it, as
 * codex's, pi's and Kimi Code's are (codex-sessions.ts, pi-sessions.ts, kimi-sessions.ts): so delegate_task,
 * task_status and get_agent_output work on an opencode agent, with its tokens.
 *
 * Measured on opencode 1.19.6 (20/11/2026, its TUI in a PTY against a loopback endpoint): one SQLite database (WAL),
 * `$XDG_DATA_HOME/opencode/opencode.db`. A `session` row (`ses_<base62>`, its `directory`) is written at the session's
 * first prompt. Each message is a `message` row whose `data` holds `role`, `time.created` and, once done,
 * `time.completed`; an assistant's `finish` (`tool-calls` for a step that asked for a tool, `stop` at the turn's end),
 * its `tokens` (input without the cache, output, reasoning, cache read and write) and `modelID`, or an `error`
 * (`MessageAbortedError` after an Esc, `APIError` with its message when the endpoint failed). The texts are `part` rows
 * of `type: 'text'`.
 *
 * Whose session is whose is decided on evidence, never on the folder alone (the user's own opencode writes the same
 * database): a session made in the agent's folder since the launch whose first prompt carries the agent's identity
 * line ("[Tars: you are agent ... (id <agent id>)"), or, with none, a text Tars typed into this agent's terminal and
 * into no other's; a session the launch resumed (`--session <id>`) by its id, read from the launch on. Posted under the
 * UUID made from opencode's id (providers/opencode-cli.ts): the hook routes take nothing else.
 * opencode-sessions.test.ts says each way this goes wrong.
 */

export interface OpencodeSessionWatchDeps {
  /** The database (production: opencodeDbPath). */
  dbPath: () => string;
  now: () => number;
  /** Posts as the agent's terminal (production: its own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
  /** Told a turn was interrupted, before the rest is posted (production: task-watch.ts, turnInterrupted). */
  interrupted?: (agentId: string, sessionId: string) => void;
}

interface Turn { texts: string[]; usage?: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number } }
interface Bound {
  sessionId: string;
  resumed: boolean;
  registered: boolean;
  /** Messages already read: those before the launch for a resumed session, and each one once posted. */
  done: Set<string>;
  turn?: Turn;
}
interface Launch {
  cwd: string;
  at: number;
  resume?: string;
  /** What Tars typed into the agent's terminal since the launch, whitespace folded, for a session's first prompt. */
  typed: string[];
  bound?: Bound;
}
type Row = { id: string; time_created: number; data: string };

const IDENTITY = /\[Tars: you are agent ".*?" \(id ([0-9a-zA-Z-]{4,})\)/;
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();
const TYPED_HEAD = 200;
const TYPED_MIN = 16;
const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sameDir = (a: string, b: string): boolean => {
  const ra = realOf(a);
  const rb = realOf(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};

export class OpencodeSessionWatch {
  private launches = new Map<string, Launch>();

  constructor(private deps: OpencodeSessionWatchDeps) {}

  setDeps(deps: Partial<OpencodeSessionWatchDeps>): void {
    Object.assign(this.deps, deps);
  }

  /** An opencode terminal was spawned for the agent in `cwd`, resuming opencode's session `resume` when given. */
  noteLaunch(agentId: string, cwd: string, resume?: string): void {
    this.launches.set(agentId, { cwd, at: this.deps.now(), resume, typed: [] });
  }

  /** Tars typed `text` into the agent's terminal: a session whose first prompt holds it, and no other's, is the agent's. */
  noteTyped(agentId: string, text: string): void {
    const launch = this.launches.get(agentId);
    const folded = fold(text).slice(0, TYPED_HEAD);
    if (!launch || launch.bound || folded.length < TYPED_MIN) return;
    launch.typed.push(folded);
    if (launch.typed.length > 20) launch.typed.shift();
  }

  get watching(): boolean {
    return this.launches.size > 0;
  }

  async tick(): Promise<void> {
    const file = this.deps.dbPath();
    if (!fs.existsSync(file)) return;
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const taken = new Set([...this.launches.values()].map((l) => l.bound?.sessionId).filter(Boolean) as string[]);
      for (const [agentId, launch] of this.launches) {
        if (!launch.bound) {
          const bound = this.bind(db, agentId, launch, taken);
          if (bound) { launch.bound = bound; taken.add(bound.sessionId); }
        }
        if (launch.bound) await this.follow(db, agentId, launch);
      }
    } catch (err) {
      // Not a database yet, locked for a moment, or written by an opencode of another shape: read at the next tick.
      if (!(err instanceof Error && /not a database|SQLITE_BUSY|no such table|file is not a database/i.test(err.message))) {
        console.warn('[opencode-sessions]', err instanceof Error ? err.message : err);
      }
    } finally {
      db?.close();
    }
  }

  private texts(db: Database.Database, messageId: string): string[] {
    const rows = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id').all(messageId) as Array<{ data: string }>;
    const out: string[] = [];
    for (const r of rows) {
      let p: Record<string, unknown> | undefined;
      try { p = asObj(JSON.parse(r.data)); } catch { continue; }
      if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
    }
    return out;
  }

  /** The first prompt of a session, once its text is written; null before. */
  private firstPrompt(db: Database.Database, sessionId: string): string | null {
    const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as Row[];
    for (const row of rows) {
      let data: Record<string, unknown> | undefined;
      try { data = asObj(JSON.parse(row.data)); } catch { continue; }
      if (data?.role !== 'user') continue;
      const text = this.texts(db, row.id).join('\n');
      return text || null;
    }
    return null;
  }

  private bind(db: Database.Database, agentId: string, launch: Launch, taken: Set<string>): Bound | undefined {
    const sessions = db.prepare('SELECT id, directory, time_created FROM session').all() as Array<{ id: string; directory: string; time_created: number }>;
    if (launch.resume) {
      const s = sessions.find((x) => x.id === launch.resume);
      if (!s) return undefined;
      const before = db.prepare('SELECT id FROM message WHERE session_id = ? AND time_created < ?').all(s.id, launch.at) as Array<{ id: string }>;
      return { sessionId: s.id, resumed: true, registered: false, done: new Set(before.map((r) => r.id)) };
    }
    const others = [...this.launches].filter(([id, l]) => id !== agentId && !l.bound).flatMap(([, l]) => l.typed);
    for (const s of sessions) {
      if (taken.has(s.id) || typeof s.directory !== 'string' || !(s.time_created >= launch.at) || !sameDir(s.directory, launch.cwd)) continue;
      const first = this.firstPrompt(db, s.id);
      if (first === null) continue;
      const named = IDENTITY.exec(first)?.[1];
      const ours = named
        ? named === agentId
        : launch.typed.some((t) => fold(first).includes(t) && !others.some((o) => fold(first).includes(o)));
      if (ours) return { sessionId: s.id, resumed: false, registered: false, done: new Set() };
    }
    return undefined;
  }

  private post(agentId: string, b: Bound, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(agentId, { path: route, body: { agent_id: agentId, session_id: opencodeUuidOf(b.sessionId) ?? b.sessionId, ...body } });
  }

  private async follow(db: Database.Database, agentId: string, launch: Launch): Promise<void> {
    const b = launch.bound!;
    if (!b.registered && !b.resumed) {
      b.registered = true;
      await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: 'startup' });
    }
    const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(b.sessionId) as Row[];
    for (const row of rows) {
      if (b.done.has(row.id)) continue;
      let data: Record<string, unknown> | undefined;
      try { data = asObj(JSON.parse(row.data)); } catch { return; }
      if (!data) return;
      if (!b.registered) {
        b.registered = true;
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: 'resume' });
      }
      if (data.role === 'user') {
        // Its text is written in its parts, a moment after the row: read again at the next tick until it is there.
        const text = this.texts(db, row.id).join('\n');
        if (!text) return;
        b.done.add(row.id);
        b.turn = { texts: [] };
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: text });
        continue;
      }
      if (data.role !== 'assistant') { b.done.add(row.id); continue; }
      const error = asObj(data.error);
      const completed = num(asObj(data.time)?.completed) > 0;
      if (!error && !completed) return;
      b.done.add(row.id);
      const turn = b.turn ?? (b.turn = { texts: [] });
      if (error) {
        b.turn = undefined;
        if (error.name === 'MessageAbortedError') {
          this.deps.interrupted?.(agentId, opencodeUuidOf(b.sessionId) ?? b.sessionId);
          await this.post(agentId, b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
        } else {
          const said = asObj(error.data)?.message;
          const message = typeof said === 'string' && said.trim() ? said.trim() : String(error.name ?? 'the turn failed');
          await this.post(agentId, b, '/api/hooks/status', { status: 'error', error_kind: 'opencode_turn_failed', error_message: message.slice(0, 2000) });
        }
        continue;
      }
      turn.texts.push(...this.texts(db, row.id));
      const tokens = asObj(data.tokens);
      if (tokens && typeof data.modelID === 'string' && data.modelID) {
        const u = turn.usage ?? (turn.usage = { model: data.modelID, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        u.input += num(tokens.input);
        // Reasoning is billed as output, as a Claude Code turn counts its thinking.
        u.output += num(tokens.output) + num(tokens.reasoning);
        u.cacheRead += num(asObj(tokens.cache)?.read);
        u.cacheWrite += num(asObj(tokens.cache)?.write);
      }
      // A step that asked for a tool goes on; any other finish ends the turn.
      if (data.finish === 'tool-calls') continue;
      b.turn = undefined;
      const answer = reportOf(turn.texts);
      if (answer) await this.post(agentId, b, '/api/hooks/output', { hook: 'Stop', output: answer });
      await this.post(agentId, b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
      await this.post(agentId, b, '/api/hooks/agent-stopped', { hook: 'Stop' });
      if (turn.usage) {
        const u = turn.usage;
        await this.post(agentId, b, '/api/hooks/turn-usage', {
          usage: { model: u.model, input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
        });
      }
    }
  }
}

/** The one watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const opencodeSessionWatch = new OpencodeSessionWatch({
  dbPath: () => opencodeDbPath(),
  now: () => Date.now(),
  post: async () => {},
});

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads the opencode agents' sessions every second while one is launched. */
export function startOpencodeSessionWatch(deps: Pick<OpencodeSessionWatchDeps, 'post' | 'interrupted'>): void {
  opencodeSessionWatch.setDeps(deps);
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy || !opencodeSessionWatch.watching) return;
    busy = true;
    opencodeSessionWatch.tick().catch((err) => console.warn('[opencode-sessions]', err instanceof Error ? err.message : err)).finally(() => { busy = false; });
  }, 1000);
  timer.unref?.();
}

export function stopOpencodeSessionWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
