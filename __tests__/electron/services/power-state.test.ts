import { describe, expect, it } from 'vitest';
import {
  clamshellOf, linuxExternalDisplay, linuxLidClosed, linuxOnBattery, powerWarnings, type PowerReading,
} from '../../../electron/services/power-state';

/**
 * What the computer tells of its power during a project's hours (services/power-state.ts, 2.0.7): on battery, a lid
 * closed with no external display (agents' turns die when the computer sleeps), read where the system says it, and
 * said plainly not known where it does not.
 *
 * How it fails, written before the code:
 * 1. macOS: ioreg's "AppleClamshellState" = Yes read as open, No as closed, or a Mac with no lid (no such key) read as
 *    closed or as not known.
 * 2. Linux, /sys/class/power_supply: a laptop on its mains with its battery charging read as on battery; one off its
 *    mains with its battery discharging read as on mains; a desktop with no supply listed read as on battery.
 * 3. Linux, /proc/acpi/button/lid/<n>/state: "state:      closed" read as open; no lid read as closed.
 * 4. Linux, /sys/class/drm: the built-in panel (eDP, LVDS, DSI) read as an external display; a connected HDMI or DP
 *    one not; a disconnected one counted.
 * 5. Warnings: on battery not warned; a lid closed with an external display warned (that is the clamshell mode that
 *    keeps running); a lid closed with no external display, or none Tars can see, not warned; a reading the system
 *    does not give said as nothing; keep awake set to never, or refused by the system, not warned; a computer on its
 *    mains, lid open, warned anyway.
 * 6. A warning carries a dash of the forbidden kind.
 */

describe('clamshellOf (macOS)', () => {
  it('1. reads the lid from ioreg, and no key as no lid', () => {
    expect(clamshellOf('+-o AppleSmartBattery\n    {\n      "AppleClamshellState" = Yes\n      "AppleClamshellCausesSleep" = Yes\n')).toBe(true);
    expect(clamshellOf('    "AppleClamshellState" = No\n')).toBe(false);
    expect(clamshellOf('')).toBeUndefined();
    expect(clamshellOf('+-o IOPMrootDomain  <class IOPMrootDomain>\n')).toBeUndefined();
  });
});

describe('Linux readings', () => {
  it('2. reads battery power from the power supplies', () => {
    expect(linuxOnBattery([{ type: 'Mains', online: '1' }, { type: 'Battery', status: 'Charging' }])).toBe(false);
    expect(linuxOnBattery([{ type: 'Mains', online: '0' }, { type: 'Battery', status: 'Discharging' }])).toBe(true);
    expect(linuxOnBattery([{ type: 'Battery', status: 'Discharging' }])).toBe(true);
    expect(linuxOnBattery([{ type: 'USB', online: '1' }, { type: 'Battery', status: 'Discharging' }])).toBe(false);
    expect(linuxOnBattery([])).toBe(false);
    expect(linuxOnBattery([{ type: 'Mains', online: '1' }])).toBe(false);
  });

  it('3. reads the lid, and no lid as open', () => {
    expect(linuxLidClosed(['state:      closed\n'])).toBe(true);
    expect(linuxLidClosed(['state:      open\n'])).toBe(false);
    expect(linuxLidClosed(['state:      open\n', 'state:      closed\n'])).toBe(true);
    expect(linuxLidClosed([])).toBe(false);
  });

  it('4. counts only connected displays that are not the built-in panel', () => {
    expect(linuxExternalDisplay([{ name: 'card0-eDP-1', status: 'connected' }])).toBe(false);
    expect(linuxExternalDisplay([{ name: 'card0-LVDS-1', status: 'connected\n' }, { name: 'card0-DSI-1', status: 'connected' }])).toBe(false);
    expect(linuxExternalDisplay([{ name: 'card0-eDP-1', status: 'connected' }, { name: 'card1-HDMI-A-1', status: 'connected\n' }])).toBe(true);
    expect(linuxExternalDisplay([{ name: 'card0-DP-1', status: 'disconnected' }])).toBe(false);
    expect(linuxExternalDisplay([])).toBe(false);
  });
});

describe('powerWarnings', () => {
  const fine: PowerReading = { battery: false, lidClosed: false, externalDisplay: false };
  const keep = { mode: 'while-working' as const };
  const kinds = (r: PowerReading, k: Parameters<typeof powerWarnings>[1] = keep) => powerWarnings(r, k).map((w) => w.kind);

  it('5. warns of what kills a turn, and says what it cannot know', () => {
    expect(kinds(fine)).toEqual([]);
    expect(kinds({ ...fine, battery: true })).toEqual(['battery']);
    expect(kinds({ ...fine, lidClosed: true, externalDisplay: true })).toEqual([]);
    expect(kinds({ ...fine, lidClosed: true, externalDisplay: false })).toEqual(['lid']);
    expect(kinds({ ...fine, lidClosed: true, externalDisplay: 'unknown' })).toEqual(['lid']);
    expect(kinds({ battery: 'unknown', lidClosed: 'unknown', externalDisplay: 'unknown' })).toEqual(['unknown-battery', 'unknown-lid']);
    expect(kinds(fine, { mode: 'never' })).toEqual(['keep-awake']);
    expect(kinds(fine, { mode: 'always', refused: true })).toEqual(['keep-awake']);
  });

  it('6. says it with no forbidden dash', () => {
    const all = powerWarnings({ battery: true, lidClosed: true, externalDisplay: false }, { mode: 'never' })
      .concat(powerWarnings({ battery: 'unknown', lidClosed: 'unknown', externalDisplay: 'unknown' }, { mode: 'always', refused: true }));
    expect(all.length).toBe(6);
    for (const w of all) {
      expect(w.text).not.toMatch(/[\u2013\u2014]/);
      expect(w.text.length).toBeGreaterThan(20);
    }
  });
});
