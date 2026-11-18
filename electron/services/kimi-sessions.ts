import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HookPost } from './codex-sessions';
import { reportOf } from './terminal-answer';

export type { HookPost };

/**
 * Kimi Code's turns, read from the session log it writes and told to Tars the way Claude Code's hooks tell it, as
 * codex's (codex-sessions.ts) and pi's (pi-sessions.ts) are.
 *
 * Measured on kimi-code 2.6.3 (19/11/2026, a PTY against a loopback endpoint): every session is
 * `$KIMI_CODE_HOME/sessions/<workspace>/<session id>/agents/main/wire.jsonl`, listed in `session_index.jsonl` as
 * `{sessionId, sessionDir, workDir}`. A turn is `turn.prompt` (its `input` parts, `turnId` a number), the answer's
 * `content.part` records (`context.append_loop_event`, `turnId` a string, `step`, `block`, `part: {type: 'text'}`),
 * then `turn.ended` with `reason` `completed`, or `cancelled` after an Esc (with `turn.cancel` before it). Subagents
 * write their own `agents/agent-<n>/wire.jsonl`, never read here.
 *
 * The user's own Kimi home is the one the agent's kimi runs on (its login, its providers), so whose session is whose
 * is decided on evidence, never on the folder alone: while a kimi process holds a session it keeps
 * `locks/sessions/<session id>.lock`, JSON with its `pid` (kimi-code's sessionLockService), and a session whose lock
 * names a process of the agent's terminal is that agent's. Where processes cannot be listed (Windows: no `ps`), the
 * first prompt Tars typed in carries the agent's identity line ("[Tars: you are agent ... (id <agent id>)"), as it
 * does for codex. A session the launch resumed (`kimi --session <id>`) is the agent's by that id, read from where it
 * stood at the launch. kimi-sessions.test.ts says each way this goes wrong.
 */

export type KimiEvent =
  | { kind: 'prompt'; turnId: number; text: string }
  | { kind: 'text'; turnId: number; step: number; block: number; text: string }
  | { kind: 'ended'; turnId: number; reason: string };

const IDENTITY = /\[Tars: you are agent ".*?" \(id ([0-9a-zA-Z-]{4,})\)/;

const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const turnIdOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
};

/** One line of a session's wire.jsonl, as Tars reads it; null for a line that is not one of these. */
export function kimiEventOf(line: string): KimiEvent | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  const e = asObj(entry);
  if (!e || (e.agentId !== undefined && e.agentId !== 'main')) return null;
  if (e.type === 'turn.prompt') {
    const turnId = turnIdOf(e.turnId);
    if (turnId === undefined || !Array.isArray(e.input)) return null;
    const text = e.input.map((p) => { const o = asObj(p); return o?.type === 'text' && typeof o.text === 'string' ? o.text : ''; }).join('');
    return { kind: 'prompt', turnId, text };
  }
  if (e.type === 'turn.ended') {
    const turnId = turnIdOf(e.turnId);
    return turnId === undefined ? null : { kind: 'ended', turnId, reason: typeof e.reason === 'string' ? e.reason : 'unknown' };
  }
  if (e.type === 'context.append_loop_event') {
    const ev = asObj(e.event);
    const part = asObj(ev?.part);
    const turnId = turnIdOf(ev?.turnId);
    if (ev?.type !== 'content.part' || part?.type !== 'text' || typeof part.text !== 'string' || turnId === undefined) return null;
    return { kind: 'text', turnId, step: typeof ev.step === 'number' ? ev.step : 0, block: typeof ev.block === 'number' ? ev.block : 0, text: part.text };
  }
  return null;
}

/** Where kimi keeps its data: KIMI_CODE_HOME, else ~/.kimi-code (kimi-code 2.6.3, docs/en/configuration/data-locations.md). */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

export interface KimiSessionWatchDeps {
  homeOf: () => string;
  now: () => number;
  /** Posts as the agent's terminal (production: its own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
  /** Told a turn was interrupted, before the rest is posted (production: task-watch.ts, turnInterrupted). */
  interrupted?: (agentId: string, sessionId: string) => void;
  /** The processes of the agent's terminal and everything under it; undefined where they cannot be listed. */
  pidsOf: (agentId: string) => Promise<number[] | undefined>;
}

interface Bound {
  sessionId: string;
  file: string;
  offset: number;
  partial: string;
  resumed: boolean;
  registered: boolean;
  turn?: { id: number; parts: Map<string, string> };
}
interface Launch {
  cwd: string;
  at: number;
  resume?: { sessionId: string; size: number };
  bound?: Bound;
}

type IndexEntry = { sessionId: string; sessionDir: string; workDir: string };

const sameDir = (a: string, b: string): boolean => {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const ra = real(a);
  const rb = real(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};
const sizeOf = (file: string): number => { try { return fs.statSync(file).size; } catch { return 0; } };
function readFrom(file: string, offset: number, max = Infinity): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const out = Buffer.alloc(Math.min(size - offset, max));
    fs.readSync(fd, out, 0, out.length, offset);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
const wireOf = (sessionDir: string): string => path.join(sessionDir, 'agents', 'main', 'wire.jsonl');

export class KimiSessionWatch {
  private launches = new Map<string, Launch>();

  constructor(private deps: KimiSessionWatchDeps) {}

  setDeps(deps: Partial<KimiSessionWatchDeps>): void {
    Object.assign(this.deps, deps);
  }

  /** A kimi terminal was spawned for the agent in `cwd`, resuming `resumeSessionId` when given. */
  noteLaunch(agentId: string, cwd: string, resumeSessionId?: string): void {
    const launch: Launch = { cwd, at: this.deps.now() };
    if (resumeSessionId) {
      const entry = this.index().find((e) => e.sessionId === resumeSessionId);
      launch.resume = { sessionId: resumeSessionId, size: entry ? sizeOf(wireOf(entry.sessionDir)) : 0 };
    }
    this.launches.set(agentId, launch);
  }

  forget(agentId: string): void {
    this.launches.delete(agentId);
  }

  get watching(): boolean {
    return this.launches.size > 0;
  }

  /** The session the agent's kimi is bound to, for a resume (utils/resume-session.ts). */
  sessionOf(agentId: string): string | undefined {
    return this.launches.get(agentId)?.bound?.sessionId;
  }

  private index(): IndexEntry[] {
    let text = '';
    try { text = fs.readFileSync(path.join(this.deps.homeOf(), 'session_index.jsonl'), 'utf8'); } catch { return []; }
    const out: IndexEntry[] = [];
    for (const line of text.split('\n')) {
      try {
        const e = asObj(JSON.parse(line));
        if (e && typeof e.sessionId === 'string' && typeof e.sessionDir === 'string' && typeof e.workDir === 'string') {
          out.push({ sessionId: e.sessionId, sessionDir: e.sessionDir, workDir: e.workDir });
        }
      } catch { /* a line being written, or not an entry */ }
    }
    return out;
  }

  private lockPid(sessionId: string): number | undefined {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined;
    try {
      const lock = asObj(JSON.parse(fs.readFileSync(path.join(this.deps.homeOf(), 'locks', 'sessions', `${sessionId}.lock`), 'utf8')));
      return typeof lock?.pid === 'number' ? lock.pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** The id the first prompt of a session names, read from its head; null when it names nobody (yet). */
  private namedIn(file: string): string | null {
    let head = '';
    try { head = readFrom(file, 0, 1024 * 1024).toString('utf8'); } catch { return null; }
    for (const line of head.split('\n')) {
      const event = kimiEventOf(line);
      if (event?.kind === 'prompt') return IDENTITY.exec(event.text)?.[1] ?? '';
    }
    return null;
  }

  async tick(): Promise<void> {
    const taken = new Set([...this.launches.values()].map((l) => l.bound?.sessionId).filter(Boolean) as string[]);
    for (const [agentId, launch] of this.launches) {
      if (!launch.bound) {
        const bound = await this.bind(agentId, launch, taken);
        if (bound) { launch.bound = bound; taken.add(bound.sessionId); }
      }
      if (launch.bound) await this.follow(agentId, launch.bound);
    }
  }

  private async bind(agentId: string, launch: Launch, taken: Set<string>): Promise<Bound | undefined> {
    const entries = this.index();
    if (launch.resume) {
      const entry = entries.find((e) => e.sessionId === launch.resume!.sessionId);
      if (entry) return { sessionId: entry.sessionId, file: wireOf(entry.sessionDir), offset: launch.resume.size, partial: '', resumed: true, registered: false };
    }
    const pids = await this.deps.pidsOf(agentId);
    for (const entry of entries) {
      if (taken.has(entry.sessionId) || !sameDir(entry.workDir, launch.cwd)) continue;
      const file = wireOf(entry.sessionDir);
      if (!fs.existsSync(file)) continue;
      const holder = this.lockPid(entry.sessionId);
      const held = pids !== undefined && holder !== undefined;
      if (held && pids!.includes(holder!)) return { sessionId: entry.sessionId, file, offset: 0, partial: '', resumed: false, registered: false };
      if (held) continue;
      if (this.namedIn(file) === agentId) return { sessionId: entry.sessionId, file, offset: 0, partial: '', resumed: false, registered: false };
    }
    return undefined;
  }

  private post(agentId: string, b: Bound, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(agentId, { path: route, body: { agent_id: agentId, session_id: b.sessionId, ...body } });
  }

  private async follow(agentId: string, b: Bound): Promise<void> {
    // A new session registers once bound; a resumed one at its first new line, as pi's does (pi-sessions.ts).
    if (!b.registered && !b.resumed) {
      b.registered = true;
      await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: 'startup' });
    }
    let chunk: Buffer;
    try { chunk = readFrom(b.file, b.offset); } catch { return; }
    if (!chunk.length) return;
    b.offset += chunk.length;
    if (!b.registered) {
      b.registered = true;
      await this.post(agentId, b, '/api/hooks/status', { status: 'running', source: 'resume' });
    }
    const lines = (b.partial + chunk.toString('utf8')).split('\n');
    b.partial = lines.pop() ?? '';
    for (const line of lines) {
      const event = kimiEventOf(line);
      if (!event) continue;
      if (event.kind === 'prompt') {
        b.turn = { id: event.turnId, parts: new Map() };
        await this.post(agentId, b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: event.text });
      } else if (event.kind === 'text') {
        if (!b.turn || b.turn.id !== event.turnId) continue;
        const key = `${event.step}:${event.block}`;
        b.turn.parts.set(key, (b.turn.parts.get(key) ?? '') + event.text);
      } else if (b.turn && b.turn.id === event.turnId) {
        const said = [...b.turn.parts.values()];
        b.turn = undefined;
        if (event.reason === 'completed') {
          const answer = reportOf(said);
          if (answer) await this.post(agentId, b, '/api/hooks/output', { hook: 'Stop', output: answer });
          await this.post(agentId, b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
          await this.post(agentId, b, '/api/hooks/agent-stopped', { hook: 'Stop' });
        } else if (event.reason === 'cancelled') {
          this.deps.interrupted?.(agentId, b.sessionId);
          await this.post(agentId, b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
        } else {
          await this.post(agentId, b, '/api/hooks/status', { status: 'error', error_kind: 'kimi_turn_failed', error_message: `the turn ended: ${event.reason}` });
        }
      }
    }
  }
}

/** The one watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const kimiSessionWatch = new KimiSessionWatch({
  homeOf: () => kimiHome(),
  now: () => Date.now(),
  post: async () => {},
  pidsOf: async () => undefined,
});

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads the kimi agents' sessions every second while one is launched. */
export function startKimiSessionWatch(deps: Pick<KimiSessionWatchDeps, 'post' | 'interrupted' | 'pidsOf'>): void {
  kimiSessionWatch.setDeps(deps);
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy || !kimiSessionWatch.watching) return;
    busy = true;
    kimiSessionWatch.tick().catch((err) => console.warn('[kimi-sessions]', err instanceof Error ? err.message : err)).finally(() => { busy = false; });
  }, 1000);
  timer.unref?.();
}

export function stopKimiSessionWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
