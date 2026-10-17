import { describe, it, expect } from 'vitest';
import { linuxTrayShown } from '../../../electron/platform/linux-tray';

/**
 * Whether a tray icon is shown on this Linux desktop (2.0.4, parity P2): what decides whether closing the window can
 * hide Tars to the tray (platform/desktop-shell.ts closeAction). Electron's Linux tray is a StatusNotifierItem, shown
 * only where something holds the session bus name org.kde.StatusNotifierWatcher: KDE, and GNOME with the AppIndicator
 * extension (Ubuntu ships it on). GNOME without it shows no icon at all.
 *
 * How it fails, written before the code:
 * 1. A tray is taken as shown on a desktop with no watcher: closing hides Tars where nothing brings it back.
 * 2. A shown tray is missed, so Linux closes (and the agents end) where it could hide.
 * 3. The question goes to a program found on the PATH (the packaged main process may have a bare one), or one that is
 *    missing, failing, hanging or answering oddly throws, hangs the launch, or reads as shown.
 * 4. Another platform asks D-Bus.
 */

type Call = { file: string; args: readonly string[] };
const asking = (answers: Record<string, string | Error>) => {
  const calls: Call[] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const a = answers[file];
    if (a === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, run };
};
const GDBUS_ARGS = ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
  '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'];

describe('whether a tray is shown on Linux', () => {
  it('1-2. asks the session bus, by gdbus at its absolute path, whether a StatusNotifierWatcher is there', async () => {
    const shown = asking({ '/usr/bin/gdbus': '(true,)\n' });
    expect(await linuxTrayShown({ platform: 'linux', run: shown.run })).toBe(true);
    expect(shown.calls).toEqual([{ file: '/usr/bin/gdbus', args: GDBUS_ARGS }]);
    expect(await linuxTrayShown({ platform: 'linux', run: asking({ '/usr/bin/gdbus': '(false,)\n' }).run })).toBe(false);
  });

  it('2-3. without gdbus, dbus-send answers the same question', async () => {
    const shown = asking({ '/usr/bin/dbus-send': '   boolean true\n' });
    expect(await linuxTrayShown({ platform: 'linux', run: shown.run })).toBe(true);
    expect(shown.calls.map((c) => c.file)).toEqual(['/usr/bin/gdbus', '/bin/gdbus', '/usr/bin/dbus-send']);
    expect(shown.calls[2].args).toEqual(['--session', '--print-reply=literal', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher']);
    expect(await linuxTrayShown({ platform: 'linux', run: asking({ '/usr/bin/dbus-send': '   boolean false\n' }).run })).toBe(false);
  });

  it('3. nothing to ask, a failure, or an odd answer: not shown, and nothing thrown', async () => {
    expect(await linuxTrayShown({ platform: 'linux', run: asking({}).run })).toBe(false);
    expect(await linuxTrayShown({ platform: 'linux', run: asking({ '/usr/bin/gdbus': new Error('Cannot autolaunch D-Bus without X11 $DISPLAY') }).run })).toBe(false);
    for (const odd of ['', 'true', '(true)', '(1,)', 'Error: org.freedesktop.DBus.Error.ServiceUnknown']) {
      expect(await linuxTrayShown({ platform: 'linux', run: asking({ '/usr/bin/gdbus': odd }).run }), odd).toBe(false);
    }
  });

  it('4. darwin and win32: not asked', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const ask = asking({ '/usr/bin/gdbus': '(true,)' });
      expect(await linuxTrayShown({ platform, run: ask.run })).toBe(false);
      expect(ask.calls).toEqual([]);
    }
  });

  it.runIf(process.platform === 'linux')('3. real: answers within its time, whatever the machine', async () => {
    const started = Date.now();
    expect(typeof (await linuxTrayShown())).toBe('boolean');
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});
