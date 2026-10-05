import type { AgentStatus } from '@/types/electron';

/**
 * Who stopped an agent, when and why, in one sentence: "Stopped by
 * Orchestrator at 14:02: frozen on a file read for 40 minutes". It goes where
 * an error gives its reason (the card's task line, the pane header's branch,
 * the window's path, the second line of a row in an orchestrator's rail), and
 * is the title of the word `stopped`. Frame: `Agent stopped · who and why` in
 * design/tars-redesign.pen. Its failures are listed, and pinned, in
 * __tests__/lib/stop-line.test.ts.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Longest caller name drawn before it is cut, in code points, as MessageWaitingNotice cuts a sender's. */
const MAX_NAME = 40;

/**
 * What hides or rearranges text, or breaks a line: the class MessageWaitingNotice
 * flattens in a sender's name, for the same reason. `stoppedBy` is an agent's
 * name as its owner typed it, and a U+202E in it would turn the time and the
 * reason around on screen. The main process cleans the reason more narrowly.
 */
const HIDDEN_OR_LINE_BREAKING = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;

export const flat = (text: string | undefined) => (text ?? '').replace(HIDDEN_OR_LINE_BREAKING, ' ').replace(/\s+/g, ' ').trim();

/** Cut by code points, so a character beyond the BMP is never split in two. */
export function caller(name: string | undefined): string {
  const points = [...flat(name)];
  return points.length > MAX_NAME ? `${points.slice(0, MAX_NAME - 1).join('')}…` : points.join('');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "at 14:02" today, "on 30 Sep at 23:58" another day, with the year when it is not this one. */
export function when(iso: string | undefined, now: Date): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  if (sameYear && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return `at ${time}`;
  return `on ${at.getDate()} ${MONTHS[at.getMonth()]}${sameYear ? '' : ` ${at.getFullYear()}`} at ${time}`;
}

/** The sentence, or null for an agent that is not stopped, whatever a stop left behind. */
export function stopLine(
  agent: Pick<AgentStatus, 'status' | 'stoppedBy' | 'stoppedAt' | 'stopReason'>,
  now = new Date(),
): string | null {
  if (agent.status !== 'stopped') return null;
  const by = caller(agent.stoppedBy);
  const head = ['Stopped', by && `by ${by}`, when(agent.stoppedAt, now)].filter(Boolean).join(' ');
  const reason = flat(agent.stopReason);
  return reason ? `${head}: ${reason}` : head;
}
