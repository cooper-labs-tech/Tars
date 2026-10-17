import { describe, it, expect } from 'vitest';

import { detectShells } from '../../../electron/platform/shell-choices';
import { resolveShell } from '../../../electron/platform/shell';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * The shells the Settings > Terminal row offers.
 *
 * How it fails, written before the code (2026-09-26):
 * 1. darwin/linux: returns choices at all (the row is Windows only, and the
 *    shell there stays $SHELL), or touches the disk. That held until 2.0.4:
 *    the parity program's P3 offers the row on macOS and Linux too (8 to 13).
 * 2. A shell that is installed is missing: pwsh.exe only in
 *    %ProgramFiles%\PowerShell\7 (not on the PATH), powershell.exe only in
 *    System32 when the PATH lost it, cmd.exe from %ComSpec%, Git Bash in
 *    Program Files, in %LOCALAPPDATA%\Programs (per-user install), or next to
 *    a git.exe on the PATH.
 * 3. A shell that is not installed is offered with a path (pwsh on a stock
 *    Windows 11, as measured here), or Git Bash is listed when absent.
 * 4. Git Bash's bash.exe is confused with WSL's C:\Windows\System32\bash.exe
 *    (the launcher that opens WSL, not Git Bash).
 * 5. The "default" differs from what a terminal actually starts with no
 *    setting (resolveShell), so the row lies about it.
 * 6. Environment keys are read case-sensitively (Path vs PATH, ProgramFiles).
 * 7. A SystemRoot, ComSpec, ProgramFiles or LOCALAPPDATA that is not a plain
 *    absolute path (`Windows`, `C:Windows`, `cmd.exe`, `Program Files`) is
 *    trusted, so a shell planted in the working directory, an agent's
 *    project, is offered.
 *
 * And on macOS and Linux (the parity program's P3, 2026-10-17), whose login
 * shells are the ones /etc/shells lists:
 * 8. darwin/linux offer nothing, or something /etc/shells does not list.
 * 9. A listed shell missing from the disk, a comment, a blank line or a
 *    relative entry is offered.
 * 10. A listed program that is no terminal for a person is offered: a
 *    restricted shell (rbash), a multiplexer (tmux, screen), a refusal
 *    (nologin, false, git-shell).
 * 11. One shell is offered twice (/bin/bash and /usr/bin/bash on a merged
 *    /usr, links to one file), or two shells of one name once (Apple's
 *    /bin/bash and Homebrew's): each choice is a file, keyed by its path and
 *    named by its shell.
 * 12. The default is not what a terminal starts with no setting ($SHELL,
 *    resolveShell).
 * 13. No /etc/shells, or one that cannot be read: a throw, where the row has
 *    nothing to offer but its default.
 */

function fakeWinFs(files: string[]): FsProbe {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    isFile: (p) => set.has(p.toLowerCase()),
    readFile: (p) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); },
  };
}

const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const GITBASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const STOCK_ENV = {
  Path: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\',
  SystemRoot: 'C:\\Windows',
  ComSpec: CMD,
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
};

/** A macOS or Linux disk: /etc/shells (null when there is none), and the files it lists, each with its real path. */
function posixDisk(shells: string | null, files: Record<string, string>): { fs: FsProbe; realpath: (p: string) => string } {
  return {
    fs: {
      isFile: (p) => p in files,
      readFile: (p) => {
        if (p === '/etc/shells' && shells !== null) return shells;
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      },
    },
    realpath: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return files[p];
    },
  };
}

/** Ubuntu 24.04's, a merged /usr: /bin is /usr/bin. fish and screen are listed, not installed. */
const UBUNTU_SHELLS = [
  '# /etc/shells: valid login shells', '/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/rbash', '/usr/bin/rbash',
  '/usr/bin/dash', '/usr/bin/tmux', '/usr/bin/screen', '/usr/bin/zsh', '/bin/zsh', '/usr/bin/fish', '/usr/sbin/nologin', '',
].join('\n');
const UBUNTU_FILES: Record<string, string> = {
  '/bin/sh': '/usr/bin/dash', '/usr/bin/sh': '/usr/bin/dash', '/bin/bash': '/usr/bin/bash', '/usr/bin/bash': '/usr/bin/bash',
  '/bin/rbash': '/usr/bin/bash', '/usr/bin/rbash': '/usr/bin/bash', '/usr/bin/dash': '/usr/bin/dash', '/usr/bin/tmux': '/usr/bin/tmux',
  '/usr/bin/zsh': '/usr/bin/zsh', '/bin/zsh': '/usr/bin/zsh', '/usr/sbin/nologin': '/usr/sbin/nologin',
};

/** macOS's own, and two Homebrew shells added to it. */
const MAC_SHELLS = [
  '# List of acceptable shells for chpass(1).', '# Ftpd will not allow users to connect who are not using', '# one of these shells.', '',
  '/bin/bash', '/bin/csh', '/bin/dash', '/bin/ksh', '/bin/sh', '/bin/tcsh', '/bin/zsh', '/opt/homebrew/bin/bash', '/opt/homebrew/bin/fish', '',
].join('\n');

function byId(r: ReturnType<typeof detectShells>) {
  return Object.fromEntries((r?.choices ?? []).map((c) => [c.id, c.path]));
}

describe('detectShells', () => {
  it('8, 9, 10, 11, 12. Ubuntu: one choice per shell file /etc/shells lists and the disk has, none that is no terminal', () => {
    const disk = posixDisk(UBUNTU_SHELLS, UBUNTU_FILES);
    expect(detectShells({ platform: 'linux', env: { SHELL: '/usr/bin/zsh' }, ...disk })).toEqual({
      defaultPath: '/usr/bin/zsh',
      choices: [
        { id: '/bin/sh', path: '/bin/sh', name: 'sh' },
        { id: '/bin/bash', path: '/bin/bash', name: 'bash' },
        { id: '/usr/bin/zsh', path: '/usr/bin/zsh', name: 'zsh' },
      ],
    });
  });

  it("11, 12. macOS: Apple's shells and Homebrew's, both bashes, the default $SHELL or zsh", () => {
    const disk = posixDisk(MAC_SHELLS, Object.fromEntries(MAC_SHELLS.split('\n').filter((l) => l.startsWith('/')).map((l) => [l, l])));
    const found = detectShells({ platform: 'darwin', env: {}, ...disk })!;
    expect(found.defaultPath).toBe('/bin/zsh');
    expect(found.choices.map((c) => c.id)).toEqual([
      '/bin/bash', '/bin/csh', '/bin/dash', '/bin/ksh', '/bin/sh', '/bin/tcsh', '/bin/zsh', '/opt/homebrew/bin/bash', '/opt/homebrew/bin/fish',
    ]);
    expect(found.choices.filter((c) => c.name === 'bash').map((c) => c.path)).toEqual(['/bin/bash', '/opt/homebrew/bin/bash']);
    expect(detectShells({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/fish' }, ...disk })!.defaultPath).toBe('/opt/homebrew/bin/fish');
  });

  it('9. reads an entry past its blanks and its comment, and never a relative one', () => {
    const disk = posixDisk('  /bin/zsh   # the default\nbin/fish\n\n#/bin/bash\n', { '/bin/zsh': '/bin/zsh', 'bin/fish': 'bin/fish', '/bin/bash': '/bin/bash' });
    expect(detectShells({ platform: 'linux', env: {}, ...disk })!.choices).toEqual([{ id: '/bin/zsh', path: '/bin/zsh', name: 'zsh' }]);
  });

  it('13. no /etc/shells, or one it cannot read: its default alone, and no throw', () => {
    expect(detectShells({ platform: 'linux', env: { SHELL: '/bin/bash' }, ...posixDisk(null, {}) })).toEqual({ defaultPath: '/bin/bash', choices: [] });
  });

  it('a stock Windows 11: PowerShell 5.1 and cmd, no pwsh, no Git Bash', () => {
    const fs = fakeWinFs([PS51, CMD, 'C:\\Windows\\System32\\bash.exe']);
    const r = detectShells({ platform: 'win32', env: STOCK_ENV, fs });
    expect(r?.choices.map((c) => c.id)).toEqual(['pwsh', 'powershell', 'cmd']);
    expect(byId(r)).toEqual({ pwsh: null, powershell: PS51, cmd: CMD });
    expect(r?.defaultPath).toBe(resolveShell({ platform: 'win32', env: STOCK_ENV, fs }));
    expect(r?.defaultPath).toBe(PS51);
  });

  it('this machine: Git for Windows in Program Files', () => {
    const fs = fakeWinFs([PS51, CMD, GITBASH]);
    expect(byId(detectShells({ platform: 'win32', env: STOCK_ENV, fs }))['git-bash']).toBe(GITBASH);
  });

  it('pwsh installed but not on the PATH is still offered, and is not the default', () => {
    const fs = fakeWinFs([PS51, CMD, PWSH]);
    const r = detectShells({ platform: 'win32', env: STOCK_ENV, fs });
    expect(byId(r).pwsh).toBe(PWSH);
    expect(r?.defaultPath).toBe(PS51);
  });

  it('pwsh on the PATH is the default', () => {
    const env = { ...STOCK_ENV, PATH: `C:\\Tools\\pwsh;${STOCK_ENV.Path}`, Path: undefined };
    const fs = fakeWinFs([PS51, CMD, 'C:\\Tools\\pwsh\\pwsh.exe']);
    const r = detectShells({ platform: 'win32', env, fs });
    expect(byId(r).pwsh).toBe('C:\\Tools\\pwsh\\pwsh.exe');
    expect(r?.defaultPath).toBe('C:\\Tools\\pwsh\\pwsh.exe');
  });

  it('powershell.exe off the PATH is found in System32', () => {
    const env = { ...STOCK_ENV, Path: 'C:\\Windows' };
    expect(byId(detectShells({ platform: 'win32', env, fs: fakeWinFs([PS51, CMD]) })).powershell).toBe(PS51);
  });

  it('cmd.exe without ComSpec is found in System32; nothing at all is null', () => {
    const env = { ...STOCK_ENV, ComSpec: undefined };
    expect(byId(detectShells({ platform: 'win32', env, fs: fakeWinFs([CMD]) })).cmd).toBe(CMD);
    expect(byId(detectShells({ platform: 'win32', env, fs: fakeWinFs([]) })).cmd).toBeNull();
  });

  it('a per-user Git for Windows, and one found through git.exe on the PATH', () => {
    const user = 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    expect(byId(detectShells({ platform: 'win32', env: STOCK_ENV, fs: fakeWinFs([user]) }))['git-bash']).toBe(user);

    const env = { ...STOCK_ENV, Path: `D:\\PortableGit\\cmd;${STOCK_ENV.Path}` };
    const fs = fakeWinFs(['D:\\PortableGit\\cmd\\git.exe', 'D:\\PortableGit\\bin\\bash.exe']);
    expect(byId(detectShells({ platform: 'win32', env, fs }))['git-bash']).toBe('D:\\PortableGit\\bin\\bash.exe');
  });

  it('never offers WSL\'s System32 bash.exe as Git Bash', () => {
    const env = { ...STOCK_ENV, Path: 'C:\\Windows\\System32' };
    const fs = fakeWinFs(['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\System32\\git.exe']);
    expect(byId(detectShells({ platform: 'win32', env, fs }))['git-bash']).toBeUndefined();
  });

  it('7. reads SystemRoot and ComSpec only when they are plain absolute paths', () => {
    const planted = ['Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'Windows\\System32\\cmd.exe', 'cmd.exe'];
    for (const [SystemRoot, ComSpec] of [['Windows', 'cmd.exe'], ['C:Windows', 'Windows\\System32\\cmd.exe'], ['\\Windows', undefined]]) {
      const env = { ...STOCK_ENV, Path: '', SystemRoot, ComSpec };
      const r = byId(detectShells({ platform: 'win32', env, fs: fakeWinFs([...planted, PS51, CMD]) }));
      expect(r.powershell, `${SystemRoot} ${ComSpec}`).toBe(PS51);
      expect(r.cmd, `${SystemRoot} ${ComSpec}`).toBe(CMD);
    }
  });

  it('7. looks for pwsh and Git Bash only under plain absolute ProgramFiles and LOCALAPPDATA', () => {
    const env = { ...STOCK_ENV, Path: '', ProgramFiles: 'Program Files', LOCALAPPDATA: 'AppData\\Local' };
    const fs = fakeWinFs([PS51, CMD, 'Program Files\\PowerShell\\7\\pwsh.exe', 'Program Files\\Git\\bin\\bash.exe', 'AppData\\Local\\Programs\\Git\\bin\\bash.exe']);
    const r = byId(detectShells({ platform: 'win32', env, fs }));
    expect(r.pwsh).toBeNull();
    expect(r['git-bash']).toBeUndefined();
  });

  it('reads environment keys whatever their case', () => {
    const env = { path: STOCK_ENV.Path, systemroot: 'C:\\Windows', comspec: CMD, programfiles: 'C:\\Program Files' };
    const fs = fakeWinFs([PS51, CMD, GITBASH]);
    const r = byId(detectShells({ platform: 'win32', env, fs }));
    expect(r.powershell).toBe(PS51);
    expect(r.cmd).toBe(CMD);
    expect(r['git-bash']).toBe(GITBASH);
  });
});
