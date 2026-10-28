import * as fs from 'fs';
import { transcriptPath, transcriptRoots } from '../utils/resume-session';

/**
 * Whether a task Tars started a session on has gone in, and what to do when no turn says so yet (the DB brief
 * fix-twin-deliveries-2810.md, the orchestrators' feedback of 28/10): read by the delivery check in
 * agent-manager.ts before it types the task again or says it never began.
 *
 * Measured over 23 to 28/10: three launch tasks typed again by Tars into a session that already held them (300 s,
 * 894 s and 3899 s after the first), each run twice. The check typed the task again 15 s after the session
 * registered, by the clock alone, while the CLI still ran its UserPromptSubmit hooks (36 s under a load of 280 on
 * 27/10): the CLI queued the copy and ran it as a second turn. Then it said `error`, "never began", of a task that ran.
 *
 * So the clock decides nothing. A task is in when a turn began after the session registered, or when the CLI's own
 * record holds it (its prompt's entry, or a copy it queued). It is typed again only on proof that the CLI dropped
 * it: the CLI said it is idle at its prompt (Claude Code's idle_prompt notification, which a CLI still running its
 * hooks never sends) and nothing of the task is on record. Typed again once, and dropped again the same way, it
 * never began.
 */

export type DeliveryVerdict = 'taken' | 'wait' | 'retype' | 'never-began';

export interface DeliveryFacts {
  /** When the session registered (ms). */
  registeredAt: number;
  /** The last turn's start (UserPromptSubmit), ms. */
  turnStartedAt?: number;
  /** The last idle prompt Claude Code sent for this agent (ms). */
  idlePromptAt?: number;
  /** When Tars typed the task again, if it did (ms). */
  retypedAt?: number;
  /** The task is on the CLI's record (taskOnRecord). */
  onRecord: boolean;
}

export function deliveryVerdict(f: DeliveryFacts): DeliveryVerdict {
  if (f.turnStartedAt !== undefined && f.turnStartedAt > f.registeredAt) return 'taken';
  if (f.onRecord) return 'taken';
  const since = f.retypedAt ?? f.registeredAt;
  if (f.idlePromptAt === undefined || f.idlePromptAt <= since) return 'wait';
  return f.retypedAt === undefined ? 'retype' : 'never-began';
}

/** How much of the task is looked for: its first line, enough to tell it from another. */
const PROBE_CHARS = 60;

/**
 * Whether the tail of a Claude Code transcript holds the task as handed to the CLI: in a prompt's entry, a queued
 * command, or the CLI's own queue. Searched as JSON writes it (quotes and line breaks escaped), never in what the
 * model wrote.
 */
export function taskOnRecord(tail: string, task: string): boolean {
  const first = task.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!first) return false;
  const probe = JSON.stringify(first.slice(0, PROBE_CHARS)).slice(1, -1);
  for (const line of tail.split('\n')) {
    if (!line.includes(probe)) continue;
    let e: { type?: unknown };
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'user' || e?.type === 'queue-operation' || e?.type === 'attachment') return true;
  }
  return false;
}

const TAIL_BYTES = 512 * 1024;

/** The tail of the agent's session transcript, from the folders its CLI may run in; '' when there is none. */
export function sessionTail(agent: { currentSessionId?: string; ptyCwd?: string; worktreePath?: string; projectPath?: string }): string {
  const sessionId = agent.currentSessionId;
  if (!sessionId) return '';
  for (const root of transcriptRoots(agent.ptyCwd, agent.worktreePath, agent.projectPath)) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(transcriptPath(root, sessionId), 'r');
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf-8');
    } catch {
      /* not this root */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return '';
}
