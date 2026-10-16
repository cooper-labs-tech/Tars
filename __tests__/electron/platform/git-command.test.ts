import { describe, it, expect } from 'vitest';

import { gitCommand, currentFolderLookupsOff } from '../../../electron/platform/git-command';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * Which git Tars starts, and the environment that keeps Windows from running
 * a program out of the folder it is started in.
 *
 * Node on Windows looks a bare name up in the folder a program is started in
 * before the PATH (libuv's search_path), and Tars starts git in a project's
 * folder: a repository that carries a git.exe of its own would have it run.
 * Measured on 2026-10-13 (Node 22.23 with libuv 1.51, Electron 44 with libuv
 * 1.52): execFileSync('git', args, { cwd }) ran a git.exe planted in cwd;
 * NoDefaultCurrentDirectoryInExePath=1 in the child's env did not stop it, in
 * the starting process's own env it did.
 *
 * How it fails, written before the code (2026-10-13):
 * 1. darwin/linux: anything but `git`, or a disk access.
 * 2. win32: the bare name while a git.exe is on the PATH, which lets a
 *    project's own git.exe run first.
 * 3. win32: a git.exe found through a relative PATH entry (`.`, `bin`), which
 *    Windows resolves against the current folder: the same hole.
 * 4. win32: the PATH order not honoured (a later entry's git.exe first).
 * 5. win32: the PATH read once for the life of the app: a git installed, or a
 *    PATH changed, after the first call is never seen.
 * 6. win32: a git.cmd, a sh script or a folder named git.exe taken for git.
 * 7. win32: no git.exe on the PATH gives anything but the bare name, which
 *    fails as a missing git does once current-folder lookups are off.
 * 8. currentFolderLookupsOff: on win32 anything but
 *    NoDefaultCurrentDirectoryInExePath=1; on darwin/linux any variable.
 */

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

function fakeFs(files: string[]): FsProbe & { asked: string[] } {
  const asked: string[] = [];
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    asked,
    isFile(p) {
      asked.push(p);
      return set.has(p.toLowerCase());
    },
    readFile() {
      throw new Error('not read');
    },
  };
}

describe('gitCommand', () => {
  it('is `git` on darwin and linux, with no disk access (1)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const fs = fakeFs([GIT]);
      expect(gitCommand({ PATH: '/usr/bin:/bin' }, platform, fs)).toBe('git');
      expect(fs.asked).toEqual([]);
    }
  });

  it('is the full path of the git.exe on the PATH on win32 (2)', () => {
    const fs = fakeFs([GIT]);
    expect(gitCommand({ Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd' }, 'win32', fs)).toBe(GIT);
  });

  it('never looks in a relative PATH entry (3)', () => {
    const fs = fakeFs(['bin\\git.exe', '.\\git.exe', 'git.exe', GIT]);
    expect(gitCommand({ PATH: '.;bin;C:\\Program Files\\Git\\cmd' }, 'win32', fs)).toBe(GIT);
    expect(fs.asked.every((p) => /^[a-z]:\\/i.test(p))).toBe(true);
  });

  it('takes the first git.exe in PATH order (4)', () => {
    const first = 'D:\\tools\\git\\bin\\git.exe';
    const fs = fakeFs([GIT, first]);
    expect(gitCommand({ PATH: 'D:\\tools\\git\\bin;C:\\Program Files\\Git\\cmd' }, 'win32', fs)).toBe(first);
  });

  it('reads the PATH again when it changed (5)', () => {
    const other = 'E:\\git\\cmd\\git.exe';
    const fs = fakeFs([GIT, other]);
    expect(gitCommand({ PATH: 'C:\\Program Files\\Git\\cmd' }, 'win32', fs)).toBe(GIT);
    expect(gitCommand({ PATH: 'E:\\git\\cmd' }, 'win32', fs)).toBe(other);
  });

  it('takes only a file named git.exe (6)', () => {
    const fs = fakeFs(['C:\\a\\git.cmd', 'C:\\b\\git']);
    expect(gitCommand({ PATH: 'C:\\a;C:\\b' }, 'win32', fs)).toBe('git');
  });

  it('is the bare name when the PATH has no git.exe (7)', () => {
    expect(gitCommand({ PATH: 'C:\\Windows\\System32' }, 'win32', fakeFs([]))).toBe('git');
    expect(gitCommand({}, 'win32', fakeFs([]))).toBe('git');
  });
});

describe('currentFolderLookupsOff', () => {
  it('turns the lookup in the current folder off on win32, and sets nothing elsewhere (8)', () => {
    expect(currentFolderLookupsOff('win32')).toEqual({ NoDefaultCurrentDirectoryInExePath: '1' });
    expect(currentFolderLookupsOff('darwin')).toEqual({});
    expect(currentFolderLookupsOff('linux')).toEqual({});
  });
});
