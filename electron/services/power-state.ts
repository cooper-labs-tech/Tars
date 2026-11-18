import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { KeepAwakeMode } from '../types';

/**
 * What the computer tells of its power during a project's hours (2.0.7): an agent's turn dies when the computer
 * sleeps, and two things put it to sleep whatever Tars asks (services/keep-awake.ts holds an app-suspension blocker):
 * a battery that runs out, and a lid closed with no external display (macOS sleeps then, Apple Silicon included; a
 * Linux login manager suspends by default). services/fleet-operations.ts reads it while a window is open and says
 * each warning once a window.
 *
 * Where it is read, and where it is not known:
 * - On battery: macOS and Windows from Electron's powerMonitor; Linux from /sys/class/power_supply, which needs no
 *   service (Chromium's own reading on Linux says false whatever the power).
 * - The lid: macOS from `ioreg -r -k AppleClamshellState -d 1` (no such key: a Mac with no lid); Linux from
 *   /proc/acpi/button/lid/<n>/state (no such folder: no lid, or one the system does not show, said not known on a
 *   computer with a battery). Windows does not say it to a program without a driver of its own: not known.
 * - An external display: macOS from Electron's screen (a display not `internal`); Linux from /sys/class/drm, a
 *   connected connector other than the built-in panel's (eDP, LVDS, DSI). Read only when the lid is closed.
 */

export interface PowerReading {
  battery: boolean | 'unknown';
  /** False with no lid. */
  lidClosed: boolean | 'unknown';
  externalDisplay: boolean | 'unknown';
}

export type PowerWarningKind = 'battery' | 'lid' | 'keep-awake' | 'unknown-battery' | 'unknown-lid';

/** ioreg's answer: true when the lid is closed, false when open, undefined when there is no lid. */
export function clamshellOf(ioreg: string): boolean | undefined {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(ioreg);
  return m ? m[1] === 'Yes' : undefined;
}

const MAINS = new Set(['Mains', 'USB', 'USB_C', 'USB_PD', 'USB_PD_DRP', 'BrickID', 'Wireless']);

/** The supplies of /sys/class/power_supply: on battery when no mains supply is online and a battery discharges. */
export function linuxOnBattery(supplies: Array<{ type?: string; online?: string; status?: string }>): boolean {
  const trim = (s: string | undefined) => (s ?? '').trim();
  if (supplies.some((s) => MAINS.has(trim(s.type)) && trim(s.online) === '1')) return false;
  return supplies.some((s) => trim(s.type) === 'Battery' && trim(s.status) === 'Discharging');
}

/** The lids of /proc/acpi/button/lid/<n>/state: closed when any says so; none, open. */
export function linuxLidClosed(states: string[]): boolean {
  return states.some((s) => /state:\s*closed/.test(s));
}

const BUILT_IN = /^(?:card\d+-)?(?:eDP|LVDS|DSI)(?:-|$)/;

/** The connectors of /sys/class/drm: an external display is a connected one that is not the built-in panel. */
export function linuxExternalDisplay(connectors: Array<{ name: string; status: string }>): boolean {
  return connectors.some((c) => c.status.trim() === 'connected' && !BUILT_IN.test(c.name));
}

/** What the window says for a reading, once a window each (fleet-operations.ts keeps which were said). */
export function powerWarnings(r: PowerReading, keep: { mode: KeepAwakeMode; refused?: boolean }): Array<{ kind: PowerWarningKind; text: string }> {
  const out: Array<{ kind: PowerWarningKind; text: string }> = [];
  if (r.battery === true) {
    out.push({ kind: 'battery', text: 'The computer runs on battery: it sleeps when the battery runs low, and the agents\' turns die with it. Plug it in for the night.' });
  }
  if (r.lidClosed === true && r.externalDisplay !== true) {
    out.push({ kind: 'lid', text: 'The lid is closed with no external display Tars can see: the system puts the computer to sleep whatever Tars asks, and the agents\' turns die with it. Open the lid, or connect a display.' });
  }
  if (keep.mode === 'never') {
    out.push({ kind: 'keep-awake', text: 'Keep the computer awake is set to never, in Settings: the computer may sleep during these hours, and the agents\' turns die with it.' });
  } else if (keep.refused) {
    out.push({ kind: 'keep-awake', text: 'The system refused to keep the computer awake: it may sleep during these hours, and the agents\' turns die with it.' });
  }
  if (r.battery === 'unknown') out.push({ kind: 'unknown-battery', text: 'Tars cannot tell on this system whether the computer runs on battery: check that it is plugged in.' });
  if (r.lidClosed === 'unknown') out.push({ kind: 'unknown-lid', text: 'Tars cannot tell on this system whether the lid is closed: keep it open, or a display connected, for the night.' });
  return out;
}

/** What the reading needs of Electron and the system, so a test can stand in for each. */
export interface PowerDeps {
  platform: NodeJS.Platform;
  onBattery: () => boolean;
  displays: () => Array<{ internal: boolean }>;
  ioreg: () => Promise<string>;
  readDir: (dir: string) => string[];
  readFile: (file: string) => string;
}

function readSupplies(deps: PowerDeps): Array<{ type?: string; online?: string; status?: string }> {
  const root = '/sys/class/power_supply';
  return deps.readDir(root).map((name) => {
    const read = (key: string) => { try { return deps.readFile(path.join(root, name, key)); } catch { return undefined; } };
    return { type: read('type'), online: read('online'), status: read('status') };
  });
}

/** The reading, on this system: what it does not say is 'unknown', never a guess. */
export async function readPower(deps: PowerDeps): Promise<PowerReading> {
  if (deps.platform === 'darwin') {
    let lid: boolean | 'unknown';
    try {
      lid = clamshellOf(await deps.ioreg()) ?? false;
    } catch {
      lid = 'unknown';
    }
    let external: boolean | 'unknown' = 'unknown';
    if (lid === true) {
      try { external = deps.displays().some((d) => !d.internal); } catch { external = 'unknown'; }
    }
    return { battery: safe(deps.onBattery), lidClosed: lid, externalDisplay: lid === true ? external : false };
  }
  if (deps.platform === 'linux') {
    let battery: boolean | 'unknown';
    let supplies: ReturnType<typeof readSupplies> = [];
    try {
      supplies = readSupplies(deps);
      battery = linuxOnBattery(supplies);
    } catch {
      battery = 'unknown';
    }
    let lid: boolean | 'unknown';
    try {
      const root = '/proc/acpi/button/lid';
      lid = linuxLidClosed(deps.readDir(root).map((n) => deps.readFile(path.join(root, n, 'state'))));
    } catch {
      // No lid folder: a desktop has none; a laptop's may not be shown.
      lid = supplies.some((s) => (s.type ?? '').trim() === 'Battery') ? 'unknown' : false;
    }
    let external: boolean | 'unknown' = false;
    if (lid === true) {
      try {
        const root = '/sys/class/drm';
        external = linuxExternalDisplay(deps.readDir(root).filter((n) => n.includes('-')).map((name) => {
          try { return { name, status: deps.readFile(path.join(root, name, 'status')) }; } catch { return { name, status: '' }; }
        }));
      } catch {
        external = 'unknown';
      }
    }
    return { battery, lidClosed: lid, externalDisplay: external };
  }
  // Windows: the power, from the system; the lid, not said.
  return { battery: safe(deps.onBattery), lidClosed: 'unknown', externalDisplay: 'unknown' };
}

function safe(read: () => boolean): boolean | 'unknown' {
  try { return read(); } catch { return 'unknown'; }
}

/** ioreg, by its absolute path and an argv: no shell (CLAUDE.md, Shell rule). */
export function ioregClamshell(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { timeout: 5_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** The system's own file reads, for readPower. */
export const systemFiles = {
  readDir: (dir: string) => fs.readdirSync(dir),
  readFile: (file: string) => fs.readFileSync(file, 'utf8'),
};
