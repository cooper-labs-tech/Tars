/**
 * Which account an agent's CLI starts on (electron/services/claude-accounts/choose.ts),
 * DESIGN-COMPTES-CLAUDE.md B4, with the Audit's N5.
 *
 * What goes wrong if it is wrong, first:
 * - a pin ignored, or a pin to an account that cannot run (removed, disabled,
 *   signed out) obeyed: the agent starts on nothing;
 * - an agent moved at every relaunch although its account still has room: each
 *   move starts without the account's prompt cache;
 * - an account over a threshold, blocked after a limit, disabled or signed out
 *   chosen while another has room;
 * - account 1 treated as signed out while Claude Code has not answered yet:
 *   it is the account everybody already uses;
 * - a stale counter trusted (N5): usage on claude.ai, the phone or another
 *   machine shares the plan's limits and no status line sees it, so a counter
 *   older than 30 minutes is unknown, and a window whose reset has passed is 0;
 * - a measured account passed over for one nobody measured at equal margin (N5);
 * - several agents cut at once all sent to the same account (N5): the load
 *   counts the agents already running or moving to each;
 * - nothing chosen when every account is at its limit: the one that comes back
 *   first, so its CLI waits for that reset and not a later one.
 */
import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { chooseAccount, STALE_AFTER_MS, type ChooseInput } from '../../../electron/services/claude-accounts/choose';

const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);
const IN_1H = S(NOW + 3600_000);
const IN_3H = S(NOW + 3 * 3600_000);
const IN_4D = S(NOW + 4 * 86400_000);

function input(over: Partial<ChooseInput> = {}): ChooseInput {
  return {
    accounts: [
      { id: 'default', enabled: true, signedIn: true },
      { id: 'acct-aaaaaa', enabled: true, signedIn: true },
      { id: 'acct-bbbbbb', enabled: true, signedIn: true },
    ],
    fiveHourThreshold: 90,
    weeklyThreshold: 95,
    usage: {},
    blockedUntil: {},
    load: {},
    now: NOW,
    ...over,
  };
}

const used = (p5: number, p7: number, ageMs = 60_000, r5 = IN_3H, r7 = IN_4D) => ({
  fiveHour: { usedPercentage: p5, resetsAt: r5 },
  sevenDay: { usedPercentage: p7, resetsAt: r7 },
  updatedAt: NOW - ageMs,
});

describe('a pin', () => {
  it('wins, even over a threshold', () => {
    expect(chooseAccount(input({ pin: 'acct-aaaaaa', usage: { 'acct-aaaaaa': used(99, 99) } }))).toMatchObject({ accountId: 'acct-aaaaaa', reason: 'pinned' });
  });

  it.each([
    ['removed', { pin: 'acct-ffffff' }],
    ['disabled', { pin: 'acct-aaaaaa', accounts: [{ id: 'default', enabled: true, signedIn: true }, { id: 'acct-aaaaaa', enabled: false, signedIn: true }] }],
    ['signed out', { pin: 'acct-aaaaaa', accounts: [{ id: 'default', enabled: true, signedIn: true }, { id: 'acct-aaaaaa', enabled: true, signedIn: false }] }],
    ['never checked', { pin: 'acct-aaaaaa', accounts: [{ id: 'default', enabled: true, signedIn: true }, { id: 'acct-aaaaaa', enabled: true, signedIn: null }] }],
  ])('to an account that is %s is not followed', (_why, over) => {
    const c = chooseAccount(input(over as Partial<ChooseInput>));
    expect(c.reason).not.toBe('pinned');
    expect(c.accountId).not.toBe('acct-aaaaaa');
  });
});

describe('keeping the account it had', () => {
  it('keeps it while it is under both thresholds, even if another has more room', () => {
    const c = chooseAccount(input({ last: 'acct-aaaaaa', usage: { 'acct-aaaaaa': used(80, 50), 'acct-bbbbbb': used(1, 1), default: used(1, 1) } }));
    expect(c).toMatchObject({ accountId: 'acct-aaaaaa', reason: 'kept' });
  });

  it('leaves it once it is over a threshold, blocked, disabled or signed out', () => {
    for (const over of [
      { usage: { 'acct-aaaaaa': used(90, 10) } },
      { usage: { 'acct-aaaaaa': used(10, 95) } },
      { blockedUntil: { 'acct-aaaaaa': IN_1H } },
      { accounts: [{ id: 'default', enabled: true, signedIn: true }, { id: 'acct-aaaaaa', enabled: false, signedIn: true }] },
      { accounts: [{ id: 'default', enabled: true, signedIn: true }, { id: 'acct-aaaaaa', enabled: true, signedIn: false }] },
    ]) {
      expect(chooseAccount(input({ last: 'acct-aaaaaa', ...over } as Partial<ChooseInput>)).accountId).not.toBe('acct-aaaaaa');
    }
  });
});

describe('the most room', () => {
  it('takes the largest margin under both thresholds', () => {
    const c = chooseAccount(input({ usage: { default: used(70, 20), 'acct-aaaaaa': used(20, 90), 'acct-bbbbbb': used(40, 40) } }));
    // margins: default min(20, 75) = 20; a min(70, 5) = 5; b min(50, 55) = 50
    expect(c).toMatchObject({ accountId: 'acct-bbbbbb', reason: 'most-headroom' });
  });

  it('within 5 points, prefers a measured account over one nobody measured, whatever the order', () => {
    // a unknown (margin 90) first in the list; default measured at 1 % (margin 89): within 5, measured wins.
    const c = chooseAccount(input({
      accounts: [{ id: 'acct-aaaaaa', enabled: true, signedIn: true }, { id: 'default', enabled: true, signedIn: true }],
      usage: { default: used(1, 1) },
    }));
    expect(c.accountId).toBe('default');
  });

  it('within 5 points and equally measured, sends the agent where fewer run or are moving', () => {
    const c = chooseAccount(input({ usage: { default: used(10, 10), 'acct-aaaaaa': used(12, 12), 'acct-bbbbbb': used(60, 60) }, load: { default: 3, 'acct-aaaaaa': 1 } }));
    expect(c.accountId).toBe('acct-aaaaaa');
  });

  it('then follows the order of the list', () => {
    const c = chooseAccount(input({
      accounts: [{ id: 'acct-bbbbbb', enabled: true, signedIn: true }, { id: 'default', enabled: true, signedIn: true }],
      usage: { default: used(10, 10), 'acct-bbbbbb': used(10, 10) },
    }));
    expect(c.accountId).toBe('acct-bbbbbb');
  });

  it('reads a counter older than 30 minutes as unknown', () => {
    // a looks nearly full but was measured 31 minutes ago; b was measured now at 50 %.
    const c = chooseAccount(input({
      accounts: [{ id: 'acct-aaaaaa', enabled: true, signedIn: true }, { id: 'acct-bbbbbb', enabled: true, signedIn: true }],
      usage: { 'acct-aaaaaa': used(89, 94, STALE_AFTER_MS + 60_000), 'acct-bbbbbb': used(50, 50) },
    }));
    expect(STALE_AFTER_MS).toBe(30 * 60_000);
    expect(c.accountId).toBe('acct-aaaaaa');
  });

  it('reads a window whose reset has passed as empty, from a fresh counter or an old one', () => {
    for (const age of [60_000, 6 * 3600_000]) {
      const c = chooseAccount(input({
        accounts: [{ id: 'acct-aaaaaa', enabled: true, signedIn: true }, { id: 'acct-bbbbbb', enabled: true, signedIn: true }],
        usage: { 'acct-aaaaaa': used(100, 10, age, S(NOW - 60_000)), 'acct-bbbbbb': used(50, 50) },
      }));
      expect(c.accountId).toBe('acct-aaaaaa');
    }
  });

  it('treats account 1 as usable while Claude Code has not answered about it yet, and no other account', () => {
    const c = chooseAccount(input({
      accounts: [{ id: 'acct-aaaaaa', enabled: true, signedIn: true }, { id: 'default', enabled: true, signedIn: null }, { id: 'acct-bbbbbb', enabled: true, signedIn: null }],
      usage: { 'acct-aaaaaa': used(50, 50) },
    }));
    expect(c).toMatchObject({ accountId: 'default', reason: 'most-headroom' });
  });
});

describe('every account at its limit', () => {
  it('picks the one that comes back first, and says when', () => {
    const c = chooseAccount(input({
      usage: { default: used(95, 10, 60_000, IN_3H), 'acct-aaaaaa': used(10, 99, 60_000, IN_3H, IN_4D), 'acct-bbbbbb': used(92, 10, 60_000, IN_1H) },
    }));
    expect(c).toMatchObject({ accountId: 'acct-bbbbbb', reason: 'all-at-limit', comesBackAt: IN_1H });
  });

  it('counts a block after a limit as the time it comes back', () => {
    const c = chooseAccount(input({
      accounts: [{ id: 'default', enabled: true, signedIn: true }, { id: 'acct-aaaaaa', enabled: true, signedIn: true }],
      usage: { default: used(95, 10, 60_000, IN_3H) },
      blockedUntil: { 'acct-aaaaaa': IN_1H },
    }));
    expect(c).toMatchObject({ accountId: 'acct-aaaaaa', reason: 'all-at-limit', comesBackAt: IN_1H });
  });

  it('falls back to account 1 when no account can run at all', () => {
    const c = chooseAccount(input({ accounts: [{ id: 'default', enabled: false, signedIn: false }, { id: 'acct-aaaaaa', enabled: false, signedIn: true }] }));
    expect(c).toMatchObject({ accountId: 'default', reason: 'fallback' });
  });
});
