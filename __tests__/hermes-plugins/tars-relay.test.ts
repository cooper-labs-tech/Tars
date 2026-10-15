import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

/**
 * The tars-relay Hermes plugin's own tests, in the regression net.
 *
 * The plugin is Python and runs inside JeanBrasse's Hermes, never in Tars. Its rules are tested by
 * hermes-plugins/tars-relay/tests (unittest, standard library only), and CI runs nothing but npm test, so this runs
 * them there.
 *
 * How this can fail, written before the code:
 * 1. Python is there under another name than python3 (python, or the py launcher on Windows) and is not found;
 * 2. something that is not a Python 3.9 or later is taken for one: an older Python, or Windows's "python" that only
 *    opens the Store;
 * 3. there is no Python and the plugin's tests are skipped without a word, or skipped on CI, where they must run;
 * 4. the tests do not run at all, and zero tests reads as a success;
 * 5. some of them stop being found, and fewer tests pass than were written;
 * 6. one of them fails.
 */
const PLUGIN = path.resolve(__dirname, '../../hermes-plugins/tars-relay');
const WRITTEN = 38;
const CANDIDATES: Array<[string, string[]]> = [['python3', []], ['python', []], ['py', ['-3']]];

/** The first of python3, python and py -3 that is a Python 3.9 or later, or null. */
function findPython(): { command: string; args: string[] } | null {
  for (const [command, args] of CANDIDATES) {
    const probe = spawnSync(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf-8',
      timeout: 20_000,
    });
    const [major, minor] = String(probe.stdout ?? '').trim().split('.').map(Number);
    if (probe.status === 0 && major === 3 && minor >= 9) return { command, args };
  }
  return null;
}

describe('the tars-relay Hermes plugin', () => {
  it('passes its own tests, every one of them run', (ctx) => {
    const python = findPython();
    if (!python) {
      expect(process.env.CI, 'no Python 3.9 or later on CI (python3, python, py -3): the plugin\'s tests must run there').toBeFalsy();
      // Printed as well: the default reporter counts a skip without showing its note.
      const why = 'no Python 3.9 or later on PATH (tried python3, python, py -3): the tars-relay plugin\'s own tests did not run';
      console.warn(why);
      ctx.skip(why);
    }

    const run = spawnSync(python!.command, [...python!.args, '-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
      cwd: PLUGIN,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 60_000,
    });

    expect(run.error, `${python!.command} did not run`).toBeUndefined();
    const ran = /^Ran (\d+) tests? in /m.exec(run.stderr);
    expect(ran, run.stderr.slice(-3000)).not.toBeNull();
    expect(Number(ran![1]), run.stderr.slice(-3000)).toBeGreaterThanOrEqual(WRITTEN);
    expect(run.status, run.stderr.slice(-3000)).toBe(0);
  }, 90_000);
});
