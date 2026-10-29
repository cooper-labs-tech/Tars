import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEV_PORT } from './e2e/ports.mjs';

// One directory per run, named once here in the runner and handed to the
// workers through the environment, which they inherit: each process loads this
// file, and a stamp taken in each would name a different folder. The run's
// artefacts land in it (traces, screenshots, values.json, command.txt), and
// E2E_RUN_DIR names it outright.
process.env.E2E_RUN_DIR ||= path.join('test-results', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));

/**
 * How many spec files run at once (E2E_WORKERS, 1 to 4; 1 unset, as always). Each spec starts its own Electron in its
 * own sandbox home, and each worker moves its API ports by 1,000 (e2e/ports.mjs), so files run side by side; the tests
 * of one file stay in order. Measured on 29/10 (reports/faster-e2e.md): the default suite is 62 minutes of tests one
 * after the other, its median test 4.7 s, most of it an app's boot. Four is what this Mac's eight cores and 24 GB hold
 * beside another run: a release gate asks for it, a developer's own run need not.
 */
function readWorkers(): number {
  const raw = process.env.E2E_WORKERS;
  if (raw === undefined || raw === '') return 1;
  if (!/^[1-4]$/.test(raw)) throw new Error(`E2E_WORKERS must be a whole number from 1 to 4, not ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** What the default project leaves out: the benches, the CLI matrix, and the teardown that reads the whole run. */
const NOT_DEFAULT = /(known-errors|\.bench|cli-matrix(\.live)?)\.spec\.ts$/;

/**
 * The default specs that name no interface: the new-interface project runs them again with the new one
 * (e2e/fixture.mjs seedNewInterface). Those that name it loop both themselves, or choose by E2E_NEW_INTERFACE.
 */
function specsNamingNoInterface(): RegExp[] {
  const dir = path.join(__dirname, 'e2e');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts') && !NOT_DEFAULT.test(f) && !fs.readFileSync(path.join(dir, f), 'utf8').includes('newInterface'))
    .map((f) => new RegExp(`[\\\\/]${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

export default defineConfig({
  testDir: './e2e',
  workers: readWorkers(),
  fullyParallel: false,
  timeout: 60_000,
  outputDir: process.env.E2E_RUN_DIR,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  // The references beside it are macOS's, read where they have always been, on
  // macOS and Linux alike. Windows draws its own fonts and title bar, so it
  // compares against, and records into, a folder of its own: __screenshots__/win32/.
  snapshotPathTemplate: process.platform === 'win32'
    ? '{testDir}/__screenshots__/{platform}/{arg}{ext}'
    : '{testDir}/__screenshots__/{arg}{ext}',
  // Makes the directory each run's surfaces record their page errors in.
  globalSetup: './e2e/global-setup.mjs',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    // Every spec that drives the app. Left unnamed, so test titles and output
    // folders read as they did when this was the only project.
    {
      name: '',
      // The benches are not tests of the product: they sample the main
      // process's heap for minutes, and the replica clones the runner's own
      // ~/.claude/projects. Run only on purpose, below. Nor is the CLI matrix
      // here: its own project, below.
      testIgnore: NOT_DEFAULT,
      teardown: 'known-errors',
    },
    // Both interfaces in one run (E2E_BOTH_INTERFACES=1, the owner's rule of 16/10): the default specs that name no
    // interface, again with the new one. Until 2.0.6 a throwaway patch of the QA's at each release gate (pass B). No
    // reference is drawn in the new interface: its pictures are compared nowhere, its page errors are counted as
    // everywhere else.
    ...(process.env.E2E_BOTH_INTERFACES === '1' ? [{
      name: 'new-interface',
      testMatch: specsNamingNoInterface(),
      ignoreSnapshots: true,
      teardown: 'known-errors',
    }] : []),
    // The check that no tolerated page error has outlived its defect. As a
    // teardown it starts once everything above has finished, even after a
    // failure and whatever order the files ran in, which is what it needs to
    // see the whole run. See e2e/known-errors.spec.ts.
    {
      name: 'known-errors',
      testMatch: /known-errors\.spec\.ts$/,
    },
    // The heap benches (e2e/*.bench.spec.ts), there only when asked for:
    // TARS_HEAP_BENCH=1 npx playwright test --project=bench <file>.
    ...(process.env.TARS_HEAP_BENCH === '1' ? [{ name: 'bench', testMatch: /\.bench\.spec\.ts$/ }] : []),
    // The CLI matrix (e2e/cli-matrix.spec.ts, and its live twin, opt-in on top),
    // there only when asked for: every CLI delegating to, messaging and hearing
    // back from every other, 27 minutes for its two shells, which nearly
    // doubled the default suite. Run at every release gate, by `npm run
    // e2e:auto` when a diff touches what a delegation goes through
    // (scripts/scope-checks.mjs), and by hand: `npm run e2e:matrix`.
    ...(process.env.E2E_MATRIX === '1' ? [{ name: 'matrix', testMatch: /cli-matrix(\.live)?\.spec\.ts$/ }] : []),
  ],
  webServer: {
    // E2E_PORT_OFFSET moves this with every suite's API port: see e2e/ports.mjs.
    // On the loopback only: the server runs with the runner's own HOME, and
    // src/app/api/claude/sessions reads ~/.claude/projects from it. Unless told
    // otherwise, next dev listens on every interface.
    command: `npx next dev -H 127.0.0.1 -p ${DEV_PORT}`,
    url: `http://localhost:${DEV_PORT}`,
    reuseExistingServer: true,
    // The first request compiles the dashboard, in whatever the machine has to
    // spare. On 2026-09-23: 43 s cold at a load average of 195, and two runs
    // started together above 400 both gave up at 120 s, before any surface.
    // The wait ends at the first answer, so a longer one costs a quick server
    // nothing.
    timeout: 300_000,
    // Next dev phones home twice per run (telemetry.nextjs.org, seen leaving
    // the machine by lsof on 2026-09-17). This is merged over process.env by
    // the runner, so nothing else about the environment changes.
    env: { NEXT_TELEMETRY_DISABLED: '1' },
  },
});
