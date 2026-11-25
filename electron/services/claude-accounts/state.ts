/**
 * What Tars knows about its Claude accounts that is not in the registry file,
 * in memory only: what Claude Code last said about each sign-in (the e-mail
 * and plan never reach a file, the Audit's N2), when a limit blocks an
 * account, and which agents were just sent to which account, so that agents
 * launched together spread out (N5); and the moves switching.ts asks for,
 * until the launch that makes them. Shared by the Settings handlers and the
 * launch path.
 */

export interface AuthState {
  signedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  error: string | null;
  /** `cli-missing`: there is no claude to ask (auth.ts ClaudeCliMissing). */
  code?: 'cli-missing' | null;
}

/** A move switching.ts asked for, made by the agent's next terminal launch. */
export interface RequestedMove {
  to: string;
  reason: 'limit' | 'threshold';
  window: 'fiveHour' | 'sevenDay';
  usedPercentage: number | null;
}

const auth = new Map<string, AuthState>();
const blocked = new Map<string, number>();
const moves = new Map<string, { accountId: string; at: number }>();
const requested = new Map<string, RequestedMove>();
const movedAt = new Map<string, number>();

/** How long a choice counts for an agent that has no terminal yet. */
export const MOVE_COUNTS_FOR_MS = 60_000;

export function getAuth(id: string): AuthState | undefined {
  return auth.get(id);
}

export function hasAuth(id: string): boolean {
  return auth.has(id);
}

export function setAuth(id: string, state: AuthState): void {
  auth.set(id, state);
}

export function deleteAuth(id: string): void {
  auth.delete(id);
  blocked.delete(id);
}

/** Epoch seconds. */
export function blockedUntil(): Record<string, number> {
  return Object.fromEntries(blocked);
}

/** An account hit a limit: skipped by the choice until then (epoch seconds). */
export function setBlocked(id: string, untilSeconds: number): void {
  blocked.set(id, untilSeconds);
}

export function requestMove(agentId: string, move: RequestedMove): void {
  requested.set(agentId, move);
}

export function pendingMove(agentId: string): RequestedMove | undefined {
  return requested.get(agentId);
}

/** The move asked for, handed to the launch that makes it, and forgotten. */
export function takeMove(agentId: string): RequestedMove | undefined {
  const move = requested.get(agentId);
  requested.delete(agentId);
  return move;
}

/** When Tars last moved this agent on its own (epoch ms). */
export function lastMovedAt(agentId: string): number | undefined {
  return movedAt.get(agentId);
}

export function noteMovedAt(agentId: string, at: number): void {
  movedAt.set(agentId, at);
}

export function noteMove(agentId: string, accountId: string, now: number = Date.now()): void {
  moves.set(agentId, { accountId, at: now });
}

/** Agents sent to an account in the last minute, by agent. */
export function recentMoves(now: number = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  for (const [agentId, m] of moves) {
    if (now - m.at > MOVE_COUNTS_FOR_MS) moves.delete(agentId);
    else out.set(agentId, m.accountId);
  }
  return out;
}

/** For tests: forget everything. */
export function resetAccountState(): void {
  auth.clear();
  blocked.clear();
  moves.clear();
  requested.clear();
  movedAt.clear();
}
