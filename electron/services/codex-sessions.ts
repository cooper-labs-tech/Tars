import * as fs from 'fs';
import * as path from 'path';
import { codexHome, codexRolloutOf } from '../providers/codex-cli';
import { reportOf } from './terminal-answer';

/**
 * Codex's turns, read from its own session log and told to Tars the way Claude Code's hooks tell it (2.0.4).
 *
 * codex runs no hook Tars installs, so a codex agent read `running` from its launch to its end, and delegate_task
 * waited on a turn it would never see end. codex writes each session to
 * $CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl, one JSON object a line (measured on
 * codex-cli 0.163.0): `session_meta` (its id, its folder, `source`: `cli`, or a subagent such as the guardian of the
 * automatic review), `task_started`, the user's message (`item_completed`, a `UserMessage`), and `task_complete`,
 * with `last_agent_message`, or with `error` when the turn failed, or `turn_aborted` when it was interrupted (no
 * task_complete then: Tars is told, task-watch.ts, turnInterrupted). This reads it and posts, as the agent's terminal
 * and with that terminal's token, what Claude Code's hooks post (session-start.sh, user-prompt-submit.sh,
 * on-stop.sh, stop-failure.sh, permission-request.sh): the hook routes decide what happens, so a codex agent goes
 * through the one state machine every agent goes through (hooks-routes.ts). codex-sessions.test.ts says each way
 * this goes wrong.
 *
 * Whose session is whose: a launch is noted when Tars spawns a codex terminal (spawnAgentPty), and a new session in
 * its folder, begun after it, is that launch's only on evidence (the Audit's M1 on #465: the first session in the
 * folder was taken, the user's own codex included, and its id then became the agent's, to resume): its first message
 * carries the agent's identity line ("[Tars: you are agent ... (id <agent id>)", which every session Tars begins
 * carries, agent-guide.ts), the agent's own codex holds its rollout open (measured on 0.163: from its first line to
 * the codex's end, at rest included; platform/open-files.ts), or it is a fork of the agent's own session that the
 * launch began. A first message naming another agent is nobody's, and so, where a process's files cannot be read
 * (Windows), is one that names nobody. Where they can, a lookup that fails (ps or lsof failed, or timed out under load)
 * is asked again, later each time, and never binds (the Audit's L5 on #465). A new rollout is read from its head on,
 * each byte once and only until its first message: never whole, at every tick.
 *
 * An approval codex waits on (normal mode asks before a command outside its sandbox, and before each call of an MCP
 * server's tool) is in no line of the log: it is read from the terminal's screen (terminal-mirror.ts,
 * codexDialogOnScreen) while a turn is open. A codex that will ask to sign in writes no session at all: why is asked
 * at its launch and said in the agent's status (the Audit's L7 on #465, codex-cli.ts codexSignInGap).
 */

export interface HookPost {
  path: '/api/hooks/status' | '/api/hooks/output' | '/api/hooks/agent-stopped';
  body: Record<string, unknown>;
}

export type CodexEvent =
  | { kind: 'session'; id: string; cwd: string; subagent: boolean; at: number; forkedFrom?: string }
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'user'; text: string }
  /** A message codex wrote in the turn (an `AgentMessage` item): its answer is the turn's report (reportOf). */
  | { kind: 'agent'; text: string }
  | { kind: 'turn_complete'; turnId: string; message: string | null; error: string | null }
  | { kind: 'turn_aborted'; turnId: string };

/** What a turn's `error` says, in codex's own words: the API's message when codex kept the API's answer whole. */
function errorText(error: unknown): string | null {
  const raw = typeof error === 'string' ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message
      : null;
  if (raw === null) return error ? 'the turn failed' : null;
  try {
    const inner = (JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown });
    const said = inner?.error?.message ?? inner?.message;
    if (typeof said === 'string' && said.trim()) return said.trim();
  } catch { /* not JSON: codex's own sentence */ }
  return raw.trim() || 'the turn failed';
}

/** One line of a rollout, as Tars reads it; null for a line that is not one of these. */
export function codexEventOf(line: string): CodexEvent | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { type, payload, timestamp } = entry as { type?: unknown; payload?: unknown; timestamp?: unknown };
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (type === 'session_meta') {
    const id = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : '';
    if (!id || typeof p.cwd !== 'string') return null;
    const at = Date.parse(typeof p.timestamp === 'string' ? p.timestamp : typeof timestamp === 'string' ? timestamp : '');
    const subagent = !!p.source && typeof p.source === 'object' && 'subagent' in (p.source as object);
    // `codex fork <id>` names the session it forks (measured on 0.163).
    const forkedFrom = typeof p.forked_from_id === 'string' ? p.forked_from_id : undefined;
    return { kind: 'session', id, cwd: p.cwd, subagent, at: Number.isFinite(at) ? at : 0, ...(forkedFrom ? { forkedFrom } : {}) };
  }
  if (type !== 'event_msg') return null;
  if (p.type === 'task_started') return { kind: 'turn_started', turnId: typeof p.turn_id === 'string' ? p.turn_id : '' };
  // Interrupted (Esc): measured on 0.163, `turn_aborted` with reason `interrupted`, and no task_complete after it.
  if (p.type === 'turn_aborted') return { kind: 'turn_aborted', turnId: typeof p.turn_id === 'string' ? p.turn_id : '' };
  if (p.type === 'task_complete') {
    return {
      kind: 'turn_complete',
      turnId: typeof p.turn_id === 'string' ? p.turn_id : '',
      message: typeof p.last_agent_message === 'string' ? p.last_agent_message : null,
      error: p.error === undefined || p.error === null ? null : errorText(p.error),
    };
  }
  if (p.type === 'item_completed') {
    const item = p.item as { type?: unknown; content?: unknown } | undefined;
    if ((item?.type !== 'UserMessage' && item?.type !== 'AgentMessage') || !Array.isArray(item.content)) return null;
    const text = item.content
      .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('');
    return item.type === 'UserMessage' ? { kind: 'user', text } : { kind: 'agent', text };
  }
  return null;
}

export interface CodexSessionWatchDeps {
  codexHome: () => string;
  now: () => number;
  /** Posts as the agent's terminal (production: the agent's own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
  /** codex's approval dialog on the agent's screen, as one line, or undefined. */
  dialogTitle: (agentId: string) => string | undefined;
  /** Told a turn was interrupted, before the agent's rest is posted (production: task-watch.ts, turnInterrupted). */
  interrupted?: (agentId: string, sessionId: string) => void;
  /** The session the agent's launch may resume (production: its resumableSessionId, utils/resume-session.ts). */
  resumableSessionOf?: (agentId: string) => string | undefined;
  /** Whether codex runs in the agent's terminal now (production: cliRunningIn). */
  codexRunning?: (agentId: string) => boolean;
  /**
   * Which of these agents' own codex holds this file open (production: the codex under each one's terminal and what it
   * started, by lsof or /proc, platform/open-files.ts): its id, null for none of them, undefined when it was not
   * learned (ps or lsof failed or timed out, or Windows, where no tool lists a process's files).
   */
  heldOpenBy?: (file: string, agentIds: string[]) => Promise<string | null | undefined>;
  /**
   * Whether a process's open files can be listed here (production: platform/open-files.ts, macOS and Linux). Where they
   * can, a lookup that learned nothing is asked again; where they cannot, it never will learn anything.
   */
  openFilesReadable?: () => boolean;
  /**
   * Why this agent's codex will start not signed in, when it will (production: codex-cli.ts codexSignInGap): asked off
   * the main thread at each launch, and said, through notSignedIn, while that launch still waits for its session.
   */
  signInGapOf?: (agentId: string) => Promise<string | undefined>;
  notSignedIn?: (agentId: string, text: string) => void;
}

interface Launch {
  agentId: string;
  cwd: string;
  at: number;
  /** The agent's own session, which the launch may resume: its rollout, and how long it was then. */
  resume?: { sessionId: string; file: string; size: number };
}
interface Bound {
  agentId: string;
  sessionId: string;
  offset: number;
  /** The last line read, with no end yet: its own bytes (linesOf). */
  pending: Buffer;
  registered: boolean;
  turnOpen: boolean;
  startPosted: boolean;
  asking: boolean;
  /** What codex wrote in the open turn, in order: the turn's answer is its report (reportOf), not its last line alone. */
  said?: string[];
  /** Bound as resumed: no session_meta comes, so its registration is posted at its first lines. */
  resumed?: boolean;
}

/** A session's time may read a little before the launch Tars noted: the two clocks are read apart. */
const LAUNCH_SLACK_MS = 2_000;
/**
 * A launch no session has matched in this long is given up on, once its codex no longer runs (a CLI that never
 * started, or that ended). Never while it runs: measured on 0.163, codex started with no prompt writes no rollout
 * before its first turn, which may come hours later.
 */
const LAUNCH_TTL_MS = 10 * 60_000;
/** A new rollout not settled yet, read from its head on: what its first lines say, and where its reading stopped. */
interface Head {
  offset: number;
  pending: Buffer;
  session?: Extract<CodexEvent, { kind: 'session' }>;
  firstUser?: string;
  /** Its first line is not a session's: nobody's. */
  notASession?: boolean;
  /** Read HEAD_CAP_BYTES in with no first message. */
  capped?: boolean;
  /** How many times whose codex holds it was asked and not learned, and when it is asked again. */
  unlearned?: number;
  askAgainAt?: number;
}

/** How long a new session waits for its first message, which may say whose it is, before it is settled without it. */
const IDENTITY_WAIT_MS = 10_000;
/** Tars's identity line (agent-guide.ts identityLine, and spawnAgentSession's header). */
const IDENTITY = /\[Tars: you are agent ".*?" \(id ([0-9a-fA-F-]{8,})\)/;
/**
 * How far into a new rollout its first message is looked for. Measured on 0.163: at 43 KB, after session_meta (19 KB),
 * codex's instructions and context; the project's AGENTS.md comes before it too, 32 KiB at most as codex reads it.
 */
const HEAD_CAP_BYTES = 1024 * 1024;
/** How much of a rollout's head one read takes. */
const HEAD_CHUNK_BYTES = 128 * 1024;
/**
 * How many times whose codex holds a session's file is asked when it is not learned (ps or lsof failed, or took more
 * than its 5 s under load: the Audit's L5 on #465), and how long after the first failure it is asked again, twice as
 * long each time: 1, 2, 4, 8 and 16 s, half a minute of a machine too loaded to answer at least.
 */
const HOLDER_ASKS = 6;
const HOLDER_RETRY_MS = 1_000;

function realOf(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/** The bytes of a file from `offset`, `max` of them at most. */
function readFrom(file: string, offset: number, max = Infinity): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const buffer = Buffer.alloc(Math.min(size - offset, max));
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return read === buffer.length ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The whole lines of what was read, after what the last read left: a line codex is still writing waits for its end,
 * kept as its own bytes (a copy, never a slice of the buffer it was read in: the heap rules), and a character cut
 * between two reads is decoded whole once the rest of it comes.
 */
function linesOf(state: { pending: Buffer }, chunk: Buffer): string[] {
  const data = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
  const lines: string[] = [];
  let start = 0;
  for (let end = data.indexOf(0x0a, start); end >= 0; end = data.indexOf(0x0a, start)) {
    lines.push(data.toString('utf8', start, end));
    start = end + 1;
  }
  state.pending = Buffer.from(data.subarray(start));
  return lines;
}

export class CodexSessionWatch {
  private launches: Launch[] = [];
  private bound = new Map<string, Bound>();
  /** Files read and found nobody's (another folder, before any launch, a subagent, no evidence): never read again. */
  private nobodys = new Set<string>();
  /** New rollouts not settled yet, each read on from where it stopped. */
  private heads = new Map<string, Head>();

  constructor(private deps: CodexSessionWatchDeps) {}

  setDeps(deps: Partial<CodexSessionWatchDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** A codex terminal was spawned for this agent: its session, from now on, is this one's. */
  noteLaunch(agentId: string, cwd: string): void {
    this.launches = this.launches.filter(l => l.agentId !== agentId);
    for (const [file, b] of this.bound) if (b.agentId === agentId) this.bound.delete(file);
    const launch: Launch = { agentId, cwd: realOf(cwd), at: this.deps.now() };
    // It may resume the agent's own session. Measured on 0.163: `codex resume`
    // appends to that session's rollout, under the day it began, and writes no
    // session_meta. The session is the agent's again once that file grows past
    // where it was now, unless a new session (a fresh start, a fork) comes first.
    const resumable = this.deps.resumableSessionOf?.(agentId);
    const file = resumable ? codexRolloutOf(resumable, this.deps.codexHome()) : undefined;
    if (resumable && file) {
      try { launch.resume = { sessionId: resumable, file, size: fs.statSync(file).size }; } catch { /* gone: a new session, then */ }
    }
    this.launches.push(launch);
    // A codex that will ask to sign in writes no session: said while this launch waits, not once a session came or a
    // later launch replaced it.
    this.deps.signInGapOf?.(agentId).then(
      text => { if (text && this.launches.includes(launch)) this.deps.notSignedIn?.(agentId, text); },
      () => { /* nothing known to say */ },
    );
  }

  /** Whether anything is waited on or followed: no codex agent, no reading. */
  get busy(): boolean {
    return this.launches.length > 0 || this.bound.size > 0;
  }

  /** The rollouts to look at: changed since the oldest launch waited on, in the day folders that can hold them. */
  filesToRead(): string[] {
    if (this.launches.length === 0) return [];
    const since = Math.min(...this.launches.map(l => l.at)) - LAUNCH_SLACK_MS;
    const sessions = path.join(this.deps.codexHome(), 'sessions');
    const days = new Set<string>();
    for (let at = since - 86_400_000; at <= this.deps.now() + 86_400_000; at += 86_400_000) {
      const d = new Date(at);
      days.add(path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
      days.add(path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')));
    }
    const files: string[] = [];
    for (const day of days) {
      let names: string[];
      try { names = fs.readdirSync(path.join(sessions, day)); } catch { continue; }
      for (const name of names) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue;
        const file = path.join(sessions, day, name);
        if (this.bound.has(file) || this.nobodys.has(file)) continue;
        try {
          if (fs.statSync(file).mtimeMs >= since) files.push(file);
        } catch { /* gone */ }
      }
    }
    return files.sort();
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    this.launches = this.launches.filter(l => now - l.at < LAUNCH_TTL_MS || this.deps.codexRunning?.(l.agentId) === true);
    this.bindResumed();
    await this.bindNew(now);
    for (const [file, b] of this.bound) await this.follow(file, b);
    for (const b of this.bound.values()) await this.lookForApproval(b);
  }

  private bindResumed(): void {
    for (const launch of [...this.launches]) {
      if (!launch.resume) continue;
      let size: number;
      try { size = fs.statSync(launch.resume.file).size; } catch { continue; }
      if (size <= launch.resume.size) continue;
      this.launches = this.launches.filter(l => l !== launch);
      this.nobodys.delete(launch.resume.file);
      this.bound.set(launch.resume.file, {
        agentId: launch.agentId, sessionId: launch.resume.sessionId, offset: launch.resume.size, pending: Buffer.alloc(0),
        registered: false, turnOpen: false, startPosted: false, asking: false, resumed: true,
      });
    }
  }

  private async bindNew(now: number): Promise<void> {
    const files = this.filesToRead();
    // What no launch waits for any more is not read on.
    for (const file of this.heads.keys()) if (!files.includes(file)) this.heads.delete(file);
    const read: Array<{ file: string; head: Head & { session: Extract<CodexEvent, { kind: 'session' }> } }> = [];
    for (const file of files) {
      let head = this.heads.get(file);
      if (!head) {
        head = { offset: 0, pending: Buffer.alloc(0) };
        this.heads.set(file, head);
      }
      try { this.readHead(file, head); } catch { continue; } // gone, or not readable for now
      if (head.notASession) this.settle(file, null);
      else if (head.session) read.push({ file, head: head as Head & { session: Extract<CodexEvent, { kind: 'session' }> } });
    }
    for (const { file, head } of read.sort((a, b) => a.head.session.at - b.head.session.at)) {
      const launch = await this.launchOf(file, head, now);
      if (launch === 'wait') continue;
      this.settle(file, launch);
      if (launch) {
        this.launches = this.launches.filter(l => l !== launch);
        this.bound.set(file, {
          agentId: launch.agentId, sessionId: head.session.id, offset: 0, pending: Buffer.alloc(0),
          registered: false, turnOpen: false, startPosted: false, asking: false,
        });
      }
    }
  }

  /** A new rollout's head read on from where it stopped: up to its first message, or HEAD_CAP_BYTES. */
  private readHead(file: string, head: Head): void {
    while (head.firstUser === undefined && !head.capped && !head.notASession) {
      const chunk = readFrom(file, head.offset, HEAD_CHUNK_BYTES);
      if (!chunk.length) return;
      head.offset += chunk.length;
      for (const line of linesOf(head, chunk)) {
        const event = codexEventOf(line);
        if (!head.session) {
          if (event?.kind !== 'session') { head.notASession = true; return; }
          head.session = event;
        } else if (event?.kind === 'user') {
          head.firstUser = event.text;
          break;
        }
      }
      if (head.firstUser === undefined && head.offset >= HEAD_CAP_BYTES) head.capped = true;
    }
  }

  /**
   * The launch a new session is, on evidence only: a fork of the session the launch may resume, Tars's identity line in
   * its first message, or its file held open by the agent's own codex. 'wait' while its first message may still come,
   * and while whose codex holds it is asked again after a lookup that learned nothing; null when no launch waits in its
   * folder since before it began, when its first message names an agent no waiting launch is, or when no waiting
   * agent's codex holds it, or that cannot be known (Windows), or was not learned in HOLDER_ASKS lookups.
   */
  private async launchOf(file: string, head: Head & { session: Extract<CodexEvent, { kind: 'session' }> }, now: number): Promise<Launch | null | 'wait'> {
    const { session } = head;
    if (session.subagent) return null;
    const cwd = realOf(session.cwd);
    const waiting = this.launches.filter(l => l.cwd === cwd && session.at >= l.at - LAUNCH_SLACK_MS);
    if (waiting.length === 0) return null;
    if (session.forkedFrom) {
      const forker = waiting.find(l => l.resume?.sessionId === session.forkedFrom);
      if (forker) return forker;
    }
    if (head.firstUser === undefined && !head.capped && now - session.at < IDENTITY_WAIT_MS) return 'wait';
    const named = head.firstUser?.match(IDENTITY)?.[1]?.toLowerCase();
    if (named) return waiting.find(l => l.agentId.toLowerCase() === named) ?? null;
    if (head.askAgainAt !== undefined && now < head.askAgainAt) return 'wait';
    const holder = await this.deps.heldOpenBy?.(file, waiting.map(l => l.agentId));
    if (holder === undefined && this.deps.heldOpenBy && this.deps.openFilesReadable?.()) {
      // Not learned (ps or lsof failed, or timed out): never bound on it, and asked again, later each time.
      head.unlearned = (head.unlearned ?? 0) + 1;
      if (head.unlearned < HOLDER_ASKS) {
        head.askAgainAt = now + HOLDER_RETRY_MS * 2 ** (head.unlearned - 1);
        return 'wait';
      }
      console.warn(`[codex-sessions] whose codex holds ${file} was not learned in ${HOLDER_ASKS} lookups (ps or lsof failed): nobody's`);
    }
    return (holder && waiting.find(l => l.agentId === holder)) || null;
  }

  /** A new rollout settled, bound or nobody's: its head is read no more. */
  private settle(file: string, launch: Launch | null): void {
    this.heads.delete(file);
    if (!launch) this.nobodys.add(file);
  }

  private post(b: Bound, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(b.agentId, { path: route, body: { agent_id: b.agentId, session_id: b.sessionId, ...body } });
  }

  private async follow(file: string, b: Bound): Promise<void> {
    let chunk: Buffer;
    try { chunk = readFrom(file, b.offset); } catch { return; }
    if (!chunk.length) return;
    b.offset += chunk.length;
    if (b.resumed && !b.registered) {
      b.registered = true;
      await this.post(b, '/api/hooks/status', { status: 'running', source: 'resume' });
    }
    // A last line with no end yet is still being written: it waits for the rest (linesOf).
    for (const line of linesOf(b, chunk)) {
      const event = codexEventOf(line);
      if (!event) continue;
      if (event.kind === 'session') {
        if (!b.registered) {
          b.registered = true;
          await this.post(b, '/api/hooks/status', { status: 'running', source: 'startup' });
        }
      } else if (event.kind === 'turn_started') {
        b.turnOpen = true;
        b.startPosted = false;
        b.said = [];
      } else if (event.kind === 'agent') {
        (b.said ??= []).push(event.text);
      } else if (event.kind === 'user') {
        if (b.turnOpen && !b.startPosted) {
          b.startPosted = true;
          await this.post(b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: event.text });
        }
      } else if (event.kind === 'turn_complete') {
        if (!b.startPosted) await this.post(b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit' });
        b.turnOpen = false;
        b.startPosted = false;
        b.asking = false;
        if (event.error) {
          await this.post(b, '/api/hooks/status', { status: 'error', error_kind: 'codex_turn_failed', error_message: event.error });
        } else {
          const answer = reportOf(b.said ?? []) ?? event.message;
          b.said = [];
          if (answer) await this.post(b, '/api/hooks/output', { hook: 'Stop', output: answer });
          await this.post(b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
          await this.post(b, '/api/hooks/agent-stopped', { hook: 'Stop' });
        }
      } else if (event.kind === 'turn_aborted' && b.turnOpen) {
        b.turnOpen = false;
        b.startPosted = false;
        b.asking = false;
        // No answer, and no task_complete will come: said interrupted first, then the rest codex is at.
        this.deps.interrupted?.(b.agentId, b.sessionId);
        await this.post(b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
      }
    }
  }

  private async lookForApproval(b: Bound): Promise<void> {
    if (!b.turnOpen) return;
    const title = this.deps.dialogTitle(b.agentId);
    if (title && !b.asking) {
      b.asking = true;
      await this.post(b, '/api/hooks/status', {
        status: 'waiting', waiting_reason: 'permission', tool_name: 'codex', tool_input: { command: title }, opened_at: this.deps.now(),
      });
    } else if (!title && b.asking) {
      b.asking = false;
      await this.post(b, '/api/hooks/status', { status: 'running' });
    }
  }
}

/** The one watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const codexSessionWatch = new CodexSessionWatch({
  codexHome: () => codexHome(),
  now: () => Date.now(),
  post: async () => {},
  dialogTitle: () => undefined,
});

/** Noted for every codex terminal Tars spawns (core/agent-pty.ts). */
export function noteCodexLaunch(agentId: string, cwd: string): void {
  codexSessionWatch.noteLaunch(agentId, cwd);
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads codex's sessions every second while a codex agent is launched or followed. */
export function startCodexSessionWatch(deps: Pick<CodexSessionWatchDeps, 'post' | 'dialogTitle' | 'interrupted' | 'resumableSessionOf' | 'codexRunning' | 'heldOpenBy' | 'openFilesReadable' | 'signInGapOf' | 'notSignedIn'>): void {
  codexSessionWatch.setDeps(deps);
  if (timer) return;
  let running = false;
  timer = setInterval(() => {
    if (running || !codexSessionWatch.busy) return;
    running = true;
    codexSessionWatch.tick()
      .catch(err => console.warn('[codex-sessions] a tick failed:', err instanceof Error ? err.message : err))
      .finally(() => { running = false; });
  }, 1000);
  timer.unref?.();
}
