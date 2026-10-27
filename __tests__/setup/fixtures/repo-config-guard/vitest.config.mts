import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The guard alone, on the fixtures beside this file. repo-config-guard.test.ts runs vitest on them in a
 * child whose folder is a throwaway repository, which plays the suite's own and is the run's root (vite
 * keeps its cache there, in the temporary folder): `dir` only says where the fixtures are. The suite's
 * own run never picks these up, since it takes only *.test.ts files.
 */
export default defineConfig({
  test: {
    dir: here,
    environment: 'node',
    setupFiles: [path.join(here, '..', '..', 'repo-config-guard.ts')],
    include: ['*.fixture.ts'],
  },
});
