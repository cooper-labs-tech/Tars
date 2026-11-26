/**
 * Moving agents between Claude accounts on their own
 * (electron/services/claude-accounts/switching.ts), DESIGN-COMPTES-CLAUDE.md B4,
 * with the Audit's N4 and N6.
 *
 * What goes wrong if it is wrong, first:
 * - the option off, or an agent of another provider, and anything at all
 *   happens: an account blocked, an agent restarted, a notification lost;
 * - a passing 429 taken for the plan's limit (N4): one overloaded request
 *   parks an account for five hours. Only "You've hit your session limit",
 *   the weekly (and Opus, Sonnet) limits, or a counter at 100 % block it; a
 *   monthly spend limit or usage credits are not a plan window;
 * - the account blocked until the wrong time: the counter's reset when it
 *   has one ahead, otherwise five hours;
 * - a pinned agent moved: the pin wins, even at the limit (its account is
 *   still blocked for the others);
 * - (the Audit's L1 on #600) an agent on a remote host moved, or its limit
 *   taken for one of these accounts': its CLI runs on that host's own
 *   sign-in, and the restart a move asks for ended its session there for
 *   nothing;
 * - an agent moved when no other account has room, or moved to an account
 *   over its threshold, or to one signed out;
 * - every account at its limit and nothing planned while another comes back
 *   before this one: the move is set for that reset, and happens then;
 * - an agent moved again and again: once per agent every ten minutes;
 * - a move at rest while the account is still under its thresholds, or with a
 *   stale counter (claude.ai use unseen), or in the middle of a turn: only at
 *   the end of a turn, and the restart path still waits for a draft, a note,
 *   a background job;
 * - the restart asked at the very moment the turn ends, before agent-watch has
 *   typed what it held: asked a moment later;
 * - the "Continue" line typed into the old CLI, or before the new session
 *   takes keys, or into a dialog (N6): after the new session's SessionStart,
 *   through the writer, from Tars, and not at all into an open dialog;
 * - a move no window hears of: claude-accounts:agent-moved, and the last move
 *   kept on the agent for its card;
 * - a threshold move followed by "Continue": nothing was cut, nothing typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';
import * as fs from 'fs';
import * as path from 'path';

const h = vi.hoisted(() => ({
  restarts: [] as { agentId: string; changed: string[]; opts?: { always?: boolean } }[],
  broadcasts: [] as { channel: string; payload: unknown }[],
  written: [] as { data: string; origin: unknown }[],
  agents: new Map<string, Record<string, unknown>>(),
  ptys: new Map<string, object>(),
  cliRunning: true,
  dialog: false,
  started: true,
}));

vi.mock('../../../electron/core/agent-restart', () => ({
  restartForSettings: (agentId: string, changed: string[], opts?: { always?: boolean }) => {
    h.restarts.push({ agentId, changed, opts });
    return { action: 'restarted' };
  },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { h.broadcasts.push({ channel, payload }); },
}));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: h.agents }));
vi.mock('../../../electron/core/pty-manager', () => ({
  ptyProcesses: h.ptys,
  writeProgrammaticInput: (_p: object, data: string, _bracket: boolean, origin: unknown) => {
    h.written.push({ data, origin });
    return 'written';
  },
}));
vi.mock('../../../electron/core/agent-pty', () => ({ cliRunningIn: () => h.cliRunning }));
vi.mock('../../../electron/core/agent-launch', () => ({
  sessionStarted: async () => h.started,
  dialogOpen: () => h.dialog,
}));

import {
  usageLimitFrom,
  onUsageLimit,
  onTurnEnded,
  movedLaunch,
  continueAfterMove,
  resetSwitching,
  CONTINUE_MESSAGE,
  MOVE_EVERY_MS,
  RESTART_AFTER_MS,
} from '../../../electron/services/claude-accounts/switching';
import { blockedUntil, pendingMove, setAuth, resetAccountState } from '../../../electron/services/claude-accounts/state';
import { countersDir } from '../../../electron/services/claude-accounts/counters';
import { normalizeAccountsSettings, writeAccountsSettings, accountsFile } from '../../../electron/services/claude-accounts/registry';
import type { AgentStatus } from '../../../electron/types';

const A = 'acct-aaaaaa';
const B = 'acct-bbbbbb';
const NOW = Date.UTC(2026, 8, 30, 20, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);
const SESSION_LIMIT = "You've hit your session limit · resets 11:59pm (Asia/Tbilisi)";

function registry(over: Record<string, unknown> = {}): void {
  writeAccountsSettings(normalizeAccountsSettings({
    enabled: true,
    accounts: [{ id: 'default', label: 'Account 1' }, { id: A, label: 'Max two' }, { id: B, label: 'Max three' }],
    ...over,
  }));
}

/** A counter as the status line leaves it: percentages, resets in epoch seconds, updatedAt in seconds. */
function counter(id: string, five: number, week = 10, opts: { fiveReset?: number; weekReset?: number; updatedAt?: number } = {}): void {
  fs.mkdirSync(countersDir(), { recursive: true });
  fs.writeFileSync(path.join(countersDir(), `${id}.json`), JSON.stringify({
    updatedAt: opts.updatedAt ?? S(NOW),
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: opts.fiveReset ?? S(NOW) + 3600 },
      seven_day: { used_percentage: week, resets_at: opts.weekReset ?? S(NOW) + 5 * 86400 },
    },
  }));
}

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  const a = { id: `ag-${Math.random().toString(16).slice(2, 8)}`, name: 'Worker', status: 'error', projectPath: '/p', skills: [], output: [], lastActivity: '', provider: 'claude', claudeAccountId: 'default', ptyId: 'pty-1', ...over } as AgentStatus;
  h.agents.set(a.id, a as unknown as Record<string, unknown>);
  return a;
}

const moves = () => h.broadcasts.filter(b => b.channel === 'claude-accounts:agent-moved').map(b => b.payload);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  h.restarts.length = 0;
  h.broadcasts.length = 0;
  h.written.length = 0;
  h.agents.clear();
  h.ptys.clear();
  h.ptys.set('pty-1', {});
  h.cliRunning = true;
  h.dialog = false;
  h.started = true;
  resetAccountState();
  resetSwitching();
  fs.rmSync(countersDir(), { recursive: true, force: true });
  if (fs.existsSync(accountsFile())) fs.unlinkSync(accountsFile());
  for (const id of ['default', A, B]) setAuth(id, { signedIn: true, email: `${id}@example.com`, subscriptionType: 'max', error: null });
  registry();
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(claudeAccountsNotPorted())('a plan limit, told from a passing 429 (N4)', () => {
  it.each([
    [SESSION_LIMIT, 'fiveHour'],
    ["You've hit your weekly limit · resets Oct 3, 9am", 'sevenDay'],
    ["You've hit your Opus limit · resets Oct 3, 9am", 'sevenDay'],
    ["You've hit your Sonnet limit · progress saved", 'sevenDay'],
  ])('reads %j as the %s window', (message, window) => {
    expect(usageLimitFrom(message, undefined, NOW)?.window).toBe(window);
  });

  it.each([
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of concurrent connections has exceeded your rate limit."}}'],
    ["You've hit your monthly spend limit · raise it at claude.ai/settings"],
    ["You're out of usage credits · resets Oct 1"],
    [''],
  ])('does not read %j as a plan limit, with no counter at 100 %%', (message) => {
    expect(usageLimitFrom(message, { fiveHour: { usedPercentage: 60, resetsAt: S(NOW) + 60 }, sevenDay: null, updatedAt: NOW }, NOW)).toBeNull();
  });

  it('reads a counter at 100 % as that window, whatever the message', () => {
    const usage = { fiveHour: { usedPercentage: 40, resetsAt: S(NOW) + 60 }, sevenDay: { usedPercentage: 100, resetsAt: S(NOW) + 7200 }, updatedAt: NOW };
    expect(usageLimitFrom('API Error: 429', usage, NOW)).toEqual({ window: 'sevenDay', resetsAt: S(NOW) + 7200 });
  });

  it('blocks until the counter\'s reset when it is ahead, five hours otherwise', () => {
    const usage = { fiveHour: { usedPercentage: 100, resetsAt: S(NOW) + 1800 }, sevenDay: null, updatedAt: NOW };
    expect(usageLimitFrom(SESSION_LIMIT, usage, NOW)).toEqual({ window: 'fiveHour', resetsAt: S(NOW) + 1800 });
    const passed = { fiveHour: { usedPercentage: 100, resetsAt: S(NOW) - 10 }, sevenDay: null, updatedAt: NOW };
    expect(usageLimitFrom(SESSION_LIMIT, passed, NOW)).toEqual({ window: 'fiveHour', resetsAt: S(NOW) + 5 * 3600 });
    expect(usageLimitFrom(SESSION_LIMIT, undefined, NOW)).toEqual({ window: 'fiveHour', resetsAt: S(NOW) + 5 * 3600 });
  });
});

describe.skipIf(claudeAccountsNotPorted())('an agent cut by its limit', () => {
  it('blocks its account and moves it to the one with most room, restarting it a moment later', () => {
    counter('default', 100);
    counter(A, 40);
    counter(B, 10);
    const a = agent();
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(true);
    expect(blockedUntil().default).toBe(S(NOW) + 3600);
    expect(pendingMove(a.id)).toMatchObject({ to: B, reason: 'limit', window: 'fiveHour' });
    vi.advanceTimersByTime(RESTART_AFTER_MS - 1);
    expect(h.restarts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.restarts).toEqual([{ agentId: a.id, changed: ['claudeAccount'], opts: { always: true } }]);
  });

  it('does nothing with the option off', () => {
    registry({ enabled: false });
    counter('default', 100);
    const a = agent();
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(false);
    expect(blockedUntil()).toEqual({});
    vi.advanceTimersByTime(RESTART_AFTER_MS * 4);
    expect(h.restarts).toEqual([]);
  });

  it('does nothing for an agent of another provider', () => {
    const a = agent({ provider: 'openrouter' as AgentStatus['provider'] });
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(false);
    expect(blockedUntil()).toEqual({});
  });

  it('does not block or move on a passing 429', () => {
    counter('default', 60);
    const a = agent();
    expect(onUsageLimit(a, 'API Error: 429 rate_limit_error')).toBe(false);
    expect(blockedUntil()).toEqual({});
    expect(pendingMove(a.id)).toBeUndefined();
  });

  it('blocks the account but leaves a pinned agent where it is', () => {
    counter('default', 100);
    const a = agent({ claudeAccountPin: 'default' });
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(false);
    expect(blockedUntil().default).toBeDefined();
    vi.advanceTimersByTime(RESTART_AFTER_MS * 4);
    expect(h.restarts).toEqual([]);
  });

  it('does nothing for an agent on a remote host, whose CLI runs on the host\'s own sign-in: no block, no move, no restart', () => {
    const a = agent({ remote: { hostId: 'build-1', folder: '/home/agent/work/p' } });
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(false);
    expect(blockedUntil()).toEqual({});
    expect(pendingMove(a.id)).toBeUndefined();
    counter('default', 99);
    expect(onTurnEnded(agent({ status: 'idle', remote: { hostId: 'build-1', folder: '/home/agent/work/p' } }))).toBe(false);
    vi.advanceTimersByTime(RESTART_AFTER_MS * 4);
    expect(h.restarts).toEqual([]);
  });

  it('moves nowhere signed out, disabled or over its threshold', () => {
    registry({ accounts: [{ id: 'default', label: 'Account 1' }, { id: A, label: 'Max two', enabled: false }, { id: B, label: 'Max three' }] });
    setAuth(B, { signedIn: false, email: null, subscriptionType: null, error: null });
    counter('default', 100);
    const a = agent();
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(false);
    registry();
    setAuth(B, { signedIn: true, email: 'b@example.com', subscriptionType: 'max', error: null });
    counter(A, 95);
    counter(B, 92);
    expect(onUsageLimit(agent(), SESSION_LIMIT)).toBe(false);
    vi.advanceTimersByTime(RESTART_AFTER_MS * 4);
    expect(h.restarts).toEqual([]);
  });

  it('with every account at its limit, sets the move for the one that comes back before its own', () => {
    counter('default', 100, 10, { fiveReset: S(NOW) + 4 * 3600 });
    counter(A, 100, 10, { fiveReset: S(NOW) + 1200 });
    counter(B, 100, 10, { fiveReset: S(NOW) + 7200 });
    const a = agent();
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(true);
    vi.advanceTimersByTime(RESTART_AFTER_MS * 4);
    expect(h.restarts).toEqual([]);
    // Account 2's reset passes: its window is empty again.
    vi.setSystemTime(NOW + 1200 * 1000 + 1000);
    vi.advanceTimersByTime(1200 * 1000 + RESTART_AFTER_MS);
    expect(pendingMove(a.id)).toMatchObject({ to: A, reason: 'limit' });
    expect(h.restarts.map(r => r.agentId)).toEqual([a.id]);
  });

  it('waits for its own reset when no other account comes back sooner: nothing planned', () => {
    counter('default', 100, 10, { fiveReset: S(NOW) + 600 });
    counter(A, 100, 10, { fiveReset: S(NOW) + 3600 });
    counter(B, 100, 10, { fiveReset: S(NOW) + 7200 });
    expect(onUsageLimit(agent(), SESSION_LIMIT)).toBe(false);
  });

  it('sets nothing for an account that comes back only when its own does', () => {
    registry({ accounts: [{ id: A, label: 'Max two' }, { id: 'default', label: 'Account 1' }, { id: B, label: 'Max three' }] });
    counter('default', 100, 10, { fiveReset: S(NOW) + 3600 });
    counter(A, 100, 10, { fiveReset: S(NOW) + 3600 });
    counter(B, 100, 10, { fiveReset: S(NOW) + 7200 });
    expect(onUsageLimit(agent(), SESSION_LIMIT)).toBe(false);
  });

  it('moves an agent once every ten minutes at most', () => {
    counter('default', 100);
    counter(A, 10);
    counter(B, 10);
    const a = agent();
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(true);
    a.claudeAccountId = A;
    counter(A, 100);
    vi.setSystemTime(NOW + MOVE_EVERY_MS - 1000);
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(false);
    vi.setSystemTime(NOW + MOVE_EVERY_MS + 1000);
    expect(onUsageLimit(a, SESSION_LIMIT)).toBe(true);
  });
});

describe.skipIf(claudeAccountsNotPorted())('an agent at rest on an account past its threshold', () => {
  it('moves at the end of its turn, as a threshold move, without cutting anything', () => {
    counter('default', 91);
    counter(A, 20);
    counter(B, 60);
    const a = agent({ status: 'idle' });
    expect(onTurnEnded(a)).toBe(true);
    expect(pendingMove(a.id)).toMatchObject({ to: A, reason: 'threshold', window: 'fiveHour', usedPercentage: 91 });
    expect(blockedUntil()).toEqual({});
    vi.advanceTimersByTime(RESTART_AFTER_MS);
    expect(h.restarts.map(r => r.agentId)).toEqual([a.id]);
  });

  it('names the weekly window when that is the one past its threshold', () => {
    counter('default', 30, 96);
    counter(A, 20, 20);
    counter(B, 60, 60);
    const a = agent({ status: 'idle' });
    expect(onTurnEnded(a)).toBe(true);
    expect(pendingMove(a.id)).toMatchObject({ window: 'sevenDay', usedPercentage: 96 });
  });

  it('stays under its thresholds, with a stale counter, pinned, or with nowhere better', () => {
    counter('default', 89, 94);
    counter(A, 5);
    expect(onTurnEnded(agent({ status: 'idle' }))).toBe(false);
    counter('default', 99, 10, { updatedAt: S(NOW) - 31 * 60 });
    expect(onTurnEnded(agent({ status: 'idle' }))).toBe(false);
    counter('default', 99);
    expect(onTurnEnded(agent({ status: 'idle', claudeAccountPin: 'default' }))).toBe(false);
    counter(A, 95);
    counter(B, 93);
    expect(onTurnEnded(agent({ status: 'idle' }))).toBe(false);
    vi.advanceTimersByTime(RESTART_AFTER_MS * 4);
    expect(h.restarts).toEqual([]);
  });

  it('never in the middle of a turn', () => {
    counter('default', 99);
    counter(A, 5);
    expect(onTurnEnded(agent({ status: 'running' }))).toBe(false);
  });

  it('does nothing with the option off', () => {
    registry({ enabled: false });
    counter('default', 99);
    counter(A, 5);
    expect(onTurnEnded(agent({ status: 'idle' }))).toBe(false);
  });
});

describe.skipIf(claudeAccountsNotPorted())('the launch that makes the move', () => {
  const move = (a: AgentStatus, reason: 'limit' | 'threshold') => ({ agentId: a.id, from: 'default', to: A, reason, window: 'fiveHour' as const, usedPercentage: reason === 'limit' ? 100 : 91, at: NOW });

  it('keeps the move on the agent and tells every window', () => {
    const a = agent({ status: 'idle' });
    movedLaunch(a, move(a, 'threshold'));
    expect(a.claudeAccountMove).toEqual(move(a, 'threshold'));
    expect(moves()).toEqual([move(a, 'threshold')]);
  });

  it('types nothing after a threshold move: nothing was cut', async () => {
    const a = agent({ status: 'idle', sessionRegisteredAt: new Date(NOW + 5000).toISOString() });
    movedLaunch(a, move(a, 'threshold'));
    await vi.runAllTimersAsync();
    expect(h.written).toEqual([]);
  });

  it('after a limit, types Continue from Tars once the new session has registered', async () => {
    const a = agent({ status: 'idle', sessionRegisteredAt: new Date(NOW - 60_000).toISOString() });
    const done = continueAfterMove(a.id, NOW);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.written).toEqual([]);
    a.sessionRegisteredAt = new Date(NOW + 3000).toISOString();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBe('written');
    expect(h.written).toEqual([{ data: CONTINUE_MESSAGE, origin: { agentId: a.id, from: 'Tars', sender: { kind: 'tars' } } }]);
  });

  it('types nothing into an open dialog, a terminal with no CLI, or a session that never comes', async () => {
    const a = agent({ status: 'waiting', sessionRegisteredAt: new Date(NOW + 1000).toISOString() });
    h.dialog = true;
    expect(await continueAfterMove(a.id, NOW)).toBe('skipped');
    h.dialog = false;
    h.cliRunning = false;
    expect(await continueAfterMove(a.id, NOW)).toBe('skipped');
    h.cliRunning = true;
    const b = agent({ status: 'idle', sessionRegisteredAt: undefined });
    const never = continueAfterMove(b.id, NOW);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await never).toBe('skipped');
    expect(h.written).toEqual([]);
  });
});
