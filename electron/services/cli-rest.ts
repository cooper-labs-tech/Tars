/**
 * Whether a codex or pi agent rests at its prompt, as Tars itself read it in that CLI's own session log (2.0.7; the
 * Audit's re-read of #594 at 82f13ebd2): set only by Tars's watchers (codex-sessions.ts, pi-sessions.ts) when they read
 * a turn's end, cleared when they read a turn's start or a hook says one began. A hook post never sets it: a Stop is
 * posted with the agent's own token, which the agent holds, and two posts mid-turn forged its rest. In memory only:
 * after a restart nothing rests until a turn's end is read again.
 */
const rests = new Map<string, string>();

/** The watcher read a turn's end for that agent, in that session of its CLI. */
export function restRead(agentId: string, sessionId: string): void {
  rests.set(agentId, sessionId);
}

/** A turn of that agent began, as a watcher read it or a hook said: no rest until its end is read. */
export function turnRead(agentId: string): void {
  rests.delete(agentId);
}

/** The session in which the agent was last read at rest, or undefined. */
export function restReadOf(agentId: string): string | undefined {
  return rests.get(agentId);
}
