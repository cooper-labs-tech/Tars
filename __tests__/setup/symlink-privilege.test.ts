import './home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canSymlink, cannotSymlink } from './symlink-privilege';

/**
 * The witness for symlink-privilege.ts, which decides whether the tests that
 * plant a symbolic link run or skip.
 *
 * How it can fail:
 *  1. it says no where a link can be made, and hides tests that would run
 *     (macOS, Linux, CI windows-latest): a regression net with holes nobody sees;
 *  2. it says yes where a link cannot be made, and those tests fail on EPERM
 *     instead of on what they assert;
 *  3. it swallows an error that is not the missing privilege, and skips for a
 *     reason it did not check;
 *  4. its two answers disagree.
 */

function linkWorksHere(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-symlink-witness-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));
    return fs.lstatSync(path.join(dir, 'link')).isSymbolicLink();
  } catch (error) {
    // Only the missing privilege is an answer; anything else fails the witness.
    expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('whether the tests that plant a symbolic link run', () => {
  it('answers what making one actually does on this machine (1, 2, 3)', () => {
    expect(canSymlink()).toBe(linkWorksHere());
  });

  it.runIf(process.platform !== 'win32')('runs them everywhere but Windows, whatever the account (1)', () => {
    expect(canSymlink()).toBe(true);
  });

  it('skips exactly when it cannot (4)', () => {
    expect(cannotSymlink()).toBe(!canSymlink());
  });
});
