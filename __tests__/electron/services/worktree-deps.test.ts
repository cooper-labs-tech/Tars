/**
 * An agent's new worktree gets its project's dependencies as a clone (JeanBrasse's
 * choice 17, 05/10): `cp -c` on APFS shares every block, 9.8 s and about 65 MB
 * of real space for a 1.2 GB node_modules (measured 01/10 for
 * scripts/worktree.mjs), where an agent ran its own `npm ci` into each
 * worktree and filled the disk (46 GB in .worktrees on 01/10).
 * (electron/services/worktree-deps.ts, agent:create and agent:update)
 *
 * How it fails, written before the code (2026-10-05):
 * 1. The worktree gets no node_modules, or only the root's: a project with
 *    packages of its own (mcp-*, landing) has one per package.json.
 * 2. A node_modules installed for another lock is cloned: the agent then
 *    runs on dependencies its package-lock.json does not name.
 * 3. A worktree that already has a node_modules is written over.
 * 4. A clone that fails leaves half a node_modules behind, or throws: the
 *    worktree must be as it was, the agent installs as before, and the reason
 *    is given.
 * 5. A project's node_modules that is a link is followed out of the project.
 * 6. A system that cannot clone (no APFS, no reflink) copies the whole tree,
 *    gigabytes per worktree: it must clone or do nothing.
 * And from the gates of #325 (05/10):
 * 7. (QA) On macOS `cp -c -R` onto a volume that is not APFS makes a full copy
 *    and exits 0 (measured on an HFS+ disk image): the volume of both ends
 *    must be APFS, and the same one, before the clone is tried.
 * 8. (Audit) A committed link at <package>/node_modules that points nowhere is
 *    read as absent, and the failure branch then deletes it: anything there,
 *    a link included, is left alone.
 * And on Windows (the parity program's P7, R5, 2026-10-17), where there is no
 * cp -c: Windows 11 24H2 clones a file's blocks when CopyFile copies it within
 * one ReFS volume (a Dev Drive), and Node's fs.cp copies each file with it.
 * 9. On win32 nothing is ever cloned, a Dev Drive included.
 * 10. On win32 a copy is made where it would not share blocks, gigabytes per
 *    worktree: before Windows 11 24H2, on NTFS or a file system that cannot be
 *    read, across two volumes, on a volume mounted in a folder (the drive's own
 *    file system is not its), or on a path with no drive. It clones or does
 *    nothing (6).
 * 11. The copy follows a link inside node_modules (a workspace's junction, an
 *    npm link) and copies what it points to, where cp -R keeps the link.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cloneDependencies, cloneArgs, windowsClone, windowsDriveFormat, type WindowsCloneFacts } from '../../../electron/services/worktree-deps';
import { cannotSymlink } from '../../setup/symlink-privilege';

let root: string;
let project: string;
let worktree: string;

function pkg(dir: string, deps: Record<string, string>, installed: Record<string, string> | null): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), dependencies: deps }));
  const packages: Record<string, unknown> = { '': { name: path.basename(dir) } };
  for (const [name, version] of Object.entries(deps)) packages[`node_modules/${name}`] = { version };
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  if (installed) {
    const nm = path.join(dir, 'node_modules');
    const recorded: Record<string, unknown> = {};
    for (const [name, version] of Object.entries(installed)) {
      fs.mkdirSync(path.join(nm, name), { recursive: true });
      fs.writeFileSync(path.join(nm, name, 'index.js'), `module.exports = '${version}';\n`);
      recorded[`node_modules/${name}`] = { version };
    }
    fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: recorded }));
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-deps-')));
  project = path.join(root, 'project');
  worktree = path.join(project, '.worktrees', 'feat-x');
  pkg(project, { left: '1.0.0' }, { left: '1.0.0' });
  pkg(path.join(project, 'mcp-x'), { right: '2.0.0' }, { right: '2.0.0' });
  // The worktree as git checks it out: the tracked files, no node_modules.
  pkg(worktree, { left: '1.0.0' }, null);
  pkg(path.join(worktree, 'mcp-x'), { right: '2.0.0' }, null);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const cloneable = process.platform === 'darwin' || process.platform === 'linux';

describe("a new worktree's dependencies", () => {
  it.runIf(cloneable)('1. each package gets its node_modules from the project, root and sub-packages alike', async () => {
    const result = await cloneDependencies(project, worktree);
    // A file system that cannot clone (tmpfs, ext4) skips both, with its reason: 6.
    if (result.skipped.some(s => /clone/.test(s.why))) return;
    expect(result.cloned.sort()).toEqual(['', 'mcp-x']);
    expect(fs.readFileSync(path.join(worktree, 'node_modules', 'left', 'index.js'), 'utf8')).toContain('1.0.0');
    expect(fs.readFileSync(path.join(worktree, 'mcp-x', 'node_modules', 'right', 'index.js'), 'utf8')).toContain('2.0.0');
  });

  it('2. a node_modules installed for another lock is not cloned', async () => {
    pkg(worktree, { left: '1.1.0' }, null);
    const result = await cloneDependencies(project, worktree, { copy: async () => undefined });
    expect(result.cloned).not.toContain('');
    expect(result.skipped).toContainEqual({ dir: '', why: expect.stringMatching(/lock/) });
  });

  it("2. nor one whose package has the lock's version but another integrity", async () => {
    const lockPath = path.join(worktree, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/left'].integrity = 'sha512-wanted';
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const installedPath = path.join(project, 'node_modules', '.package-lock.json');
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    installed.packages['node_modules/left'].integrity = 'sha512-other';
    fs.writeFileSync(installedPath, JSON.stringify(installed));
    const result = await cloneDependencies(project, worktree, { copy: async () => undefined });
    expect(result.cloned).not.toContain('');
  });

  it('3. a worktree that has its node_modules keeps it', async () => {
    fs.mkdirSync(path.join(worktree, 'node_modules', 'mine'), { recursive: true });
    const copied: string[] = [];
    const result = await cloneDependencies(project, worktree, { copy: async (_s, d) => { copied.push(d); } });
    expect(copied).not.toContain(path.join(worktree, 'node_modules'));
    expect(result.cloned).not.toContain('');
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'mine'))).toBe(true);
  });

  it('4. a clone that fails leaves nothing behind and says why', async () => {
    const result = await cloneDependencies(project, worktree, {
      copy: async (_source, target) => {
        fs.mkdirSync(path.join(target, 'half'), { recursive: true });
        throw new Error('cp: clonefile failed');
      },
    });
    expect(result.cloned).toEqual([]);
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, 'mcp-x', 'node_modules'))).toBe(false);
    expect(result.skipped).toContainEqual({ dir: '', why: expect.stringContaining('clonefile failed') });
  });

  it.skipIf(cannotSymlink())('5. a node_modules that is a link is not followed', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.renameSync(path.join(project, 'node_modules'), elsewhere);
    fs.symlinkSync(elsewhere, path.join(project, 'node_modules'));
    const copied: string[] = [];
    await cloneDependencies(project, worktree, { copy: async s => { copied.push(s); } });
    expect(copied).not.toContain(path.join(project, 'node_modules'));
  });

  it.skipIf(cannotSymlink())('8. leaves a link at the worktree\'s node_modules alone, even one that points nowhere', async () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(worktree, 'node_modules'));
    const copied: string[] = [];
    await cloneDependencies(project, worktree, { copy: async (_s, d) => { copied.push(d); throw new Error('no'); } });
    expect(copied).not.toContain(path.join(worktree, 'node_modules'));
    expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('7. copies nothing onto a volume that is not APFS, where cp -c would copy in full', async () => {
    const dmg = path.join(root, 'hfs.dmg');
    const mnt = path.join(root, 'mnt');
    fs.mkdirSync(mnt);
    execFileSync('hdiutil', ['create', '-size', '20m', '-fs', 'HFS+', '-volname', 'tarsdeps', '-quiet', dmg]);
    execFileSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mnt, dmg]);
    try {
      const onHfs = path.join(mnt, 'feat-x');
      pkg(onHfs, { left: '1.0.0' }, null);
      const result = await cloneDependencies(project, onHfs);
      expect(fs.existsSync(path.join(onHfs, 'node_modules'))).toBe(false);
      expect(result.cloned).toEqual([]);
      expect(result.skipped).toContainEqual({ dir: '', why: expect.stringMatching(/APFS/) });
    } finally {
      execFileSync('hdiutil', ['detach', '-quiet', mnt]);
    }
  }, 60_000);

  it('6. clones or does nothing: never a plain copy', () => {
    expect(cloneArgs('darwin', '/a', '/b')).toEqual(['-c', '-R', '/a', '/b']);
    expect(cloneArgs('linux', '/a', '/b')).toEqual(['-R', '--reflink=always', '/a', '/b']);
    expect(cloneArgs('win32', '/a', '/b')).toBeNull();
  });
});

describe("on Windows (the parity program's P7, R5)", () => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform); });

  /** A Dev Drive: Windows 11 24H2, one ReFS volume with a drive letter of its own. */
  const devDrive: WindowsCloneFacts = { release: () => '10.0.26100', rootOf: () => 'D:\\', devOf: () => 7, driveFormat: async () => 'ReFS' };
  const cloneOn = (facts: Partial<WindowsCloneFacts>) =>
    cloneDependencies(project, worktree, { copy: (source, target) => windowsClone(source, target, { ...devDrive, ...facts }) });

  it('9. a Dev Drive on Windows 11 24H2 or later gets each package\'s clone', async () => {
    const result = await cloneOn({});
    expect(result.cloned.sort()).toEqual(['', 'mcp-x']);
    expect(fs.readFileSync(path.join(worktree, 'node_modules', 'left', 'index.js'), 'utf8')).toContain('1.0.0');
    expect(fs.readFileSync(path.join(worktree, 'mcp-x', 'node_modules', 'right', 'index.js'), 'utf8')).toContain('2.0.0');
  });

  it.skipIf(cannotSymlink())('11. a link inside node_modules is copied as the link it is', async () => {
    const linked = path.join(root, 'linked-pkg');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, 'index.js'), 'linked');
    fs.symlinkSync(linked, path.join(project, 'node_modules', 'linked'), 'junction');
    await cloneOn({});
    expect(fs.lstatSync(path.join(worktree, 'node_modules', 'linked')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(worktree, 'node_modules', 'linked'))).toBe(fs.realpathSync(linked));
  });

  it.each([
    ['Windows 11 23H2', { release: () => '10.0.22631' }, /24H2/],
    ['Windows 10', { release: () => '10.0.19045' }, /24H2/],
    ['NTFS', { driveFormat: async () => 'NTFS' }, /not ReFS \(NTFS\)/],
    ['a file system it cannot read', { driveFormat: async () => undefined }, /not ReFS \(unknown\)/],
    ['two volumes', { devOf: (p: string) => (p.startsWith(worktree) ? 8 : 7) }, /another volume/],
    ['a volume mounted in a folder', { devOf: (p: string) => (p === 'D:\\' ? 9 : 7) }, /mounted in a folder/],
    ['no drive letter', { rootOf: () => '\\\\server\\share\\' }, /not on a drive/],
  ] as Array<[string, Partial<WindowsCloneFacts>, RegExp]>)('10. copies nothing where blocks would not be shared: %s', async (_name, facts, why) => {
    const result = await cloneOn(facts);
    expect(result.cloned).toEqual([]);
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false);
    expect(result.skipped).toContainEqual({ dir: '', why: expect.stringMatching(why) });
  });

  it.skipIf(hostPlatform.value === 'win32')('9. on win32 the copier asks Windows, not cp', async () => {
    Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'win32' });
    // This host is no Windows 11 24H2: the clone is refused, by Windows's rule.
    const result = await cloneDependencies(project, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.skipped).toContainEqual({ dir: '', why: expect.stringMatching(/24H2/) });
  });

  it.runIf(hostPlatform.value === 'win32')('10. reads the real drive\'s file system, and clones only where it shares blocks', async () => {
    expect(await windowsDriveFormat(path.win32.parse(root).root)).toMatch(/^(NTFS|ReFS|FAT32|exFAT)$/);
    const result = await cloneDependencies(project, worktree);
    if (result.cloned.length) return;
    expect(result.skipped).toContainEqual({ dir: '', why: expect.stringMatching(/24H2|not ReFS \((NTFS|FAT32|exFAT)\)|another volume|mounted/) });
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false);
  });
});
