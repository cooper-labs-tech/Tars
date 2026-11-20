import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCliUpdatePass, type CliUpdateContext } from '../../../electron/services/cli-updater';
import { cannotSymlink } from '../../setup/symlink-privilege';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The scratch folders that updates could not remove, swept by a later pass.
 *
 * Each npm update works in a folder of its own under the system's temp folder,
 * with npm's cache in it, and removes the folder when it is done. A removal
 * that fails leaves it there, and nothing removed it afterwards: one more folder
 * each half hour where the removal keeps failing, as it does on Windows (the
 * gates of #218).
 *
 * Every way this can fail, written before the code:
 *  1. a leftover old enough to belong to no update is still there after a pass;
 *  2. a folder an update may still be using is removed from under it: another
 *     Tars's, or a sandbox's. An update holds its folder for at most about 23
 *     minutes: a one-minute view, a ten-minute download, a ten-minute install
 *     and two one-minute lsof checks;
 *  3. something that is not one of our folders goes:
 *     - a name that only starts like ours, another program's or a test's
 *       (`tars-cli-update-cleanup-...`);
 *     - a name one character off mkdtemp's six;
 *     - a file with our name;
 *     - a symbolic link with our name, or what it points to;
 *  4. a leftover still read-only, as the failed removal found it, is never
 *     removed;
 *  5. a leftover the sweep cannot remove either stops the pass, or is said at
 *     every pass: it is said once;
 *  6. what the sweep removes goes unsaid in ~/.tars/cli-updates.log, the log
 *     that named the folder when it was left.
 * Not tested here: a folder that belongs to another user, which would take a
 * second account to make.
 *
 * The temp folder is the test's own (the context's tmpDir): nothing here
 * touches the system's.
 */

const IS_ROOT = process.getuid?.() === 0;

let root: string;
let tmp: string;
let log: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-scratch-sweep-test-')));
  tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  log = path.join(root, 'cli-updates.log');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // Whatever a test left read-only is made writable again, so that it can go.
  const unlock = (dir: string): void => {
    try { fs.chmodSync(dir, 0o755); } catch { return; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) unlock(path.join(dir, entry.name));
    }
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
});

function ctx(): CliUpdateContext {
  const home = path.join(root, 'home');
  return { home, logFile: log, tmpDir: tmp, env: { HOME: home, PATH: '/usr/bin:/bin' } } as CliUpdateContext;
}

/** A pass that checks nothing: amp, which no agent runs. The sweep is all it does besides. */
function pass() {
  return runCliUpdatePass([{ cli: 'amp', command: 'amp', inUse: false }], ctx());
}

function backdate(file: string, minutes: number): void {
  const at = new Date(Date.now() - minutes * 60_000);
  fs.lutimesSync(file, at, at);
}

/** A folder named as an update names its own, `minutes` old, with npm's cache in it. */
function leftover(name: string, minutes: number): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'npm-cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'npm-cache', 'index'), '');
  backdate(dir, minutes);
  return dir;
}

function linesNaming(dir: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes(dir)) : [];
}

describe('the scratch folders earlier updates could not remove', () => {
  it('1, 6. a leftover over an hour old goes at the next pass, and the log says so', async () => {
    const dir = leftover('tars-cli-update-a1B2c3', 120);

    await pass();

    expect(fs.existsSync(dir)).toBe(false);
    expect(linesNaming(dir)).toEqual([expect.stringMatching(/^\S+Z .*removed/)]);
  });

  it('2. a folder an update may still be using stays, and goes unsaid', async () => {
    const dir = leftover('tars-cli-update-g7H8i9', 30);

    await pass();

    expect(fs.existsSync(path.join(dir, 'npm-cache', 'index'))).toBe(true);
    expect(linesNaming(dir)).toEqual([]);
  });

  it('3. what is not one of our folders stays, however old', async () => {
    const kept = [
      leftover('tars-cli-update-cleanup-j0K1l2', 120),
      leftover('tars-cli-update-abcde', 120),
      leftover('tars-cli-update-abcdefg', 120),
    ];
    const file = path.join(tmp, 'tars-cli-update-m3N4o5');
    fs.writeFileSync(file, 'not a folder');
    backdate(file, 120);
    // The link and what it points to are both old: only the link's own kind keeps them.
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'keep'), 'keep');
    backdate(elsewhere, 120);
    // Only where this account may make a link (symlink-privilege.ts): the rest runs everywhere.
    const link = path.join(tmp, 'tars-cli-update-p6Q7r8');
    const linked = !cannotSymlink();
    if (linked) {
      fs.symlinkSync(elsewhere, link);
      backdate(link, 120);
    }

    await pass();

    for (const dir of kept) expect(fs.existsSync(path.join(dir, 'npm-cache', 'index')), dir).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('not a folder');
    if (linked) expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, 'keep'), 'utf8')).toBe('keep');
    if (hasPosixModes()) expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o755);
  });

  // Root removes it all the same, and a read-only folder on Windows still lets its children go.
  it.skipIf(IS_ROOT || process.platform === 'win32')('4. a leftover still read-only goes', async () => {
    const dir = leftover('tars-cli-update-d4E5f6', 120);
    fs.chmodSync(dir, 0o555);

    await pass();

    expect(fs.existsSync(dir)).toBe(false);
  });

  it.skipIf(IS_ROOT || process.platform === 'win32')('5. a leftover it cannot remove is said once, and the passes go on', async () => {
    const dir = leftover('tars-cli-update-s9T0u1', 120);
    fs.chmodSync(path.join(dir, 'npm-cache'), 0o555);

    const first = await pass();
    const second = await pass();

    for (const results of [first, second]) expect(results).toEqual([expect.objectContaining({ cli: 'amp', outcome: 'skipped' })]);
    expect(fs.existsSync(path.join(dir, 'npm-cache', 'index'))).toBe(true);
    expect(linesNaming(dir)).toHaveLength(1);
  });
});
