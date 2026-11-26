import type { AgentStatus, ClaudeAccountMove, ClaudeAccountsSettings } from '../../types';
import { agents } from '../../core/agent-manager';
import { restartForSettings } from '../../core/agent-restart';
import { ptyProcesses, writeProgrammaticInput } from '../../core/pty-manager';
import { cliRunningIn } from '../../core/agent-pty';
import { dialogOpen, sessionStarted } from '../../core/agent-launch';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { DEFAULT_ACCOUNT_ID, readAccountsSettings } from './registry';
import { readAccountUsage } from './counters';
import type { AccountUsage } from './choose';
import { choiceFor, isClaudeSubscription } from './launch';
import { blockedUntil, lastMovedAt, noteMovedAt, requestMove, setBlocked, type RequestedMove } from './state';

/**
 * Moving agents between Claude accounts on their own (DESIGN-COMPTES-CLAUDE.md
 * B4, with the Audit's N4 and N6). With the option off, nothing here does
 * anything.
 *
 * Two moments, never in the middle of a turn:
 * - a turn cut by the account's limit (StopFailure `rate_limit`): the account
 *   is blocked until that window resets, and the agent is restarted on the
 *   account with most room, on the same conversation, then told to continue.
 *   A 429 that is not the plan's limit blocks nothing (N4);
 * - a turn ended (Stop) on an account past one of its thresholds: the agent is
 *   restarted on the account with most room, and nothing is typed, since
 *   nothing was cut.
 *
 * Never a pinned agent (its account is still blocked for the others), never
 * to an account without room, once per agent every ten minutes at most. With
 * every account at its limit the agent waits where it is, as Claude Code does
 * by itself, unless another account comes back first: then the move is set for
 * that account's reset.
 *
 * A move is asked of agent-restart.ts, which waits for whatever the agent is
 * doing (a draft, a note owed to it, background work) and relaunches it on its
 * conversation; the launch (launch.ts) makes the move, and main.ts hands it
 * back here to be told to the windows (movedLaunch).
 */

export const MOVE_EVERY_MS = 10 * 60_000;

/**
 * How long after the turn's end the restart is asked for: agent-watch types
 * what it held for the agent at that same status change, and a restart must
 * see that write before it decides the field is free.
 */
export const RESTART_AFTER_MS = 500;

/** How long a moved agent's new session has to come up before "Continue" is given up. */
export const CONTINUE_WAIT_MS = 3 * 60_000;

/** Typed after a move for a limit: the cut prompt is in the conversation, and a turn has to start again. */
export const CONTINUE_MESSAGE = 'Continue where you left off: your last turn was cut by a usage limit and you are now on another Claude account.';

const FIVE_HOURS_S = 5 * 3600;

/**
 * Claude Code's names for its plan windows, in "You've hit your <name>"
 * (read from the 2.1.285 binary). A monthly spend limit, usage credits and a
 * team's budget are not a window another account has room in.
 */
const PLAN_LIMITS: [RegExp, 'fiveHour' | 'sevenDay'][] = [
  [/You've hit your session limit/i, 'fiveHour'],
  [/You've hit your (weekly|Opus|Sonnet) limit/i, 'sevenDay'],
];

type Window = 'fiveHour' | 'sevenDay';

function liveWindow(usage: AccountUsage | undefined, window: Window, now: number): { usedPercentage: number; resetsAt: number } | null {
  const w = usage?.[window];
  return w && w.resetsAt * 1000 > now ? w : null;
}

/**
 * The plan window a limit hit, and when the account has room again (epoch
 * seconds): the counter's reset when it is ahead, five hours otherwise. Null
 * for anything that is not the plan's limit (N4).
 */
export function usageLimitFrom(message: string | undefined, usage: AccountUsage | undefined, now: number): { window: Window; resetsAt: number } | null {
  let window: Window | undefined = PLAN_LIMITS.find(([pattern]) => pattern.test(message ?? ''))?.[1];
  if (!window) {
    window = (['fiveHour', 'sevenDay'] as const).find(w => (liveWindow(usage, w, now)?.usedPercentage ?? 0) >= 100);
  }
  if (!window) return null;
  return { window, resetsAt: liveWindow(usage, window, now)?.resetsAt ?? Math.floor(now / 1000) + FIVE_HOURS_S };
}

/** Timers set for a move at another account's reset, by agent. */
const comebacks = new Map<string, ReturnType<typeof setTimeout>>();

function whereFrom(agent: AgentStatus): string {
  return agent.claudeAccountId ?? DEFAULT_ACCOUNT_ID;
}

function moving(settings: ClaudeAccountsSettings, agent: AgentStatus): boolean {
  // An agent on a remote host runs on that host's own sign-in, never one of these accounts (the Audit's L1 on #600):
  // its limit blocks none of them, and a move's restart would only end its session there.
  return settings.enabled && isClaudeSubscription(agent) && !agent.remote;
}

/**
 * Asks for the move when the choice gives the agent another account with
 * room: true when it did, or set one for a reset to come (limit only).
 */
function planMove(agent: AgentStatus, why: Omit<RequestedMove, 'to'>, settings: ClaudeAccountsSettings, now: number): boolean {
  if (agent.claudeAccountPin) return false;
  const last = lastMovedAt(agent.id);
  if (last !== undefined && now - last < MOVE_EVERY_MS) return false;

  const from = whereFrom(agent);
  const choice = choiceFor(agent, settings, { agents: agents.values(), usage: readAccountUsage(), now, ignorePin: true });
  if (choice.reason === 'most-headroom' && choice.accountId !== from) {
    const name = agent.name || agent.id;
    console.log(`[claude-accounts] ${name}: moving from ${from} to ${choice.accountId} (${why.reason}, ${why.window})`);
    clearComeback(agent.id);
    requestMove(agent.id, { ...why, to: choice.accountId });
    noteMovedAt(agent.id, now);
    const timer = setTimeout(() => { restartForSettings(agent.id, ['claudeAccount'], { always: true }); }, RESTART_AFTER_MS);
    timer.unref?.();
    return true;
  }

  // Every account at its limit: the one that comes back first. When that is
  // not this agent's own, move there at its reset.
  const ownBack = blockedUntil()[from] ?? 0;
  if (why.reason === 'limit' && choice.reason === 'all-at-limit' && choice.accountId !== from
    && choice.comesBackAt !== undefined && choice.comesBackAt < ownBack) {
    setComeback(agent.id, choice.comesBackAt, why);
    return true;
  }
  return false;
}

function clearComeback(agentId: string): void {
  const timer = comebacks.get(agentId);
  if (timer) clearTimeout(timer);
  comebacks.delete(agentId);
}

function setComeback(agentId: string, atSeconds: number, why: Omit<RequestedMove, 'to'>): void {
  clearComeback(agentId);
  const timer = setTimeout(() => {
    comebacks.delete(agentId);
    const agent = agents.get(agentId);
    const settings = readAccountsSettings();
    // Moved, stopped or pinned since, or the option turned off: nothing to do.
    if (!agent || !moving(settings, agent)) return;
    if ((blockedUntil()[whereFrom(agent)] ?? 0) * 1000 <= Date.now()) return;
    planMove(agent, why, settings, Date.now());
  }, Math.max(0, atSeconds * 1000 - Date.now()) + 1000);
  timer.unref?.();
  comebacks.set(agentId, timer);
}

/**
 * A turn ended on a usage limit (StopFailure `rate_limit`, with the CLI's own
 * message). True when the agent is being moved, or will be at another
 * account's reset: the "error" notification then says nothing Tars is not
 * already acting on.
 */
export function onUsageLimit(agent: AgentStatus, message: string | undefined, now: number = Date.now()): boolean {
  const settings = readAccountsSettings();
  if (!moving(settings, agent)) return false;
  const from = whereFrom(agent);
  const limit = usageLimitFrom(message, readAccountUsage()[from], now);
  if (!limit) return false;
  setBlocked(from, limit.resetsAt);
  console.log(`[claude-accounts] ${from} hit its ${limit.window === 'fiveHour' ? '5 h' : 'weekly'} limit: skipped until ${new Date(limit.resetsAt * 1000).toISOString()}`);
  return planMove(agent, { reason: 'limit', window: limit.window, usedPercentage: 100 }, settings, now);
}

/** A turn ended (Stop): a move at rest when its account is past a threshold. */
export function onTurnEnded(agent: AgentStatus, now: number = Date.now()): boolean {
  if (agent.status === 'running') return false;
  const settings = readAccountsSettings();
  if (!moving(settings, agent) || !agent.claudeAccountId) return false;
  // A stale counter needs no check here: the choice reads it as unknown, and
  // keeps the agent where it is.
  const usage = readAccountUsage()[agent.claudeAccountId];
  if (!usage) return false;
  const thresholds: Record<Window, number> = { fiveHour: settings.fiveHourThreshold, sevenDay: settings.weeklyThreshold };
  const window = (['fiveHour', 'sevenDay'] as const).find(w => (liveWindow(usage, w, now)?.usedPercentage ?? 0) >= thresholds[w]);
  if (!window) return false;
  return planMove(agent, { reason: 'threshold', window, usedPercentage: liveWindow(usage, window, now)!.usedPercentage }, settings, now);
}

/**
 * The launch that made a move (main.ts, from the env launch.ts returned): kept
 * on the agent for its card, told to every window, and after a limit, the
 * agent told to go on once its new session takes keys.
 */
export function movedLaunch(agent: AgentStatus, move: ClaudeAccountMove): void {
  agent.claudeAccountMove = move;
  broadcastToAllWindows('claude-accounts:agent-moved', move);
  if (move.reason === 'limit') void continueAfterMove(agent.id, move.at);
}

/**
 * Types CONTINUE_MESSAGE into the agent's new session (N6): once a session has
 * registered since `since` and takes keys, through the writer, which holds it
 * for a draft, and from Tars. Nothing into an open dialog or a terminal with
 * no CLI; nothing if no session comes within CONTINUE_WAIT_MS.
 */
export async function continueAfterMove(agentId: string, since: number): Promise<'written' | 'held' | 'skipped'> {
  const deadline = Date.now() + CONTINUE_WAIT_MS;
  for (;;) {
    const agent = agents.get(agentId);
    if (!agent) return 'skipped';
    const registered = agent.sessionRegisteredAt ? Date.parse(agent.sessionRegisteredAt) : NaN;
    if (registered >= since) {
      if (!(await sessionStarted(agent, Math.max(0, deadline - Date.now())))) return 'skipped';
      break;
    }
    if (Date.now() >= deadline) return 'skipped';
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const agent = agents.get(agentId);
  const ptyProcess = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!agent || !ptyProcess || !cliRunningIn(ptyProcess) || dialogOpen(agent)) {
    console.log(`[claude-accounts] ${agent?.name || agentId}: not told to continue (no CLI, or a dialog is open)`);
    return 'skipped';
  }
  const outcome = writeProgrammaticInput(ptyProcess, CONTINUE_MESSAGE, true, { agentId, from: 'Tars', sender: { kind: 'tars' } });
  return outcome === 'refused' ? 'skipped' : outcome;
}

/** Test seam. */
export function resetSwitching(): void {
  for (const timer of comebacks.values()) clearTimeout(timer);
  comebacks.clear();
}
