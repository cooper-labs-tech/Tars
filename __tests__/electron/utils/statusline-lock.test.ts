import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { enableStatusLine } from '../../../electron/utils/statusline';

/**
 * The status line's token-stats lock, with several Claude sessions rendering
 * at once.
 *
 * Each render that has a session id adds it to ~/.dorothy/token-stats.json
 * under a mkdir lock. The script took the lock, set an EXIT trap to remove it,
 * and removed it itself once its write was done. Then it went on, running git
 * for the branch, and exited, and the trap removed the lock a second time. If
 * another render had taken it in between, that render's lock was the one
 * removed: a third render came in beside the second, both read the same file,
 * and the last to rename it dropped the other's session from the Usage page.
 * Found while porting the script to Windows, where the same lock lost 5
 * sessions in 250 rounds of six renders.
 *
 * How it fails, written before the code (2026-09-26):
 * 1. Its lock released twice: as it exits, it removes the lock another render
 *    took after this one had released its own.
 * 2. Its lock left behind when it dies holding it: every render after it
 *    waits a second and skips its write until the lock is 5 s old.
 * 3. Its lock never released once its write is done, which leaves the same
 *    stale lock at every render. Test 1 sees it: the other render cannot take
 *    the lock while this one runs git.
 *
 * These run the installed script through bash and jq, in a temp HOME, with a
 * stand-in `git` or `date` on the PATH that acts at the one moment that matters,
 * so the interleaving is certain instead of left to timing.
 */

let script: string;
const dirs: string[] = [];

beforeAll(() => {
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf-8' });
  if (jq.status !== 0) throw new Error('jq is not on PATH: the status line needs it, and so do these cases');
  enableStatusLine();
  script = path.join(os.homedir(), '.dorothy', 'statusline.sh');
});

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A temp HOME whose PATH starts with `name`, a stand-in running `body` in sh. */
function bench(name: 'git' | 'date', body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-stats-lock-'));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.dorothy'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const lock = path.join(home, '.dorothy', 'token-stats.lock');
  const stats = path.join(home, '.dorothy', 'token-stats.json');
  const render = () => spawnSync('bash', [script], {
    input: JSON.stringify({ session_id: 's1', model: { display_name: 'Opus 5' }, context_window: {}, cost: {} }),
    cwd: home, encoding: 'utf-8', env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home },
  });
  return { home, lock, stats, render };
}

describe('the token-stats lock of the status line', () => {
  it('1. leaves alone, as it exits, a lock another render took after it released its own', () => {
    // git runs after the write, for the branch: the moment another render
    // takes the lock is while this one waits on it. `took` says it could:
    // this render had released its own lock by then, so the lock left at the
    // end is the other render's.
    const b = bench('git', `mkdir "$HOME/.dorothy/token-stats.lock" && touch "$HOME/took"\necho main`);

    const run = b.render();

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(b.stats, 'utf-8'))).toHaveProperty('s1');
    expect(fs.existsSync(path.join(b.home, 'took')), 'its own lock was still held when git ran').toBe(true);
    expect(fs.existsSync(b.lock), 'the other render\'s lock was removed').toBe(true);
  });

  it('2. still releases its lock when it dies holding it', () => {
    // `date` is first called for the entry's date, with the lock held; under
    // `set -e` its failure ends the script there.
    const b = bench('date', 'exit 1');

    const run = b.render();

    expect(run.status, 'the render did not die holding the lock').not.toBe(0);
    expect(fs.existsSync(b.stats)).toBe(false);
    expect(fs.existsSync(b.lock), 'the lock was left behind').toBe(false);
  });
});
