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
 *
 * Widened after the Audit's L1 on #628 (22/11), and written before the specs it found were fixed:
 * 4. A spec makes its folder under another prefix (tars-e2e-, dorothy-cli-paths-, /tmp/tars-), its prefix held in a
 *    constant, or its call spread over several lines: the scan of `mkdtempSync(...dorothy-e2e-` on one line does not see
 *    it, and it leaks unseen. chat-history made two such homes and removed neither.
 * 5. The removal of something else is counted as the home's: chat-history's rmSync of a file stood for one of its homes.
 * 6. A helper module under e2e/ (a global setup, a picture script) makes a folder that nothing removes, or a spec calls
 *    makeShotSandbox and never removeShotSandbox.
 */

const E2E = path.join(__dirname, '..', 'e2e');

/**
 * Every spec and helper module under e2e/, however deep, except what Playwright generates, and except fixture.mjs, which
 * holds the makers and removeHome themselves (makeShotSandbox's folder is its caller's to remove, and counted there).
 */
function files(): string[] {
  return (fs.readdirSync(E2E, { recursive: true }) as string[])
    .filter((name) => /\.(ts|mts|js|mjs)$/.test(name) && name !== 'fixture.mjs')
    .filter((name) => !name.split(path.sep).some((part) => part === 'report' || part === '__screenshots__'));
}

/**
 * The folders a text makes: every call of mkdtempSync, whatever its prefix and however its arguments are laid out, and
 * every makeShotSandbox. Its removals: every removeHome and removeShotSandbox, and every rmSync whose first argument is a
 * home (`home`, `homeB`...) or a variable the text assigned a mkdtempSync to. An rmSync of anything else is not one.
 */
function count(text: string): { made: number; removed: number } {
  const folders = new Set(
    [...text.matchAll(/([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:await\s+)?(?:[\w$]+\.)?mkdtempSync\s*\(/g)].map((m) => m[1]),
  );
  return {
    made: (text.match(/\bmkdtempSync\s*\(|\bmakeShotSandbox\s*\(/g) ?? []).length,
    removed: (text.match(/\b(?:removeHome|removeShotSandbox)\s*\(/g) ?? []).length
      + [...text.matchAll(/\brmSync\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)].filter((m) => /^home/.test(m[1]) || folders.has(m[1])).length,
  };
}

const counts = (name: string) => count(fs.readFileSync(path.join(E2E, name), 'utf-8'));

describe('the e2e sandboxes', () => {
  it('4, 5, 6. are counted whatever their prefix and layout, and only a removal of a folder made counts', () => {
    expect(count("const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-chat-history-'));"), 'another prefix').toEqual({ made: 1, removed: 0 });
    expect(count("const PREFIX = 'x-';\nconst home = fs.mkdtempSync(\n  path.join(os.tmpdir(), PREFIX),\n);"), 'a constant, over three lines').toEqual({ made: 1, removed: 0 });
    expect(count("const home = mkdtempSync(p);\nfs.rmSync(s2File);"), 'an rmSync of a file').toEqual({ made: 1, removed: 0 });
    expect(count("const dir = fs.mkdtempSync(p);\nfs.rmSync(dir, { recursive: true, force: true });"), 'a helper removing its own').toEqual({ made: 1, removed: 1 });
    expect(count("const homeB = fs.mkdtempSync(p);\nfs.rmSync(homeB, { recursive: true });"), 'a second home').toEqual({ made: 1, removed: 1 });
    expect(count("sandbox = makeShotSandbox('x-', root);\nawait removeShotSandbox(sandbox);"), 'a shot sandbox').toEqual({ made: 1, removed: 1 });
    expect(count("import { mkdtempSync, rmSync } from 'node:fs';\nimport { removeHome } from './fixture.mjs';"), 'imports name, they do not call').toEqual({ made: 0, removed: 0 });
  });

  it('3. are read from real specs and helpers, many of which make one', () => {
    const making = files().filter((name) => counts(name).made > 0);
    expect(making.length, 'files under e2e/ that make a sandbox').toBeGreaterThan(150);
    expect(making).toEqual(expect.arrayContaining(['agent-queue.spec.ts', 'resume-after-crash.spec.ts', 'global-setup.mjs', 'surfaces.spec.ts']));
    expect(counts('chat-history.spec.ts').made, 'chat-history, under tars-e2e-').toBe(2);
  });

  it('1, 2, 4, 5, 6. are each removed by the file that made it', () => {
    const left = files()
      .map((name) => ({ name, ...counts(name) }))
      .filter(({ made, removed }) => made > 0 && removed < made)
      .map(({ name, made, removed }) => `e2e/${name}: makes ${made}, removes ${removed}`);
    expect(left, 'call removeHome(home) in the finally that closes the app').toEqual([]);
  });
});
