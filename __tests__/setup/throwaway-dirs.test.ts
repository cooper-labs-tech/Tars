import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertThrowaway } from './throwaway-dirs';

/**
 * The guard a test calls before it writes or removes anything under DATA_DIR or PRIVATE_DIR (the Audit's I-4 on
 * #596). Under the repo's setupFiles those are in a throwaway home inside the file's temporary folder; run without
 * them, as on 20/11, they are the owner's ~/.tars and ~/.tars-private, and a test's afterEach would remove the real
 * trace store, install file and keys.
 *
 * Shown here with folders the test makes itself, never the real home: one stands in for the temporary folder, and
 * a fake DATA_DIR sits outside it.
 *
 * How it fails, written before the guard (24/11):
 * G1. A folder outside the temporary folder is let through, and the removal after it runs.
 * G2. A folder inside it is refused.
 * G3. A sibling whose name only begins like the temporary folder (`<tmp>-other`) is let through.
 * G4. A path that climbs out with `..` is let through.
 * G5. A link inside the temporary folder that points outside it is let through.
 * Each case bites a guard of its own (the Audit's L1 at ae56b8d6e), run as mutants (reports/traces-lows/mutants/):
 * G3 a prefix test without the separator, G4 a guard that compares the path as written (G4 is given the raw string,
 * never path.join's, which would fold the `..` first), G5 a guard that does not follow links.
 * Added before the home's guard (QA's proof of its own home guard, 25/11). Loading electron/constants settles
 * ~/.dorothy and ~/.tars in os.homedir() at once (core/data-dir-move.ts), so a guard called after that import comes
 * too late:
 * G6. A file whose first import is the home's guard, under a home outside the temporary folder: something is made in
 *     that home before the guard throws. Shown to bite on a mutant as well as on the guard missing (the Audit's I-1 at
 *     01b73680c): with throwaway-home.ts emptied, nothing throws and the constants make `.dorothy` in that home.
 * G7. (The gap itself.) The old order, the constants loaded and the guard called after: the home gets a link before
 *     the guard throws. Shown on a stand-in home inside this test's own folder, never the real one.
 */

let base: string;
let tmp: string;
let outside: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'throwaway-dirs-'));
  tmp = path.join(base, 'tmp');
  outside = path.join(base, 'not-tmp');
  fs.mkdirSync(tmp);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the throwaway guard', () => {
  it('G1. a fake DATA_DIR outside the temporary folder: it throws, and the removal after it never runs', () => {
    const dataDir = path.join(outside, '.tars');
    fs.mkdirSync(path.join(dataDir, 'traces'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'traces', 'traces.db'), 'the store');
    expect(() => {
      assertThrowaway({ DATA_DIR: dataDir }, tmp);
      fs.rmSync(path.join(dataDir, 'traces'), { recursive: true, force: true });
    }).toThrow(/DATA_DIR/);
    expect(fs.readFileSync(path.join(dataDir, 'traces', 'traces.db'), 'utf8')).toBe('the store');
  });

  it('G2. folders inside it, made or not yet, pass', () => {
    fs.mkdirSync(path.join(tmp, 'home', '.tars'), { recursive: true });
    expect(() => assertThrowaway({ DATA_DIR: path.join(tmp, 'home', '.tars'), PRIVATE_DIR: path.join(tmp, 'home', '.tars-private') }, tmp)).not.toThrow();
  });

  it('G3. a sibling whose name only begins like it is refused', () => {
    fs.mkdirSync(`${tmp}-other`);
    expect(() => assertThrowaway({ DATA_DIR: path.join(`${tmp}-other`, '.tars') }, tmp)).toThrow(/DATA_DIR/);
  });

  it('G4. a path that climbs out with .., as written, is refused', () => {
    // The raw string: it begins with the temporary folder, and only resolving it shows where it goes.
    const climbing = `${tmp}${path.sep}..${path.sep}not-tmp${path.sep}.tars-private`;
    expect(climbing.startsWith(tmp)).toBe(true);
    expect(() => assertThrowaway({ PRIVATE_DIR: climbing }, tmp)).toThrow(/PRIVATE_DIR/);
  });

  // A stand-in home outside a stand-in temporary folder, both in this test's own folder, holding a .tars as an
  // owner's would: the variables the system reads them from point there while a fixture loads.
  const underStandIns = async (fixture: string) => {
    const home = path.join(outside, 'home');
    fs.mkdirSync(path.join(home, '.tars'), { recursive: true });
    const names = ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP'] as const;
    const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const n of ['TMPDIR', 'TMP', 'TEMP'] as const) process.env[n] = tmp;
    vi.resetModules();
    let thrown: unknown;
    try {
      await import(fixture);
    } catch (err) {
      thrown = err;
    } finally {
      for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
      vi.resetModules();
    }
    return { thrown, made: fs.readdirSync(home).sort() };
  };

  it('G6. the home\'s guard first: under a home outside the temporary folder it throws, and nothing is made there', async () => {
    const r = await underStandIns('./fixtures/throwaway/guarded-first');
    expect(String(r.thrown)).toMatch(/HOME/);
    expect(r.made).toEqual(['.tars']);
  });

  it.skipIf(process.platform === 'win32')('G7. the old order: the constants make a link in that home before the guard throws', async () => {
    const r = await underStandIns('./fixtures/throwaway/guarded-after');
    expect(String(r.thrown)).toMatch(/DATA_DIR/);
    expect(r.made).toContain('.dorothy');
  });

  it.skipIf(process.platform === 'win32')('G5. a link inside it that points outside is refused', () => {
    fs.symlinkSync(outside, path.join(tmp, 'home'));
    expect(() => assertThrowaway({ DATA_DIR: path.join(tmp, 'home', '.tars') }, tmp)).toThrow(/DATA_DIR/);
  });
});
