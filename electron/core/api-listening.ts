/**
 * Whether an agent's CLI may start: true once this Tars listens on its port, false once it gave the port up, and
 * waited for while it tries (the Audit's H1 on #541). Claude's MCP calls to Tars's shared servers carry the agent's
 * token to whatever holds the port, with no proof it is this Tars (services/mcp-shared.ts): an agent started while
 * Tars retried its port, about 90 s at launch, handed its token to the process holding it. Every agent's CLI is
 * spawned after this answers true (the five calls of spawnAgentPty's callers). A process that never started an API (a
 * unit test) is not held.
 *
 * The API server tells it its phase (services/api-server.ts): a module of its own, so the core can wait on it without
 * importing the server and everything the server imports.
 */

type Phase = 'stopped' | 'starting' | 'retrying' | 'listening' | 'failed';

let phase: Phase = 'stopped';
const waiters = new Set<() => void>();

const decided = (p: Phase): boolean | undefined => (p === 'listening' || p === 'stopped' ? true : p === 'failed' ? false : undefined);

export function noteApiPhase(next: Phase): void {
  phase = next;
  if (decided(phase) === undefined) return;
  for (const w of [...waiters]) w();
}

export function apiListening(): Promise<boolean> {
  const now = decided(phase);
  if (now !== undefined) return Promise.resolve(now);
  return new Promise(resolve => {
    const w = () => {
      const v = decided(phase);
      if (v === undefined) return;
      waiters.delete(w);
      resolve(v);
    };
    waiters.add(w);
  });
}

/** Thrown by a start refused because Tars gave its port up: its agents could not call it back anyway. */
export const NOT_LISTENING = 'Tars is not listening on its port (another process holds it), so no agent starts: its token would go to that process';
