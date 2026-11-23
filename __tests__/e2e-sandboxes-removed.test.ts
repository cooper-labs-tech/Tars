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
 *
 * Added after the Audit's M1 on #628 (23/11), written before the specs it found were fixed. A red run keeps its home
 * (removeHome), so whatever a spec copied there from the real home stays with it: cli-matrix.live copied the real
 * ~/.codex/auth.json and ~/.qwen/settings.json, qwen-code.live the latter, and the replica benches the owner's
 * transcripts and task texts. copyFromRealHome (e2e/fixture.mjs) records such a copy, and removeHome deletes it whatever
 * the outcome.
 * 7. A file copies a file or a folder of the real home (`os.homedir()`, or a name built on it, directly or through a
 *    for-of) with copyFileSync, cpSync or a `cp`, not through copyFromRealHome: a red run keeps the copy.
 * 8. Over-correction: a stand-in's own source (a String.raw or multi-line template the spec writes out), a copy of the
 *    repository's own files, or a link to the real file is taken for such a copy.
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

/**
 * A text with every template that is a written-out source emptied: a String.raw one, or one spanning lines. Backticks
 * are paired in order, an escaped one skipped, so the code between two templates is never taken for one.
 */
function withoutWrittenSources(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('`', at);
    if (open < 0) return out + text.slice(at);
    let close = open + 1;
    while (close < text.length && (text[close] !== '`' || text[close - 1] === '\\')) close++;
    const body = text.slice(open, close + 1);
    const written = /String\.raw\s*$/.test(text.slice(Math.max(0, open - 16), open)) || body.includes('\n');
    out += text.slice(at, open) + (written ? '``' : body);
    at = close + 1;
  }
}

/**
 * The copies of the real home a text makes itself: every copyFileSync, cpSync, copyFile or execFile of `cp` whose
 * arguments name the real home. A name is the real home's when it is assigned an expression that calls homedir() or
 * holds such a name, or is bound by a for-of over one; a stand-in's source written out in a String.raw or a multi-line
 * template is not the spec's own code.
 */
function realHomeCopies(text: string): string[] {
  const code = withoutWrittenSources(text);
  const names = new Set<string>();
  const mentionsHome = (s: string) => /\bhomedir\s*\(/.test(s) || [...names].some((n) => new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, '\\$')}\\b`).test(s));
  for (let grew = true; grew;) {
    grew = false;
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g)) {
      if (!names.has(m[1]) && mentionsHome(m[2])) { names.add(m[1]); grew = true; }
    }
    for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let)\s*\[([^\]]+)\]\s+of\s+([^\n]+)/g)) {
      for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) if (!names.has(n) && mentionsHome(m[2])) { names.add(n); grew = true; }
    }
  }
  return [...code.matchAll(/\b(?:copyFileSync|cpSync|copyFile)\s*\([^;\n]*|\bexecFile(?:Sync)?\(\s*['"](?:\/bin\/)?cp['"][^;\n]*/g)]
    .map((m) => m[0])
    .filter(mentionsHome);
}

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

  it('7, 8. a copy of the real home is told from a stand-in, a copy of the repository and a link', () => {
    expect(realHomeCopies("const real = os.homedir();\nfor (const [from, to] of [[path.join(real, '.codex', 'auth.json'), dest]])\n  if (fs.existsSync(from)) fs.copyFileSync(from, to);"), 'through a for-of').toHaveLength(1);
    expect(realHomeCopies("const USER_QWEN = path.join(os.homedir(), '.qwen', 'settings.json');\nfs.copyFileSync(USER_QWEN, dest);"), 'a constant').toHaveLength(1);
    expect(realHomeCopies("const REAL_HOME = process.env.X ?? os.homedir();\nconst from = path.join(REAL_HOME, '.tars', f);\nfs.copyFileSync(from, to);"), 'two names deep').toHaveLength(1);
    expect(realHomeCopies("const REAL_HOME = os.homedir();\nexecFileSync('/bin/cp', ['-c', '-R', path.join(REAL_HOME, '.claude', 'projects'), to]);"), 'a cp').toHaveLength(1);
    expect(realHomeCopies("fs.cpSync(path.join(os.homedir(), '.claude'), to, { recursive: true });"), 'inline').toHaveLength(1);
    expect(realHomeCopies("const USER_QWEN = path.join(os.homedir(), '.qwen', 'settings.json');\ncopyFromRealHome(USER_QWEN, dest);"), 'through the fixture').toEqual([]);
    expect(realHomeCopies("const STAND_IN = String.raw`\nconst home = os.homedir();\nfs.copyFileSync(path.join(home, 'x'), 'y');\n`;"), 'a stand-in').toEqual([]);
    expect(realHomeCopies("fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'b.js'));"), 'the repository').toEqual([]);
    expect(realHomeCopies("const AUTH = path.join(os.homedir(), '.codex', 'auth.json');\nfs.symlinkSync(AUTH, path.join(codexHome, 'auth.json'));"), 'a link').toEqual([]);
    expect(realHomeCopies("const home = fs.mkdtempSync(p);\nfs.copyFileSync(path.join(home, 'a.jsonl'), test.info().outputPath('a.jsonl'));"), 'the sandbox to the output').toEqual([]);
  });

  it('7. every copy of the real home goes through copyFromRealHome', () => {
    const naming = files().filter((name) => /\bhomedir\s*\(/.test(fs.readFileSync(path.join(E2E, name), 'utf-8')));
    expect(naming.length, 'files under e2e/ that read the real home').toBeGreaterThan(5);
    const left = files().flatMap((name) => realHomeCopies(fs.readFileSync(path.join(E2E, name), 'utf-8')).map((call) => `e2e/${name}: ${call.slice(0, 90)}`));
    expect(left, 'copy it with copyFromRealHome (e2e/fixture.mjs): removeHome deletes it, a kept red home included').toEqual([]);
  });

  it('1, 2, 4, 5, 6. are each removed by the file that made it', () => {
    const left = files()
      .map((name) => ({ name, ...counts(name) }))
      .filter(({ made, removed }) => made > 0 && removed < made)
      .map(({ name, made, removed }) => `e2e/${name}: makes ${made}, removes ${removed}`);
    expect(left, 'call removeHome(home) in the finally that closes the app').toEqual([]);
  });
});
