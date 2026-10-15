import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, ofType, textOf, type Mount } from './hook-runtime';
import type { ClaudeAccountState, ClaudeAccountsView } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings > AI & Providers > Claude accounts, on #263's channels
 * (window.electronAPI.claudeAccounts, DESIGN-COMPTES-CLAUDE.md B6). Frames:
 * `Settings · Claude accounts` and `Settings · Claude accounts · states`, and
 * their light copies, in design/tars-redesign.pen. The section is driven here
 * through a stand-in for the bridge, the store and the page together, the
 * way the page is used. Written before the code, as the ways it can fail:
 * 1. the switch reads on while the option is off, or before main has answered,
 *    and a flip sends anything but setEnabled with the other value;
 * 2. it does not say that each account signs in through Claude Code itself,
 *    that Tars never sees the sign-in, and that each account must be your own
 *    and its limits are Anthropic's (Audit B4, closed by JeanBrasse on that line);
 * 3. with the option off, the accounts or the thresholds show;
 * 4. with it on, an account is missing, out of the order main gives, or its
 *    row is told the wrong place, the wrong thresholds, or offers to remove
 *    account 1, which stays;
 * 5. a control reaches the wrong channel or the wrong account: a move that
 *    sends another order than the one on screen with two rows swapped, a use
 *    switch that sends the value it already had, a rename to another id, a
 *    removal without asking first;
 * 6. add an account stays offered at five accounts, or opens nothing; sign in
 *    on an account opens a terminal for another one;
 * 7. a channel that fails says nothing, or a view main pushes later is not
 *    shown;
 * 8. every account at its limit is not said, with when agents resume and on
 *    which account;
 * 9. thresholds outside 50 to 100 are sent, or valid ones are not;
 * 10. a registry main cannot read (#263's registryError, after its gates) is
 *    not said, from the first view or from one main pushes, or stays said once
 *    a view reads again, or is said twice when a change it refuses says the
 *    same sentence.
 */

type El = { type: unknown; props: Record<string, unknown> };
type Calls = Array<[string, unknown]>;
const g = globalThis as unknown as { window?: unknown };
const NOW = new Date(2026, 8, 28, 14, 50, 0);
const at = (h: number, m: number) => Math.floor(new Date(2026, 8, 28, h, m).getTime() / 1000);

function acct(over: Partial<ClaudeAccountState> & { id: string; label: string }): ClaudeAccountState {
  return {
    configDir: over.id === 'default' ? null : `/Users/someone/.claude-accounts/${over.id}`,
    enabled: true, signedIn: true, email: `${over.id}@example.com`, subscriptionType: 'max',
    fiveHour: { usedPercentage: 30, resetsAt: at(18, 20) }, sevenDay: { usedPercentage: 12, resetsAt: at(23, 0) },
    updatedAt: NOW.getTime(), blockedUntil: null, agentIds: [], error: null,
    ...over,
  };
}
function mkView(enabled: boolean, accounts: ClaudeAccountState[], thresholds = { fiveHourThreshold: 90, weeklyThreshold: 95 }, registryError: string | null = null): ClaudeAccountsView {
  return { settings: { enabled, accounts: accounts.map(a => ({ id: a.id, label: a.label, configDir: a.configDir, enabled: a.enabled })), ...thresholds }, accounts, registryError };
}
const MAIN = acct({ id: 'default', label: 'Main' });
const SECOND = acct({ id: 'acct-000002', label: 'Second' });

/** The bridge #263 exposes, answering every channel from `state`, and recording each call. */
function bridge(initial: ClaudeAccountsView, fail: Record<string, string> = {}) {
  const calls: Calls = [];
  let state = initial;
  let pushed: ((v: ClaudeAccountsView) => void) | null = null;
  const answer = (name: string, arg: unknown, next?: (v: ClaudeAccountsView) => ClaudeAccountsView) => {
    calls.push([name, arg]);
    if (fail[name]) return Promise.resolve({ success: false, error: fail[name] });
    if (next) state = next(state);
    return Promise.resolve({ success: true, ...state });
  };
  const api = {
    list: () => answer('list', undefined),
    setEnabled: (on: boolean) => answer('setEnabled', on, v => mkView(on, v.accounts, { fiveHourThreshold: v.settings.fiveHourThreshold, weeklyThreshold: v.settings.weeklyThreshold })),
    setThresholds: (p: { fiveHour: number; weekly: number }) => answer('setThresholds', p, v => mkView(v.settings.enabled, v.accounts, { fiveHourThreshold: p.fiveHour, weeklyThreshold: p.weekly })),
    add: (p: { label: string }) => { calls.push(['add', p]); return Promise.resolve({ success: true, account: acct({ id: 'acct-00000n', label: p.label, signedIn: false }) }); },
    rename: (p: unknown) => answer('rename', p),
    setAccountEnabled: (p: unknown) => answer('setAccountEnabled', p),
    reorder: (ids: string[]) => answer('reorder', ids),
    remove: (id: string) => answer('remove', id),
    refresh: (id?: string) => answer('refresh', id),
    loginStart: (p: unknown) => { calls.push(['loginStart', p]); return Promise.resolve({ success: true, ptyId: 'pty-1' }); },
    loginWrite: () => Promise.resolve({ success: true }),
    loginResize: () => Promise.resolve({ success: true }),
    loginKill: (p: unknown) => { calls.push(['loginKill', p]); return Promise.resolve({ success: true }); },
    onLoginData: () => () => {},
    onLoginExit: () => () => {},
    onChanged: (cb: (v: ClaudeAccountsView) => void) => { pushed = cb; return () => { pushed = null; }; },
    setAgentAccount: (p: unknown) => answer('setAgentAccount', p),
  };
  return { api, calls, push: (v: ClaudeAccountsView) => pushed?.(v) };
}

let page: Mount<unknown> | null = null;
let mods: {
  Section: typeof import('../../src/components/Settings/ClaudeAccountsSection');
  Row: typeof import('../../src/components/Settings/ClaudeAccountRow');
  SettingsRow: typeof import('../../src/components/Settings/SettingsRow');
  Toggle: typeof import('../../src/components/Settings/Toggle');
  Login: typeof import('../../src/components/Settings/ClaudeAccountLoginModal');
  ui: typeof import('../../src/components/ui');
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // Each test hands the store a new bridge, which starts it over.
  mods = {
    Section: await import('../../src/components/Settings/ClaudeAccountsSection'),
    Row: await import('../../src/components/Settings/ClaudeAccountRow'),
    SettingsRow: await import('../../src/components/Settings/SettingsRow'),
    Toggle: await import('../../src/components/Settings/Toggle'),
    Login: await import('../../src/components/Settings/ClaudeAccountLoginModal'),
    ui: await import('../../src/components/ui'),
  };
});
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
  vi.useRealTimers();
});

async function open(view: ClaudeAccountsView, fail: Record<string, string> = {}) {
  const b = bridge(view, fail);
  g.window = { electronAPI: { claudeAccounts: b.api } };
  page = mount(() => mods.Section.ClaudeAccountsSection());
  await settle();
  const rows = () => ofType(page!.result, mods.SettingsRow.SettingsRow) as unknown as El[];
  const row = (label: string) => {
    const found = rows().filter(r => r.props.label === label);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const accountRows = () => ofType(page!.result, mods.Row.ClaudeAccountRow) as unknown as El[];
  return { ...b, rows, row, accountRows };
}

describe('the switch (1, 2, 3)', () => {
  it('reads the option from main, off by default, and a flip sends the other value only', async () => {
    const s = await open(mkView(false, [acct({ id: 'default', label: 'Account 1' })]));
    const control = s.row('Use several Claude subscriptions').props.control as El;
    expect(control.type).toBe(mods.Toggle.Toggle);
    expect(control.props.enabled).toBe(false);
    (control.props.onChange as () => void)();
    await settle();
    expect(s.calls.filter(c => c[0] === 'setEnabled')).toEqual([['setEnabled', true]]);
    expect((s.row('Use several Claude subscriptions').props.control as El).props.enabled).toBe(true);
  });

  it('reads off, and cannot be flipped, until main has answered', () => {
    g.window = { electronAPI: { claudeAccounts: { ...bridge(mkView(true, [MAIN, SECOND])).api, list: () => new Promise(() => {}) } } };
    page = mount(() => mods.Section.ClaudeAccountsSection());
    const control = (ofType(page.result, mods.SettingsRow.SettingsRow) as unknown as El[])[0].props.control as El;
    expect(control.props.enabled).toBe(false);
    expect(control.props.disabled).toBe(true);
  });

  it('says how accounts sign in, that Tars never sees it, and that each account must be your own', async () => {
    const s = await open(mkView(false, [MAIN]));
    const text = textOf(s.row('Use several Claude subscriptions').props.description as never);
    expect(text).toContain('Each account signs in through Claude Code itself, in a terminal Tars opens. Tars never sees the sign-in.');
    expect(text).toContain("Each account must be your own, and its limits are Anthropic's.");
  });

  it('shows no account and no threshold while the option is off', async () => {
    const s = await open(mkView(false, [MAIN, SECOND]));
    expect(s.accountRows()).toHaveLength(0);
    expect(s.rows().map(r => r.props.label)).toEqual(['Use several Claude subscriptions']);
  });
});

describe('the list (4, 5)', () => {
  it("lists main's accounts in main's order, each told its place and the thresholds", async () => {
    const third = acct({ id: 'acct-000003', label: 'Third', signedIn: false });
    const s = await open(mkView(true, [SECOND, MAIN, third], { fiveHourThreshold: 80, weeklyThreshold: 97 }));
    const rows = s.accountRows();
    expect(rows.map(r => (r.props.account as ClaudeAccountState).id)).toEqual(['acct-000002', 'default', 'acct-000003']);
    expect(rows.map(r => [r.props.position, r.props.first, r.props.last])).toEqual([[1, true, false], [2, false, false], [3, false, true]]);
    expect(rows.every(r => r.props.fiveHourThreshold === 80 && r.props.weeklyThreshold === 97)).toBe(true);
    expect(rows[1].props.onRemove).toBeUndefined();
    expect(typeof rows[0].props.onRemove).toBe('function');
    expect(textOf(s.row('Accounts').props.description as never)).toBe('Agents go where the most room is left, and this order breaks ties. 3 of 5.');
  });

  it('sends the order on screen with the two rows swapped', async () => {
    const third = acct({ id: 'acct-000003', label: 'Third' });
    const s = await open(mkView(true, [MAIN, SECOND, third]));
    (s.accountRows()[1].props.onMove as (d: -1 | 1) => void)(1);
    await settle();
    expect(s.calls.filter(c => c[0] === 'reorder')).toEqual([['reorder', ['default', 'acct-000003', 'acct-000002']]]);
  });

  it("sends the other value of an account's use switch, and a rename, to that account", async () => {
    const off = acct({ id: 'acct-000002', label: 'Second', enabled: false });
    const s = await open(mkView(true, [MAIN, off]));
    (s.accountRows()[1].props.onToggle as () => void)();
    (s.accountRows()[0].props.onRename as (l: string) => void)('Work');
    await settle();
    expect(s.calls.filter(c => c[0] === 'setAccountEnabled' || c[0] === 'rename')).toEqual([
      ['setAccountEnabled', { id: 'acct-000002', enabled: true }],
      ['rename', { id: 'default', label: 'Work' }],
    ]);
  });

  it('asks before removing an account, and removes only that one', async () => {
    const s = await open(mkView(true, [MAIN, SECOND]));
    (s.accountRows()[1].props.onRemove as () => void)();
    await settle();
    expect(s.calls.filter(c => c[0] === 'remove')).toEqual([]);
    const dialogs = ofType(page!.result, mods.ui.DialogShell) as unknown as El[];
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].props.title).toBe('Remove Second?');
    expect(textOf(dialogs[0].props.subtitle as never)).toBe('Claude Code signs its folder out, and Tars moves the folder to the Trash. Its agents move to another account as their turns end.');
    const buttons = ofType(dialogs[0].props.footerRight, mods.ui.Button) as unknown as El[];
    const confirm = buttons.find(b => textOf(b.props.children as never) === 'Remove Second')!;
    expect(confirm.props.variant).toBe('danger');
    (confirm.props.onClick as () => void)();
    await settle();
    expect(s.calls.filter(c => c[0] === 'remove')).toEqual([['remove', 'acct-000002']]);
    expect(ofType(page!.result, mods.ui.DialogShell)).toHaveLength(0);
  });
});

describe('adding and signing in (6)', () => {
  it('opens the sign-in terminal to add an account, or on the account whose sign in was pressed', async () => {
    const third = acct({ id: 'acct-000003', label: 'Third', signedIn: false });
    const s = await open(mkView(true, [MAIN, SECOND, third]));
    const add = s.row('Accounts').props.control as El;
    expect(add.props.disabled).toBeFalsy();
    (add.props.onClick as () => void)();
    let modals = ofType(page!.result, mods.Login.ClaudeAccountLoginModal) as unknown as El[];
    expect(modals).toHaveLength(1);
    expect(modals[0].props.accountId).toBeUndefined();
    (modals[0].props.onClose as () => void)();
    expect(ofType(page!.result, mods.Login.ClaudeAccountLoginModal)).toHaveLength(0);

    (s.accountRows()[2].props.onSignIn as () => void)();
    modals = ofType(page!.result, mods.Login.ClaudeAccountLoginModal) as unknown as El[];
    expect(modals).toHaveLength(1);
    expect(modals[0].props.accountId).toBe('acct-000003');
  });

  it('turns add an account off at five accounts, and says why', async () => {
    const five = [MAIN, SECOND, ...[3, 4, 5].map(n => acct({ id: `acct-00000${n}`, label: `A${n}` }))];
    const s = await open(mkView(true, five));
    expect((s.row('Accounts').props.control as El).props.disabled).toBe(true);
    expect(textOf(s.row('Accounts').props.description as never)).toBe('Five accounts, the most Tars runs at once.');
  });
});

describe('what main says (7, 8)', () => {
  it("shows a failed channel's sentence, and a view main pushes later", async () => {
    const s = await open(mkView(true, [MAIN, SECOND]), { reorder: 'A new order names every account once.' });
    (s.accountRows()[1].props.onMove as (d: -1 | 1) => void)(-1);
    await settle();
    expect(textOf(page!.result as never)).toContain('A new order names every account once.');

    s.push(mkView(true, [MAIN, SECOND, acct({ id: 'acct-000003', label: 'Third' })]));
    await settle();
    expect(s.accountRows().map(r => (r.props.account as ClaudeAccountState).label)).toEqual(['Main', 'Second', 'Third']);
  });

  it('says when agents resume, and on which account, once every account is at its limit', async () => {
    const full = acct({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 100, resetsAt: at(22, 15) } });
    const blocked = acct({ id: 'acct-000002', label: 'Second', blockedUntil: at(21, 40) });
    const s = await open(mkView(true, [full, blocked]));
    expect(textOf(page!.result as never)).toContain('Every account is at its limit. Agents resume at 21:40 when Second resets.');
    s.push(mkView(true, [full, SECOND]));
    await settle();
    expect(textOf(page!.result as never)).not.toContain('Every account is at its limit');
  });
});

describe('a registry main cannot read (10)', () => {
  const FROZEN = '~/.tars-private/claude-accounts.json does not read as a list of accounts. Nothing is changed until it is fixed or removed.';
  const times = (text: string) => textOf(page!.result as never).split(text).length - 1;

  it('says so from the first view, and no longer once a view main pushes reads again', async () => {
    const s = await open(mkView(true, [MAIN], undefined, FROZEN));
    expect(times(FROZEN)).toBe(1);
    s.push(mkView(true, [MAIN, SECOND]));
    await settle();
    expect(times(FROZEN)).toBe(0);
    s.push(mkView(true, [MAIN], undefined, FROZEN));
    await settle();
    expect(times(FROZEN)).toBe(1);
  });

  it('says it once when a change it refuses says the same sentence', async () => {
    const s = await open(mkView(true, [MAIN], undefined, FROZEN), { setEnabled: FROZEN });
    const toggle = ofType(page!.result, mods.Toggle.Toggle)[0] as unknown as El;
    (toggle.props.onChange as () => void)();
    await settle();
    expect(s.calls.map(([name]) => name)).toContain('setEnabled');
    expect(times(FROZEN)).toBe(1);
  });
});

describe('thresholds (9)', () => {
  it('saves both thresholds when they are whole percentages from 50 to 100, and never otherwise', async () => {
    const s = await open(mkView(true, [MAIN, SECOND]));
    const fields = s.row('Move agents at').props.control as El;
    expect([fields.props.fiveHour, fields.props.weekly]).toEqual([90, 95]);
    const save = fields.props.onSave as (p: { fiveHour: number; weekly: number }) => void;
    save({ fiveHour: 49, weekly: 95 });
    save({ fiveHour: 85.5, weekly: 95 });
    save({ fiveHour: 85, weekly: 101 });
    await settle();
    expect(s.calls.filter(c => c[0] === 'setThresholds')).toEqual([]);
    save({ fiveHour: 85, weekly: 100 });
    await settle();
    expect(s.calls.filter(c => c[0] === 'setThresholds')).toEqual([['setThresholds', { fiveHour: 85, weekly: 100 }]]);
    expect([(s.row('Move agents at').props.control as El).props.fiveHour, (s.row('Move agents at').props.control as El).props.weekly]).toEqual([85, 100]);
  });
});
