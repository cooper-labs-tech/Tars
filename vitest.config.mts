import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  // Renderer modules use the same @ alias Next resolves, so tests that reach
  // into src/ need it too.
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  test: {
    globals: true,
    environment: 'node',
    // Loaded before each test file's imports, which is the point: constants.ts
    // reads DOROTHY_API_PORT and computes DATA_DIR from the home directory at
    // module load, so anything later is too late. See each file for what it
    // removes, what it keeps, and where HOME now points.
    // worktree-name.ts first: in a folder where vitest cannot load some
    // built-in modules, it fails every file with the reason before any fails
    // without one. tmpdir-isolation.ts next, so that the throwaway HOME
    // home-isolation.ts makes is inside the file's own temporary folder too.
    // repo-config-guard.ts last: it fails a file that changed the git
    // configuration of the repository the suite runs in.
    setupFiles: ['./__tests__/setup/worktree-name.ts', './__tests__/setup/tmpdir-isolation.ts', './__tests__/setup/env-isolation.ts', './__tests__/setup/home-isolation.ts', './__tests__/setup/repo-config-guard.ts'],
    // The run's own temporary folder, which must be empty at the end of the
    // run: see __tests__/setup/tmpdir-run.ts.
    globalSetup: ['./__tests__/setup/tmpdir-run.ts'],
    // .tsx too: the overseer's text renderer is asserted through the markup
    // it produces, which needs the component itself.
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: [
        'electron/constants/**',
        'electron/utils/**',
        'electron/services/**',
        'electron/handlers/**',
        'electron/providers/**',
        'mcp-orchestrator/src/utils/**',
        'mcp-orchestrator/src/tools/**',
        'mcp-telegram/src/**',
        'mcp-kanban/src/**',
      ],
    },
  },
});
