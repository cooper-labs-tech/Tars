/**
 * An account's folder on Windows (electron/services/claude-accounts/provision.ts;
 * the parity program's P6, the plumbing behind the gate that still keeps the
 * accounts off there, platform/claude-accounts.ts). The rules themselves are
 * provision.test.ts, which runs where the folders are POSIX.
 *
 * On Windows a mode does nothing (0o700 sets no access list), a uid is not
 * an owner, and a symbolic link needs Developer Mode or an administrator.
 *
 * How it fails, written before the code (2026-10-17):
 * 1. A folder Tars makes is left with the access list its parent hands down:
 *    it is closed to every account but this user's (ownerOnlyDirSync) before
 *    anything is written in it.
 * 2. A folder is checked by its mode and uid, meaningless there, or not at
 *    all: one open to other accounts, or whose list cannot be read, is written
 *    into. It is read by its access list (ownerOnlyDirProblemSync), refused,
 *    and never repaired.
 * 3. A shared folder (projects/, sessions/, skills/...) is joined with a
 *    symbolic link, which Windows refuses without the privilege, so the
 *    account keeps transcripts of its own: a junction, which needs none.
 * 4. A shared file (history.jsonl, CLAUDE.md) gets nothing without the
 *    privilege: a symbolic link when Windows allows one, else a hard link to
 *    the same file.
 * 5. At the next launch, a junction or a hard link Tars made is taken for
 *    something real and reported, or made again; a junction that points
 *    elsewhere is not repointed; a hard link that is no longer the same file
 *    (the original replaced since) is taken as Tars's own: it is reported.
 * 6. darwin and linux change: their folders are made by mode and joined by
 *    symbolic links, as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cannotSymlink } from '../../setup/symlink-privilege';

const acl = vi.hoisted(() => ({ closed: [] as string[], problem: null as string | null, read: [] as string[] }));
vi.mock('../../../electron/platform/owner-only', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../electron/platform/owner-only')>();
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...real,
    // What ownerOnlyDirSync does there, the access list aside: made (0o700, as it does), then closed.
    ownerOnlyDirSync: (dir: string) => {
      if (process.platform !== 'win32') return 'skipped';
      acl.closed.push(dir);
      realFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return 'restricted';
    },
    ownerOnlyDirProblemSync: (dir: string) => {
      if (process.platform !== 'win32') return null;
      acl.read.push(dir);
      return acl.problem;
    },
  };
});

const links = vi.hoisted(() => ({ types: [] as { link: string; type?: string }[], noSymbolicFiles: false }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const symlinkSync = (target: string, link: string, type?: string) => {
    links.types.push({ link, type });
    // Windows without Developer Mode: no symbolic link, a junction still allowed.
    if (links.noSymbolicFiles && type !== 'junction') throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${link}'`), { code: 'EPERM' });
    return real.symlinkSync(target, link);
  };
  return { ...real, symlinkSync, default: { ...real, symlinkSync } };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { provisionAccountDir } from '../../../electron/services/claude-accounts/provision';

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const readAs = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...hostPlatform, value: platform });

let home: string;
let claudeDir: string;
let dir: string;
let n = 0;

beforeEach(() => {
  home = fs.realpathSync(os.homedir());
  claudeDir = path.join(home, '.claude');
  dir = path.join(home, '.claude-accounts', `acct-${(0xb00000 + n++).toString(16)}`);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'the user\'s own\n');
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  acl.closed.length = 0;
  acl.read.length = 0;
  acl.problem = null;
  links.types.length = 0;
  links.noSymbolicFiles = false;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform);
});

const sameFile = (a: string, b: string) => {
  const x = fs.statSync(a, { bigint: true });
  const y = fs.statSync(b, { bigint: true });
  return x.ino === y.ino && x.dev === y.dev;
};

describe('an account folder on Windows', () => {
  it('1, 2. is made closed by its access list, and read by it before anything is written', () => {
    readAs('win32');
    provisionAccountDir(dir, home);
    expect(acl.closed).toEqual([path.join(home, '.claude-accounts'), dir]);
    expect(acl.read).toEqual([path.join(home, '.claude-accounts'), dir]);
    expect(fs.existsSync(path.join(dir, '.claude.json'))).toBe(true);
  });

  it('2. is refused when its access list leaves it open, or cannot be read, and is not repaired', () => {
    readAs('win32');
    fs.mkdirSync(dir, { recursive: true });
    for (const problem of ['is open to other users', 'could not be read: Windows did not give its access list (exit 1)']) {
      acl.problem = problem;
      acl.closed.length = 0;
      expect(() => provisionAccountDir(dir, home)).toThrow(problem);
      expect(acl.closed).not.toContain(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });
});

describe('what is shared, on Windows', () => {
  it('3. joins a shared folder with a junction', () => {
    readAs('win32');
    provisionAccountDir(dir, home);
    for (const name of ['projects', 'sessions', 'skills']) {
      expect(links.types).toContainEqual({ link: path.join(dir, name), type: 'junction' });
    }
  });

  it('4. links a shared file symbolically when Windows allows it, else hard: the same file either way', () => {
    readAs('win32');
    provisionAccountDir(dir, home);
    // A Windows host without the privilege makes the hard link here too.
    if (!cannotSymlink()) expect(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(sameFile(path.join(dir, 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'))).toBe(true);

    links.noSymbolicFiles = true;
    const other = path.join(home, '.claude-accounts', `acct-${(0xb00000 + n++).toString(16)}`);
    const report = provisionAccountDir(other, home);
    expect(report.conflicts).toEqual([]);
    for (const name of ['CLAUDE.md', 'history.jsonl']) {
      expect(fs.lstatSync(path.join(other, name)).isSymbolicLink()).toBe(false);
      expect(sameFile(path.join(other, name), path.join(claudeDir, name))).toBe(true);
    }
    fs.appendFileSync(path.join(other, 'history.jsonl'), '{"display":"through the account"}\n');
    expect(fs.readFileSync(path.join(claudeDir, 'history.jsonl'), 'utf8')).toContain('through the account');
  });

  it('5. keeps its own junctions and hard links at the next launch, and repoints a junction that points elsewhere', () => {
    readAs('win32');
    links.noSymbolicFiles = true;
    provisionAccountDir(dir, home);
    const before = fs.statSync(path.join(dir, 'CLAUDE.md'), { bigint: true }).ino;
    links.types.length = 0;
    expect(provisionAccountDir(dir, home).conflicts).toEqual([]);
    expect(links.types).toEqual([]);
    expect(fs.statSync(path.join(dir, 'CLAUDE.md'), { bigint: true }).ino).toBe(before);

    const elsewhere = path.join(home, 'elsewhere-skills');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.unlinkSync(path.join(dir, 'skills'));
    fs.symlinkSync(elsewhere, path.join(dir, 'skills'), 'junction');
    expect(provisionAccountDir(dir, home).conflicts).toEqual([]);
    expect(fs.realpathSync(path.join(dir, 'skills'))).toBe(fs.realpathSync(path.join(claudeDir, 'skills')));

    // Windows may give a junction's target back in another spelling: a trailing separator, say.
    fs.unlinkSync(path.join(dir, 'projects'));
    fs.symlinkSync(`${path.join(claudeDir, 'projects')}${path.sep}`, path.join(dir, 'projects'), 'junction');
    links.types.length = 0;
    expect(provisionAccountDir(dir, home).conflicts).toEqual([]);
    expect(links.types).toEqual([]);
  });

  it('5. reports a hard link that is no longer the same file, and leaves it', () => {
    readAs('win32');
    links.noSymbolicFiles = true;
    provisionAccountDir(dir, home);
    // An editor that saves by writing a new file over the old one.
    const fresh = path.join(claudeDir, 'CLAUDE.md.new');
    fs.writeFileSync(fresh, 'edited\n');
    fs.renameSync(fresh, path.join(claudeDir, 'CLAUDE.md'));
    expect(provisionAccountDir(dir, home).conflicts).toEqual(['CLAUDE.md']);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('the user\'s own\n');
  });
});

// Where a mode is a mode: a Windows host has none to read.
describe.skipIf(hostPlatform.value === 'win32').each(['darwin', 'linux'] as const)('on %s', (platform) => {
  it('6. makes the folder by its mode, reads no access list, and joins by symbolic links', () => {
    readAs(platform);
    provisionAccountDir(dir, home);
    expect(acl.closed).toEqual([]);
    expect(acl.read).toEqual([]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(links.types.every((l) => l.type === undefined)).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });
});
