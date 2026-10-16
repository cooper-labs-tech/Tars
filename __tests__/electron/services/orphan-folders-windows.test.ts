import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const host = vi.hoisted(() => ({ lsofMissing: false }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  // Windows has no lsof: asked there, it is not found.
  const execFile = ((file: string, ...rest: unknown[]) => {
    if (file === 'lsof' && host.lsofMissing) {
      const done = rest[rest.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      setImmediate(() => done(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }), '', ''));
      return undefined;
    }
    return (actual.execFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFile;
  return { ...actual, execFile, default: { ...actual, execFile } };
});

import { listOrphanFolders, removeOrphanFolders } from '../../../electron/services/orphan-folders';
import { holdUnreadable, makeUnremovable } from '../../setup/file-access';

/**
 * The folders no agent owns, removed on Windows (the parity program's P7, R4).
 * The rest of their rules is orphan-folders.test.ts.
 *
 * Before a folder goes, macOS reads with lsof which process works in it, and
 * Linux with /proc. Windows has neither, so the processes could never be read
 * there, every folder was kept with its use unknown, and Settings · System
 * removed nothing. What Windows says instead is a refusal: it will not move a
 * folder while a program has a file open in it or works in it (Explorer's
 * "the folder or a file in it is open in another program").
 *
 * How it fails, written before the code (2026-10-17):
 * 1. On win32 nothing is ever removed: lsof is asked, there is none, and
 *    every folder is kept, its use unknown.
 * 2. On win32 a folder Windows refuses to move (a program holds a file in it,
 *    or works in it) is removed, in part or whole: it is kept whole, in use.
 * 3. A refusal of a moment (an antivirus scan holding a file) keeps a folder
 *    free a moment later; or a refusal that lasts is tried for ever.
 * 4. A folder moved aside that then cannot be removed stays under the name it
 *    was moved to, which the window never showed, or its reason names that
 *    name: it goes back under its own and says why, as elsewhere.
 * 5. A failure of the move that is no refusal (the folder gone, the name
 *    taken) is said to be a program's hold.
 * 6. The processes a reader names stop deciding on win32, before any move; or
 *    on darwin and linux a folder is moved, or a refusal to move keeps it.
 */

let root: string;
let project: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wts = (...parts: string[]) => path.join(project, '.worktrees', ...parts);
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const readAs = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...hostPlatform, value: platform });
const refusal = (code: string) => Object.assign(new Error(`${code}: rename`), { code });

function file(p: string, bytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 120));
}

/** The removal of what a listing just showed, as the window asks for it. */
async function removeShown(opts: Omit<Parameters<typeof removeOrphanFolders>[0], 'paths'>) {
  const shown = await listOrphanFolders({ projects: opts.projects, owned: opts.owned });
  return removeOrphanFolders({ ...opts, paths: shown.folders.map(f => f.path) });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-orphans-win-')));
  project = path.join(root, 'proj');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform);
  host.lsofMissing = false;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('on Windows', () => {
  it('1. removes a folder no program holds, without lsof', async () => {
    readAs('win32');
    host.lsofMissing = true;
    file(wts('idle', 'deep', 'x.bin'), 1000);
    const report = await removeShown({ projects: [project], owned: [] });
    expect(report.kept).toEqual([]);
    expect(report.removed).toBe(1);
    expect(fs.readdirSync(wts())).toEqual([]);
  });

  it('2, 3. keeps whole and in use a folder Windows will not move, after trying again for a while, not for ever', async () => {
    readAs('win32');
    host.lsofMissing = true;
    file(wts('busy', 'deep', 'x.bin'), 1000);
    const tries: number[] = [];
    const report = await removeShown({ projects: [project], owned: [], rename: () => { tries.push(Date.now()); throw refusal('EPERM'); } });
    expect(report.removed).toBe(0);
    expect(report.kept).toEqual([{ path: wts('busy'), project, reason: 'in-use', detail: expect.stringContaining('(EPERM)') }]);
    expect(fs.readFileSync(wts('busy', 'deep', 'x.bin'))).toHaveLength(1000);
    expect(tries.length).toBeGreaterThan(1);
    expect(tries.length).toBeLessThanOrEqual(10);
    expect(tries[tries.length - 1] - tries[0]).toBeLessThan(3_000);
  });

  it('3. removes a folder free a moment after a refusal', async () => {
    readAs('win32');
    host.lsofMissing = true;
    file(wts('scanned', 'x.bin'), 1000);
    let refusals = 2;
    const report = await removeShown({
      projects: [project], owned: [],
      rename: (from, to) => { if (refusals-- > 0) throw refusal('EBUSY'); fs.renameSync(from, to); },
    });
    expect(report.kept).toEqual([]);
    expect(report.removed).toBe(1);
    expect(fs.readdirSync(wts())).toEqual([]);
  });

  it('4. puts a folder it moved but could not remove back under its own name, and says why as elsewhere', async () => {
    file(wts('stuck', 'locked', 'f'), 10);
    // Made before the platform is read as win32: the helper picks the host's own way.
    const restore = makeUnremovable(wts('stuck', 'locked'), wts('stuck', 'locked', 'f'));
    readAs('win32');
    host.lsofMissing = true;
    try {
      const report = await removeShown({ projects: [project], owned: [] });
      const refused = hostPlatform.value === 'win32' ? 'EPERM' : 'EACCES';
      expect(report.kept).toEqual([{ path: wts('stuck'), project, reason: 'failed', detail: `${refused} on ${path.join('locked', 'f')}` }]);
      expect(fs.readdirSync(wts())).toEqual(['stuck']);
    } finally {
      restore();
    }
  });

  it('5. says a failure of the move that is no refusal as it is', async () => {
    readAs('win32');
    host.lsofMissing = true;
    file(wts('taken', 'x.bin'), 10);
    const report = await removeShown({ projects: [project], owned: [], rename: () => { throw refusal('EEXIST'); } });
    expect(report.kept).toEqual([{ path: wts('taken'), project, reason: 'failed', detail: 'EEXIST' }]);
    expect(fs.existsSync(wts('taken', 'x.bin'))).toBe(true);
  });

  it('6. keeps before any move a folder a process the reader names works in', async () => {
    readAs('win32');
    file(wts('busy', 'x.txt'), 10);
    const moved: string[] = [];
    const report = await removeShown({
      projects: [project], owned: [],
      processCwds: async () => [{ pid: 42, command: 'node', cwd: wts('busy') }],
      rename: (from) => { moved.push(from); },
    });
    expect(report.kept).toEqual([{ path: wts('busy'), project, reason: 'in-use', detail: 'node (42)' }]);
    expect(moved).toEqual([]);
  });

  // The premise itself, on a real Windows only: a program holding one file
  // deep in a folder, with no sharing, makes Windows refuse to move the folder.
  it.runIf(hostPlatform.value === 'win32')('2. keeps a folder a program really holds a file in, then removes it once let go', async () => {
    file(wts('held', 'deep', 'x.bin'), 1000);
    const release = await holdUnreadable(wts('held', 'deep', 'x.bin'));
    try {
      const report = await removeShown({ projects: [project], owned: [] });
      expect(report.kept).toEqual([{ path: wts('held'), project, reason: 'in-use', detail: expect.stringContaining('Windows') }]);
      expect(fs.existsSync(wts('held', 'deep', 'x.bin'))).toBe(true);
    } finally {
      await release();
    }
    expect((await removeShown({ projects: [project], owned: [] })).removed).toBe(1);
  });
});

describe.each(['darwin', 'linux'] as const)('on %s', (platform) => {
  it('6. moves nothing: the processes\' working folders decide, and a refusal to move counts for nothing', async () => {
    readAs(platform);
    file(wts('idle', 'x.txt'), 10);
    file(wts('busy', 'x.txt'), 10);
    const report = await removeShown({
      projects: [project], owned: [],
      processCwds: async () => [{ pid: 42, command: 'node', cwd: wts('busy') }],
      rename: () => { throw refusal('EPERM'); },
    });
    expect(report.removed).toBe(1);
    expect(report.kept).toEqual([{ path: wts('busy'), project, reason: 'in-use', detail: 'node (42)' }]);
    expect(fs.existsSync(wts('idle'))).toBe(false);
  });
});
