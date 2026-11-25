import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';

import { detectShells } from '../../../electron/platform/shell-choices';
import { resolveShell } from '../../../electron/platform/shell';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * The shells the Settings > Terminal row offers on Windows.
 *
 * How it fails, written before the code (2026-09-26):
 * 1. darwin/linux: returns choices at all (the row is Windows only, and the
 *    shell there stays $SHELL), or touches the disk.
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
 */

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

function byId(r: ReturnType<typeof detectShells>) {
  return Object.fromEntries((r?.choices ?? []).map((c) => [c.id, c.path]));
}

describe('detectShells', () => {
  it('darwin and linux offer nothing and read nothing', () => {
    expect(detectShells({ platform: 'darwin', env: STOCK_ENV, fs: noFs })).toBeNull();
    expect(detectShells({ platform: 'linux', env: STOCK_ENV, fs: noFs })).toBeNull();
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
