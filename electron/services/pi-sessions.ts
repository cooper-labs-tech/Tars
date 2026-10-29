import * as fs from 'fs';
import * as path from 'path';
import type { HookPost } from './codex-sessions';
import { reportOf } from './terminal-answer';

export type { HookPost };

/**
 * pi's turns, read from its own session file and told to Tars the way Claude
 * Code's hooks tell it (2.0.4, the CLI matrix's pi row), as codex's are from
 * its rollout (codex-sessions.ts).
 *
 * pi runs no hook Tars installs. What it writes, read in
 * @earendil-works/pi-coding-agent 1.3.0 (docs/session-format.md,
 * dist/core/session-manager.js, dist/core/agent-session.js): one JSONL file
 * per session, created at its first message, `{"type":"session","id",...}`
 * first, then one line per message as it ends. An assistant message carries
 * `stopReason`: `stop` and `length` end the turn; `toolUse`, `pending` and
 * `deferred` do not; `aborted` is an Esc; `error` ends it on an error, which
 * pi may retry (another assistant line, no new user line), so an error is
 * posted only once no line has followed it for RETRY_GRACE_MS.
 *
 * Whose session is whose needs no evidence here: each pi agent is handed a
 * session folder of its own (PI_CODING_AGENT_SESSION_DIR, which pi ranks above
 * its own `sessionDir` setting, and in which it writes its files directly), so
 * every file in it is that agent's. The one followed is the last one that grew
 * since the launch: a file there before it is a resumed session, a new one is
 * a new session (pi's /new). pi-sessions.test.ts says each way this goes wrong.
 */

export type PiEvent =
  | { kind: 'session'; id: string }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; stop: string; text: string; error?: string };

/** How long an error waits for pi's retry before it ends the turn. */
const RETRY_GRACE_MS = 20_000;

/** A message's text: a string, or its text blocks joined (thinking, tool calls and images left out). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .join('');
}

/** One line of a session file, as Tars reads it; null for a line that is not one of these. */
export function piEventOf(line: string): PiEvent | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as { type?: unknown; id?: unknown; message?: unknown };
  if (e.type === 'session') return typeof e.id === 'string' && e.id ? { kind: 'session', id: e.id } : null;
  if (e.type !== 'message' || !e.message || typeof e.message !== 'object') return null;
  const m = e.message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (m.role === 'user') return { kind: 'user', text: textOf(m.content) };
  if (m.role === 'assistant' && typeof m.stopReason === 'string') {
    return { kind: 'assistant', stop: m.stopReason, text: textOf(m.content), ...(typeof m.errorMessage === 'string' ? { error: m.errorMessage } : {}) };
  }
  return null;
}

/** The session folder of one pi agent, in Tars's data folder. */
export function piSessionDir(dataDir: string, agentId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(agentId) || agentId === '.' || agentId === '..') throw new Error(`not an agent id: ${agentId}`);
  return path.join(dataDir, 'pi', 'sessions', agentId);
}

export interface PiSessionWatchDeps {
  /** The agent's session folder (production: piSessionDir of the data folder). */
  dirOf: (agentId: string) => string;
  now: () => number;
  /** Posts as the agent's terminal (production: its own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
  /** Told a turn was interrupted, before the rest is posted (production: task-watch.ts, turnInterrupted). */
  interrupted?: (agentId: string, sessionId: string) => void;
}

interface Followed {
  file: string;
  sessionId: string;
  offset: number;
  partial: string;
  resumed: boolean;
  registered: boolean;
  turnOpen: boolean;
  pendingError?: { at: number; message: string };
  /** What pi wrote in the open turn, in order: the turn's answer is its report (reportOf), not its last line alone. */
  said?: string[];
}

interface Launch {
  /** Each file's size when it was last read, or at the launch. */
  sizes: Map<string, number>;
  followed?: Followed;
}

const sessionFiles = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
};
const sizeOf = (file: string): number => {
  try { return fs.statSync(file).size; } catch { return 0; }
};
function readFrom(file: string, offset: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const out = Buffer.alloc(size - offset);
    fs.readSync(fd, out, 0, out.length, offset);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
/** The session's id from its header, the file's first line; else from its name, `<time>_<id>.jsonl`. */
function sessionIdOf(file: string): string {
  try {
    const head = readFrom(file, 0).subarray(0, 64 * 1024).toString('utf8');
    const event = piEventOf(head.split('\n')[0] ?? '');
    if (event?.kind === 'session') return event.id;
  } catch { /* the name, below */ }
  return path.basename(file, '.jsonl').split('_').pop() ?? '';
}

export class PiSessionWatch {
  private launches = new Map<string, Launch>();

  constructor(private deps: PiSessionWatchDeps) {}

  setDeps(deps: Partial<PiSessionWatchDeps>): void {
    Object.assign(this.deps, deps);
  }

  /** A pi terminal was spawned for the agent: what is in its folder now is from before. */
  noteLaunch(agentId: string): void {
    const sizes = new Map<string, number>();
    for (const file of sessionFiles(this.deps.dirOf(agentId))) sizes.set(file, sizeOf(file));
    this.launches.set(agentId, { sizes });
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

  private async step(agentId: string, launch: Launch): Promise<void> {
    // The file that grew since it was last read: the agent's session now. A
    // new one wins over one that only grew (pi's /new writes a new file).
    let grown: string | undefined;
    for (const file of sessionFiles(this.deps.dirOf(agentId))) {
      const was = launch.sizes.get(file);
      const size = sizeOf(file);
      if (was === undefined || size > was) {
        if (!grown || launch.sizes.get(grown) !== undefined) grown = file;
      }
    }
    if (grown && grown !== launch.followed?.file) {
      const before = launch.sizes.get(grown);
      launch.followed = {
        file: grown, sessionId: sessionIdOf(grown), offset: before ?? 0, partial: '',
        resumed: before !== undefined, registered: false, turnOpen: false,
      };
    }
    const f = launch.followed;
    if (!f) return;
    await this.follow(agentId, f);
    launch.sizes.set(f.file, f.offset);
    if (f.pendingError && this.deps.now() - f.pendingError.at >= RETRY_GRACE_MS) {
      const { message } = f.pendingError;
      f.pendingError = undefined;
      f.turnOpen = false;
      await this.post(agentId, f, { status: 'error', error_kind: 'pi_turn_failed', error_message: message });
    }
  }

  private post(agentId: string, f: Followed, body: Record<string, unknown>): Promise<void> {
    return this.postTo(agentId, f, '/api/hooks/status', body);
  }

  private postTo(agentId: string, f: Followed, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(agentId, { path: route, body: { agent_id: agentId, session_id: f.sessionId, ...body } });
  }

  private async follow(agentId: string, f: Followed): Promise<void> {
    let chunk: Buffer;
    try { chunk = readFrom(f.file, f.offset); } catch { return; }
    if (!chunk.length) return;
    f.offset += chunk.length;
    if (f.resumed && !f.registered) {
      f.registered = true;
      await this.post(agentId, f, { status: 'running', source: 'resume' });
    }
    // A last line with no end yet is still being written: it waits for the rest.
    const text = f.partial + chunk.toString('utf8');
    const lines = text.split('\n');
    f.partial = lines.pop() ?? '';
    for (const line of lines) {
      const event = piEventOf(line);
      if (!event) continue;
      if (event.kind === 'session') {
        if (!f.registered) {
          f.registered = true;
          await this.post(agentId, f, { status: 'running', source: 'startup' });
        }
      } else if (event.kind === 'user') {
        if (f.pendingError) {
          // A new prompt after an error: the error was the turn's end.
          const { message } = f.pendingError;
          f.pendingError = undefined;
          await this.post(agentId, f, { status: 'error', error_kind: 'pi_turn_failed', error_message: message });
        }
        f.turnOpen = true;
        f.said = [];
        await this.post(agentId, f, { status: 'running', event: 'UserPromptSubmit', current_task: event.text });
      } else if (f.turnOpen) {
        if (event.text) (f.said ??= []).push(event.text);
        if (event.stop === 'error') {
          f.pendingError = { at: this.deps.now(), message: event.error || 'the turn failed' };
        } else if (event.stop === 'stop' || event.stop === 'length') {
          f.pendingError = undefined;
          f.turnOpen = false;
          const answer = reportOf(f.said ?? []) ?? (event.text || null);
          f.said = [];
          if (answer) await this.postTo(agentId, f, '/api/hooks/output', { hook: 'Stop', output: answer });
          await this.postTo(agentId, f, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
          await this.postTo(agentId, f, '/api/hooks/agent-stopped', { hook: 'Stop' });
        } else if (event.stop === 'aborted') {
          f.pendingError = undefined;
          f.turnOpen = false;
          // No answer: said interrupted first, then the rest pi is at.
          this.deps.interrupted?.(agentId, f.sessionId);
          await this.postTo(agentId, f, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
        } else {
          // toolUse, pending, deferred: the turn goes on, a retry after an error included.
          f.pendingError = undefined;
        }
      }
    }
  }
}

/** The one watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const piSessionWatch = new PiSessionWatch({
  dirOf: () => '',
  now: () => Date.now(),
  post: async () => {},
});

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads the pi agents' sessions every second while one is launched. */
export function startPiSessionWatch(deps: Pick<PiSessionWatchDeps, 'dirOf' | 'post' | 'interrupted'>): void {
  piSessionWatch.setDeps(deps);
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy || !piSessionWatch.watching) return;
    busy = true;
    piSessionWatch.tick().catch((err) => console.warn('[pi-sessions]', err instanceof Error ? err.message : err)).finally(() => { busy = false; });
  }, 1000);
  timer.unref?.();
}

export function stopPiSessionWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
