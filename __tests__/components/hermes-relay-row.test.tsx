import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, elements, ofType, textOf, type Mount } from './hook-runtime';
import { HermesRelayRow } from '../../src/components/Settings/HermesRelayRow';
import { Toggle } from '../../src/components/Settings/Toggle';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';
import { Button, StatusBadge } from '../../src/components/ui';
import type { HermesRelayStatus } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Telegram through Hermes switch in Settings, Hermes (#285's contract:
 * `hermesRelayEnabled`, `hermes.relayStatus()` and `onRelayStatus`). Frames:
 * `Settings · Connection`, and `Settings · Connection · Telegram through
 * Hermes` with its light copy. Written before the code. How it can fail:
 * 1. a click on the switch turns the relay on at once, and erases the bot's
 *    token with no warning first;
 * 2. cancel saves anyway, or leaves the warning up;
 * 3. turn on saves something other than hermesRelayEnabled on, or twice;
 * 4. turning it off asks first (nothing is erased then), or saves nothing;
 * 5. the row shows a state while the switch is off, not the one main reports
 *    (relayStatus at mount, each onRelayStatus after), or keeps listening once
 *    it is gone;
 * 6. the switch has no name for assistive technology.
 */

type Row = ReturnType<typeof HermesRelayRow>;
const g = globalThis as unknown as { window?: unknown };
let row: Mount<Row> | null = null;
let push: ((s: HermesRelayStatus) => void) | null = null;
let unsubscribed = false;
const onSave = vi.fn();

function api(initial: HermesRelayStatus) {
  g.window = {
    electronAPI: {
      hermes: {
        relayStatus: vi.fn(async () => initial),
        onRelayStatus: vi.fn((cb: (s: HermesRelayStatus) => void) => { push = cb; return () => { unsubscribed = true; }; }),
      },
    },
  };
}

beforeEach(() => {
  onSave.mockReset();
  push = null;
  unsubscribed = false;
});
afterEach(() => {
  row?.unmount();
  row = null;
  delete g.window;
});

async function open(enabled: boolean, initial: HermesRelayStatus = { enabled, state: enabled ? 'ready' : 'off', waiting: 0 }) {
  api(initial);
  row = mount(() => HermesRelayRow({ enabled, onSave }));
  await settle();
  return row;
}

const toggle = (r: Mount<Row>) => ofType(r.result, Toggle)[0].props as { enabled: boolean; onChange: () => void; label?: string };
const settingsRow = (r: Mount<Row>) => ofType(r.result, SettingsRow)[0].props as { label: string; description: string; control: unknown };
const buttons = (r: Mount<Row>) => ofType(r.result, Button).map(b => ({ text: textOf(b.props.children as never), click: b.props.onClick as () => void }));
const button = (r: Mount<Row>, text: string) => buttons(r).find(b => b.text === text);
const notice = (r: Mount<Row>) => elements(r.result).filter(el => typeof el.props.children !== 'undefined')
  .map(el => (typeof el.props.children === 'string' ? el.props.children : '')).find(t => t.startsWith('Turning it on erases'));
const word = (r: Mount<Row>) => ofType(settingsRow(r).control, StatusBadge).map(b => textOf(b.props.children as never)).join('').trim();

describe('the Telegram through Hermes switch', () => {
  it('asks first: a click on the switch shows the warning and saves nothing (1)', async () => {
    const r = await open(false);
    toggle(r).onChange();
    expect(onSave).not.toHaveBeenCalled();
    expect(notice(r)).toContain("Turning it on erases the Tars bot's token and switches the bot off");
    expect(button(r, 'turn on')).toBeDefined();
    expect(button(r, 'cancel')).toBeDefined();
    expect(toggle(r).enabled).toBe(false);
  });

  it('cancel takes the warning down and saves nothing (2)', async () => {
    const r = await open(false);
    toggle(r).onChange();
    button(r, 'cancel')!.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(notice(r)).toBeUndefined();
    expect(button(r, 'turn on')).toBeUndefined();
  });

  it('turn on saves the switch on, once, and takes the warning down (3)', async () => {
    const r = await open(false);
    toggle(r).onChange();
    button(r, 'turn on')!.click();
    expect(onSave.mock.calls).toEqual([[true]]);
    expect(notice(r)).toBeUndefined();
  });

  it('turning it off saves at once, with no warning (4)', async () => {
    const r = await open(true);
    toggle(r).onChange();
    expect(onSave.mock.calls).toEqual([[false]]);
    expect(notice(r)).toBeUndefined();
  });

  it('says no state while off, and the warning (5)', async () => {
    const r = await open(false);
    expect(word(r)).toBe('');
    expect(settingsRow(r).description).toContain("Turning it on erases the Tars bot's token and switches the bot off.");
  });

  it('says no state once the switch is off, while main\'s last report still says ready (5)', async () => {
    const r = await open(false, { enabled: true, state: 'ready', waiting: 0 });
    expect(word(r)).toBe('');
    expect(settingsRow(r).description).toContain("Turning it on erases the Tars bot's token and switches the bot off.");
  });

  it('says the state main reports, at once and as it changes, and stops listening when it goes (5)', async () => {
    const r = await open(true, { enabled: true, state: 'unreachable', waiting: 2 });
    expect(word(r)).toBe('unreachable');
    expect(settingsRow(r).description).toBe('Hermes did not answer. 2 messages wait, and go when it answers.');
    push!({ enabled: true, state: 'ready', waiting: 0 });
    expect(word(r)).toBe('ready');
    r.unmount();
    row = null;
    expect(unsubscribed).toBe(true);
  });

  it('names the switch (6)', async () => {
    const r = await open(false);
    expect(toggle(r).label).toBe('Telegram through Hermes');
    expect(settingsRow(r).label).toBe('Telegram through Hermes');
  });
});
