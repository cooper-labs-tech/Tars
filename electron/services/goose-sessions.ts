import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { HookPost } from './codex-sessions';
import { reportOf } from './terminal-answer';
import { GOOSE_SKILLS_LINE, gooseDbPath, gooseUuidOf, type GooseLaunchFrom } from '../providers/goose-cli';

export type { HookPost };

/**
 * Goose's turns, read from the database its TUI writes and told to Tars the way Claude Code's hooks tell it, as
 * opencode's are (opencode-sessions.ts): so delegate_task, task_status and get_agent_output work on a Goose agent,
 * with its tokens.
 *
 * Measured on Goose 1.60.1 (20/11/2026, its TUI in a PTY against a loopback endpoint): one SQLite database (WAL),
 * `$XDG_DATA_HOME/goose/sessions/sessions.db`. A `sessions` row (`YYYYMMDD_N`, its `working_dir`, `created_at` in UTC
 * whole seconds) is written at the TUI's start. Each message is a `messages` row, appended once whole: an
 * autoincremented `id`, its `role`, `content_json` (a list of `text`, `toolRequest`, `toolResponse` or `error` items),
 * `created_timestamp` in whole seconds, and `metadata_json`, whose `userVisible` is false on the turn context Goose adds
 * under each prompt. Each model call is a `usage_ledger` row (its `model`, its input with the cache read counted in it,
 * its output, its cache read). No row says a turn ended: an assistant message with text and no tool request ends it; an
 * endpoint's failure is an assistant message whose content is an `error`; a Ctrl+C leaves the turn's rows and no
 * assistant row after them (Goose reports `idle` over OSC 7501 then, services/program-status). A fork (`--resume
 * --session-id <id> --fork`) is a new `sessions` row with no `parent_session_id`, every message of the session it forks
 * copied with its own `created_timestamp`.
 *
 * Whose session is whose is decided on evidence, never on the folder alone (the user's own Goose writes the same
 * database), for a session made in the agent's folder since the launch and held by no other launch, as for opencode:
 * Tars's identity lines in its first prompt all naming this agent, at a line's start or right after the skills line a
 * launch types first (a prompt naming two agents names nobody by itself); or, unless it holds a text another unbound
 * launch was sent, a text this terminal was sent, noted from after that skills line, which is every such agent's
 * (the Audit's M1 on #618, #613's M2 for opencode); or, for a fork, under the same condition, a copy of the forked
 * session's first prompt (the same time and text). A session the launch resumed is bound by its id, read from the launch on,
 * unless another launch holds it. Posted under the UUID made from Goose's id (providers/goose-cli.ts): the hook routes
 * take nothing else. goose-sessions.test.ts says each way this goes wrong.
 *
 * What reading costs: a tick runs every second while a launch is noted (forgotten with its terminal), on the main
 * thread. For a bound session it reads only the messages and model calls after the last one read.
 */

export interface GooseSessionWatchDeps {
  /** The database (production: gooseDbPath). */
  dbPath: () => string;
  now: () => number;
  /** Posts as the agent's terminal (production: its own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
  /** Told a turn was interrupted, before the rest is posted (production: task-watch.ts, turnInterrupted). */
  interrupted?: (agentId: string, sessionId: string) => void;
}

/** What a launch said of its session (gooseLaunchOf), and the terminal it runs in, which forgets it at its exit. */
export interface GooseLaunchNote extends GooseLaunchFrom { terminal?: object }

interface Usage { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
interface Bound {
  sessionId: string;
  /** Registered at its first new message (a resumed session) rather than at once. */
  registerLater: boolean;
  registered: boolean;
  /** The last message read, and the last model call counted: each read once. */
  lastId: number;
  lastCallId: number;
  /** In whole seconds, as Goose writes them: every message before is history (a resumed session's, a fork's copies). */
  since: number;
  turn?: { texts: string[] };
}
interface Launch {
  cwd: string;
  at: number;
  resume?: string;
  forkOf?: string;
  terminal?: object;
  /** What this terminal was sent since the launch (what Tars typed), whitespace folded, for a first prompt. */
  typed: string[];
  bound?: Bound;
}
type Row = { id: number; role: string; content_json: string; created_timestamp: number; metadata_json: string | null };
type Item = Record<string, unknown>;

/**
 * Tars's identity line, at a line's start or right after the skills line a launch types first (gooseSkillsLine): where
 * Tars writes it, and never a header quoted inside a line.
 */
const IDENTITY = new RegExp(String.raw`^\s*(?:${GOOSE_SKILLS_LINE}\s*)?\[Tars: you are agent ".*?" \(id ([0-9a-zA-Z-]{4,})\)`, 'gm');
/** The skills line at a typed text's start: the same for every agent with the same skills, never what tells them apart. */
const SKILLS_FIRST = new RegExp(String.raw`^\s*${GOOSE_SKILLS_LINE}\s*`);
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();
const TYPED_HEAD = 200;
const TYPED_MIN = 16;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const secondsOf = (ms: number): number => Math.floor(ms / 1000);
const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sameDir = (a: string, b: string): boolean => {
  const ra = realOf(a);
  const rb = realOf(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};
/** A message's items, or undefined when its content does not parse as a list. */
const itemsOf = (json: string): Item[] | undefined => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((i): i is Item => !!i && typeof i === 'object' && !Array.isArray(i)) : undefined;
  } catch {
    return undefined;
  }
};
const hidden = (metadata: string | null): boolean => {
  try { return (JSON.parse(metadata ?? '{}') as { userVisible?: unknown }).userVisible === false; } catch { return false; }
};
const textsOf = (items: Item[]): string[] => items.filter((i) => i.type === 'text' && typeof i.text === 'string' && i.text).map((i) => i.text as string);
/**
 * `created_at` in whole seconds: `YYYY-MM-DD HH:MM:SS` in UTC as SQLite's CURRENT_TIMESTAMP writes it, or with a
 * fraction and a zone (`...16:31:10.123456789+00:00`, `...Z`) as sqlx writes a DateTime<Utc>; NaN for anything else.
 */
const createdSeconds = (v: unknown): number => {
  if (typeof v === 'number') return Math.floor(v);
  if (typeof v !== 'string') return NaN;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v.trim());
  if (!m) return NaN;
  const zone = !m[4] || m[4] === 'Z' ? 'Z' : m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4];
  return Math.floor(Date.parse(`${m[1]}T${m[2]}${zone}`) / 1000);
};

export class GooseSessionWatch {
  private launches = new Map<string, Launch>();

  constructor(private deps: GooseSessionWatchDeps) {}

  setDeps(deps: Partial<GooseSessionWatchDeps>): void {
    Object.assign(this.deps, deps);
  }

  /** A Goose terminal was spawned for the agent in `cwd`: `from` is what its line says (gooseLaunchOf), and its terminal. */
  noteLaunch(agentId: string, cwd: string, from: GooseLaunchNote = {}): void {
    this.launches.set(agentId, { cwd, at: this.deps.now(), resume: from.resume, forkOf: from.forkOf, terminal: from.terminal, typed: [] });
  }

  /**
   * Tars typed `text` into the agent's terminal: a session whose first prompt holds it, and no other's, is the agent's.
   * Noted from after the skills line, which would fill the head noted and be every such agent's (the Audit's M1 on #618).
   */
  noteTyped(agentId: string, text: string): void {
    const launch = this.launches.get(agentId);
    const folded = fold(text.replace(SKILLS_FIRST, '')).slice(0, TYPED_HEAD);
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
      // Not a database yet, locked for a moment, or written by a Goose of another shape: read at the next tick.
      if (!(err instanceof Error && /not a database|SQLITE_BUSY|no such table|no such column/i.test(err.message))) {
        console.warn('[goose-sessions]', err instanceof Error ? err.message : err);
      }
    } finally {
      db?.close();
    }
  }

  private rows(db: Database.Database, sessionId: string, afterId: number, since: number): Row[] {
    return db.prepare('SELECT id, role, content_json, created_timestamp, metadata_json FROM messages WHERE session_id = ? AND id > ? AND created_timestamp >= ? ORDER BY id')
      .all(sessionId, afterId, since) as Row[];
  }

  /** A prompt the user (or Tars) typed: a user message with text, not the turn context Goose adds, not a tool's response. */
  private promptOf(row: Row, items: Item[]): string | undefined {
    if (row.role !== 'user' || hidden(row.metadata_json)) return undefined;
    const texts = textsOf(items);
    return texts.length > 0 ? texts.join('\n') : undefined;
  }

  /** The first prompt of a session and its time; null before it is written. */
  private firstPrompt(db: Database.Database, sessionId: string): { text: string; at: number } | null {
    for (const row of this.rows(db, sessionId, 0, 0)) {
      const items = itemsOf(row.content_json);
      const text = items && this.promptOf(row, items);
      if (text) return { text, at: row.created_timestamp };
    }
    return null;
  }

  private boundTo(sessionId: string, launch: Launch, registerLater: boolean): Bound {
    return { sessionId, registerLater, registered: false, lastId: 0, lastCallId: 0, since: secondsOf(launch.at) };
  }

  private bind(db: Database.Database, agentId: string, launch: Launch, taken: Set<string>): Bound | undefined {
    const sessions = db.prepare('SELECT id, working_dir, created_at FROM sessions').all() as Array<{ id: unknown; working_dir: unknown; created_at: unknown }>;
    if (launch.resume) {
      // Held by another live launch: two agents would each get the other's turns.
      if (taken.has(launch.resume)) return undefined;
      return sessions.some((s) => s.id === launch.resume) ? this.boundTo(launch.resume, launch, true) : undefined;
    }
    const others = [...this.launches].filter(([id, l]) => id !== agentId && !l.bound).flatMap(([, l]) => l.typed);
    const forked = launch.forkOf ? this.firstPrompt(db, launch.forkOf) : null;
    for (const s of sessions) {
      if (typeof s.id !== 'string' || typeof s.working_dir !== 'string' || taken.has(s.id)) continue;
      // Made since the launch (in Goose's whole seconds): never the session a fork copies, which is older.
      if (!(createdSeconds(s.created_at) >= secondsOf(launch.at)) || !sameDir(s.working_dir, launch.cwd)) continue;
      const first = this.firstPrompt(db, s.id);
      if (first === null) continue;
      const folded = fold(first.text);
      // Tars's identity lines, when they all name this agent, bind it; a first prompt naming two agents names nobody.
      const names = [...first.text.matchAll(IDENTITY)].map((m) => m[1]);
      if (names.length > 0 && names.every((n) => n === agentId)) return this.boundTo(s.id, launch, false);
      // Otherwise, what another unbound launch was sent rules it out: that session may be the other agent's.
      if (others.some((o) => folded.includes(o))) continue;
      const sent = launch.typed.some((t) => folded.includes(t));
      const copied = !!forked && forked.at === first.at && forked.text === first.text;
      if (sent || copied) return this.boundTo(s.id, launch, false);
    }
    return undefined;
  }

  private post(agentId: string, b: Bound, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(agentId, { path: route, body: { agent_id: agentId, session_id: gooseUuidOf(b.sessionId) ?? b.sessionId, ...body } });
  }

  /** The model calls of the turn since the last counted, summed: Goose's input counts the cache read, Tars's does not. */
  private usageSince(db: Database.Database, b: Bound): Usage | undefined {
    const calls = db.prepare('SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_ledger WHERE session_id = ? AND id > ? AND created_timestamp >= ? ORDER BY id')
      .all(b.sessionId, b.lastCallId, b.since) as Array<{ id: number; model: unknown; input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown }>;
    let usage: Usage | undefined;
    for (const c of calls) {
      b.lastCallId = Math.max(b.lastCallId, c.id);
      if (typeof c.model !== 'string' || !c.model) continue;
      const u = usage ?? (usage = { model: c.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const cacheRead = num(c.cache_read_tokens);
      u.input += Math.max(0, num(c.input_tokens) - cacheRead);
      u.output += num(c.output_tokens);
      u.cacheRead += cacheRead;
      u.cacheWrite += num(c.cache_write_tokens);
    }
    return usage;
  }

  private async follow(db: Database.Database, agentId: string, launch: Launch): Promise<void> {
    const b = launch.bound!;
    if (!b.registered && !b.registerLater) {
      b.registered = true;
      // A fork goes on with an earlier conversation, under its own id.
      await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: launch.forkOf ? 'resume' : 'startup' });
    }
    for (const row of this.rows(db, b.sessionId, b.lastId, b.since)) {
      b.lastId = row.id;
      const items = itemsOf(row.content_json);
      // A row whose content does not parse is passed over: it must not stop its session.
      if (!items) continue;
      if (!b.registered) {
        b.registered = true;
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: 'resume' });
      }
      const prompt = this.promptOf(row, items);
      if (prompt !== undefined) {
        if (b.turn) {
          // The turn before had no end: cut by Ctrl+C, which leaves no row of its own.
          this.deps.interrupted?.(agentId, gooseUuidOf(b.sessionId) ?? b.sessionId);
          await this.post(agentId, b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
        }
        b.turn = { texts: [] };
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: prompt });
        continue;
      }
      if (row.role !== 'assistant' || hidden(row.metadata_json)) continue;
      const error = items.find((i) => i.type === 'error');
      if (error) {
        b.turn = undefined;
        this.usageSince(db, b);
        const said = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : 'the turn failed';
        await this.post(agentId, b, '/api/hooks/status', { status: 'error', error_kind: 'goose_turn_failed', error_message: said.slice(0, 2000) });
        continue;
      }
      const turn = b.turn ?? (b.turn = { texts: [] });
      const texts = textsOf(items);
      turn.texts.push(...texts);
      // A step that asked for a tool goes on, and so does one with no text; text and no tool request ends the turn.
      if (items.some((i) => i.type === 'toolRequest') || texts.length === 0) continue;
      b.turn = undefined;
      const answer = reportOf(turn.texts);
      if (answer) await this.post(agentId, b, '/api/hooks/output', { hook: 'Stop', output: answer });
      await this.post(agentId, b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
      await this.post(agentId, b, '/api/hooks/agent-stopped', { hook: 'Stop' });
      const u = this.usageSince(db, b);
      if (u) {
        await this.post(agentId, b, '/api/hooks/turn-usage', {
          usage: { model: u.model, input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
        });
      }
    }
  }
}

/** The watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const gooseSessionWatch = new GooseSessionWatch({ dbPath: () => gooseDbPath(), now: () => Date.now(), post: async () => {} });

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads the sessions of the Goose agents every second while one is launched. */
export function startGooseSessionWatch(deps: Pick<GooseSessionWatchDeps, 'post' | 'interrupted'>): void {
  gooseSessionWatch.setDeps(deps);
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy || !gooseSessionWatch.watching) return;
    busy = true;
    gooseSessionWatch.tick().catch((err) => console.warn('[goose-sessions]', err instanceof Error ? err.message : err)).finally(() => { busy = false; });
  }, 1000);
  timer.unref?.();
}

export function stopGooseSessionWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
