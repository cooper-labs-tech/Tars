import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cannotSymlink } from './setup/symlink-privilege';
// @ts-expect-error: the fixture is plain JavaScript, with no declarations
import { pruneKeptSandboxes } from '../e2e/fixture.mjs';

/**
 * pruneKeptSandboxes (e2e/fixture.mjs), which the e2e global setup runs before every run: the sandboxes red runs kept
 * (removeHome marks each with `.tars-e2e-kept`) are removed once they are a day old.
 *
 * The Audit's L1 on #628 (23/11): a red run keeps its home, about 20 MB, and nothing ever removed one. A run where
 * everything fails (next dev down, the machine asleep) keeps about 190 of them, nearly 4 GB: the disk problem #628
 * fixes.
 *
 * How it can fail, written before the code:
 * 1. A kept sandbox older than a day stays, run after run.
 * 2. Over-correction: a kept sandbox younger than a day goes, with what the red run left to read, the same day.
 * 3. A folder without the mark goes: another agent's probe in /tmp, a sandbox a running spec is using, anything not
 *    kept by removeHome.
 * 4. A link is followed: a link in a root to a marked folder outside it, or a mark that is a link, and what it points at
 *    goes.
 * 5. A folder outside the roots it is given goes, or a root itself.
 *
 * Every folder a case could delete lies in the case's own mkdtemp, passed as the only root.
 */

let base: string;
let root: string;
const DAY = 24 * 3600 * 1000;
const now = Date.now();

/** A sandbox in `where` holding a file, marked as kept `ageMs` ago unless `marked` is false. */
function sandbox(where: string, name: string, ageMs: number, marked = true): string {
  const dir = path.join(where, name);
  fs.mkdirSync(path.join(dir, '.tars'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tars', 'fake-cli.log'), 'what the red run left\n');
  const at = new Date(now - ageMs);
  if (marked) {
    fs.writeFileSync(path.join(dir, '.tars-e2e-kept'), '{}\n');
    fs.utimesSync(path.join(dir, '.tars-e2e-kept'), at, at);
  }
  fs.utimesSync(dir, at, at);
  return dir;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-kept-prune-')));
  root = path.join(base, 'root');
  fs.mkdirSync(root);
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('pruneKeptSandboxes, in the roots it is given', () => {
  it('1, 2. removes a kept sandbox a day old, and keeps one an hour old', () => {
    const aged = sandbox(root, 'dorothy-e2e-queue-classic-aged', DAY + 3600 * 1000);
    const fresh = sandbox(root, 'dorothy-e2e-queue-classic-fresh', 3600 * 1000);
    const removed = pruneKeptSandboxes({ roots: [root], now });
    expect(fs.existsSync(aged), 'the aged one').toBe(false);
    expect(fs.existsSync(path.join(fresh, '.tars', 'fake-cli.log')), 'the fresh one, whole').toBe(true);
    expect(removed).toEqual([aged]);
  });

  it('3. leaves a folder without the mark, however old', () => {
    const probe = sandbox(root, 'tars-codex-0163-probe', 30 * DAY, false);
    expect(pruneKeptSandboxes({ roots: [root], now })).toEqual([]);
    expect(fs.existsSync(path.join(probe, '.tars', 'fake-cli.log'))).toBe(true);
  });

  it.skipIf(cannotSymlink())('4. follows no link: to a marked folder outside, or a mark that is a link', () => {
    const outside = sandbox(base, 'outside-marked', 30 * DAY);
    fs.symlinkSync(outside, path.join(root, 'dorothy-e2e-link'));
    const linkedMark = sandbox(root, 'dorothy-e2e-linked-mark', 30 * DAY, false);
    fs.symlinkSync(path.join(outside, '.tars-e2e-kept'), path.join(linkedMark, '.tars-e2e-kept'));
    expect(pruneKeptSandboxes({ roots: [root], now })).toEqual([]);
    expect(fs.existsSync(path.join(outside, '.tars', 'fake-cli.log')), 'the folder outside').toBe(true);
    expect(fs.existsSync(path.join(linkedMark, '.tars', 'fake-cli.log')), 'the folder whose mark is a link').toBe(true);
  });

  it('5. touches nothing outside its roots, and never a root', () => {
    const outside = sandbox(base, 'dorothy-e2e-outside', 30 * DAY);
    fs.writeFileSync(path.join(root, '.tars-e2e-kept'), '{}\n');
    fs.utimesSync(path.join(root, '.tars-e2e-kept'), new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    expect(pruneKeptSandboxes({ roots: [root], now })).toEqual([]);
    expect(fs.existsSync(path.join(outside, '.tars', 'fake-cli.log'))).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });
});
