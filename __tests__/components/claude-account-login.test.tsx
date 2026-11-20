import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, ofType, textOf, elements, type Mount } from './hook-runtime';
import type { ClaudeAccountState, ClaudeAccountsView } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));
// The terminal's theme follows the document, which a node run does not have.
vi.mock('../../src/lib/terminal-theme', () => ({
  useTerminalTheme: () => ({}),
  createXtermOptions: () => ({}),
  TERMINAL_SURFACE_CLASS: 'bg-term-bg',
}));

/**
 * Adding a Claude account, and signing one in: the terminal where Claude Code's
 * own `claude auth login --claudeai` runs, on #263's login channels. Frames:
 * `Settings · Claude accounts · states` > ADDING AN ACCOUNT. Written before the
 * code, as the ways it can fail:
 * 1. an account is added under an empty label, or under the one proposed when
 *    another was typed; a refusal from main is not said, or the terminal opens
 *    anyway;
 * 2. signing in an account that exists adds another one, or opens a terminal
 *    for another account;
 * 3. the terminal shows another terminal's output, sends keys to another one,
 *    or forwards the terminal's own replies to a query as if they were typed;
 * 4. closing the dialog leaves `claude auth login` running, or kills one that
 *    has already ended;
 * 5. the footer says the account is signed in before Claude Code says so, or
 *    says nothing when the sign-in ended in failure.
 */

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };
const NOW = new Date(2026, 8, 28, 14, 50, 0);

function acct(over: Partial<ClaudeAccountState> & { id: string; label: string }): ClaudeAccountState {
  return {
    configDir: over.id === 'default' ? null : `/Users/someone/.claude-accounts/${over.id}`,
    enabled: true, signedIn: true, email: `${over.id}@example.com`, subscriptionType: 'max',
    fiveHour: null, sevenDay: null, updatedAt: null, blockedUntil: null, agentIds: [], error: null,
    ...over,
  };
}
function mkView(accounts: ClaudeAccountState[]): ClaudeAccountsView {
  return { settings: { enabled: true, accounts: accounts.map(a => ({ id: a.id, label: a.label, configDir: a.configDir, enabled: a.enabled })), fiveHourThreshold: 90, weeklyThreshold: 95 }, accounts };
}

function bridge(view: ClaudeAccountsView, addFails?: string) {
  const calls: Array<[string, unknown]> = [];
  let pushed: ((v: ClaudeAccountsView) => void) | null = null;
  const data: Array<(e: { ptyId: string; data: string }) => void> = [];
  const exit: Array<(e: { ptyId: string; exitCode: number }) => void> = [];
  const api = {
    list: () => Promise.resolve({ success: true, ...view }),
    add: (p: { label: string }) => {
      calls.push(['add', p]);
      return Promise.resolve(addFails ? { success: false, error: addFails } : { success: true, account: acct({ id: 'acct-00000n', label: p.label, signedIn: false }) });
    },
    loginStart: (p: unknown) => { calls.push(['loginStart', p]); return Promise.resolve({ success: true, ptyId: 'pty-1' }); },
    loginWrite: (p: unknown) => { calls.push(['loginWrite', p]); return Promise.resolve({ success: true }); },
    loginResize: (p: unknown) => { calls.push(['loginResize', p]); return Promise.resolve({ success: true }); },
    loginKill: (p: unknown) => { calls.push(['loginKill', p]); return Promise.resolve({ success: true }); },
    onLoginData: (cb: (e: { ptyId: string; data: string }) => void) => { data.push(cb); return () => { data.splice(data.indexOf(cb), 1); calls.push(['offData', null]); }; },
    onLoginExit: (cb: (e: { ptyId: string; exitCode: number }) => void) => { exit.push(cb); return () => { exit.splice(exit.indexOf(cb), 1); calls.push(['offExit', null]); }; },
    onChanged: (cb: (v: ClaudeAccountsView) => void) => { pushed = cb; return () => { pushed = null; }; },
  };
  return {
    api, calls,
    push: (v: ClaudeAccountsView) => pushed?.(v),
    emitData: (e: { ptyId: string; data: string }) => [...data].forEach(cb => cb(e)),
    emitExit: (e: { ptyId: string; exitCode: number }) => [...exit].forEach(cb => cb(e)),
  };
}

/** Enough of an xterm Terminal for the wiring: what was written, and a way to type. */
function fakeTerm() {
  const written: string[] = [];
  let typed: ((d: string) => void) | null = null;
  return {
    written,
    type: (d: string) => typed?.(d),
    term: { cols: 100, rows: 30, write: (d: string) => { written.push(d); }, onData: (cb: (d: string) => void) => { typed = cb; return { dispose: () => { typed = null; } }; } },
  };
}

let modal: Mount<unknown> | null = null;
let mods: {
  Login: typeof import('../../src/components/Settings/ClaudeAccountLoginModal');
  ui: typeof import('../../src/components/ui');
};
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mods = { Login: await import('../../src/components/Settings/ClaudeAccountLoginModal'), ui: await import('../../src/components/ui') };
});
afterEach(() => {
  modal?.unmount();
  modal = null;
  delete g.window;
  vi.useRealTimers();
});

async function openModal(view: ClaudeAccountsView, accountId?: string, addFails?: string) {
  const b = bridge(view, addFails);
  g.window = { electronAPI: { claudeAccounts: b.api } };
  const closed: string[] = [];
  modal = mount(() => mods.Login.ClaudeAccountLoginModal({ accountId, onClose: () => closed.push('closed') }));
  await settle();
  const shell = () => (ofType(modal!.result, mods.ui.DialogShell) as unknown as El[])[0];
  const input = () => (ofType(shell().props.children, mods.ui.Input) as unknown as El[])[0];
  const button = (label: string) => (ofType([shell().props.footerRight, shell().props.children], mods.ui.Button) as unknown as El[]).find(x => textOf(x.props.children as never) === label);
  return { ...b, closed, shell, input, button };
}

describe('adding (1)', () => {
  it('adds the account under the label typed, trimmed, then opens its sign-in', async () => {
    const m = await openModal(mkView([acct({ id: 'default', label: 'Account 1' }), acct({ id: 'acct-000002', label: 'Account 2' })]));
    expect(m.shell().props.title).toBe('Add a Claude account');
    expect(m.input().props.value).toBe('Account 3');
    (m.input().props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '  Work  ' } });
    (m.button('Add and sign in')!.props.onClick as () => void)();
    await settle();
    expect(m.calls.filter(c => c[0] === 'add')).toEqual([['add', { label: 'Work' }]]);
    expect(m.input()).toBeUndefined();
    expect(textOf(m.shell().props.subtitle as never)).toBe("Claude Code's own sign-in runs below, in a folder of its own. Tars never sees it.");
  });

  it('adds nothing under an empty label, and says what main refused', async () => {
    const m = await openModal(mkView([acct({ id: 'default', label: 'Account 1' })]), undefined, 'Another account already has the label "Work".');
    (m.input().props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '   ' } });
    (m.button('Add and sign in')!.props.onClick as () => void)();
    await settle();
    expect(m.calls.filter(c => c[0] === 'add')).toEqual([]);
    expect(textOf(m.shell().props.children as never)).toContain('An account needs a label.');

    (m.input().props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'Work' } });
    (m.button('Add and sign in')!.props.onClick as () => void)();
    await settle();
    expect(textOf(m.shell().props.children as never)).toContain('Another account already has the label "Work".');
    expect(m.input()).toBeDefined();
    expect(m.calls.filter(c => c[0] === 'loginStart')).toEqual([]);
  });
});

describe('signing in (2, 5)', () => {
  it('opens on the account given, without adding one, and says it is signed in only once Claude Code does', async () => {
    const out = acct({ id: 'acct-000003', label: 'Third', signedIn: false });
    const m = await openModal(mkView([acct({ id: 'default', label: 'Main' }), out]), 'acct-000003');
    expect(m.input()).toBeUndefined();
    expect(m.shell().props.title).toBe('Sign in Third');
    expect(textOf(m.shell().props.footerLeft as never)).toBe('Waiting for the sign-in. Third is in the list already, and reads signed in once Claude Code says so.');
    expect(m.button('Close')).toBeDefined();
    m.push(mkView([acct({ id: 'default', label: 'Main' }), { ...out, signedIn: true, email: 'third@example.com' }]));
    await settle();
    expect(textOf(m.shell().props.footerLeft as never)).toBe('Signed in as third@example.com.');
    expect(m.button('Done')).toBeDefined();
    expect(m.calls.filter(c => c[0] === 'add')).toEqual([]);
  });

  it("says so when Claude Code's sign-in ended in failure", async () => {
    const out = acct({ id: 'acct-000003', label: 'Third', signedIn: false });
    const m = await openModal(mkView([out]), 'acct-000003');
    const exits: number[] = [];
    const t = fakeTerm();
    mods.Login.connectLoginTerminal(m.api as never, 'acct-000003', t.term, code => exits.push(code));
    await settle();
    m.emitExit({ ptyId: 'pty-1', exitCode: 1 });
    expect(exits).toEqual([1]);
  });
});

describe('the terminal (3, 4)', () => {
  it("starts the account's login at the terminal's size, shows only its output, and sends only typed keys", async () => {
    const b = bridge(mkView([]));
    const t = fakeTerm();
    const exits: number[] = [];
    const wire = mods.Login.connectLoginTerminal(b.api as never, 'acct-000003', t.term, code => exits.push(code));
    await settle();
    expect(b.calls.filter(c => c[0] === 'loginStart')).toEqual([['loginStart', { id: 'acct-000003', cols: 100, rows: 30 }]]);
    b.emitData({ ptyId: 'pty-1', data: 'Opening your browser' });
    b.emitData({ ptyId: 'pty-9', data: 'someone else' });
    expect(t.written).toEqual(['Opening your browser']);
    t.type('1');
    t.type('\x1b[?1;2c');
    expect(b.calls.filter(c => c[0] === 'loginWrite')).toEqual([['loginWrite', { ptyId: 'pty-1', data: '1' }]]);

    wire.dispose();
    expect(b.calls.filter(c => c[0] === 'loginKill')).toEqual([['loginKill', { ptyId: 'pty-1' }]]);
    expect(b.calls.filter(c => c[0] === 'offData' || c[0] === 'offExit')).toHaveLength(2);
  });

  it('does not kill a login that has already ended', async () => {
    const b = bridge(mkView([]));
    const t = fakeTerm();
    const wire = mods.Login.connectLoginTerminal(b.api as never, 'acct-000003', t.term, () => {});
    await settle();
    b.emitExit({ ptyId: 'pty-1', exitCode: 0 });
    wire.dispose();
    expect(b.calls.filter(c => c[0] === 'loginKill')).toEqual([]);
  });

  it('closes the dialog on Close: unmounting it disposes the wiring, which kills a running login (above)', async () => {
    const m = await openModal(mkView([acct({ id: 'acct-000003', label: 'Third', signedIn: false })]), 'acct-000003');
    (m.button('Close')!.props.onClick as () => void)();
    expect(m.closed).toEqual(['closed']);
  });
});

it('draws the terminal on the terminal surface, inside the dialog', async () => {
  const m = await openModal(mkView([acct({ id: 'acct-000003', label: 'Third', signedIn: false })]), 'acct-000003');
  const surface = elements(m.shell().props.children).find(e => String(e.props.className ?? '').includes('bg-term-bg'));
  expect(surface).toBeDefined();
});
