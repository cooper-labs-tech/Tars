import { describe, it, expect } from 'vitest';
import { withoutHome } from '../../../electron/utils/without-home';

/**
 * withoutHome says the owner's home `~` in a message for the window (#660):
 * Node quotes a file error's absolute path, and the home in it names the
 * account. The Audit's I-1 on #660 measured where it missed.
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. The home followed at once by '.' or ':' stays whole: the end of a
 *    sentence ("in /Users/acct."), a colon after the path ("/Users/acct: denied").
 * 2. On Windows, the home written in another letter case (c:\users\acct, which
 *    names the same folder there) or with forward slashes (C:/Users/Acct) stays.
 * 3. Another folder whose name starts with the home's last one (/Users/acct2,
 *    /Users/acct.old, /Users/acct-backup) is cut into "~2", "~.old", "~-backup".
 * 4. The home inside a longer path (/System/Volumes/Data/Users/acct, macOS's
 *    data volume; /Volumes/Backup/Users/acct, a backup disk) becomes
 *    "/System/Volumes/Data~", which reads as nothing. Such a path is another
 *    place than the home, and "~" would name the wrong one: it is left alone.
 * 5. A home of '/' or '' (a container's root) turns every '/' into '~'.
 * 6. Elsewhere than Windows, another letter case is another folder: left alone.
 */

describe('the home, wherever a message ends it (1)', () => {
  const HOME = '/Users/acct';
  const SAID: Array<[string, string]> = [
    ["EACCES: permission denied, open '/Users/acct/.tars-private/hermes-token'", "EACCES: permission denied, open '~/.tars-private/hermes-token'"],
    ['the file is in /Users/acct.', 'the file is in ~.'],
    ['/Users/acct: permission denied', '~: permission denied'],
    ['rename /Users/acct/a -> /Users/acct/b', 'rename ~/a -> ~/b'],
    ['"/Users/acct"', '"~"'],
    ['(/Users/acct)', '(~)'],
  ];
  it.each(SAID)('%s', (message, said) => {
    expect(withoutHome(message, HOME, 'darwin')).toBe(said);
  });

  it('on Linux, the same', () => {
    expect(withoutHome("ENOENT: no such file or directory, open '/home/acct/.cache/tars-updater/x.zip'", '/home/acct', 'linux'))
      .toBe("ENOENT: no such file or directory, open '~/.cache/tars-updater/x.zip'");
  });
});

describe('the home on Windows, in any letter case and either slash (2)', () => {
  const HOME = 'C:\\Users\\Acct';
  const SAID: Array<[string, string]> = [
    ["EPERM: operation not permitted, open 'C:\\Users\\Acct\\AppData\\Local\\x'", "EPERM: operation not permitted, open '~\\AppData\\Local\\x'"],
    ["open 'c:\\users\\acct\\AppData\\x'", "open '~\\AppData\\x'"],
    ['open C:/Users/Acct/AppData/x', 'open ~/AppData/x'],
    ['in C:\\Users\\Acct.', 'in ~.'],
  ];
  it.each(SAID)('%s', (message, said) => {
    expect(withoutHome(message, HOME, 'win32')).toBe(said);
  });
});

describe('what is not the home stays (3, 4, 5, 6)', () => {
  const LEFT: Array<[string, string, NodeJS.Platform]> = [
    ['/Users/acct2/x', '/Users/acct', 'darwin'],
    ['/Users/acct.old/x', '/Users/acct', 'darwin'],
    ['/Users/acct-backup/x', '/Users/acct', 'darwin'],
    ['C:\\Users\\Acct2\\x', 'C:\\Users\\Acct', 'win32'],
    ['/System/Volumes/Data/Users/acct/x', '/Users/acct', 'darwin'],
    ['/Volumes/Backup/Users/acct/x', '/Users/acct', 'darwin'],
    ["open '/x/y'", '/', 'linux'],
    ["open '/x/y'", '', 'linux'],
    ['/users/acct/x', '/Users/acct', 'darwin'],
  ];
  it.each(LEFT)('%s, home %s on %s', (message, home, platform) => {
    expect(withoutHome(message, home, platform)).toBe(message);
  });
});
