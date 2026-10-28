import type { AgentStatus } from '@/types/electron';
import { flat, when } from '@/lib/stop-line';

/**
 * What a permission question Tars holds says, wherever it is shown: a panel's
 * line under its header, the top of the agent window's terminal column, the
 * card's task line. Since PR 318 a Claude agent that runs the state mod asks
 * Tars, not its terminal, before a call Claude Code would put to its dialog:
 * it reads `waiting` with `permissionAsk` set, which names what the call
 * acts on, whole (`subject`, electron/services/permission-asks.ts). Frame:
 * `Permission asked of Tars` in design/tars-redesign.pen. Its failures are listed, and pinned, in
 * __tests__/lib/permission-ask.test.ts.
 */
export interface PermissionAskLine {
  /** "Asks to use Bash:", or "Asks to use <tool>" with nothing more to name. */
  who: string;
  /** The command, the file, the address or the search; '' when there is none. Each line break marked ⏎. */
  subject: string;
  /** The same, line by line, for a window that shows each on its own; [] when there is none. */
  lines: string[];
  /** "asked at 14:02", "asked on 4 Oct at 23:58", '' for a time that does not parse. */
  at: string;
  /** The whole sentence, for a title. */
  title: string;
  /** Why Claude Code asks, whole, as it said it; '' when it did not. */
  reason: string;
  /** The settings rule that asked, such as `Bash(rm:*)`; '' when none did. */
  rule: string;
}

/**
 * The line, or null when Tars holds no question for this agent. Only while it
 * waits: a copy of an agent allowed and running again may still carry the
 * permissionAsk it had. A waiting agent with no permissionAsk is at its
 * terminal's dialog, which only the terminal answers. The subject is the
 * question's own, whole (the gate of PR 318, Medium 2): waitingOn is cut at 200
 * characters and hidden once an interrupt is recorded, and what is allowed
 * must be what was read. The reason and the rule are Claude Code's, kept
 * whole: in bypass, an ask rule is the only reason a call comes to Tars. Each
 * is flattened like the rest, since the agent's own shell can ask with any.
 */
/** A line break in what is asked: \r\n, \r, \n, U+0085, U+2028 and U+2029, each one. */
const BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/;
export const BREAK_MARK = '⏎';

/**
 * The subject's lines, each flattened as the rest is, none at either end. A break is never read as a space: "echo
 * safe" then "rm -rf important" are two commands, and an allow covers both (the Audit's M1 on PR 544).
 */
function linesOf(text: string | undefined): string[] {
  const lines = (text ?? '').split(BREAKS).map(flat);
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

export function permissionAskLine(
  agent: Pick<AgentStatus, 'status' | 'permissionAsk'>,
  now = new Date(),
): PermissionAskLine | null {
  if (agent.status !== 'waiting' || !agent.permissionAsk) return null;
  const tool = flat(agent.permissionAsk.tool);
  const lines = linesOf(agent.permissionAsk.subject);
  // A file is named "Read /path", and a tool with nothing to name by itself.
  if (lines.length && lines[0].startsWith(`${tool} `)) lines[0] = lines[0].slice(tool.length + 1).trim();
  if (lines.length === 1 && lines[0] === tool) lines.length = 0;
  const subject = lines.join(` ${BREAK_MARK} `);
  const who = subject ? `Asks to use ${tool}:` : `Asks to use ${tool}`;
  const time = when(agent.permissionAsk.askedAt, now);
  return {
    who, subject, lines, at: time && `asked ${time}`, title: subject ? `${who} ${subject}` : who,
    reason: flat(agent.permissionAsk.reason), rule: flat(agent.permissionAsk.rule),
  };
}
