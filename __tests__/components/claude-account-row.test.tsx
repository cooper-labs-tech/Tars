import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, ofType, textOf, elements, type Mount } from './hook-runtime';
import { ClaudeAccountRow, UsageMeter, ThresholdFields } from '../../src/components/Settings/ClaudeAccountRow';
import { Toggle } from '../../src/components/Settings/Toggle';
import { Button, Input } from '../../src/components/ui';
import type { ClaudeAccountState } from '../../src/types/electron';
import type { AccountNote } from '../../src/lib/claude-accounts';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * One account in Settings > Claude accounts, its 5 h and weekly bars, and the
 * two threshold fields. Frames: `Settings · Claude accounts · states`, in
 * design/tars-redesign.pen. Written before the code, as the ways it can fail:
 * 1. the row names another account, or not what Claude Code reported for it
 *    (signed in or not, email, plan, the agents on it), or its folder with the
 *    home spelled out;
 * 2. a bar longer than its use, a threshold tick somewhere else than the
 *    threshold, a bar that does not turn the waiting colour past it and the
 *    error colour at the limit, a reset time that is not there;
 * 3. an account never used draws bars at zero, as if it had been measured;
 * 4. the order arrows move the first row up or the last one down, or move it
 *    the wrong way;
 * 5. the use switch turns on an account that is not signed in (it would take
 *    no agent); or cannot turn off one that is;
 * 6. account 1 can be removed; an account not signed in offers no way to sign
 *    it in; the page's note or main's own sentence about it is lost;
 * 7. a rename sends an empty label, the old label, or a label after Escape;
 * 8. a threshold field sends what is not a whole percentage from 50 to 100,
 *    or keeps showing it once refused;
 * 9. main's answer to a save, landing once something else has been typed,
 *    writes the saved value over it: the new value is lost, or refused
 *    without a word (seen in the e2e at a load average of 180); or a change
 *    from another window does not replace what the fields show.
 */

type El = { type: unknown; props: Record<string, unknown> };
const NOW = new Date(2026, 8, 28, 14, 50, 0);
const at = (h: number, m: number) => Math.floor(new Date(2026, 8, 28, h, m).getTime() / 1000);

function acct(over: Partial<ClaudeAccountState> & { id: string; label: string }): ClaudeAccountState {
  return {
    configDir: over.id === 'default' ? null : `/Users/someone/.claude-accounts/${over.id}`,
    enabled: true, signedIn: true, email: 'you@example.com', subscriptionType: 'max',
    fiveHour: { usedPercentage: 93, resetsAt: at(16, 40) }, sevenDay: { usedPercentage: 40, resetsAt: at(23, 0) },
    updatedAt: NOW.getTime(), blockedUntil: null, agentIds: ['a1', 'a2', 'a3'], error: null,
    ...over,
  };
}

let view: Mount<unknown> | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

function row(account: ClaudeAccountState, over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<[string, unknown]> = [];
  const props = {
    account, position: 2, first: false, last: false, fiveHourThreshold: 90, weeklyThreshold: 95,
    note: null as AccountNote | null,
    onMove: (d: -1 | 1) => calls.push(['move', d]),
    onToggle: () => calls.push(['toggle', null]),
    onRename: (l: string) => calls.push(['rename', l]),
    onRemove: (() => calls.push(['remove', null])) as (() => void) | undefined,
    onSignIn: () => calls.push(['signIn', null]),
    ...over,
  };
  view = mount(() => ClaudeAccountRow(props as Parameters<typeof ClaudeAccountRow>[0]));
  // The ui Buttons, and the name, which is plain text you click to edit.
  const buttons = () => [...(ofType(view!.result, Button) as unknown as El[]), ...(elements(view!.result).filter(e => e.type === 'button') as unknown as El[])];
  const byLabel = (label: string) => buttons().find(b => b.props['aria-label'] === label || textOf(b.props.children as never) === label);
  return { calls, buttons, byLabel, text: () => textOf(view!.result as never) };
}

describe('what the row says (1, 6)', () => {
  it("names the account, Claude Code's answer about it, and its folder with home as ~", () => {
    const r = row(acct({ id: 'acct-2a3b4c', label: 'Second' }));
    const text = r.text();
    expect(text).toContain('Second');
    expect(text).toContain('signed in');
    expect(text).toContain('you@example.com · max · 3 agents');
    expect(text).toContain('~/.claude-accounts/acct-2a3b4c');
    expect(text).not.toContain('/Users/someone');
  });

  it("shows the page's note in its tone, and main's own sentence about the account", () => {
    const r = row(acct({ id: 'default', label: 'Main', error: 'This Claude account is already added as Second.' }), { note: { text: 'Past 90% of its 5 h window: agents go to another account.', tone: 'waiting' } });
    const notes = elements(view!.result).filter(e => typeof e.props.children === 'string');
    const note = notes.find(e => e.props.children === 'Past 90% of its 5 h window: agents go to another account.')!;
    expect(String(note.props.className)).toContain('text-status-waiting');
    const error = notes.find(e => e.props.children === 'This Claude account is already added as Second.')!;
    expect(String(error.props.className)).toContain('text-status-error');
    expect(r.text()).toContain('Main');
  });

  it('offers sign in on an account that is not signed in, and no remove on account 1', () => {
    const out = row(acct({ id: 'acct-000003', label: 'Third', signedIn: false }));
    const signIn = out.byLabel('sign in')!;
    (signIn.props.onClick as () => void)();
    expect(out.calls).toEqual([['signIn', null]]);
    view!.unmount();
    const main = row(acct({ id: 'default', label: 'Main' }), { onRemove: undefined });
    expect(main.byLabel('remove')).toBeUndefined();
    expect(main.byLabel('sign in')).toBeUndefined();
  });
});

describe('the bars (2, 3)', () => {
  it('draws the use, a tick at the threshold, and the reset time, in the tone the use has reached', () => {
    const meter = (usedPercentage: number) => {
      const m = mount(() => UsageMeter({ label: '5 h', window: { usedPercentage, resetsAt: at(16, 40) }, threshold: 90 }));
      const styled = elements(m.result).filter(e => e.props.style);
      const used = styled.find(e => e.props['data-meter'] === 'used')!;
      const tick = styled.find(e => e.props['data-meter'] === 'threshold')!;
      const out = { width: (used.props.style as { width: string }).width, tick: (tick.props.style as { left: string }).left, bar: String(used.props.className), text: textOf(m.result as never) };
      m.unmount();
      return out;
    };
    const low = meter(34.4);
    expect(low).toMatchObject({ width: '34%', tick: '90%', text: '5 h34% · resets 16:40' });
    expect(low.bar).toContain('bg-primary');
    expect(meter(93).bar).toContain('bg-status-waiting');
    const full = meter(100);
    expect(full.bar).toContain('bg-status-error');
    expect(full.width).toBe('100%');
  });

  it('draws no bar at all for an account that was never measured', () => {
    const r = row(acct({ id: 'acct-000004', label: 'Fourth', fiveHour: null, sevenDay: null }), { note: { text: 'No use seen yet: the first agent that runs on it measures it.', tone: 'muted' } });
    expect(ofType(view!.result, UsageMeter)).toHaveLength(0);
    expect(r.text()).toContain('No use seen yet');
  });
});

describe('the controls (4, 5)', () => {
  it('moves up and down, and not past either end', () => {
    const middle = row(acct({ id: 'acct-000002', label: 'Second' }));
    (middle.byLabel('Move Second up')!.props.onClick as () => void)();
    (middle.byLabel('Move Second down')!.props.onClick as () => void)();
    expect(middle.calls).toEqual([['move', -1], ['move', 1]]);
    view!.unmount();
    const first = row(acct({ id: 'default', label: 'Main' }), { first: true, last: true });
    expect(first.byLabel('Move Main up')!.props.disabled).toBe(true);
    expect(first.byLabel('Move Main down')!.props.disabled).toBe(true);
  });

  it('cannot turn on an account that is not signed in, and can always turn one off', () => {
    const toggleOf = () => (ofType(view!.result, Toggle) as unknown as El[])[0];
    row(acct({ id: 'acct-000003', label: 'Third', signedIn: false, enabled: false }));
    expect(toggleOf().props.disabled).toBe(true);
    view!.unmount();
    row(acct({ id: 'acct-000003', label: 'Third', signedIn: false, enabled: true }));
    expect(toggleOf().props.disabled).toBeFalsy();
    view!.unmount();
    const on = row(acct({ id: 'acct-000002', label: 'Second' }));
    expect(toggleOf().props.enabled).toBe(true);
    expect(toggleOf().props.label).toBe('Use Second');
    (toggleOf().props.onChange as () => void)();
    expect(on.calls).toEqual([['toggle', null]]);
  });
});

describe('renaming (7)', () => {
  it('edits the name in place: Enter sends the trimmed label, Escape and an unchanged label send nothing', () => {
    const r = row(acct({ id: 'acct-000002', label: 'Second' }));
    const input = () => (ofType(view!.result, Input) as unknown as El[]).find(e => e.props['aria-label'] === 'Name of Second');
    expect(input()).toBeUndefined();
    (r.byLabel('Rename Second')!.props.onClick as () => void)();
    (input()!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '  Work  ' } });
    (input()!.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({ key: 'Enter', preventDefault: () => {} });
    expect(r.calls).toEqual([['rename', 'Work']]);
    expect(input()).toBeUndefined();

    (r.byLabel('Rename Second')!.props.onClick as () => void)();
    (input()!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'Other' } });
    (input()!.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({ key: 'Escape', preventDefault: () => {} });
    (r.byLabel('Rename Second')!.props.onClick as () => void)();
    (input()!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '   ' } });
    (input()!.props.onBlur as () => void)();
    (r.byLabel('Rename Second')!.props.onClick as () => void)();
    (input()!.props.onBlur as () => void)();
    expect(r.calls).toEqual([['rename', 'Work']]);
  });
});

describe('threshold fields (8)', () => {
  it('sends both values once each is a whole percentage from 50 to 100, and puts a refused one back', () => {
    const saved: Array<{ fiveHour: number; weekly: number }> = [];
    const m = mount(() => ThresholdFields({ fiveHour: 90, weekly: 95, onSave: p => saved.push(p) }));
    const input = (name: string) => (ofType(m.result, Input) as unknown as El[]).find(e => e.props['aria-label'] === name)!;
    const type = (name: string, value: string) => (input(name).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    const blur = (name: string) => (input(name).props.onBlur as () => void)();

    type('5 h threshold', '120');
    blur('5 h threshold');
    expect(saved).toEqual([]);
    expect(input('5 h threshold').props.value).toBe('90');
    expect(textOf(m.result as never)).toContain('A threshold is a whole percentage from 50 to 100.');

    type('Weekly threshold', '98');
    blur('Weekly threshold');
    expect(saved).toEqual([{ fiveHour: 90, weekly: 98 }]);
    expect(textOf(m.result as never)).not.toContain('A threshold is a whole percentage');
    blur('Weekly threshold');
    expect(saved).toHaveLength(1);
    m.unmount();
  });

  it("keeps what was typed after a save when main's answer to it lands, and says a refusal of it (9)", () => {
    const saved: Array<{ fiveHour: number; weekly: number }> = [];
    let main = { fiveHour: 90, weekly: 95 };
    const m = mount(() => ThresholdFields({ ...main, onSave: p => saved.push(p) }));
    const input = (name: string) => (ofType(m.result, Input) as unknown as El[]).find(e => e.props['aria-label'] === name)!;
    const type = (name: string, value: string) => (input(name).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    const blur = (name: string) => (input(name).props.onBlur as () => void)();

    type('5 h threshold', '85');
    blur('5 h threshold');
    expect(saved).toEqual([{ fiveHour: 85, weekly: 95 }]);
    type('5 h threshold', '120');
    main = { fiveHour: 85, weekly: 95 };
    m.rerender();
    expect(input('5 h threshold').props.value).toBe('120');
    blur('5 h threshold');
    expect(input('5 h threshold').props.value).toBe('85');
    expect(textOf(m.result as never)).toContain('A threshold is a whole percentage from 50 to 100.');
    expect(saved).toHaveLength(1);
    m.unmount();
  });

  it('shows a change made from another window, over what was typed (9)', () => {
    let main = { fiveHour: 90, weekly: 95 };
    const m = mount(() => ThresholdFields({ ...main, onSave: () => {} }));
    const input = (name: string) => (ofType(m.result, Input) as unknown as El[]).find(e => e.props['aria-label'] === name)!;
    (input('5 h threshold').props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '88' } });
    main = { fiveHour: 70, weekly: 99 };
    m.rerender();
    expect(input('5 h threshold').props.value).toBe('70');
    expect(input('Weekly threshold').props.value).toBe('99');
    m.unmount();
  });
});
