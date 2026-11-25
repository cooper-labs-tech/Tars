import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import {
  AUTOMATIC,
  accountFolder,
  accountNote,
  accountWord,
  allAtLimit,
  controlLabel,
  controlTitle,
  formatReset,
  isThreshold,
  menuOptions,
  meterTone,
  moveInOrder,
  moveLine,
  moveNote,
  showsAccountControl,
  suggestLabel,
  tildify,
  whoLine,
} from '../../src/lib/claude-accounts';
import type { ClaudeAccountMove, ClaudeAccountState, ClaudeAccountsView } from '../../src/types/electron';

/**
 * What the Claude accounts section and an agent's account control say, worked
 * out apart from the page (src/lib/claude-accounts.ts). The contract is #263's
 * (DESIGN-COMPTES-CLAUDE.md, B6); the words are the frames' in
 * design/tars-redesign.pen, `Settings · Claude accounts · states` and
 * `Agent · Claude account`. Written before the code, as the ways it can fail:
 * 1. a reset time that reads wrong: a time of day for a reset days away, or a
 *    day for one due within the hour;
 * 2. a bar that turns the waiting colour before its threshold or the error
 *    colour before the limit, or never does;
 * 3. an account that says it can take agents when it cannot: not signed in,
 *    still being checked, turned off, blocked by a limit, or full; or a note
 *    that names no way out when another account has room;
 * 4. the notice that every account is at its limit shown while one has room,
 *    or naming the wrong time or the wrong account;
 * 5. an order move that drops, doubles or reorders anything but the two rows;
 * 6. the agent's control shown with the option off, with a single account, or
 *    on an agent that does not run Claude on a subscription; or naming the
 *    wrong account, or hiding that it is pinned;
 * 7. a menu that lets an agent be pinned to an account that cannot take it;
 * 8. a move by Tars (#269's claude-accounts:agent-moved) told wrong in the
 *    agent's window: the wrong account, time or window, a limit told as a
 *    threshold or the reverse, a use that was not measured written as a
 *    number, or a line that is not a grey notice on a line of its own;
 * 9. the control's title that hides a move by Tars, or tells one that no
 *    longer holds (the agent pinned since, or started on another account
 *    since), or tells a move from an earlier day by its time alone.
 */

const NOW = new Date(2026, 8, 28, 14, 50, 0);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (h: number, m: number, dayOffset = 0) => sec(new Date(2026, 8, 28 + dayOffset, h, m, 0));

function account(over: Partial<ClaudeAccountState> & { id: string; label: string }): ClaudeAccountState {
  return {
    configDir: over.id === 'default' ? null : `/Users/someone/.claude-accounts/${over.id}`,
    enabled: true,
    signedIn: true,
    email: `${over.id}@example.com`,
    subscriptionType: 'max',
    fiveHour: { usedPercentage: 10, resetsAt: at(18, 20) },
    sevenDay: { usedPercentage: 10, resetsAt: at(9, 0, 3) },
    updatedAt: NOW.getTime(),
    blockedUntil: null,
    agentIds: [],
    error: null,
    ...over,
  };
}

function view(accounts: ClaudeAccountState[], over: Partial<ClaudeAccountsView['settings']> = {}): ClaudeAccountsView {
  return {
    settings: {
      enabled: true,
      accounts: accounts.map(a => ({ id: a.id, label: a.label, configDir: a.configDir, enabled: a.enabled })),
      fiveHourThreshold: 90,
      weeklyThreshold: 95,
      ...over,
    },
    accounts,
  };
}

describe('reset times (1)', () => {
  it('writes a reset within a day as the time of day, and a later one with its weekday', () => {
    expect(formatReset(at(16, 40), NOW)).toBe('16:40');
    expect(formatReset(at(9, 5, 1), NOW)).toBe('09:05');
    const thursday = new Date(2026, 9, 1, 9, 0, 0);
    expect(formatReset(sec(thursday), NOW)).toBe('Thu 09:00');
  });
});

describe('thresholds and bars (2)', () => {
  it('takes whole percentages from 50 to 100 only', () => {
    for (const ok of [50, 90, 95, 100]) expect(isThreshold(ok)).toBe(true);
    for (const bad of [49, 101, 90.5, Number.NaN, -1]) expect(isThreshold(bad)).toBe(false);
  });

  it('turns a bar the waiting colour at its threshold and the error colour at the limit', () => {
    expect(meterTone(89, 90)).toBe('normal');
    expect(meterTone(90, 90)).toBe('near');
    expect(meterTone(99.6, 90)).toBe('near');
    expect(meterTone(100, 90)).toBe('full');
  });
});

describe('what an account says about itself (3)', () => {
  it('says checking, signed in or not signed in', () => {
    expect(accountWord(account({ id: 'a', label: 'A', signedIn: null }))).toEqual({ word: 'checking', tone: 'idle' });
    expect(accountWord(account({ id: 'a', label: 'A', signedIn: true }))).toEqual({ word: 'signed in', tone: 'running' });
    expect(accountWord(account({ id: 'a', label: 'A', signedIn: false }))).toEqual({ word: 'not signed in', tone: 'waiting' });
  });

  it('gives its email, plan and agents only once signed in, and its folder with home as ~', () => {
    expect(whoLine(account({ id: 'a', label: 'A', agentIds: ['x', 'y', 'z'] }))).toBe('a@example.com · max · 3 agents');
    expect(whoLine(account({ id: 'a', label: 'A', agentIds: ['x'] }))).toBe('a@example.com · max · 1 agent');
    expect(whoLine(account({ id: 'a', label: 'A', signedIn: false }))).toBeNull();
    expect(accountFolder(account({ id: 'default', label: 'Account 1' }))).toBe('~/.claude');
    expect(accountFolder(account({ id: 'acct-2a3b4c', label: 'Second' }))).toBe('~/.claude-accounts/acct-2a3b4c');
    // Every folder Tars makes is <home>/.claude-accounts/<id> (#263, B1), whatever the home is called.
    expect(accountFolder(account({ id: 'acct-000009', label: 'Nine', configDir: '/private/var/folders/xy/T/home/.claude-accounts/acct-000009' }))).toBe('~/.claude-accounts/acct-000009');
    expect(tildify('/home/someone/.claude-accounts/acct-1')).toBe('~/.claude-accounts/acct-1');
    expect(tildify('/Volumes/work/acct')).toBe('/Volumes/work/acct');
  });

  it('says why an account takes no agent, and where agents go past a threshold', () => {
    const second = account({ id: 'acct-000002', label: 'Second' });
    const note = (a: ClaudeAccountState, others: ClaudeAccountState[] = [second]) => accountNote(a, view([a, ...others]), NOW);

    expect(note(account({ id: 'default', label: 'Main', signedIn: null }))).toEqual({ text: 'Asking Claude Code whether this folder is signed in.', tone: 'muted' });
    expect(note(account({ id: 'default', label: 'Main', signedIn: false }))).toEqual({ text: 'Not signed in, or its sign-in expired. It takes no agent until it is signed in.', tone: 'secondary' });
    expect(note(account({ id: 'default', label: 'Main', enabled: false }))).toEqual({ text: 'Turned off: Tars starts no agent on it.', tone: 'muted' });
    expect(note(account({ id: 'default', label: 'Main', blockedUntil: at(22, 15) }))).toEqual({ text: 'At its limit until 22:15.', tone: 'error' });
    expect(note(account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 100, resetsAt: at(21, 40) } }))).toEqual({ text: 'At its limit until 21:40.', tone: 'error' });
    expect(note(account({ id: 'default', label: 'Main', fiveHour: null, sevenDay: null }))).toEqual({ text: 'No use seen yet: the first agent that runs on it measures it.', tone: 'muted' });
    expect(note(account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 93, resetsAt: at(16, 40) } }))).toEqual({ text: 'Past 90% of its 5 h window: agents go to another account.', tone: 'waiting' });
    expect(note(account({ id: 'default', label: 'Main', sevenDay: { usedPercentage: 96, resetsAt: at(9, 0, 3) } }))).toEqual({ text: 'Past 95% of its weekly window: agents go to another account.', tone: 'waiting' });
    expect(note(account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 93, resetsAt: at(16, 40) }, sevenDay: { usedPercentage: 96, resetsAt: at(9, 0, 3) } })))
      .toEqual({ text: 'Past its 5 h and weekly thresholds: agents go to another account.', tone: 'waiting' });
    expect(note(account({ id: 'default', label: 'Main' }))).toBeNull();
  });

  it('says no other account has room when none has: turned off, signed out, blocked or past a threshold', () => {
    const main = account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 93, resetsAt: at(16, 40) } });
    const others = [
      account({ id: 'acct-000002', label: 'Off', enabled: false }),
      account({ id: 'acct-000003', label: 'Out', signedIn: false }),
      account({ id: 'acct-000004', label: 'Blocked', blockedUntil: at(20, 0) }),
      account({ id: 'acct-000005', label: 'Full', sevenDay: { usedPercentage: 95, resetsAt: at(9, 0, 3) } }),
    ];
    expect(accountNote(main, view([main, ...others]), NOW)).toEqual({ text: 'Past 90% of its 5 h window, and no other account has room.', tone: 'waiting' });
  });
});

describe('every account at its limit (4)', () => {
  it('names the first account back and its time, among the accounts that can take agents', () => {
    const main = account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 100, resetsAt: at(22, 15) } });
    const second = account({ id: 'acct-000002', label: 'Second', blockedUntil: at(21, 40) });
    const out = account({ id: 'acct-000003', label: 'Out', signedIn: false });
    const off = account({ id: 'acct-000004', label: 'Off', enabled: false });
    expect(allAtLimit(view([main, second, out, off]), NOW)).toEqual({ at: '21:40', label: 'Second' });
  });

  it('is not shown while one account has room, or when no account can take agents at all', () => {
    const main = account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 100, resetsAt: at(22, 15) } });
    const second = account({ id: 'acct-000002', label: 'Second', fiveHour: { usedPercentage: 97, resetsAt: at(19, 5) } });
    expect(allAtLimit(view([main, second]), NOW)).toBeNull();
    expect(allAtLimit(view([account({ id: 'default', label: 'Main', signedIn: false })]), NOW)).toBeNull();
  });

  it('waits for both windows of an account whose 5 h and week are both full', () => {
    const main = account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 100, resetsAt: at(16, 0) }, sevenDay: { usedPercentage: 100, resetsAt: at(9, 0, 2) } });
    expect(allAtLimit(view([main]), NOW)).toEqual({ at: formatReset(at(9, 0, 2), NOW), label: 'Main' });
  });
});

describe('the order (5)', () => {
  it('swaps a row with its neighbour and nothing else, and leaves the ends alone', () => {
    const ids = ['default', 'acct-000002', 'acct-000003'];
    expect(moveInOrder(ids, 1, -1)).toEqual(['acct-000002', 'default', 'acct-000003']);
    expect(moveInOrder(ids, 1, 1)).toEqual(['default', 'acct-000003', 'acct-000002']);
    expect(moveInOrder(ids, 0, -1)).toEqual(ids);
    expect(moveInOrder(ids, 2, 1)).toEqual(ids);
    expect(ids).toEqual(['default', 'acct-000002', 'acct-000003']);
  });

  it('suggests a label no account has yet', () => {
    const v = view([account({ id: 'default', label: 'Account 1' }), account({ id: 'acct-000002', label: 'account 3' })]);
    expect(suggestLabel(v)).toBe('Account 4');
    expect(suggestLabel(view([account({ id: 'default', label: 'Account 1' })]))).toBe('Account 2');
  });
});

describe("an agent's account control (6, 7)", () => {
  const main = account({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 93, resetsAt: at(16, 40) }, sevenDay: { usedPercentage: 40, resetsAt: at(9, 0, 3) } });
  const second = account({ id: 'acct-000002', label: 'Second', fiveHour: { usedPercentage: 12, resetsAt: at(19, 5) }, sevenDay: { usedPercentage: 20, resetsAt: at(11, 30, 5) } });
  const third = account({ id: 'acct-000003', label: 'Third', signedIn: false });
  const v = view([main, second, third]);

  it('shows only with the option on, more than one account, and a Claude subscription agent', () => {
    expect(showsAccountControl(v, { provider: 'claude' })).toBe(true);
    expect(showsAccountControl(v, {})).toBe(true);
    expect(showsAccountControl(view([main, second], { enabled: false }), { provider: 'claude' })).toBe(false);
    expect(showsAccountControl(view([main]), { provider: 'claude' })).toBe(false);
    expect(showsAccountControl(v, { provider: 'codex' })).toBe(false);
    expect(showsAccountControl(v, { provider: 'openrouter' })).toBe(false);
    expect(showsAccountControl(v, { provider: 'local' })).toBe(false);
    expect(showsAccountControl(null, { provider: 'claude' })).toBe(false);
  });

  it('names the account the agent runs on, or the one it is pinned to, and says so in its title', () => {
    expect(controlLabel(v, {})).toBe('Main');
    expect(controlTitle(v, {})).toBe('Runs on Main, chosen by Tars.');
    expect(controlLabel(v, { claudeAccountId: 'acct-000002' })).toBe('Second');
    expect(controlLabel(v, { claudeAccountId: 'acct-000002', claudeAccountPin: 'acct-000002' })).toBe('Second · pinned');
    expect(controlTitle(v, { claudeAccountId: 'acct-000002', claudeAccountPin: 'acct-000002' }))
      .toBe('Runs on Second, pinned by you. It stays there past its thresholds, and waits at its limit.');
    expect(controlLabel(v, { claudeAccountPin: 'acct-000002' })).toBe('Second · pinned');
    expect(controlTitle(v, { claudeAccountPin: 'acct-000002' })).toBe('Pinned by you to Second. It runs on Main until its turn ends, then moves.');
    expect(controlLabel(v, { claudeAccountId: 'acct-gone00' })).toBe('a removed account');
  });

  it('offers Automatic first, then each account with its use, and none that cannot take the agent', () => {
    const options = menuOptions(v, {}, NOW);
    expect(options.map(o => o.value)).toEqual([AUTOMATIC, 'default', 'acct-000002', 'acct-000003']);
    expect(options[0]).toMatchObject({ label: 'Automatic', hint: 'now on Main' });
    expect(options[1]).toMatchObject({ label: 'Main', hint: '5 h 93% · week 40%', hintTone: 'waiting', dividerBefore: true });
    expect(options[1].disabled).toBeFalsy();
    expect(options[2]).toMatchObject({ label: 'Second', hint: '5 h 12% · week 20%', hintTone: 'muted' });
    expect(options[3]).toMatchObject({ label: 'Third', hint: 'not signed in', disabled: true });
    expect(menuOptions(v, { claudeAccountPin: 'acct-000002' }, NOW)[0].hint).toBe('Tars picks');

    const blocked = account({ id: 'acct-000002', label: 'Second', blockedUntil: at(21, 40) });
    const off = account({ id: 'acct-000003', label: 'Third', enabled: false });
    const checking = account({ id: 'acct-000004', label: 'Fourth', signedIn: null });
    const more = menuOptions(view([main, blocked, off, checking]), {}, NOW);
    expect(more[2]).toMatchObject({ hint: 'at its limit until 21:40', hintTone: 'error' });
    expect(more[3]).toMatchObject({ hint: 'turned off', disabled: true });
    expect(more[4]).toMatchObject({ hint: 'checking', disabled: true });
  });
});

describe('a move by Tars (8, 9)', () => {
  const main = account({ id: 'default', label: 'Main' });
  const second = account({ id: 'acct-000002', label: 'Second' });
  const v = view([main, second]);
  const at1402 = new Date(2026, 8, 28, 14, 2, 0).getTime();
  const past: ClaudeAccountMove = { agentId: 'a1', from: 'default', to: 'acct-000002', reason: 'threshold', window: 'fiveHour', usedPercentage: 91.4, at: at1402 };
  const cut: ClaudeAccountMove = { ...past, reason: 'limit', usedPercentage: 100 };

  it('says why, in the words of the frame, for each reason and window (8)', () => {
    expect(moveNote(v, past)).toBe('Main was at 91% of its 5 h window.');
    expect(moveNote(v, cut)).toBe('Main hit its 5 h limit.');
    expect(moveNote(v, { ...past, window: 'sevenDay', usedPercentage: 96 })).toBe('Main was at 96% of its weekly window.');
    expect(moveNote(v, { ...cut, window: 'sevenDay' })).toBe('Main hit its weekly limit.');
    expect(moveNote(v, { ...past, usedPercentage: null })).toBe('Main was past its 5 h threshold.');
    expect(moveNote(v, { ...past, from: 'acct-gone00' })).toBe('a removed account was at 91% of its 5 h window.');
  });

  it("writes one grey line of its own in the agent's window, as the other notices (8)", () => {
    expect(moveLine(v, past)).toBe('\r\n\x1b[90m(Moved to Second at 14:02: Main was at 91% of its 5 h window.)\x1b[0m\r\n');
    expect(moveLine(v, cut)).toBe('\r\n\x1b[90m(Moved to Second at 14:02: Main hit its 5 h limit.)\x1b[0m\r\n');
    expect(moveLine(v, { ...cut, from: 'acct-000002', to: 'default', at: new Date(2026, 8, 28, 9, 5, 0).getTime() }))
      .toBe('\r\n\x1b[90m(Moved to Main at 09:05: Second hit its 5 h limit.)\x1b[0m\r\n');
  });

  it('says in the title where an agent Tars moved came from, and when (9)', () => {
    const moved = { claudeAccountId: 'acct-000002', claudeAccountMove: past };
    expect(controlLabel(v, moved)).toBe('Second');
    expect(controlTitle(v, moved, NOW)).toBe('Runs on Second, chosen by Tars. Moved from Main at 14:02: Main was at 91% of its 5 h window.');
    expect(controlTitle(v, { ...moved, claudeAccountMove: cut }, NOW)).toBe('Runs on Second, chosen by Tars. Moved from Main at 14:02: Main hit its 5 h limit.');
    const nextDay = new Date(2026, 8, 29, 10, 0, 0);
    expect(controlTitle(v, moved, nextDay)).toBe('Runs on Second, chosen by Tars. Moved from Main on 28 Sep at 14:02: Main was at 91% of its 5 h window.');
    expect(controlTitle(v, {}, NOW)).toBe('Runs on Main, chosen by Tars.');
  });

  it('says no move that no longer holds: pinned since, or started on another account since (9)', () => {
    expect(controlTitle(v, { claudeAccountId: 'acct-000002', claudeAccountPin: 'acct-000002', claudeAccountMove: past }, NOW))
      .toBe('Runs on Second, pinned by you. It stays there past its thresholds, and waits at its limit.');
    expect(controlTitle(v, { claudeAccountId: 'default', claudeAccountMove: past }, NOW)).toBe('Runs on Main, chosen by Tars.');
    expect(controlTitle(v, { claudeAccountMove: past }, NOW)).toBe('Runs on Main, chosen by Tars.');
  });
});
