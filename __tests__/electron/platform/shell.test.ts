import { describe, it, expect } from 'vitest';

import { resolveShell, shellArgs, agentShell } from '../../../electron/platform/shell';
import { defaultShell } from '../../../electron/utils/default-shell';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * The shell a human terminal runs, and the arguments it gets.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. darwin/linux: with no shell set, resolveShell returns anything but what
 *    defaultShell() returns today, SHELL set or not. Until 2.0.4 the setting
 *    was read on Windows only; since the parity program's P3 (2026-10-17) it
 *    is read there too: ignoring a shell the user chose (an absolute path), or
 *    taking a setting that is not one (a Windows path, a bare name, a relative
 *    path, blanks), fails.
 * 2. darwin/linux: shellArgs returns anything but ['-l'], for any shell,
 *    pwsh and fish included (both take -l there).
 * 3. win32: returns /bin/bash, or an MSYS SHELL such as /usr/bin/bash that
 *    Git Bash exports and node-pty cannot spawn.
 * 4. win32: prefers powershell.exe when pwsh.exe is on the PATH.
 * 5. win32: finds pwsh.exe only when the key is spelled PATH, not Path.
 * 6. win32: returns a pwsh.exe named by the PATH that is not a file.
 * 7. win32: ignores the user's setting, or returns a bare name from it
 *    (`pwsh`) that node-pty cannot find (it applies no PATHEXT).
 * 8. win32: with no PowerShell anywhere, returns nothing or throws instead
 *    of %ComSpec% (and C:\Windows\System32\cmd.exe when that is unset too).
 * 9. win32: passes -l to PowerShell or cmd (PowerShell 5.1 rejects it), or
 *    misses -l for Git Bash's bash.exe; or matches names case-sensitively or
 *    with the extension (BASH.EXE, pwsh vs pwsh.exe, a quoted path).
 * 10. darwin/linux: an agent's waiting shell follows the user's setting; it
 *    stays /bin/bash -l there, since the launch line typed into it is bash.
 */

/** A read-only Windows disk: case-insensitive, backslash paths. */
function fakeWinFs(files: string[]): FsProbe {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    isFile: (p) => set.has(p.toLowerCase()),
    readFile: (p) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); },
  };
}
const noFs: FsProbe = {
  isFile: () => { throw new Error('darwin/linux must not touch the disk'); },
  readFile: () => { throw new Error('darwin/linux must not touch the disk'); },
};

const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WINPS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('darwin/linux', () => {
  const envs = [{}, { SHELL: '' }, { SHELL: '/usr/bin/fish' }, { SHELL: '/bin/zsh' }, { SHELL: '/usr/local/bin/pwsh' }];

  it.each(['darwin', 'linux'] as const)('1. resolveShell is defaultShell on %s with no shell set, or a setting that is no absolute path', (platform) => {
    for (const env of envs) {
      expect(resolveShell({ env, platform, fs: noFs })).toBe(defaultShell(env, platform));
      for (const setting of ['C:\\Git\\bin\\bash.exe', 'fish', 'bin/zsh', '  ']) {
        expect(resolveShell({ env, platform, setting, fs: noFs })).toBe(defaultShell(env, platform));
      }
    }
  });

  it.each(['darwin', 'linux'] as const)('1. the shell the user chose on %s, an absolute path as given', (platform) => {
    expect(resolveShell({ env: { SHELL: '/bin/zsh' }, platform, setting: '/opt/homebrew/bin/fish', fs: noFs })).toBe('/opt/homebrew/bin/fish');
    expect(resolveShell({ env: {}, platform, setting: ' /usr/bin/fish ', fs: noFs })).toBe('/usr/bin/fish');
  });

  it.each(['darwin', 'linux'] as const)('10. an agent waits in /bin/bash -l on %s, whatever shell the user chose', (platform) => {
    expect(agentShell({ platform, setting: '/opt/homebrew/bin/fish', env: { SHELL: '/bin/zsh' } })).toEqual({ shell: '/bin/bash', args: ['-l'] });
  });

  it.each(['darwin', 'linux'] as const)('2. shellArgs is ["-l"] for every shell on %s', (platform) => {
    for (const shell of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/usr/local/bin/pwsh', '/bin/sh', 'cmd']) {
      expect(shellArgs(shell, platform)).toEqual(['-l']);
    }
  });
});

describe('win32', () => {
  const base = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };

  it('3, 4. pwsh.exe on the PATH first, whatever SHELL says', () => {
    const env = { ...base, SHELL: '/usr/bin/bash', Path: `C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\PowerShell\\7` };
    expect(resolveShell({ env, platform: 'win32', fs: fakeWinFs([PWSH, WINPS]) })).toBe(PWSH);
  });

  it('5. finds pwsh.exe through a PATH spelled PATH or path', () => {
    for (const key of ['PATH', 'path']) {
      const env = { ...base, [key]: 'C:\\Program Files\\PowerShell\\7' };
      expect(resolveShell({ env, platform: 'win32', fs: fakeWinFs([PWSH]) })).toBe(PWSH);
    }
  });

  it('6. skips a pwsh.exe the PATH names but the disk does not have, then takes powershell.exe', () => {
    const env = { ...base, Path: 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32\\WindowsPowerShell\\v1.0' };
    expect(resolveShell({ env, platform: 'win32', fs: fakeWinFs([WINPS]) })).toBe(WINPS);
  });

  it('powershell.exe at its fixed place when it is not on the PATH', () => {
    const env = { ...base, Path: 'C:\\nothing' };
    expect(resolveShell({ env, platform: 'win32', fs: fakeWinFs([WINPS]) })).toBe(WINPS);
  });

  it('8. %ComSpec% when there is no PowerShell, then System32\\cmd.exe', () => {
    expect(resolveShell({ env: { ...base, Path: 'C:\\x' }, platform: 'win32', fs: fakeWinFs([]) })).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(resolveShell({ env: { comspec: 'D:\\cmd.exe' }, platform: 'win32', fs: fakeWinFs([]) })).toBe('D:\\cmd.exe');
    expect(resolveShell({ env: {}, platform: 'win32', fs: fakeWinFs([]) })).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('7. the setting wins, an absolute path as given', () => {
    const env = { ...base, Path: 'C:\\Program Files\\PowerShell\\7' };
    const git = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolveShell({ env, platform: 'win32', setting: git, fs: fakeWinFs([PWSH, git]) })).toBe(git);
    expect(resolveShell({ env, platform: 'win32', setting: '  ', fs: fakeWinFs([PWSH]) })).toBe(PWSH);
  });

  it('7. a bare name in the setting is resolved on the PATH, never returned bare when it can be found', () => {
    const env = { ...base, Path: 'C:\\Program Files\\PowerShell\\7' };
    expect(resolveShell({ env, platform: 'win32', setting: 'pwsh', fs: fakeWinFs([PWSH]) })).toBe(PWSH);
    // The case of the name as typed: Windows file names are case-insensitive.
    expect(resolveShell({ env, platform: 'win32', setting: 'PWSH.EXE', fs: fakeWinFs([PWSH]) }).toLowerCase()).toBe(PWSH.toLowerCase());
    // Not found: the user's word, as typed, so the spawn error names it.
    expect(resolveShell({ env, platform: 'win32', setting: 'nu', fs: fakeWinFs([PWSH]) })).toBe('nu');
  });

  it('9. shellArgs per shell', () => {
    const cases: Array<[string, string[]]> = [
      [PWSH, ['-NoLogo']],
      [WINPS, ['-NoLogo']],
      ['POWERSHELL', ['-NoLogo']],
      ['C:\\Windows\\system32\\cmd.exe', []],
      ['CMD.EXE', []],
      ['C:\\Program Files\\Git\\bin\\bash.exe', ['-l']],
      ['"C:\\Program Files\\Git\\bin\\BASH.EXE"', ['-l']],
      ['C:\\msys64\\usr\\bin\\zsh.exe', ['-l']],
      ['C:\\tools\\nu.exe', []],
    ];
    for (const [shell, args] of cases) expect([shell, shellArgs(shell, 'win32')]).toEqual([shell, args]);
  });
});
