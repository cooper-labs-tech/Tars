import './home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { homeVariables, moveTestHome, withTestHome } from './test-home';

/**
 * The witness for test-home.ts, the one way a test moves the home.
 *
 * How it can fail:
 *  1. on Windows it moves HOME alone, and os.homedir(), which reads
 *     USERPROFILE, stays on the home the suite runs in: the product reads and
 *     writes there while the test believes it is sandboxed;
 *  2. on macOS or Linux it touches anything but HOME, which changes what those
 *     platforms' tests have always run with;
 *  3. it does not put back what it moved, exactly: a variable that was unset
 *     comes back as the string "undefined", or stays set;
 *  4. a test that throws, or rejects, leaves the home moved for the next one.
 */

const MOVED_ON_WINDOWS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'];
const realPlatform = process.platform;
let dir: string;

function snapshot(): Record<string, string | undefined> {
  return Object.fromEntries(MOVED_ON_WINDOWS.map(key => [key, process.env[key]]));
}

function as(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  as(realPlatform);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-test-home-'));
  return dir;
}

describe('moving the home for a test', () => {
  it('moves every variable that names the home on Windows (1)', () => {
    const home = freshDir();
    const before = snapshot();
    as('win32');
    const restore = moveTestHome(home);
    try {
      expect(process.env.HOME).toBe(home);
      expect(process.env.USERPROFILE).toBe(home);
      expect(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`).toBe(home);
      expect(process.env.APPDATA).toBe(path.join(home, 'AppData', 'Roaming'));
      expect(process.env.LOCALAPPDATA).toBe(path.join(home, 'AppData', 'Local'));
      // What the product actually reads, where it can be asked.
      if (realPlatform === 'win32') expect(os.homedir()).toBe(home);
    } finally {
      restore();
    }
    expect(snapshot()).toEqual(before);
  });

  it.each(['darwin', 'linux'] as const)('moves HOME and nothing else on %s (2)', platform => {
    const home = freshDir();
    const before = snapshot();
    as(platform);
    const restore = moveTestHome(home);
    try {
      expect(process.env.HOME).toBe(home);
      const others = snapshot();
      const othersBefore = { ...before };
      delete others.HOME;
      delete othersBefore.HOME;
      expect(others).toEqual(othersBefore);
      expect(homeVariables(home)).toEqual({ HOME: home });
      if (realPlatform !== 'win32') expect(os.homedir()).toBe(home);
    } finally {
      restore();
    }
    expect(snapshot()).toEqual(before);
  });

  it('puts an unset variable back unset, not as a string (3)', () => {
    const home = freshDir();
    as('win32');
    const savedAppData = process.env.APPDATA;
    delete process.env.APPDATA;
    try {
      const restore = moveTestHome(home);
      restore();
      expect('APPDATA' in process.env).toBe(false);
    } finally {
      if (savedAppData !== undefined) process.env.APPDATA = savedAppData;
    }
  });

  it('puts the home back when the test throws (4)', () => {
    const home = freshDir();
    const before = snapshot();
    as('win32');
    expect(() => withTestHome(home, () => {
      expect(process.env.USERPROFILE).toBe(home);
      throw new Error('the test failed');
    })).toThrow('the test failed');
    expect(snapshot()).toEqual(before);
  });

  it('puts the home back when the test rejects, and not before it settles (4)', async () => {
    const home = freshDir();
    const before = snapshot();
    as('win32');
    let seen: string | undefined;
    await expect(withTestHome(home, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      seen = process.env.USERPROFILE;
      throw new Error('the test failed later');
    })).rejects.toThrow('the test failed later');
    expect(seen).toBe(home);
    expect(snapshot()).toEqual(before);
  });

  it('returns what the test returns', async () => {
    const home = freshDir();
    expect(withTestHome(home, () => process.env.HOME)).toBe(home);
    expect(await withTestHome(home, async () => process.env.HOME)).toBe(home);
  });
});
