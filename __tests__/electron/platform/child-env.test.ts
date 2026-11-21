import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { childEnv } from '../../../electron/platform';

/**
 * The environment a program Tars starts gets (child-env.ts): the one it was
 * given, except that Windows PowerShell 5.1 gets no PSModulePath and builds
 * its own. When Tars runs under PowerShell 7 (started from pwsh, Windows
 * Terminal, CI's step shell), the variable lists PowerShell 7's Core-only
 * modules first; 5.1 finds them, cannot load them, and loses New-Object,
 * Get-Acl and the rest.
 *
 * How it fails, written before the code:
 * 1. A Windows PowerShell child keeps the variable when named another way:
 *    full path, bare `powershell`, another case, `.EXE`, quotes around it,
 *    spaces, forward slashes.
 * 2. Only one spelling of the key goes. Windows compares variable names
 *    without case, but a copied env is a plain object: `PSMODULEPATH` beside
 *    `PSModulePath` would survive and reach the child.
 * 3. The caller's object is changed: process.env would lose the variable for
 *    every later child, pwsh's included.
 * 4. Another variable is lost or changed on the way.
 * 5. A PowerShell 7 child (pwsh repairs an inherited path itself and needs
 *    its own modules first), cmd.exe, Git Bash, a CLI, or a program whose name
 *    only contains `powershell`, loses it or gets a copy.
 * 6. darwin/linux: anything changes, for any program, even one named
 *    powershell: the same object comes back.
 */

const POLLUTED = 'C:\\Users\\n\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const parent = () => ({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', PSModulePath: POLLUTED, TARS_X: 'kept' });
const moduleKeys = (env: Record<string, unknown>) => Object.keys(env).filter(k => k.toLowerCase() === 'psmodulepath');

describe('childEnv on win32', () => {
  it('1, 4. Windows PowerShell gets no PSModulePath, however it is named, and every other variable as it was', () => {
    for (const file of [
      POWERSHELL, 'powershell', 'powershell.exe', 'PowerShell.EXE', `"${POWERSHELL}"`, `  ${POWERSHELL}  `,
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'C:\\WINDOWS\\SYSTEM32\\WINDOWSPOWERSHELL\\V1.0\\POWERSHELL.EXE',
    ]) {
      const env = childEnv(file, parent(), 'win32');
      expect(moduleKeys(env), file).toEqual([]);
      expect(env, file).toEqual({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', TARS_X: 'kept' });
    }
  });

  it('2. every spelling of the key goes', () => {
    const env = childEnv(POWERSHELL, { ...parent(), PSMODULEPATH: POLLUTED, psmodulepath: POLLUTED }, 'win32');
    expect(moduleKeys(env)).toEqual([]);
  });

  it('3. the caller\'s env is left as it was', () => {
    const given = { ...parent(), PSMODULEPATH: POLLUTED };
    const before = { ...given };
    const env = childEnv(POWERSHELL, given, 'win32');
    expect(given).toEqual(before);
    expect(env).not.toBe(given);
  });

  it('5. PowerShell 7 and every other program get the env they were given, the same object', () => {
    for (const file of [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh', 'pwsh.exe', 'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Users\\n\\.local\\bin\\claude.exe', 'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Windows\\System32\\conhost.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell_ise.exe',
      'C:\\tools\\mypowershell.exe', 'C:\\tools\\powershell.exe.bak', 'C:\\powershell\\x.exe',
    ]) {
      const given = parent();
      expect(childEnv(file, given, 'win32'), file).toBe(given);
    }
  });
});

describe.each(['darwin', 'linux'] as const)('childEnv on %s', (platform) => {
  it('6. returns the env it was given, the same object, whatever the program', () => {
    for (const file of ['/bin/bash', '/bin/zsh', '/usr/local/bin/pwsh', 'powershell', 'powershell.exe', POWERSHELL, '/usr/bin/afplay']) {
      const given = parent();
      expect(childEnv(file, given, platform), file).toBe(given);
      expect(given.PSModulePath).toBe(POLLUTED);
    }
  });
});
