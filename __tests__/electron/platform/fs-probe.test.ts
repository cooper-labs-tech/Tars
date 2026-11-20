import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * realFs.isFile and Windows app execution aliases.
 *
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` (and pwsh.exe, python.exe,
 * winget.exe when they come from the Store) is a reparse point CreateProcess
 * starts, whose target Node cannot open: measured on Windows 11,
 * `fs.statSync` on wt.exe throws EACCES and `fs.lstatSync` answers a link of
 * 93 bytes. isFile said false, so findOnPath, resolveShell and resolveCliBinary
 * could not see any of them.
 *
 * How it can fail, written before the code:
 * 1. an alias (stat EACCES, lstat a link) is not a file;
 * 2. a broken link (stat ENOENT) becomes one;
 * 3. a directory, or a link to one, becomes one;
 * 4. a file stat can read stops being one, or an error escapes.
 */

const stat = vi.hoisted(() => ({ statSync: vi.fn(), lstatSync: vi.fn() }));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), ...stat }));

import { realFs } from '../../../electron/platform';

const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
const entry = (kind: 'file' | 'dir' | 'link') => ({
  isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link',
});

beforeEach(() => { stat.statSync.mockReset(); stat.lstatSync.mockReset(); });

describe('realFs.isFile', () => {
  it('1. an app execution alias is a file to start', () => {
    stat.statSync.mockImplementation(fail('EACCES'));
    stat.lstatSync.mockReturnValue(entry('link'));
    expect(realFs.isFile('C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe')).toBe(true);
  });

  it('2, 3. a broken link, a directory or an unreadable directory is not', () => {
    stat.statSync.mockImplementation(fail('ENOENT'));
    stat.lstatSync.mockReturnValue(entry('link'));
    expect(realFs.isFile('broken')).toBe(false);
    stat.statSync.mockReturnValue(entry('dir'));
    expect(realFs.isFile('dir')).toBe(false);
    stat.statSync.mockImplementation(fail('EACCES'));
    stat.lstatSync.mockReturnValue(entry('dir'));
    expect(realFs.isFile('locked-dir')).toBe(false);
  });

  it('4. a plain file still is, and nothing throws', () => {
    stat.statSync.mockReturnValue(entry('file'));
    expect(realFs.isFile('file')).toBe(true);
    stat.statSync.mockImplementation(fail('EACCES'));
    stat.lstatSync.mockImplementation(fail('EACCES'));
    expect(realFs.isFile('nothing')).toBe(false);
  });
});
