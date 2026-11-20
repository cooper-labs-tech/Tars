import './home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { runDirParent } from './run-dir';

/**
 * The witness for run-dir.ts: where the temp dir every test file is handed
 * is made (tmpdir-run.ts).
 *
 * How it can fail:
 *  1. on Windows the run's folder keeps a %TEMP% spelled otherwise than the
 *     disk spells it (CI's 8.3 C:\Users\RUNNER~1, another case, a junction),
 *     and every test that builds a path from os.tmpdir() compares it with the
 *     canonical one git, the release scripts and the Claude project decoder
 *     report (15 tests on windows-latest);
 *  2. on macOS or Linux the temp dir is canonicalised too, and /var/folders
 *     becomes /private/var/folders under tests written against the first;
 *  3. the parent is canonicalised but the folder the workers get is not the
 *     one made under it.
 */

describe('the run\'s temp dir', () => {
  it.runIf(process.platform === 'win32')('is spelled on Windows as the disk spells it (1, 3)', () => {
    expect(os.tmpdir()).toBe(fs.realpathSync.native(os.tmpdir()));
  });

  it.runIf(process.platform === 'win32')('canonicalises a %TEMP% spelled in another case (1)', () => {
    const tmp = os.tmpdir();
    expect(runDirParent(tmp.toUpperCase(), 'win32')).toBe(fs.realpathSync.native(tmp));
  });

  it('leaves the temp dir of macOS and Linux as it is spelled (2)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(runDirParent('/var/folders/7k/T/no-such-folder', platform)).toBe('/var/folders/7k/T/no-such-folder');
    }
  });
});
