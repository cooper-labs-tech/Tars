import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it.skipIf(process.platform === 'win32')('G5. a link inside it that points outside is refused', () => {
    fs.symlinkSync(outside, path.join(tmp, 'home'));
    expect(() => assertThrowaway({ DATA_DIR: path.join(tmp, 'home', '.tars') }, tmp)).toThrow(/DATA_DIR/);
  });
});
