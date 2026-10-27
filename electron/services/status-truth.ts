import * as fs from 'fs';
import type { AgentStatus } from '../types';
import { agents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { sessionStarting } from '../core/agent-launch';
import { hasClaudeHooks } from '../core/end-of-turn';
import { getProvider } from '../providers';
import { spellingsOf, transcriptPath } from '../utils/resume-session';
import type { HookPost } from './codex-sessions';
import { tellNotTaken } from './agent-watch';

/**
 * An agent's status put right from its CLI's own record when an event never
 * reached Tars (the DB brief of 28/10, item B of the resources plan).
 *
 * The hooks keep the status: UserPromptSubmit says a turn began, Stop that it
 * ended, SessionEnd that the CLI is gone. Measured on 28/10 over 19 agents
 * (reports/db-status-and-sleep-2810.md), they fire for every way a turn starts,
 * a background task's notification included (114 of 116 such turns had their
 * UserPromptSubmit), but what Tars does between them is not always confirmed:
 * - Kotsna-QA's Stop reached Tars at 19:23:30.659Z, and in the same millisecond
 *   Tars typed the next queued task and read the agent `running`. The CLI never
 *   took it: no UserPromptSubmit, nothing in its transcript. Tars showed it
 *   working at its prompt for 42 minutes, and the six tasks queued behind it
 *   waited for an end of turn that had already come;
 * - Parallel-Frontend's claude exited mid-turn (no Stop, and SessionEnd's post
 *   never landed) and left the shell it was typed into: `running` with no CLI,
 *   for two days.
 * So, every STATUS_EVERY_MS, each agent's status is set against two things Tars
 * already reads: whether a CLI runs in its terminal (cliRunningIn), and the
 * last turn as its transcript records it (turnOnRecord): Claude Code writes the
 * prompt, the model's entries, and an end of its own (`turn_duration`, or the
 * interrupt marker for a turn cut with no Stop at all; 8 of 8 Stops of one
 * session on 2.1.306 were followed by a `turn_duration`). Never on silence: a
 * transcript that has not moved for an hour, in a turn on record, is a turn
 * (a long Bash, a long MCP wait). What is put right is posted on the hooks'
 * own route, as the terminal, as codex-sessions.ts posts codex's turns: the
 * route decides, its guards and its consequences (the desktop notice, the
 * requester's, the window) are the ones the lost event would have had.
 */

const asked = Number(process.env.DOROTHY_STATUS_EVERY_MS);
/** Every 30 s; a test run may ask for a shorter period (DOROTHY_STATUS_EVERY_MS, under DOROTHY_E2E only, 200 ms at least). */
export const STATUS_EVERY_MS = process.env.DOROTHY_E2E === '1' && Number.isFinite(asked) && asked >= 200 ? asked : 30_000;

/** A turn as the transcript's tail records it. `lastAt`: its last entry; `endedAt`: the last end written. */
export interface TurnRecord { inTurn: boolean; lastAt?: number; endedAt?: number }

/** How much of a transcript is read: its last entries, never the whole file (93 MB measured for one session). */
const TAIL_BYTES = 256 * 1024;

const INTERRUPTED = /^\[Request interrupted by user/;
/** A local command: no model call, no Stop (`/compact`, `/model`), and what it prints. */
const LOCAL = /^<(command-name|command-message|local-command-)/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
}

/**
 * The last turn as the tail of a Claude Code transcript records it, or
 * undefined when the tail holds nothing of a turn. The first line, cut by the
 * read, and any line that is not JSON are skipped. A turn's entries are the
 * prompt, the model's answers and the tool results; its end is `system`
 * `turn_duration`, written once the Stop hooks let it end, or the interrupt
 * marker. A meta entry, a compact summary, a local command, a
 * subagent's sidechain and the bookkeeping entries (a queue operation, an
 * attachment, a title, a mode) are none of these.
 */
export function turnOnRecord(tail: string): TurnRecord | undefined {
  let inTurn: boolean | undefined;
  let lastAt: number | undefined;
  let endedAt: number | undefined;
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e: { type?: unknown; subtype?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || e.isSidechain === true) continue;
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    const stamp = Number.isFinite(t) ? t : undefined;
    // Not `stop_hook_summary` alone: a Stop hook that blocks writes it, and the turn goes on.
    if (e.type === 'system' && e.subtype === 'turn_duration') {
      inTurn = false;
      endedAt = stamp ?? endedAt;
      continue;
    }
    if (e.type === 'assistant') {
      inTurn = true;
      lastAt = stamp ?? lastAt;
      continue;
    }
    if (e.type !== 'user' || e.isMeta === true || e.isCompactSummary === true) continue;
    const text = textOf(e.message?.content).trimStart();
    if (INTERRUPTED.test(text)) {
      inTurn = false;
      endedAt = stamp ?? endedAt;
      continue;
    }
    if (LOCAL.test(text)) continue;
    inTurn = true;
    lastAt = stamp ?? lastAt;
  }
  if (inTurn === undefined) return undefined;
  return { inTurn, ...(lastAt !== undefined ? { lastAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}) };
}

export interface StatusFacts {
  status: AgentStatus['status'];
  waitingReason?: string;
  now: number;
  /** A CLI runs in its terminal (cliRunningIn); false with no terminal. */
  cliRunning: boolean;
  /** A launch is on its way (sessionStarting). */
  starting: boolean;
  statusSince?: string;
  lastTurnStartedAt?: string;
  workHandedAt?: string;
  /** Its last turn on record, or undefined for a CLI whose transcript Tars does not read, or none read. */
  record: TurnRecord | undefined;
}

export type StatusFix =
  | { status: 'completed'; why: 'no-cli' }
  | { status: 'idle'; why: 'not-taken' | 'turn-ended' }
  | { status: 'running'; why: 'turn-on-record' };

const time = (iso: string | undefined) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : undefined;
};

/**
 * What the status should be, or null to leave it. `every` is the pass's
 * period: four passes are the grace a launch, a hand-over or a turn start has
 * before anything is read into its absence, and a sixth of one the margin
 * between a rest and a write that ends it.
 * - `running`, or a dialog's `waiting`, with no CLI in the terminal: the CLI is
 *   gone, `completed`, as its SessionEnd would have posted;
 * - `running` while the record says the last turn ended: `idle`, `not-taken`
 *   when a message was handed after the last turn began (the CLI never took
 *   it), `turn-ended` otherwise (a Stop that never reached Tars);
 * - at rest while the record shows a turn written lately, after the rest
 *   began: `running` (a start that never reached Tars).
 */
export function statusFix(f: StatusFacts, every: number = STATUS_EVERY_MS): StatusFix | null {
  const grace = 4 * every;
  const handed = time(f.workHandedAt);
  const started = time(f.lastTurnStartedAt);
  const lately = [handed, started].some((t) => t !== undefined && f.now - t < grace);
  const working = f.status === 'running' || (f.status === 'waiting' && f.waitingReason !== 'idle');
  if (working && !f.cliRunning) return f.starting || lately ? null : { status: 'completed', why: 'no-cli' };
  if (!f.cliRunning || !f.record) return null;
  if (f.status === 'running') {
    if (f.record.inTurn || f.starting || lately) return null;
    const notTaken = handed !== undefined && (started === undefined || handed > started);
    return { status: 'idle', why: notTaken ? 'not-taken' : 'turn-ended' };
  }
  const resting = f.status === 'idle' || (f.status === 'waiting' && f.waitingReason === 'idle');
  if (!resting || !f.record.inTurn || f.record.lastAt === undefined) return null;
  const since = time(f.statusSince);
  if (since === undefined || f.now - f.record.lastAt >= grace || f.record.lastAt <= since + every / 6) return null;
  return { status: 'running', why: 'turn-on-record' };
}

/** The agent's newest transcript among the spellings of the folders its CLI may run in, Claude Code's only. */
function transcriptOf(agent: AgentStatus): string | undefined {
  const sessionId = agent.currentSessionId;
  if (!sessionId || !hasClaudeHooks(agent) || getProvider(agent.provider).binaryName !== 'claude') return undefined;
  let best: { file: string; mtimeMs: number } | undefined;
  for (const root of [agent.ptyCwd, agent.worktreePath, agent.projectPath]) {
    if (!root) continue;
    for (const spelling of spellingsOf(root)) {
      const file = transcriptPath(spelling, sessionId);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch { /* not this spelling */ }
    }
  }
  return best?.file;
}

/** The last read of each transcript, kept while it has not changed: most agents' do not between two passes. */
const readOf = new Map<string, { size: number; mtimeMs: number; record: TurnRecord | undefined }>();

export function turnRecordOf(agent: AgentStatus): TurnRecord | undefined {
  const file = transcriptOf(agent);
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    const known = readOf.get(file);
    if (known && known.size === size && known.mtimeMs === mtimeMs) return known.record;
    const length = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(length);
    fs.readSync(fd, tail, 0, length, size - length);
    // A read from the start keeps its first line; one cut by the tail drops it.
    const text = tail.toString('utf-8');
    const record = turnOnRecord(length < size ? text.slice(text.indexOf('\n') + 1) : text);
    readOf.delete(file);
    readOf.set(file, { size, mtimeMs, record });
    while (readOf.size > 64) readOf.delete(readOf.keys().next().value as string);
    return record;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** What the rule reads of an agent, from the fleet as it is. */
export function statusFactsOf(agent: AgentStatus, now: number): StatusFacts {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  return {
    status: agent.status,
    waitingReason: agent.waitingReason,
    now,
    cliRunning: cliRunningIn(terminal),
    starting: sessionStarting(agent),
    statusSince: agent.statusSince,
    lastTurnStartedAt: agent.lastTurnStartedAt,
    workHandedAt: agent.workHandedAt,
    record: turnRecordOf(agent),
  };
}

/**
 * One look at the fleet: each status put right is posted on the hooks' route
 * as the agent's terminal (`post`, main.ts's postAsTerminal), naming the
 * session it holds. An agent with no session to name, or no terminal to post
 * as, is put right here, the window told.
 */
export async function checkStatuses(post: (agentId: string, p: HookPost) => Promise<void>, now: number = Date.now(), every: number = STATUS_EVERY_MS): Promise<Array<{ agentId: string } & StatusFix>> {
  const fixed: Array<{ agentId: string } & StatusFix> = [];
  for (const agent of agents.values()) {
    if (agent.status !== 'running' && agent.status !== 'waiting' && agent.status !== 'idle') continue;
    const fix = statusFix(statusFactsOf(agent, now), every);
    if (!fix) continue;
    console.log(`[status] ${agent.name || agent.id}: ${agent.status} -> ${fix.status} (${fix.why})`);
    const from = agent.status;
    agent.statusReconciled = { from, to: fix.status, why: fix.why, at: new Date(now).toISOString() };
    fixed.push({ agentId: agent.id, ...fix });
    if (agent.currentSessionId) {
      await post(agent.id, { path: '/api/hooks/status', body: { agent_id: agent.id, session_id: agent.currentSessionId, status: fix.status, event: 'Reconciled', reason: fix.why } });
    }
    // Not taken by the route (no session, no terminal's token): put right here.
    if (agents.get(agent.id) === agent && agent.status === from) {
      agent.status = fix.status;
      agent.waitingReason = undefined;
      announceFix(agent);
    }
    // No turn began on what it was handed: no end of turn will tell its sender.
    if (fix.why === 'not-taken' && agent.status === 'idle') tellNotTaken(agent);
  }
  return fixed;
}

let announce: ((agent: AgentStatus) => void) | undefined;
function announceFix(agent: AgentStatus): void {
  announce?.(agent);
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startStatusWatch(opts: { post: (agentId: string, p: HookPost) => Promise<void>; announce: (agent: AgentStatus) => void }): void {
  if (timer) return;
  announce = opts.announce;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    checkStatuses(opts.post).catch((err) => console.warn('[status] check failed:', err)).finally(() => { running = false; });
  }, STATUS_EVERY_MS);
  timer.unref?.();
}

export function stopStatusWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
