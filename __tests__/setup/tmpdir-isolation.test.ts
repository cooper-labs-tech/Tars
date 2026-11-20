import './home-guard';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { processesUnder } from './leftover-processes';

/**
 * Every test file writes its temporary folders into a folder of its own, which
 * goes when the file ends, and the run fails if anything is left behind.
 *
 * Measured on 2026-10-01, main at 105d22ed: one full run left 312 entries
 * (24 MB) in the temporary folder, under 96 prefixes from about 90 test files
 * and fixtures (fake-gh.ts, fake-claude.ts, worktree.test.ts, release.test.ts
 * first). The Mac had crashed that night on a full disk, and its temporary
 * folder held about a hundred of each from the day's runs. Asking each file to
 * remove what it makes is how the class reached 96 members, so
 * tmpdir-isolation.ts does it for every file, as home-isolation.ts does for HOME.
 *
 * How it can fail, each written down before the setup was:
 * 1. os.tmpdir() inside a test is still the machine's temporary folder, so
 *    whatever a test forgets to remove stays there.
 * 2. A child process the test starts without its own environment writes into
 *    the machine's folder, because the folder was moved for this process only.
 * 3. On Windows os.tmpdir() reads TEMP and TMP, not TMPDIR, so moving TMPDIR
 *    alone moves nothing there.
 * 4. The file's folder is not inside the run's own folder, so the guard at the
 *    end of the run (tmpdir-run.ts) never sees what a file leaves.
 * 5. The file's folder outlives the file. Not seen from inside the file itself:
 *    the guard fails the run when such a folder is left at its end (7 shows it
 *    on a run of its own), and the PR's witness is the run with the removal
 *    taken out (it fails).
 *
 * Written on 2026-10-05, before the fix, after CI failed on this PR's head:
 * "306 passed | 1 skipped", then "The run left 1 entry", exit 1.
 * 6. A file skipped whole runs no hooks: vitest skips its beforeAll and
 *    afterAll with its tests, whether a skipIf skipped them
 *    (real-claude-bypass.test.ts on a runner without claude, as on CI) or a -t
 *    filter matched none of them. Its folder stays, with its throwaway HOME and
 *    whatever it wrote at import (real-target.test.ts writes five files at
 *    import), and the guard fails the run on it, although nothing escaped: the
 *    run removes its own folder either way.
 * 7. The guard no longer bites: the run passes with a file's folder whose hooks
 *    ran and which outlived them, or with something written past every file's
 *    folder.
 * 8. The guard cannot tell a file that ran its hooks from one that ran none:
 *    the mark the setup leaves in a file's folder when its hooks run is missing.
 *
 * Written on 2026-10-19, before the guard below, after 130 fake ACP agents were
 * found stopped (state T, parent 1), started from
 * /T/tars-vitest-run-<id>/tars-vitest-file-<id>/tars-acp-<id>/ and ended by hand
 * by their ids: a delegated run's stop sends SIGSTOP and reads ps before its
 * SIGTERM and SIGCONT, and a worker that ended in between left them stopped. The
 * run removed its folder, and nothing looked at what had been started from it.
 * 9. A process a test started from its folder outlives the run stopped, and the
 *    run passes.
 * 10. The same with a process that still runs.
 * 11. The run fails on them and leaves them behind, stopped or running.
 * 12. The run fails without saying which processes: id, state, command line.
 * 13. A run whose processes all ended fails all the same (6 and 7 above run
 *     with the guard, and pass or fail on their folders alone).
 */

const FILE_PREFIX = 'tars-vitest-file-';
const RUN_PREFIX = 'tars-vitest-run-';
/** Left by tmpdir-isolation.ts in a file's folder when the file's hooks run. */
const MARK = 'tars-vitest-hooks-ran';

const FIXTURES = '__tests__/setup/fixtures/tmpdir-guard';
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

/**
 * vitest, run in a child on the fixtures beside FIXTURES' config, with the
 * suite's own setup files and run guard, in a temporary folder of its own,
 * which is read once the child has ended.
 *
 * Its output is read as plain text in the default reporter's words. vitest
 * picks another reporter, and drops its colours, when it finds an AI agent's
 * variables (CLAUDECODE), and colours its output on CI: these tests passed
 * under an agent and failed on CI, 2026-10-05.
 */
function runFixtures(args: string[]): { status: number | null; output: string; left: string[]; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-run-'));
  // The child is a run of its own, not a worker of this one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const child = spawnSync(process.execPath, [VITEST, 'run', '--config', `${FIXTURES}/vitest.config.mts`, '--reporter=default', ...args], {
    cwd: process.cwd(),
    env: { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: child.status, output: stripVTControlCharacters(`${child.stdout}${child.stderr}`), left: fs.readdirSync(tmp), tmp };
}

describe('the temporary folder of a test file', () => {
  it('1. is a folder of this file\'s own, not the machine\'s temporary folder', () => {
    const own = os.tmpdir();
    expect(path.basename(own).startsWith(FILE_PREFIX), `os.tmpdir() is ${own}`).toBe(true);
    expect(fs.statSync(own).isDirectory()).toBe(true);
  });

  it('2. is the one a child process started without its own environment uses', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").tmpdir())'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(os.tmpdir());
  });

  it('3. is named by TMPDIR, TMP and TEMP alike, for every platform\'s reading', () => {
    expect(process.env.TMPDIR).toBe(os.tmpdir());
    expect(process.env.TMP).toBe(os.tmpdir());
    expect(process.env.TEMP).toBe(os.tmpdir());
  });

  it('4. lies inside the run\'s own folder, which the guard empties and checks at the end of the run', () => {
    const run = path.dirname(os.tmpdir());
    expect(path.basename(run).startsWith(RUN_PREFIX), `the file's folder is in ${run}`).toBe(true);
  });

  it('8. carries the mark of a file whose hooks ran, which the guard reads at the end of the run', () => {
    expect(fs.existsSync(path.join(os.tmpdir(), MARK)), `no ${MARK} in ${os.tmpdir()}`).toBe(true);
  });
});

describe('the guard at the end of a run', () => {
  it('6. fails no run for a file skipped whole by a skipIf, and leaves nothing', () => {
    const run = runFixtures(['skipped-whole', 'ran']);
    expect(run.output).toMatch(/Test Files {2}1 passed \| 1 skipped \(2\)/);
    expect(run.status, run.output).toBe(0);
    expect(run.left).toEqual([]);
  }, 90_000);

  it('6. nor for files a -t filter skips whole, and leaves nothing', () => {
    const run = runFixtures(['skipped-whole', 'ran', '-t', 'no test has this name']);
    expect(run.output).toMatch(/Test Files {2}2 skipped \(2\)/);
    expect(run.status, run.output).toBe(0);
    expect(run.left).toEqual([]);
  }, 90_000);

  it('7. fails the run on a file\'s folder whose hooks ran and outlived them, and on what was written past every file\'s folder', () => {
    const run = runFixtures(['outlived']);
    expect(run.output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/The run left 2 entries in its temporary folder \(.*tars-vitest-file-outlived.*\)/);
    expect(run.output).toMatch(/The run left 2 entries in its temporary folder \(.*written-past.*\)/);
    expect(run.left).toEqual([]);
  }, 90_000);

  it.skipIf(process.platform === 'win32')('9, 11, 12. fails the run on a process started from its folder and left stopped, ends it, and names it', () => {
    const run = runFixtures(['left-stopped']);
    expect(run.output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(processesUnder(run.tmp), 'the stopped process outlived the run').toEqual([]);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/The run left 1 process running from its temporary folder, now ended: \d+ T\S* .*left-stopped-agent\.js/);
    expect(run.left).toEqual([]);
  }, 90_000);

  it('10, 11, 12. fails the run on a process started from its folder and left running, ends it, and names it', () => {
    const run = runFixtures(['left-running']);
    expect(run.output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(processesUnder(run.tmp), 'the running process outlived the run').toEqual([]);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/The run left 1 process running from its temporary folder, now ended: \d+ \S+ .*left-running-agent\.js/);
    expect(run.left).toEqual([]);
  }, 90_000);
});
