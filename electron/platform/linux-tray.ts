import { execFile } from 'child_process';

/**
 * Whether a tray icon is shown on this Linux desktop (2.0.4, parity P2).
 * Electron's Linux tray is a StatusNotifierItem, shown only where something
 * holds the session bus name org.kde.StatusNotifierWatcher: KDE, and GNOME
 * with the AppIndicator extension (on in Ubuntu). GNOME without it shows no
 * icon at all, and a close that hid Tars there would leave nothing on screen
 * to bring it back (platform/desktop-shell.ts closeAction).
 *
 * Asked of the session bus by gdbus, else dbus-send, each at its absolute
 * path (the packaged main process can have a bare PATH), within a few
 * seconds. Anything but a plain yes is no; never throws. darwin and win32:
 * no, and nothing is asked.
 */

type Run = (file: string, args: readonly string[]) => Promise<string>;

const WATCHER = 'org.kde.StatusNotifierWatcher';
const ASK_MS = 3_000;

const runFile: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args as string[], { timeout: ASK_MS, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

const ASKS: Array<{ files: string[]; args: string[]; yes: RegExp }> = [
  {
    files: ['/usr/bin/gdbus', '/bin/gdbus'],
    args: ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER],
    yes: /^\(true,\)$/,
  },
  {
    files: ['/usr/bin/dbus-send', '/bin/dbus-send'],
    args: ['--session', '--print-reply=literal', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER}`],
    yes: /^boolean true$/,
  },
];

export async function linuxTrayShown({ platform = process.platform, run = runFile }: { platform?: NodeJS.Platform; run?: Run } = {}): Promise<boolean> {
  if (platform !== 'linux') return false;
  for (const { files, args, yes } of ASKS) {
    for (const file of files) {
      let out: string;
      try {
        out = await run(file, args);
      } catch (err) {
        // Not there: the next one. There but failing (no session bus): no.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return false;
      }
      return yes.test(out.trim());
    }
  }
  return false;
}
