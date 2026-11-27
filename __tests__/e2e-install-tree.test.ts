import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installTree, treeChanges } from '../e2e/install-tree.mjs';

/**
 * installTree and treeChanges: the state of the account's own Hermes install before and after the opt-in run on the
 * real binary (e2e/hermes-agent.spec.ts). That run executes the installed Hermes (its checkout and bundled Python in
 * ~/.hermes), and on 27/11 two runs left 106 bytecode files in its checkout: the spec must say any file of the install
 * the run wrote, the same idea as #664's hashes of the real home.
 *
 * Every way it can fail, written down before the module:
 * 1. a file the run added (a __pycache__/*.pyc) not reported;
 * 2. a file changed in place, by its size or its modification time, not reported;
 * 3. a file removed not reported;
 * 4. an unchanged tree reported as changed;
 * 5. a link followed: a link to a folder outside walked as the install's (a link to / would walk the disk), or a loop
 *    hanging the walk; a link is one entry, by its own size and time;
 * 6. a folder of the list that does not exist throwing, instead of counting as empty (one appearing is reported);
 * 7. a report that does not say what happened to which file, by its path.
 */

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-tree-'));
  dir = path.join(tmp, 'install');
  fs.mkdirSync(path.join(dir, 'hermes_cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hermes_cli', 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the install\'s tree', () => {
  it('4: an unchanged tree reports nothing', () => {
    expect(treeChanges(installTree([dir]), installTree([dir]))).toEqual([]);
  });

  it('1 and 7: a file added is reported, by its path', () => {
    const before = installTree([dir]);
    fs.mkdirSync(path.join(dir, 'hermes_cli', '__pycache__'));
    fs.writeFileSync(path.join(dir, 'hermes_cli', '__pycache__', 'main.cpython-314.pyc'), 'x');
    expect(treeChanges(before, installTree([dir]))).toEqual([`added ${path.join(dir, 'hermes_cli', '__pycache__', 'main.cpython-314.pyc')}`]);
  });

  it('2: a file changed in place is reported, by its size or by its time', () => {
    const before = installTree([dir]);
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme, longer\n');
    expect(treeChanges(before, installTree([dir]))).toEqual([`changed ${path.join(dir, 'README.md')}`]);
    const again = installTree([dir]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'README.md'), later, later);
    expect(treeChanges(again, installTree([dir]))).toEqual([`changed ${path.join(dir, 'README.md')}`]);
  });

  it('3: a file removed is reported', () => {
    const before = installTree([dir]);
    fs.rmSync(path.join(dir, 'README.md'));
    expect(treeChanges(before, installTree([dir]))).toEqual([`removed ${path.join(dir, 'README.md')}`]);
  });

  it.skipIf(process.platform === 'win32')('5: a link is one entry, never walked, a loop included', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'big.bin'), 'x');
    fs.symlinkSync(outside, path.join(dir, 'to-outside'));
    fs.symlinkSync(dir, path.join(dir, 'hermes_cli', 'loop'));
    const tree = installTree([dir]);
    expect([...tree.keys()].sort()).toEqual([
      path.join(dir, 'README.md'), path.join(dir, 'hermes_cli', 'loop'), path.join(dir, 'hermes_cli', 'main.py'), path.join(dir, 'to-outside'),
    ].sort());
    fs.writeFileSync(path.join(outside, 'more.bin'), 'y');
    expect(treeChanges(tree, installTree([dir])), 'a change outside, through a link').toEqual([]);
  });

  it('6: a folder that does not exist counts as empty, and one appearing is reported', () => {
    const missing = path.join(tmp, 'tools');
    const before = installTree([dir, missing]);
    fs.mkdirSync(missing);
    fs.writeFileSync(path.join(missing, 'python3'), 'bin');
    expect(treeChanges(before, installTree([dir, missing]))).toEqual([`added ${path.join(missing, 'python3')}`]);
  });
});
