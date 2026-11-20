import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { HookPost } from './codex-sessions';
import { reportOf } from './terminal-answer';
import { OPENCODE_SKILLS_LINE, opencodeDbPath, opencodeUuidOf, type OpencodeLaunchFrom } from '../providers/opencode-cli';

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
 * of `type: 'text'`. A fork (`--session <id> --fork`, every restart's) is a new `session` row made at the launch, with
 * no `parent_id`, and every message of the session it forks copied under a new id with its own `time_created`.
 *
 * Whose session is whose is decided on evidence, never on the folder alone (the user's own opencode writes the same
 * database), for a session made in the agent's folder since the launch and held by no other launch:
 * - Tars's identity lines in its first prompt all name this agent: at a line's start or right after opencode's skills
 *   line, where Tars writes them (a prompt naming two agents, a header pasted into a task, names nobody by itself);
 * - or, unless it holds a text another unbound launch was sent, it holds a text this terminal was sent (typed into it,
 *   or its launch's own `--prompt`, noted from after the skills line every such agent shares);
 * - or, for a fork, under the same condition, a copy of the forked session's first prompt (the same time and text).
 * A session the launch resumed (`--session <id>`) is bound by its id, read from the launch on, unless another launch
 * holds it. The messages from before the launch are history, never posted. Posted under the UUID made from opencode's
 * id (providers/opencode-cli.ts): the hook routes take nothing else. opencode-sessions.test.ts says each way this
 * goes wrong.
 *
 * What reading costs: a tick runs every second while a launch is noted (forgotten with its terminal), on the main
 * thread. For a bound session it reads the messages from the first one not yet done on, not the whole session.
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

/** What a launch said of its session (opencodeLaunchOf), and the terminal it runs in, which forgets it at its exit. */
export interface LaunchNote extends OpencodeLaunchFrom { terminal?: object }

interface Turn { texts: string[]; usage?: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number } }
interface Bound {
  sessionId: string;
  /** Registered at its first new message (a resumed session) rather than at once. */
  registerLater: boolean;
  registered: boolean;
  /** The messages done, by id, from `since` on: each read once. */
  done: Set<string>;
  /** Every message before this time is done (from the launch's on): the next read starts there. */
  since: number;
  turn?: Turn;
}
interface Launch {
  cwd: string;
  at: number;
  resume?: string;
  forkOf?: string;
  terminal?: object;
  /** What this terminal was sent since the launch (its prompt, what Tars typed), whitespace folded, for a first prompt. */
  typed: string[];
  bound?: Bound;
}
type Row = { id: string; time_created: number; data: string };

/**
 * Tars's identity line, at a line's start or right after opencode's skills line (which a launch's prompt begins with):
 * where Tars writes it, and never a header quoted inside a line.
 */
const IDENTITY = new RegExp(String.raw`^\s*(?:${OPENCODE_SKILLS_LINE}\s*)?\[Tars: you are agent ".*?" \(id ([0-9a-zA-Z-]{4,})\)`, 'gm');
/** opencode's skills line at a prompt's start: the same for every agent with the same skills, never what tells them apart. */
const SKILLS_FIRST = new RegExp(String.raw`^\s*${OPENCODE_SKILLS_LINE}\s*`);
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
const parse = (data: string): Record<string, unknown> | undefined => { try { return asObj(JSON.parse(data)); } catch { return undefined; } };

export class OpencodeSessionWatch {
  private launches = new Map<string, Launch>();

  constructor(private deps: OpencodeSessionWatchDeps) {}

  setDeps(deps: Partial<OpencodeSessionWatchDeps>): void {
    Object.assign(this.deps, deps);
  }

  /**
   * An opencode terminal was spawned for the agent in `cwd`, or opencode typed into one: `from` is what its line says
   * (opencodeLaunchOf; a string is the session it resumes), and the terminal it runs in.
   */
  noteLaunch(agentId: string, cwd: string, from: string | LaunchNote = {}): void {
    const note: LaunchNote = typeof from === 'string' ? { resume: from } : from;
    const launch: Launch = { cwd, at: this.deps.now(), resume: note.resume, forkOf: note.forkOf, terminal: note.terminal, typed: [] };
    this.launches.set(agentId, launch);
    // Noted from after the skills line, which would fill the head noted and be every such agent's (the Audit's M2).
    if (note.prompt) this.noteTyped(agentId, note.prompt.replace(SKILLS_FIRST, ''));
  }

  /** Tars typed `text` into the agent's terminal: a session whose first prompt holds it, and no other's, is the agent's. */
  noteTyped(agentId: string, text: string): void {
    const launch = this.launches.get(agentId);
    const folded = fold(text).slice(0, TYPED_HEAD);
    if (!launch || launch.bound || folded.length < TYPED_MIN) return;
    launch.typed.push(folded);
    if (launch.typed.length > 20) launch.typed.shift();
  }

  /** The terminal exited: its launch is no longer read. A newer launch of the same agent, in another terminal, stays. */
  forgetTerminal(terminal: object): void {
    for (const [agentId, launch] of this.launches) {
      if (launch.terminal === terminal) this.launches.delete(agentId);
    }
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
      const p = parse(r.data);
      if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
    }
    return out;
  }

  /** The first prompt of a session and its time, once its text is written; null before. */
  private firstPrompt(db: Database.Database, sessionId: string): { text: string; at: number } | null {
    const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as Row[];
    for (const row of rows) {
      if (parse(row.data)?.role !== 'user') continue;
      const text = this.texts(db, row.id).join('\n');
      return text ? { text, at: row.time_created } : null;
    }
    return null;
  }

  /**
   * A session bound to a launch, read from the launch's time on: every message before it is history (a resumed
   * session's turns, a fork's copies, which keep their own times), never read, whenever it is written.
   */
  private boundFrom(sessionId: string, at: number, registerLater: boolean): Bound {
    return { sessionId, registerLater, registered: false, done: new Set(), since: at };
  }

  private bind(db: Database.Database, agentId: string, launch: Launch, taken: Set<string>): Bound | undefined {
    const sessions = db.prepare('SELECT id, directory, time_created FROM session').all() as Array<{ id: string; directory: string; time_created: number }>;
    if (launch.resume) {
      // Held by another live launch: two agents would each get the other's turns (the Audit's L1 on #613).
      if (taken.has(launch.resume)) return undefined;
      const s = sessions.find((x) => x.id === launch.resume);
      return s ? this.boundFrom(s.id, launch.at, true) : undefined;
    }
    const others = [...this.launches].filter(([id, l]) => id !== agentId && !l.bound).flatMap(([, l]) => l.typed);
    const forked = launch.forkOf ? this.firstPrompt(db, launch.forkOf) : null;
    for (const s of sessions) {
      // Made since the launch: never the session a fork copies, which is older.
      if (taken.has(s.id) || typeof s.directory !== 'string' || !(s.time_created >= launch.at) || !sameDir(s.directory, launch.cwd)) continue;
      const first = this.firstPrompt(db, s.id);
      if (first === null) continue;
      const folded = fold(first.text);
      // Tars's identity lines, when they all name this agent, bind it. A first prompt naming two agents (a header pasted
      // into a task, which comes after the identity in a launch's prompt and before it in a delivery) names nobody by
      // itself: what each terminal was sent decides (the Audit's L3 on #613).
      const names = [...first.text.matchAll(IDENTITY)].map((m) => m[1]);
      if (names.length > 0 && names.every((n) => n === agentId)) return this.boundFrom(s.id, launch.at, false);
      // Otherwise, what another unbound launch was sent rules it out: that session may be the other agent's.
      if (others.some((o) => folded.includes(o))) continue;
      const sent = launch.typed.some((t) => folded.includes(t));
      const copied = !!forked && forked.at === first.at && forked.text === first.text;
      if (sent || copied) return this.boundFrom(s.id, launch.at, false);
    }
    return undefined;
  }

  private post(agentId: string, b: Bound, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(agentId, { path: route, body: { agent_id: agentId, session_id: opencodeUuidOf(b.sessionId) ?? b.sessionId, ...body } });
  }

  private async follow(db: Database.Database, agentId: string, launch: Launch): Promise<void> {
    const b = launch.bound!;
    if (!b.registered && !b.registerLater) {
      b.registered = true;
      // A fork goes on with an earlier conversation, under its own id.
      await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: launch.forkOf ? 'resume' : 'startup' });
    }
    // From the first message not yet done on: a long session is not read whole every second (the Audit's I-b).
    const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? AND time_created >= ? ORDER BY time_created, id').all(b.sessionId, b.since) as Row[];
    let waiting: number | undefined;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (b.done.has(row.id)) continue;
      const data = parse(row.data);
      // A row that does not parse is passed over: it must not stop its session (the Audit's I-c).
      if (!data) { b.done.add(row.id); continue; }
      if (!b.registered) {
        b.registered = true;
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: 'resume' });
      }
      if (data.role === 'user') {
        // Its text is written in its parts, a moment after the row: read again at the next tick until it is there.
        const text = this.texts(db, row.id).join('\n');
        if (!text) { waiting = row.time_created; break; }
        b.done.add(row.id);
        b.turn = { texts: [] };
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: text });
        continue;
      }
      if (data.role !== 'assistant') { b.done.add(row.id); continue; }
      const error = asObj(data.error);
      const completed = num(asObj(data.time)?.completed) > 0;
      if (!error && !completed) {
        // Still being written, unless opencode went on to another assistant message after it: then it was cut short
        // (an opencode gone mid-turn), and is passed over (the Audit's I-c).
        if (rows.slice(i + 1).some((r) => parse(r.data)?.role === 'assistant')) { b.done.add(row.id); continue; }
        waiting = row.time_created;
        break;
      }
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
    // The next read starts at the first message not done (the one waited on), or at the last one read; the done
    // ids before it are no longer needed.
    const next = waiting ?? (rows.length > 0 ? rows[rows.length - 1].time_created : b.since);
    if (next > b.since) {
      b.since = next;
      const kept = new Set(rows.filter((r) => r.time_created >= next && b.done.has(r.id)).map((r) => r.id));
      b.done = kept;
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
