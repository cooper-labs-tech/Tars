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
 * 6. On Linux, another letter case is another folder: left alone.
 * 7. A file URL keeps the home (file:///Users/acct/x, file:///C:/Users/Acct/x):
 *    the '/' before it reads as a longer path (the Audit's I-a on #660). The
 *    URL and its home are said `~`.
 * 8. On macOS, the home in another letter case (/users/acct), which APFS opens
 *    all the same, stays (the Audit's I-a on #660).
 * 7 and 8 were added after the fix of 1 to 6.
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

describe('the home in a file URL, and in another letter case on macOS (7, 8)', () => {
  const SAID: Array<[string, string, string, NodeJS.Platform]> = [
    ['could not open file:///Users/acct/notes/a.md', '/Users/acct', 'could not open ~/notes/a.md', 'darwin'],
    ['could not open file:///C:/Users/Acct/notes/a.md', 'C:\\Users\\Acct', 'could not open ~/notes/a.md', 'win32'],
    ["could not open 'file:///home/acct/a.md'", '/home/acct', "could not open '~/a.md'", 'linux'],
    ["open '/users/acct/x'", '/Users/acct', "open '~/x'", 'darwin'],
    ['/USERS/ACCT: permission denied', '/Users/acct', '~: permission denied', 'darwin'],
  ];
  it.each(SAID)('%s, home %s', (message, home, said, platform) => {
    expect(withoutHome(message, home, platform)).toBe(said);
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
    ['/home/Acct/x', '/home/acct', 'linux'],
    ['/System/Volumes/Data/users/acct/x', '/Users/acct', 'darwin'],
    ['file:///Users/acct2/x', '/Users/acct', 'darwin'],
  ];
  it.each(LEFT)('%s, home %s on %s', (message, home, platform) => {
    expect(withoutHome(message, home, platform)).toBe(message);
  });
});
