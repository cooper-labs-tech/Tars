import '../setup/home-guard';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `npm run check:dashes`, run on throwaway trees and never on the repository's
 * own, so what the repository holds today cannot decide whether the check works.
 *
 * The script found its root with `new URL('..', import.meta.url).pathname`:
 * `/C:/Users/...` on Windows, a path no directory has, and `%20` for every
 * space on any platform. Every walk then failed, the failure was read as an
 * empty folder, and the script said "Clean" over a tree full of dashes.
 *
 * How it can fail, written before the fix (2026-09-25):
 * 1. A dash planted in a shipped file is not reported (exit 0, "Clean").
 * 2. The same, only because the tree sits under a folder with a space.
 * 3. A clean tree is not said clean, or is said clean without a file read:
 *    the number of files read is printed, and is the number there are.
 * 4. A tree where nothing can be read is said clean instead of failing.
 */

const SCRIPT = path.join(__dirname, '../../scripts/check-dashes.mjs');
const DASH = String.fromCharCode(0x2014);
const made: string[] = [];

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the script at <root>/scripts, as it sits in the repository, and the files given. */
function tree(files: Record<string, string>, parent = 'tree'): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-check-dashes-'));
  made.push(base);
  const root = path.join(base, parent);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'check-dashes.mjs'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

function check(root: string) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-dashes.mjs')], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check:dashes', () => {
  it('1. reports a dash planted in a shipped file', () => {
    const root = tree({ 'src/planted.ts': `export const s = 'a ${DASH} b';\n`, 'electron/clean.ts': 'export {};\n' });

    const r = check(root);

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'planted.ts')}:1`);
  });

  it('2. reports it under a folder whose name has a space', () => {
    const root = tree({ 'src/planted.ts': `// x ${DASH} y\n` }, 'Claude Project');

    const r = check(root);

    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${path.join('src', 'planted.ts')}:1`);
  });

  it('3. says a clean tree is clean, and how many files it read', () => {
    const root = tree({ 'src/a.ts': 'a\n', 'src/b/c.tsx': 'c\n', 'electron/d.ts': 'd\n', 'README.md': '# r\n' });

    const r = check(root);

    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\b4 files\b/);
  });

  it('4. fails on a tree where it could read nothing, rather than say clean', () => {
    const root = tree({});

    const r = check(root);

    expect(r.status, r.out).not.toBe(0);
    expect(r.out).not.toMatch(/Clean/);
  });
});
