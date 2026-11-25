import './setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cannotSymlink } from './setup/symlink-privilege';
// @ts-expect-error: the fixture is plain JavaScript, with no declarations
import { removeHome } from '../e2e/fixture.mjs';

/**
 * removeHome (e2e/fixture.mjs) removes a spec's sandbox HOME once its app has
 * closed, with rmSync's recursive force. It removed whatever it was handed: what
 * kept it inside a sandbox was each spec's own mkdtemp (the Audit's L1 on #385).
 * It now removes only what lies strictly under a folder the specs make their
 * sandboxes in: os.tmpdir() (an agent's own TMPDIR included), /tmp (the chat
 * rooms, for the length of the path their heads print) and macOS's own
 * temporary folder (the surfaces, for the same reason, #368).
 *
 * How it can fail, written before the guard:
 *  1. A folder outside every sandbox root (a wrong variable, a HOME, a
 *     repository) is deleted, where it must be refused, loudly, and kept.
 *  2. A sandbox root itself is deleted, os.tmpdir() handed in by mistake.
 *  3. A path that climbs out of a root (`<root>/x/../../elsewhere`, a bad join)
 *     is judged by its spelling and deleted.
 *  4. A link in a root that points outside is followed, and what it points at is
 *     deleted; or a sandbox holding such a link loses the link's target with it.
 *  5. Over-correction: a sandbox in a root is no longer removed; an absent one,
 *     cleaned twice, now throws; a root or a sandbox spelled through a link
 *     (macOS's /var for /private/var) is refused.
 *  6. A real sandbox of the suite is refused: one made under /tmp (chat-rooms),
 *     under macOS's own temporary folder (surfaces) or under os.tmpdir(), so
 *     its spec's cleanup fails.
 *
 * No case hands it a real root: under a guard that regressed, or a mutant of
 * it, that case would empty os.tmpdir(), /tmp or macOS's temporary folder.
 * Every folder a case could delete lies in the case's own mkdtemp.
 */

let base: string;
let root: string;
let outside: string;

const put = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); };

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remove-home-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  put(path.join(outside, 'precious.txt'));
  fs.mkdirSync(root);
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('removeHome, against the roots it is given', () => {
  it('1. refuses a folder outside every root, and keeps it', async () => {
    await expect(removeHome(outside, [root])).rejects.toThrow(/not inside/);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('2. refuses a root itself', async () => {
    put(path.join(root, 'other-sandbox', 'a.txt'));
    await expect(removeHome(root, [root])).rejects.toThrow(/not inside/);
    expect(fs.existsSync(path.join(root, 'other-sandbox', 'a.txt'))).toBe(true);
  });

  it('3. judges a path that climbs out of a root by where it lands', async () => {
    fs.mkdirSync(path.join(root, 'x'));
    await expect(removeHome([root, 'x', '..', '..', 'outside'].join(path.sep), [root])).rejects.toThrow(/not inside/);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it.skipIf(cannotSymlink())('4. never deletes what a link points at, handed the link or a sandbox holding it', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'));
    await expect(removeHome(path.join(root, 'link'), [root])).rejects.toThrow(/not inside/);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
    // Through a link, then `..`: spelled inside the root, it lands in outside/,
    // which is where the system would delete.
    fs.mkdirSync(path.join(outside, 'inner'));
    fs.symlinkSync(path.join(outside, 'inner'), path.join(root, 'deep'));
    // Joined by hand: path.join would fold `deep/..` away before removeHome saw it.
    await expect(removeHome([root, 'deep', '..', 'precious.txt'].join(path.sep), [root])).rejects.toThrow(/not inside/);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);

    const sandbox = path.join(root, 'sandbox');
    fs.mkdirSync(sandbox);
    fs.symlinkSync(outside, path.join(sandbox, 'link'));
    await removeHome(sandbox, [root]);
    expect(fs.existsSync(sandbox)).toBe(false);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('5. removes a sandbox in a root, and an absent one quietly', async () => {
    put(path.join(root, 'sandbox', '.tars', 'agents.json'));
    await removeHome(path.join(root, 'sandbox'), [root]);
    expect(fs.existsSync(path.join(root, 'sandbox'))).toBe(false);
    await expect(removeHome(path.join(root, 'sandbox'), [root])).resolves.toBeUndefined();
    await expect(removeHome(path.join(outside, 'never-made'), [root])).rejects.toThrow(/not inside/);
  });

  it.skipIf(cannotSymlink())('5. takes a root and a sandbox through either spelling of a link to them', async () => {
    const alias = path.join(base, 'alias');
    fs.symlinkSync(root, alias);
    put(path.join(root, 'one', 'a.txt'));
    await removeHome(path.join(root, 'one'), [alias]);
    expect(fs.existsSync(path.join(root, 'one'))).toBe(false);
    put(path.join(root, 'two', 'a.txt'));
    await removeHome(path.join(alias, 'two'), [root]);
    expect(fs.existsSync(path.join(root, 'two'))).toBe(false);
  });
});

describe("removeHome, against the suite's own roots", () => {
  it('6. removes a sandbox made where the specs make theirs', async () => {
    const made = [fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remove-home-tmpdir-'))];
    if (process.platform !== 'win32') made.push(fs.mkdtempSync('/tmp/tars-remove-home-tmp-'));
    if (process.platform === 'darwin') {
      const own = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
      made.push(fs.mkdtempSync(path.join(own, 'tars-remove-home-own-')));
    }
    try {
      for (const sandbox of made) {
        put(path.join(sandbox, '.claude.json'));
        await removeHome(sandbox);
        expect(fs.existsSync(sandbox), sandbox).toBe(false);
      }
    } finally {
      for (const sandbox of made) fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
