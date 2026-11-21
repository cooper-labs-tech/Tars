import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';

import { pathEntries, joinPathEntries, getPath, withPath, envValue } from '../../../electron/platform/path-env';

/**
 * Reading, splitting and setting a PATH in an environment block.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. win32: split on ':' and C:\a;D:\b becomes ['C', '\a;D', '\b'].
 * 2. win32: a quoted entry ("C:\odd;dir") is cut at the ';' it quotes.
 * 3. darwin/linux: an empty entry (which means the current directory there)
 *    is dropped, or the split differs from String.split(':').
 * 4. win32: the value is looked up under `PATH` only, and an env spelled
 *    `Path` (Electron started from Explorer) reads as having none.
 * 5. win32: with `Path` and `PATH` both present, the stale one is read, or
 *    both reach node-pty, which builds the block with no case-insensitive
 *    dedupe: the child then sees the first.
 * 6. withPath mutates the caller's object.
 * 7. darwin/linux: withPath touches a `Path` key, which is a different
 *    variable on a case-sensitive platform.
 * 8. An unset or empty PATH yields a phantom empty entry.
 */

describe('pathEntries / joinPathEntries', () => {
  it('1. win32 splits on ; only, drive colons intact', () => {
    expect(pathEntries('C:\\a;D:\\b b;C:\\Program Files (x86)\\x', 'win32'))
      .toEqual(['C:\\a', 'D:\\b b', 'C:\\Program Files (x86)\\x']);
  });

  it('2. win32 keeps a quoted entry whole, quotes included, and joins it back unchanged', () => {
    const value = 'C:\\a;"C:\\odd;dir";D:\\b';
    expect(pathEntries(value, 'win32')).toEqual(['C:\\a', '"C:\\odd;dir"', 'D:\\b']);
    expect(joinPathEntries(pathEntries(value, 'win32'), 'win32')).toBe(value);
  });

  it('win32 drops empty entries, which name nothing there', () => {
    expect(pathEntries(';C:\\a;;C:\\b;', 'win32')).toEqual(['C:\\a', 'C:\\b']);
  });

  it('3. darwin/linux split exactly as String.split(":"), empty entries kept', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const value of ['/a:/b', '/a::/b:', ':/a', '/only']) {
        expect(pathEntries(value, platform)).toEqual(value.split(':'));
        expect(joinPathEntries(pathEntries(value, platform), platform)).toBe(value);
      }
    }
  });

  it('8. unset or empty gives no entry at all', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(pathEntries(undefined, platform)).toEqual([]);
      expect(pathEntries('', platform)).toEqual([]);
    }
  });
});

describe('getPath / envValue', () => {
  it('4. win32 reads the value whatever the case of the key', () => {
    expect(getPath({ Path: 'C:\\a' }, 'win32')).toBe('C:\\a');
    expect(getPath({ PATH: 'C:\\b' }, 'win32')).toBe('C:\\b');
    expect(getPath({ pAtH: 'C:\\c' }, 'win32')).toBe('C:\\c');
    expect(envValue({ comspec: 'C:\\cmd.exe' }, 'ComSpec', 'win32')).toBe('C:\\cmd.exe');
  });

  it('5. win32 with two spellings reads the one set last', () => {
    expect(getPath({ Path: 'old', PATH: 'new' }, 'win32')).toBe('new');
    expect(getPath({ PATH: 'old', Path: 'new' }, 'win32')).toBe('new');
  });

  it('darwin/linux read PATH and nothing else', () => {
    expect(getPath({ Path: 'x' }, 'linux')).toBeUndefined();
    expect(getPath({ PATH: '/a', Path: 'x' }, 'darwin')).toBe('/a');
    expect(envValue({ comspec: 'x' }, 'ComSpec', 'linux')).toBeUndefined();
  });
});

describe('withPath', () => {
  it('5. win32 sets the value under the key already used and removes the other spellings', () => {
    const out = withPath({ Path: 'old', PATH: 'older', Other: '1' }, 'new', 'win32');
    expect(out).toEqual({ Path: 'new', Other: '1' });
  });

  it('win32 with no PATH at all uses the Windows spelling', () => {
    expect(withPath({ A: '1' }, 'C:\\x', 'win32')).toEqual({ A: '1', Path: 'C:\\x' });
  });

  it('6. never mutates its input', () => {
    const env = { Path: 'old', PATH: 'older' };
    withPath(env, 'new', 'win32');
    withPath(env, 'new', 'linux');
    expect(env).toEqual({ Path: 'old', PATH: 'older' });
  });

  it('7. darwin/linux set PATH and leave a Path key alone', () => {
    expect(withPath({ PATH: '/a', Path: 'x' }, '/b', 'linux')).toEqual({ PATH: '/b', Path: 'x' });
    expect(withPath({}, '/b', 'darwin')).toEqual({ PATH: '/b' });
  });
});
