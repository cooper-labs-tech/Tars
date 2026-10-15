import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { coversHome, withoutHomeCover, isUnderSafeRoot } from '../../../electron/utils/home-root';

/**
 * Whether a folder taken as a file root is the home, or holds it.
 *
 * fs:read-text-file, fs:write-text-file, fs:read-project-files and
 * local-file:// confine a path to a list of roots, and the projects the user
 * added are roots (fs:read-project-files adds the agents' folders and the
 * folders Claude has seen). Nothing looked at what a project was: one equal to
 * the home, or to a folder above it (`/Users`, `/home`), made every file of the
 * home a file of a root, `~/.ssh`, `~/.tars-private` and the shell's startup
 * files included, and through fs:write-text-file a writable one.
 * ~/.dorothy/projects.json, which lists them, is under the directory every
 * agent is handed.
 *
 * How it can fail, written before the code (2026-09-28):
 * 1. The home itself is not caught: as spelled, with a trailing separator, or
 *    with a `.` segment.
 * 2. A folder above the home (`/Users`, `/`) is not caught.
 * 3. Another name for the home or a folder above it (a symlink, a
 *    case-insensitive volume, the Data volume's firmlink on macOS) is not
 *    caught: only the spelling is compared, where the device and inode tell.
 * 4. A project under the home, a sibling sharing the home's prefix
 *    (`/Users/demox` beside `/Users/demo`), or a folder on another branch is
 *    caught: the check refuses legitimate projects.
 * 5. A root, or a home, that cannot be read throws, where it is judged by its
 *    spelling alone.
 * 6. A file system that reports no inode (0 for every file) makes every folder
 *    on it look like the home.
 * 7. The home is itself a link (/home symlinked to /data/home): the folders
 *    above its REAL location are not caught, and each opens the whole home.
 * 8. Judging a list of roots stats a root the target is not under: one project
 *    on a share nobody answers for (a stat measured at 21 s on a Windows host,
 *    and a hung NFS mount blocks as long) freezes every call, on the main
 *    thread. Only the roots the target is under by spelling may be looked at.
 * 9. A target under a legitimate root is refused, or one allowed because it is
 *    under a root that covers the home.
 */

const made: string[] = [];
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A folder link. `junction` is read on Windows, where it needs no privilege, and ignored elsewhere. */
const linkDir = (to: string, at: string) => fs.symlinkSync(to, at, 'junction');

const ROOT = path.parse(process.cwd()).root;
const HOME = path.join(ROOT, 'Users', 'demo');
const noStat = () => undefined;

describe('coversHome, by spelling', () => {
  it('1. the home, as spelled, with a trailing separator or a . segment', () => {
    for (const p of [HOME, HOME + path.sep, HOME + path.sep + path.sep, HOME + path.sep + '.']) {
      expect(coversHome(p, { home: HOME, stat: noStat }), p).toBe(true);
    }
  });

  it('2. every folder above the home', () => {
    for (const p of [path.join(ROOT, 'Users'), path.join(ROOT, 'Users') + path.sep, ROOT]) {
      expect(coversHome(p, { home: HOME, stat: noStat }), p).toBe(true);
    }
  });

  it('4. a project under the home, a sibling sharing its prefix, another branch, nothing', () => {
    for (const p of [path.join(HOME, 'atlas'), `${HOME}x`, path.join(ROOT, 'opt'), '']) {
      expect(coversHome(p, { home: HOME, stat: noStat }), p).toBe(false);
    }
  });

  it('3. another name for the home or a folder above it: the same device and inode', () => {
    const ids: Record<string, { dev: bigint; ino: bigint }> = {
      [HOME]: { dev: BigInt(7), ino: BigInt(100) },
      [path.join(ROOT, 'Users')]: { dev: BigInt(7), ino: BigInt(50) },
      [ROOT]: { dev: BigInt(7), ino: BigInt(5) },
      [path.join(ROOT, 'Volumes', 'x', 'to-home')]: { dev: BigInt(7), ino: BigInt(100) },
      [path.join(ROOT, 'Volumes', 'x', 'to-users')]: { dev: BigInt(7), ino: BigInt(50) },
      [path.join(ROOT, 'Volumes', 'x', 'elsewhere')]: { dev: BigInt(7), ino: BigInt(999) },
      [path.join(ROOT, 'Volumes', 'y', 'same-ino')]: { dev: BigInt(8), ino: BigInt(100) },
    };
    const stat = (p: string) => ids[p];
    expect(coversHome(path.join(ROOT, 'Volumes', 'x', 'to-home'), { home: HOME, stat })).toBe(true);
    expect(coversHome(path.join(ROOT, 'Volumes', 'x', 'to-users'), { home: HOME, stat })).toBe(true);
    expect(coversHome(path.join(ROOT, 'Volumes', 'x', 'elsewhere'), { home: HOME, stat })).toBe(false);
    // The inode alone is not an identity: another device.
    expect(coversHome(path.join(ROOT, 'Volumes', 'y', 'same-ino'), { home: HOME, stat })).toBe(false);
  });

  it('6. an inode of 0 is no inode', () => {
    const stat = () => ({ dev: BigInt(7), ino: BigInt(0) });
    expect(coversHome(path.join(ROOT, 'Volumes', 'stick', 'project'), { home: HOME, stat })).toBe(false);
  });

  it('5. a root or a home that cannot be read is judged by spelling, and nothing throws', () => {
    const stat = () => { throw new Error('EACCES'); };
    const realpath = () => { throw new Error('EACCES'); };
    const x = path.join(ROOT, 'x');
    expect(() => coversHome(x, { home: HOME, stat, realpath })).not.toThrow();
    expect(coversHome(x, { home: HOME, stat, realpath })).toBe(false);
    expect(coversHome(path.join(ROOT, 'Users'), { home: HOME, stat, realpath })).toBe(true);
  });

  it('withoutHomeCover keeps the order of the roots it keeps', () => {
    const a = path.join(ROOT, 'a');
    const b = path.join(HOME, 'b');
    expect(withoutHomeCover([a, path.join(ROOT, 'Users'), b, HOME], { home: HOME, stat: noStat })).toEqual([a, b]);
  });
});

describe('coversHome, on this disk', () => {
  it('3. a link to the home, or to the folder above it, is the home', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-root-')));
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-link-')));
    made.push(home, box);
    fs.mkdirSync(path.join(home, 'projects', 'atlas'), { recursive: true });
    const link = path.join(box, 'to-home');
    const parentLink = path.join(box, 'to-parent');
    linkDir(home, link);
    linkDir(path.dirname(home), parentLink);

    expect(coversHome(link, { home })).toBe(true);
    expect(coversHome(parentLink, { home })).toBe(true);
    expect(coversHome(path.join(home, 'projects', 'atlas'), { home })).toBe(false);
    expect(coversHome(box, { home })).toBe(false);
  });
});

describe('7. a home that is itself a link', () => {
  it('refuses the folders above the real home, and the real home', () => {
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-moved-')));
    made.push(box);
    const realHome = path.join(box, 'data', 'home', 'demo');
    fs.mkdirSync(path.join(realHome, 'projects', 'atlas'), { recursive: true });
    fs.mkdirSync(path.join(box, 'data', 'other'), { recursive: true });
    const home = path.join(box, 'home-link');
    linkDir(realHome, home);
    const realParent = path.dirname(realHome);

    for (const root of [realHome, realParent, path.dirname(realParent)]) expect(coversHome(root, { home }), root).toBe(true);
    expect(coversHome(path.join(realHome, 'projects', 'atlas'), { home })).toBe(false);
    expect(coversHome(path.join(box, 'data', 'other'), { home })).toBe(false);
  });

  it('refuses them by identity when only the real path names them (injected)', () => {
    const real = path.join(ROOT, 'data', 'home', 'demo');
    const ids: Record<string, { dev: bigint; ino: bigint }> = {
      [HOME]: { dev: BigInt(1), ino: BigInt(10) },
      [path.join(ROOT, 'Users')]: { dev: BigInt(1), ino: BigInt(5) },
      [real]: { dev: BigInt(1), ino: BigInt(10) },
      [path.join(ROOT, 'data', 'home')]: { dev: BigInt(2), ino: BigInt(50) },
      [path.join(ROOT, 'data')]: { dev: BigInt(2), ino: BigInt(40) },
      [path.join(ROOT, 'mnt', 'to-real-parent')]: { dev: BigInt(2), ino: BigInt(50) },
    };
    const deps = { home: HOME, stat: (p: string) => ids[p], realpath: () => real };
    expect(coversHome(path.join(ROOT, 'data', 'home'), deps)).toBe(true);
    expect(coversHome(path.join(ROOT, 'data'), deps)).toBe(true);
    expect(coversHome(path.join(ROOT, 'mnt', 'to-real-parent'), deps)).toBe(true);
    expect(coversHome(path.join(real, 'atlas'), deps)).toBe(false);
  });
});

describe('isUnderSafeRoot', () => {
  const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
  const OFFLINE = path.join(ROOT, 'net', 'offline-nas', 'proj');

  it('8, 9. stats only the roots the target is under, and allows it under a legitimate one', () => {
    const statted: string[] = [];
    const stat = (p: string) => { statted.push(p); return { dev: BigInt(1), ino: BigInt(statted.length + 100) }; };
    const roots = [OFFLINE, path.join(HOME, 'projects', 'atlas')];

    const allowed = isUnderSafeRoot(path.join(HOME, 'projects', 'atlas', 'CLAUDE.md'), roots, inside, { home: HOME, stat, realpath: (p: string) => p });

    expect(allowed).toBe(true);
    expect(statted.filter(p => p.startsWith(OFFLINE))).toEqual([]);
  });

  it('9. refuses a target whose only root covers the home, and one under no root', () => {
    expect(isUnderSafeRoot(path.join(HOME, '.ssh', 'id_rsa'), [path.join(ROOT, 'Users')], inside, { home: HOME, stat: noStat })).toBe(false);
    expect(isUnderSafeRoot(path.join(HOME, '.ssh', 'id_rsa'), [HOME], inside, { home: HOME, stat: noStat })).toBe(false);
    expect(isUnderSafeRoot(path.join(ROOT, 'x'), [path.join(ROOT, 'a')], inside, { home: HOME, stat: noStat })).toBe(false);
  });
});
