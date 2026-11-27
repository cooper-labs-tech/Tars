import * as os from 'os';

/**
 * A message for the window with the owner's home said `~`.
 *
 * Node quotes a file error's absolute path, and the home in it names the
 * account: a file of ~/.tars-private Tars could not write put
 * `/Users/<account>/...` in Settings, Hermes, and a broken connection file put
 * it on Schedules (the Audit's I-2 on #658).
 *
 * The home is said `~` wherever a path starts with it, whatever follows it
 * that cannot continue a folder's name: a separator, punctuation, the end
 * (the Audit's I-1 on #660). Not:
 * - another folder whose name starts with the home's last one (acct2,
 *   acct.old, acct-backup);
 * - the home inside a longer path (/System/Volumes/Data/Users/acct, a backup
 *   disk's /Volumes/Backup/Users/acct): that is another place, which `~`
 *   would misname, so it is left as it is.
 * On Windows, where either slash separates, the home is found with either. On
 * Windows and macOS, whose volumes open a path in any letter case (APFS as
 * NTFS), it is found in any case; on Linux another case is another folder. A
 * file URL of the home (file:///Users/acct/x, file:///C:/Users/Acct/x) is said
 * `~` whole, the URL's scheme with it (the Audit's I-a on #660).
 */
export function withoutHome(message: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (!home || home.length < 2) return message;
  const windows = platform === 'win32';
  const caseless = windows || platform === 'darwin';
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = windows ? home.split(/[\\/]/).map(escape).join('[\\\\/]') : escape(home);
  // After a file URL's scheme, or not after a name's character or a separator (a longer path);
  // never before a name's character (a longer name).
  const pattern = new RegExp(`(?:file:\\/\\/\\/?|(?<![\\p{L}\\p{N}_.\\-\\\\/]))${body}(?![\\p{L}\\p{N}_\\-]|\\.[\\p{L}\\p{N}_\\-])`, caseless ? 'giu' : 'gu');
  return message.replace(pattern, '~');
}
