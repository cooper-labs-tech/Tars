import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * main.ts requires './core/sandbox-guard' first: a test build started on the
 * account's own home exits there, before anything reads the data folder (#477,
 * the Audit's M1). Then './core/compile-cache', before any other module, so
 * every module after it is compiled from the cache it keeps (#163). A later
 * import put above it (github-watch, the Audit's gate of #234) is compiled
 * without it. The guard is not: it writes nothing and reads no data folder.
 *
 * How it fails: an import or a require that is not a type sits above either.
 */
describe('main.ts', () => {
  it('imports the sandbox guard, then the compile cache, before anything else', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../electron/main.ts'), 'utf-8');
    const imports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?['"]([^'"]+)['"];?$/gm)].map(m => m[1]);
    expect(imports.slice(0, 2)).toEqual(['./core/sandbox-guard', './core/compile-cache']);
  });
});
