import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every e2e spec that makes a sandbox HOME removes it once its app has closed (removeHome, e2e/fixture.mjs).
 *
 * QA, 22/11: 471 sandboxes, 9.4 GB, were left in the account's temporary folder by three days of gates. 27 specs make a
 * `dorothy-e2e-` home with mkdtempSync and never remove it (or remove one of their two), so every full run of the suite
 * leaves one more of each, and the machine every project's runs share fills (tars-slot then holds every run back for
 * disk). removeHome itself is sound (e2e-remove-home.test.ts); what it cannot do is run for a spec that never calls it.
 *
 * How it can fail, written before the specs were fixed:
 * 1. A spec makes a `dorothy-e2e-` sandbox and removes it nowhere (removeHome, or an rmSync of the home itself): every run
 *    leaves its home behind.
 * 2. A spec makes more sandboxes than it removes (one home per app, two apps): one of them is left behind.
 * 3. The scan reads no spec, or no sandbox, and passes for a clean suite.
 */

const E2E = path.join(__dirname, '..', 'e2e');

/** Every spec under e2e/, however deep, except what Playwright generates. */
function specs(): string[] {
  return (fs.readdirSync(E2E, { recursive: true }) as string[])
    .filter((name) => /\.spec\.(ts|mts|js|mjs)$/.test(name))
    .filter((name) => !name.split(path.sep).some((part) => part === 'report' || part === '__screenshots__'));
}

/** A spec's sandboxes made (mkdtempSync of a dorothy-e2e- home) and its removals (removeHome, or an rmSync whose first argument is a home), as written. */
function counts(name: string): { made: number; removed: number } {
  const text = fs.readFileSync(path.join(E2E, name), 'utf-8');
  return {
    made: (text.match(/mkdtempSync\([^;\n]*dorothy-e2e-/g) ?? []).length,
    removed: (text.match(/\bremoveHome\(|\brmSync\(\s*home\w*\s*[,)]/g) ?? []).length,
  };
}

describe('the e2e sandboxes', () => {
  it('3. are read from real specs, many of which make one', () => {
    const making = specs().filter((name) => counts(name).made > 0);
    expect(making.length, 'specs that make a dorothy-e2e- sandbox').toBeGreaterThan(100);
    expect(making).toEqual(expect.arrayContaining(['agent-queue.spec.ts', 'resume-after-crash.spec.ts']));
  });

  it('1, 2. are each removed by the spec that made it', () => {
    const left = specs()
      .map((name) => ({ name, ...counts(name) }))
      .filter(({ made, removed }) => made > 0 && removed < made)
      .map(({ name, made, removed }) => `e2e/${name}: makes ${made}, removes ${removed}`);
    expect(left, 'call removeHome(home) in the finally that closes the app').toEqual([]);
  });
});
