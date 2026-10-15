import { describe, it, expect } from 'vitest';
import { samePath, isUnder, isInsideWorktreesDir, isFilesystemRoot } from '../../../electron/platform';
import { POSIX_CORPUS } from './posix-corpus';
import golden from './posix-golden.json';

/**
 * Comparing two paths. Three call sites compared
 * strings built for POSIX: `want.startsWith(own + '/')` in kanban-board, a
 * trailing `/` stripped then `===` in kanban-automation, and
 * `/\/\.?worktrees\//` in claude-service and ipc-handlers. On Windows a
 * worktree agent's `C:\p\.worktrees\x` was refused its own project (403), the
 * same project spelt `c:\p\` or `C:/p` matched no agent, and worktrees were
 * listed as projects.
 *
 * How it can fail, written before the code:
 * 1. darwin/linux answer anything else than the expressions they replace
 *    (posix-golden.json, captured from the code before this change);
 * 2. win32 compares case: `C:\P` and `c:\p` are one directory on NTFS;
 * 3. win32 compares separators: `C:/p` and `C:\p` are one path;
 * 4. a trailing separator makes two spellings differ, or `C:\` stops being the
 *    root (`C:` alone is the drive's current directory, not its root);
 * 5. `\\?\C:\p` and `\\?\UNC\srv\share` are not recognised as `C:\p` and
 *    `\\srv\share`, or an unknown `\\?\` form is taken for a plain path;
 * 6. a sibling with the same prefix counts as inside (`C:\p-other` under `C:\p`);
 * 7. `..` walks out while the string still starts with the root (win32);
 * 8. a path counts as under itself, or the empty path as the same as `.`
 *    on one side only;
 * 9. Win32 trailing dots and spaces (`C:\p.\x` is `C:\p\x` for CreateFile) are
 *    compared literally;
 * 10. the worktrees test misses `\.worktrees\` or `\worktrees\`, or matches
 *     `not.worktrees`.
 */

describe('1. darwin and linux: the expressions they replace, to the byte', () => {
  it('samePath, isUnder and isInsideWorktreesDir give the golden answers', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      POSIX_CORPUS.pairs.forEach(([own, asked], i) => {
        expect(samePath(asked, own, platform) || isUnder(asked, own, platform), `projectFor ${own} ${asked}`).toBe(golden.projectFor[i]);
        expect(samePath(own, asked, platform), `same ${own} ${asked}`).toBe(golden.sameProject[i]);
      });
      POSIX_CORPUS.paths.forEach((p, i) => {
        expect(isInsideWorktreesDir(p, platform), p).toBe(golden.worktree[i]);
      });
    }
  });

  it('stays case-sensitive and backslash-blind there', () => {
    expect(samePath('/Users/demo/Tars', '/users/demo/tars', 'darwin')).toBe(false);
    expect(isUnder('/Users/demo/Tars\\x', '/Users/demo/Tars', 'linux')).toBe(false);
  });
});

describe('win32', () => {
  const w = 'win32' as const;

  it('2, 3, 4. one directory whatever the case, the separators or a trailing one', () => {
    for (const other of ['c:\\p', 'C:/p', 'C:\\p\\', 'c:/P/', 'C:\\P\\\\', 'C:\\p\\.\\']) {
      expect(samePath('C:\\p', other, w), other).toBe(true);
    }
    expect(samePath('C:\\', 'c:/', w)).toBe(true);
    expect(samePath('C:\\p', 'D:\\p', w)).toBe(false);
    expect(isUnder('C:\\x', 'C:\\', w)).toBe(true);
    expect(isUnder('c:/x', 'C:', w)).toBe(false);
  });

  it('5. the \\\\?\\ spellings are the plain ones, and nothing else is', () => {
    expect(samePath('\\\\?\\C:\\p', 'C:\\p', w)).toBe(true);
    expect(samePath('\\\\.\\C:\\p', 'c:\\P', w)).toBe(true);
    expect(samePath('\\\\?\\UNC\\srv\\share\\p', '\\\\srv\\share\\p', w)).toBe(true);
    expect(isUnder('\\\\?\\c:\\p\\.worktrees\\x', 'C:\\p', w)).toBe(true);
    expect(isUnder('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\p\\x', 'C:\\p', w)).toBe(false);
  });

  it('6, 7, 8. inside means inside', () => {
    expect(isUnder('C:\\p\\.worktrees\\x', 'C:\\p', w)).toBe(true);
    expect(isUnder('C:\\P\\SRC', 'c:/p/', w)).toBe(true);
    expect(isUnder('C:\\p-other', 'C:\\p', w)).toBe(false);
    expect(isUnder('C:\\p\\..\\other', 'C:\\p', w)).toBe(false);
    expect(isUnder('C:\\p', 'C:\\p', w)).toBe(false);
    expect(isUnder('C:\\p\\', 'c:\\p', w)).toBe(false);
    expect(isUnder('c:/', 'C:\\', w)).toBe(false);
    expect(isUnder('\\\\srv\\share\\', '\\\\SRV\\share', w)).toBe(false);
    expect(samePath('', '', w)).toBe(true);
    expect(samePath('', '.', w)).toBe(false);
  });

  it('9. trailing dots and spaces are what Win32 makes of them', () => {
    expect(samePath('C:\\p.\\x ', 'C:\\p\\x', w)).toBe(true);
    expect(isUnder('C:\\p. \\x', 'C:\\p', w)).toBe(true);
  });

  it('10. a worktree folder in either separator, in any case, and nothing else', () => {
    for (const p of ['C:\\p\\.worktrees\\feat', 'C:\\p\\worktrees\\x', 'c:/p/.Worktrees/x', 'C:\\p\\.worktrees/x']) {
      expect(isInsideWorktreesDir(p, w), p).toBe(true);
    }
    for (const p of ['C:\\p\\not.worktrees\\x', 'C:\\p\\.worktrees', 'C:\\worktreesx\\y']) {
      expect(isInsideWorktreesDir(p, w), p).toBe(false);
    }
  });
});

/**
 * isFilesystemRoot (found at review): the project listings skipped `/` by
 * string, so on Windows the folder `C--` (C:\) was a project.
 * 11. darwin/linux answer anything but `p === '/'`;
 * 12. win32 misses a drive root, a share root or `\` in any spelling, or takes
 *     a folder, `C:` (the drive's current directory) or '' for one.
 */
describe('isFilesystemRoot', () => {
  it('11. darwin and linux: exactly "/"', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const p of [...POSIX_CORPUS.paths, '//', 'C:\\']) expect(isFilesystemRoot(p, platform), p).toBe(p === '/');
    }
  });

  it('12. win32: every spelling of a root, and nothing else', () => {
    for (const p of ['C:\\', 'c:/', 'C:\\\\', '\\\\?\\C:\\', '\\\\srv\\share', '\\\\srv\\share\\', '\\\\?\\UNC\\srv\\share', '\\', '/']) {
      expect(isFilesystemRoot(p, 'win32'), p).toBe(true);
    }
    for (const p of ['C:\\x', 'C:', '', 'C:\\x\\..\\y', '\\\\srv\\share\\p']) expect(isFilesystemRoot(p, 'win32'), p).toBe(false);
  });
});
