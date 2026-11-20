// The builtins as Node holds them, never as a test file mocks them: two guarded files mock `os`
// with a homedir they set after their imports, which this module, imported first, would read
// too early (home-guard-mocked-os.test.ts). The home to check is the process's, not a mock's.
const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
const os = process.getBuiltinModule('node:os') as typeof import('node:os');
const path = process.getBuiltinModule('node:path') as typeof import('node:path');

/**
 * Imported first by every test file that writes under os.homedir(), and throws unless HOME lies
 * inside the run's temporary folder. A file run without the repo's setup files then stops before
 * any of its own code runs, instead of writing into the owner's real home.
 *
 * With the setup files (vitest.config.mts):
 * - tmpdir-run.ts makes the run's folder, `tars-vitest-run-*`;
 * - tmpdir-isolation.ts records it under Symbol.for('tars.test.runTmpdir');
 * - home-isolation.ts moves HOME to a throwaway folder inside it.
 * Without them, nothing is recorded and HOME is whatever the shell had, so this throws.
 *
 * Why: on 2026-11-20 a test run with an agent's own vitest config deleted the owner's
 * ~/.codex/config.toml, and two older files would have removed ~/.config, ~/.opencode and ~/.pi,
 * and ~/.tars/mcp-servers-runtime.json, the same way. Its tests and the sweep that keeps every
 * writer guarded: home-guard.test.ts.
 */

const RUN_PREFIX = 'tars-vitest-run-';
const HOW = "Run it with the repo's own config and setup files (npm test, or vitest -c vitest.config.mts <file>): they move HOME into the run's temporary folder (__tests__/setup/home-isolation.ts).";

/** Where a path lands, its links and `..` resolved: for one that does not exist, its nearest existing parent's landing and the rest. */
function landing(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (error) {
    const parent = path.dirname(p);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === p) throw error;
    return path.join(landing(parent), path.basename(p));
  }
}

/** Why `home` is not a HOME this run made, or null when it lies inside the run's folder `run`. */
export function homeOutsideRun(home: string, run: string | undefined): string | null {
  if (!run) return `HOME is ${home}, and no run folder is recorded: the repo's setup files did not run. ${HOW}`;
  if (!path.basename(run).startsWith(RUN_PREFIX)) return `the temporary folder ${run} is not a run folder of the repo's (${RUN_PREFIX}*). ${HOW}`;
  const root = landing(run);
  // On the value as given: path.resolve would drop `link/..` as text before the link is followed
  // (#609's Audit, L1, the same fault as the fixture's).
  const where = landing(path.isAbsolute(home) ? home : path.resolve(home));
  if (!where.startsWith(root + path.sep)) return `HOME is ${home}, which is not inside the run's temporary folder ${run}. ${HOW}`;
  return null;
}

const why = homeOutsideRun(os.homedir(), (globalThis as typeof globalThis & { [key: symbol]: string | undefined })[Symbol.for('tars.test.runTmpdir')]);
if (why) throw new Error(`This test file writes under os.homedir(), so it does not run: ${why}`);
