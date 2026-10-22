import type { AgentStatus } from '@/types/electron';

/**
 * What an agent blocked on its CLI's word says of it (OSC 7501, the Program Status Protocol, #510): the kind, the
 * status word, the line its card and its panel show, their ink, and the panel's action. A hook's state always wins on
 * the status; this only adds the reason a CLI gave. Frame: `Blocked (2.0.5) · an agent blocked, its reason`.
 */
export interface BlockedReason {
  kind: 'permission' | 'question' | 'auth';
  /** The status word: `waiting · permission`, `waiting · question`, or `blocked · sign in`. */
  word: string;
  /** The message, as the CLI wrote it, or what its kind means when it wrote none. */
  line: string;
  /** A sign-in reads in the error ink: nothing goes on until the user acts. */
  tone: 'waiting' | 'error';
  /** The panel's action: answer for a question, open for the others. Both bring its terminal forward. */
  action: 'open' | 'answer';
}

export function blockedReason(agent: Pick<AgentStatus, 'programStatus'>): BlockedReason | null {
  const status = agent.programStatus;
  if (status?.state !== 'blocked' || !status.kind) return null;
  const msg = status.msg?.trim();
  switch (status.kind) {
    case 'permission':
      return { kind: 'permission', word: 'waiting · permission', line: msg || 'Asks permission in its terminal', tone: 'waiting', action: 'open' };
    case 'question':
      return { kind: 'question', word: 'waiting · question', line: msg ? `Asks: ${msg}` : 'Asks a question in its terminal', tone: 'waiting', action: 'answer' };
    case 'auth':
      return { kind: 'auth', word: 'blocked · sign in', line: msg || 'Signed out: sign in again in its terminal', tone: 'error', action: 'open' };
    default:
      return null;
  }
}
