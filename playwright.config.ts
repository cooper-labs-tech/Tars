import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { DEV_PORT } from './e2e/ports.mjs';

// One directory per run, named once here in the runner and handed to the
// workers through the environment, which they inherit: each process loads this
// file, and a stamp taken in each would name a different folder. The run's
// artefacts land in it (traces, screenshots, values.json, command.txt), and
// E2E_RUN_DIR names it outright.
process.env.E2E_RUN_DIR ||= path.join('test-results', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));

export default defineConfig({
  testDir: './e2e',
  // One Electron instance drives every surface — keep it serial.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  outputDir: process.env.E2E_RUN_DIR,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
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
      testIgnore: /(known-errors|\.bench|cli-matrix(\.live)?)\.spec\.ts$/,
      teardown: 'known-errors',
    },
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
