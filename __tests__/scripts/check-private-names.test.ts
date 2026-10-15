import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `npm run check:names`, run on throwaway git repositories and never on this
 * one, with the list of names written beside each, outside its tree. The names
 * here are made up: the real list lives outside the repository
 * (~/.tars-private/private-names.txt), so that no file in it publishes a name.
 *
 * How it can fail, written before the script (2026-10-16):
 * 1. A listed name in a tracked file is not reported (exit 0), or the tree
 *    sits under a folder with a space and no file is read (check-dashes's bug).
 * 2. A file nobody has added yet is not read: the next commit publishes it.
 * 3. A file git ignores is reported: it is never published.
 * 4. A name in an identifier or a path is missed: camelCase, SCREAMING_CASE,
 *    snake_case, a plural, a dashed folder name, or glued behind an escape
 *    (`%5c`, `\n`).
 * 5. A name inside another word is reported: "atomic" is not "Tom".
 * 6. An entry that is not a single word (an e-mail address, two words) is not
 *    found as written, in any case.
 * 7. The report repeats the name it found, so it cannot be pasted into a PR.
 * 8. Without the list, the check fails or says nothing: CI and contributors
 *    have none, so it passes, and says that it checked nothing.
 * 9. A list that names nobody is said clean: nothing was checked.
 * 10. The list is looked for anywhere but ~/.tars-private/private-names.txt,
 *     unless TARS_PRIVATE_NAMES names another file.
 * 11. A binary file is read as text: reported, or it breaks the check. It is
 *     counted as not read instead, since a picture cannot be searched.
 * 12. Nothing listed by git (not a repository) is said clean.
 * 13. A clean tree is not said clean, or without the number of files read.
 * And found on the repository's own first run (2026-10-16):
 * 14. A name in a file's path, a folder's or its own, is not reported: the
 *     path is published as much as the file.
 * 15. A character whose lowercase is longer (`\u0130`, a capital I with a dot)
 *     shifts every position after it, so a name after it is missed or
 *     masked one character off.
 */

const SCRIPT = path.join(__dirname, '../../scripts/check-private-names.mjs');
const made: string[] = [];

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** The environment without git's own variables, so the throwaway repository is the one git sees. */
function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  delete env.TARS_PRIVATE_NAMES;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

interface Tree { base: string; root: string }

/**
 * A git repository holding a copy of the script at scripts/, `added` staged and
 * `loose` left unadded. The list of names goes in `base`, outside the tree.
 */
function tree(added: Record<string, string | Buffer>, loose: Record<string, string> = {}, parent = 'tree', init = true): Tree {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-check-names-'));
  made.push(base);
  const root = path.join(base, parent);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'check-private-names.mjs'));
  const write = (files: Record<string, string | Buffer>) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
  };
  write(added);
  if (init) {
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, env: cleanEnv(), encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q');
    git('add', '-A');
  }
  write(loose);
  return { base, root };
}

function names(t: Tree, lines: string[]): string {
  const file = path.join(t.base, 'private-names.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function check(t: Tree, env: Record<string, string | undefined>) {
  // The search for a repository stops at the throwaway folder, whatever holds it.
  const r = spawnSync(process.execPath, [path.join(t.root, 'scripts', 'check-private-names.mjs')], { cwd: t.root, env: cleanEnv({ GIT_CEILING_DIRECTORIES: t.base, ...env }), encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check:names', () => {
  it('1. reports a listed name in a tracked file, under a folder whose name has a space', () => {
    const t = tree({ 'src/a.ts': 'export const s = 1;\n// asked by Zelda on 12/10\n', 'README.md': '# r\n' }, {}, 'Claude Project');

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'a.ts')}:2:`);
  });

  it('2. reads a file nobody has added yet', () => {
    const t = tree({ 'src/a.ts': 'export {};\n' }, { 'src/new.ts': 'const by = "zelda";\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'new.ts')}:1:`);
  });

  it('3. leaves alone a file git ignores', () => {
    const t = tree({ '.gitignore': 'notes/\n', 'src/a.ts': 'export {};\n' }, { 'notes/private.md': 'Zelda said so.\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(0);
  });

  it('4. finds a name in identifiers, paths and behind an escape', () => {
    const lines = [
      'function zeldaWrites() {}',
      'const ZELDA_SAID = 1;',
      'seedZeldasConversation();',
      'def zeldas_turn(): pass',
      "const dir = '-Users-zelda-tars';",
      "const url = 'app://-/%5cUsers%5czelda%5c.dorothy';",
      "const text = 'fatal\\nzelda';",
      'const home = "/Users/Zelda/projects";',
    ];
    const t = tree({ 'src/a.ts': lines.join('\n') + '\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(1);
    for (let n = 1; n <= lines.length; n++) expect(r.out).toContain(`${path.join('src', 'a.ts')}:${n}:`);
  });

  it('5. does not take a name inside another word for the name', () => {
    const t = tree({ 'src/a.ts': 'const atomic = true; // the atomics stay\n', 'src/b.ts': "const by = \"Tom's\";\n" });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['tom']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain(path.join('src', 'a.ts'));
    expect(r.out).toContain(`${path.join('src', 'b.ts')}:1:`);
  });

  it('6. finds an entry that is not a word as written, in any case', () => {
    const t = tree({ 'src/a.ts': "const to = 'Z.Quill@Example.org';\n", 'src/b.ts': "const who = 'ada  lune';\nconst also = 'Ada Lune';\n" });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['z.quill@example.org', 'Ada Lune']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'a.ts')}:1:`);
    expect(r.out).toContain(`${path.join('src', 'b.ts')}:2:`);
    expect(r.out).not.toContain(`${path.join('src', 'b.ts')}:1:`);
  });

  it('7. shows where a name is without repeating it', () => {
    const t = tree({ 'src/a.ts': "const home = '/Users/zelda/x'; // Zelda's, mailed to z.quill@example.org\n" });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda', 'z.quill@example.org']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'a.ts')}:1:`);
    expect(r.out.toLowerCase()).not.toContain('zelda');
    expect(r.out.toLowerCase()).not.toContain('quill');
    expect(r.out).toContain('/Users/');
  });

  it('8. without the list, passes and says it checked nothing', () => {
    const t = tree({ 'src/a.ts': 'Zelda\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: path.join(t.base, 'absent.txt') });

    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(path.join(t.base, 'absent.txt'));
    expect(r.out).toMatch(/nothing (was )?checked/i);
    expect(r.out).not.toMatch(/clean/i);
  });

  it('9. fails on a list that names nobody, rather than say clean', () => {
    const t = tree({ 'src/a.ts': 'Zelda\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['# the list', '', '   ']) });

    expect(r.status, r.out).toBe(2);
    expect(r.out).not.toMatch(/clean/i);
  });

  it('10. reads ~/.tars-private/private-names.txt when nothing names another list', () => {
    const t = tree({ 'src/a.ts': 'Zelda\n' });
    const home = path.join(t.base, 'home');
    fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tars-private', 'private-names.txt'), 'zelda\n');

    const r = check(t, { HOME: home, USERPROFILE: home, TARS_PRIVATE_NAMES: undefined });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'a.ts')}:1:`);
  });

  it('11. counts a binary file as not read, and does not report it', () => {
    const picture = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), Buffer.from(' Zelda ')]);
    const t = tree({ 'shot.png': picture, 'src/a.ts': 'export {};\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain('shot.png:');
    expect(r.out).toMatch(/\b1 binary file\b/);
  });

  it('12. fails outside a git repository, rather than say clean', () => {
    const t = tree({ 'src/a.ts': 'Zelda\n' }, {}, 'tree', false);

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(2);
    expect(r.out).not.toMatch(/clean/i);
  });

  it('13. says a clean tree is clean, and how many files it read', () => {
    const t = tree({ 'src/a.ts': 'a\n', 'src/b/c.tsx': 'c\n', 'README.md': '# r\n' }, { 'notes.md': 'n\n' });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(0);
    // The three files, the loose note and the script's own copy.
    expect(r.out).toMatch(/\b5 files\b/);
    expect(r.out).toMatch(/clean/i);
  });

  it('14. reports a name in a file\'s path, masked, and masks it where a line is reported', () => {
    const t = tree({
      'e2e/zelda-answers.spec.ts': 'export {};\n',
      'docs/zelda/notes.md': '# notes\nasked by Zelda\n',
      'src/a.ts': 'export {};\n',
    });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(path.join('e2e', '*****-answers.spec.ts'));
    expect(r.out).toContain(`${path.join('docs', '*****', 'notes.md')}:2:`);
    expect(r.out.toLowerCase()).not.toContain('zelda');
  });

  it('15. finds and masks a name after a character whose lowercase is longer', () => {
    const t = tree({ 'src/a.ts': `// \u0130 Zelda here\n` });

    const r = check(t, { TARS_PRIVATE_NAMES: names(t, ['Zelda']) });

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'a.ts')}:1:6`);
    expect(r.out).toContain('// \u0130 ***** here');
  });
});
