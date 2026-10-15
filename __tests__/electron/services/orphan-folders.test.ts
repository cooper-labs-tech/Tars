/**
 * The folders no agent owns (JeanBrasse's choice 16 of 05/10; the frames merged in
 * #315, "Settings · System · folders no agent owns"): the folders under a
 * project's .worktrees that no git worktree holds, listed with their size and
 * last change, and removed only when the window says so, one at a time.
 * (electron/services/orphan-folders.ts)
 *
 * How it fails, written before the code (2026-10-06):
 * 1. A folder git still lists as a worktree, or one an agent works in, is
 *    listed: removing it would take a live worktree.
 * 2. A folder whose .git points to a gitdir that is gone (git forgot it), or
 *    one with no .git at all, is missed.
 * 3. A folder that only holds worktrees (`.worktrees/feat/` for a branch
 *    `feat/x`) is listed whole, live worktrees and all; or one that holds
 *    forgotten worktrees hides them.
 * 4. Anything outside a project's .worktrees is listed, or a link is
 *    followed out of it.
 * 5. A size or a last change is wrong, or the totals are not the sum.
 * 6. The removal takes what the window was shown rather than what is true at
 *    that moment (a folder git took back since, one an agent took), a folder
 *    a process works in, or follows a link.
 * 7. The progress is not told per folder, the space given back is wrong, or a
 *    folder is kept without saying why.
 * 8. The processes cannot be read, and the folders are removed anyway.
 * 9. The disk's free and total space are not the disk's, or the floor is not
 *    30 GB.
 * And from the Audit's gate of #334 (NOT AS IS, bench gate-334/) and QA's Low:
 * the code took "absent from this project's `git worktree list`" for an
 * orphan, and never read the folder's own .git. Each of these lost real work:
 * 10. (H1) `git worktree list` fails (spawn under memory pressure, xcrun after
 *     an update, safe.directory), and every live worktree is listed
 *     git-forgot, then removed.
 * 11. (H2, QA) A repository of its own (its .git a folder: a clone, a git init)
 *     is listed and removed, its unpushed commits with it; or a .git file that
 *     cannot be read as a gitdir is taken for a forgotten one.
 * 12. (H2) A live worktree of another repository (its gitdir there, alive) is
 *     listed and removed.
 * 13. (M1) A repository two levels or more under a folder with no .git goes
 *     with that folder; or one too deep to look through is listed whole.
 * 14. (L1) The processes are read once, before a removal that can last
 *     minutes: one that starts in a folder meanwhile is not seen.
 * 15. (L2) On Linux, processes that cannot be read count as none, where
 *     macOS keeps every folder.
 * And from the Frontend (06/10), on 10's fix:
 * 16. A project whose git cannot list its worktrees offers nothing, and the
 *     listing does not say so: the window reads an empty listing as "every
 *     folder belongs to a worktree git knows", which is false for it. Or one
 *     such project hides the folders of the others.
 * And from the Audit's recheck of 4e939d5c (Lows):
 * 17. A repository inside a node_modules (a package cloned there, `npm link`'s
 *     target checked out in place) goes with its folder: the search for a
 *     .git below skips node_modules whole.
 * 18. A folder below an orphan that cannot be read, or more to look through
 *     than the search's bound, is taken for nothing and the orphan offered.
 * And from the Audit's gate of #336, main's half:
 * 19. (M1) The removal takes what main finds then, not what the window showed
 *     and the person confirmed: a folder that became an orphan while Settings
 *     stayed open goes unseen. Or a path the window names that is not an
 *     orphan now (a live worktree, anything else) is removed; or an empty
 *     list removes anything.
 * 20. (M2) A folder that could not be removed says why with Node's message,
 *     which carries its absolute path, the home folder included, to the
 *     window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  listOrphanFolders, removeOrphanFolders, diskSpace, DISK_FLOOR_BYTES, procCwds,
} from '../../../electron/services/orphan-folders';
import { cannotSymlink } from '../../setup/symlink-privilege';
import { makeUnreadable } from '../../setup/file-access';

let root: string;
let project: string;
let wt: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A file of `bytes` bytes, last changed at `when`. */
function file(p: string, bytes: number, when?: Date): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 120));
  if (when) fs.utimesSync(p, when, when);
}

/**
 * `file` in `folder` cannot be removed. macOS and Linux: the folder at 0555,
 * as this test always did. Windows has no mode bits, and a read-only folder
 * still lets its children go: there access control entries deny this account
 * deleting the file and the folder deleting its children, since either one
 * alone still lets the file go (measured 2026-10-07). The failure there is
 * EPERM where POSIX says EACCES.
 */
function makeUnremovable(folder: string, file: string): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(folder, 0o555);
    return () => fs.chmodSync(folder, 0o755);
  }
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const account = os.userInfo().username;
  execFileSync(icacls, [file, '/deny', `${account}:(DE)`], { stdio: 'pipe' });
  execFileSync(icacls, [folder, '/deny', `${account}:(DC)`], { stdio: 'pipe' });
  return () => {
    execFileSync(icacls, [folder, '/remove:d', account], { stdio: 'pipe' });
    execFileSync(icacls, [file, '/remove:d', account], { stdio: 'pipe' });
  };
}

/** A worktree git made, then forgot: its .git points to a gitdir that is gone. */
function forgotten(p: string): void {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, '.git'), `gitdir: ${path.join(project, '.git', 'worktrees', path.basename(p) + '-gone')}\n`);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-orphans-')));
  project = path.join(root, 'tars-hermes');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  // A live worktree git knows, nested as a branch name nests it.
  wt = path.join(project, '.worktrees', 'feat', 'live');
  git(project, 'worktree', 'add', '-q', wt, '-b', 'feat/live');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const old = new Date('2026-05-01T10:00:00Z');

/** The removal of what a listing just showed, as the window asks for it. */
async function removeShown(opts: Omit<Parameters<typeof removeOrphanFolders>[0], 'paths'>) {
  const shown = await listOrphanFolders({ projects: opts.projects, owned: opts.owned });
  return removeOrphanFolders({ ...opts, paths: shown.folders.map(f => f.path) } as Parameters<typeof removeOrphanFolders>[0]);
}

describe('listing', () => {
  it('1, 2, 3. lists what git forgot and what has no .git, never a live worktree, an agent\'s, or a folder that holds them', async () => {
    forgotten(path.join(project, '.worktrees', 'feat-relay-retry'));
    file(path.join(project, '.worktrees', 'feat-relay-retry', 'node_modules', 'x', 'index.js'), 4096, old);
    file(path.join(project, '.worktrees', 'agent-7f3c1a', 'notes.md'), 1024, old);
    forgotten(path.join(project, '.worktrees', 'feat', 'gone'));
    const agentOwned = path.join(project, '.worktrees', 'agent-owned');
    file(path.join(agentOwned, 'work.txt'), 10);

    const listing = await listOrphanFolders({ projects: [project], owned: [agentOwned] });
    const byName = Object.fromEntries(listing.folders.map(f => [f.name, f]));

    expect(Object.keys(byName).sort()).toEqual(['agent-7f3c1a', 'feat-relay-retry', path.join('feat', 'gone')].sort());
    expect(byName['feat-relay-retry']).toMatchObject({ project, reason: 'git-forgot', path: path.join(project, '.worktrees', 'feat-relay-retry') });
    expect(byName['agent-7f3c1a'].reason).toBe('no-git');
    expect(byName[path.join('feat', 'gone')].reason).toBe('git-forgot');
  });

  it('3. never lists a folder that holds a live worktree two levels down', async () => {
    const deep = path.join(project, '.worktrees', 'team', 'feat', 'deep');
    git(project, 'worktree', 'add', '-q', deep, '-b', 'team/feat/deep');
    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual([]);
  });

  it('4. lists nothing outside .worktrees, and follows no link out of it', async () => {
    const outside = path.join(root, 'outside');
    file(path.join(outside, 'precious.txt'), 10);
    fs.mkdirSync(path.join(project, '.worktrees'), { recursive: true });
    // Only where this account may make a link (symlink-privilege.ts): what is outside .worktrees is checked everywhere.
    if (!cannotSymlink()) fs.symlinkSync(outside, path.join(project, '.worktrees', 'a-link'));
    file(path.join(project, 'not-a-worktree', 'x.txt'), 10);
    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual([]);
  });

  it('5. says each folder\'s size and last change, and the totals', async () => {
    forgotten(path.join(project, '.worktrees', 'one'));
    file(path.join(project, '.worktrees', 'one', 'big.bin'), 300_000, old);
    file(path.join(project, '.worktrees', 'two', 'small.bin'), 100_000, new Date('2026-06-01T10:00:00Z'));
    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    const one = listing.folders.find(f => f.name === 'one')!;
    const two = listing.folders.find(f => f.name === 'two')!;
    expect(one.sizeBytes).toBeGreaterThanOrEqual(300_000);
    expect(two.sizeBytes).toBeGreaterThanOrEqual(100_000);
    expect(two.sizeBytes).toBeLessThan(one.sizeBytes);
    expect(two.lastChangedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(listing).toMatchObject({ count: 2, totalBytes: one.sizeBytes + two.sizeBytes });
  });
});

describe('removing them all', () => {
  const noProcess = async () => [];

  it('6, 7. removes each orphan, tells each step and the space given back, and leaves the live worktree', async () => {
    forgotten(path.join(project, '.worktrees', 'one'));
    file(path.join(project, '.worktrees', 'one', 'big.bin'), 300_000);
    file(path.join(project, '.worktrees', 'two', 'small.bin'), 100_000);
    const before = await listOrphanFolders({ projects: [project], owned: [] });
    const steps: Array<{ done: number; total: number; freedBytes: number }> = [];

    const report = await removeShown({ projects: [project], owned: [], processCwds: noProcess, onProgress: p => steps.push(p) });

    expect(report).toEqual({ removed: 2, freedBytes: before.totalBytes, kept: [] });
    expect(steps.map(s => [s.done, s.total])).toEqual([[1, 2], [2, 2]]);
    expect(steps[1].freedBytes).toBe(before.totalBytes);
    expect(fs.existsSync(path.join(project, '.worktrees', 'one'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.worktrees', 'two'))).toBe(false);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/live');
  });

  it('6, 7. keeps a folder a process works in, and says so', async () => {
    file(path.join(project, '.worktrees', 'busy', 'x.txt'), 10);
    file(path.join(project, '.worktrees', 'idle', 'x.txt'), 10);
    const busy = path.join(project, '.worktrees', 'busy');
    const report = await removeShown({
      projects: [project], owned: [],
      processCwds: async () => [{ pid: 4242, command: 'node', cwd: path.join(busy, 'sub') }],
    });
    expect(report.removed).toBe(1);
    expect(report.kept).toEqual([{ path: busy, project, reason: 'in-use', detail: 'node (4242)' }]);
    expect(fs.existsSync(busy)).toBe(true);
  });

  it('6. takes what is true when it removes: an agent that took a folder since the list keeps it', async () => {
    const taken = path.join(project, '.worktrees', 'taken');
    file(path.join(taken, 'x.txt'), 10);
    const shown = (await listOrphanFolders({ projects: [project], owned: [] })).folders.map(f => f.path);
    expect(shown).toEqual([taken]);
    const report = await removeOrphanFolders({ projects: [project], owned: [taken], paths: shown, processCwds: noProcess } as Parameters<typeof removeOrphanFolders>[0]);
    expect(report.removed).toBe(0);
    expect(fs.existsSync(taken)).toBe(true);
  });

  it.skipIf(cannotSymlink())('6. follows no link: a link out of .worktrees is neither listed nor removed through', async () => {
    const outside = path.join(root, 'outside');
    file(path.join(outside, 'precious.txt'), 10);
    fs.mkdirSync(path.join(project, '.worktrees'), { recursive: true });
    fs.symlinkSync(outside, path.join(project, '.worktrees', 'a-link'));
    await removeShown({ projects: [project], owned: [], processCwds: noProcess });
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toHaveLength(10);
  });

  it('8. removes nothing when the processes cannot be read, and says why for each', async () => {
    file(path.join(project, '.worktrees', 'idle', 'x.txt'), 10);
    const report = await removeShown({ projects: [project], owned: [], processCwds: async () => null });
    expect(report.removed).toBe(0);
    expect(report.kept).toEqual([{ path: path.join(project, '.worktrees', 'idle'), project, reason: 'unknown-use' }]);
    expect(fs.existsSync(path.join(project, '.worktrees', 'idle'))).toBe(true);
  });
});

/** A repository of its own at `p`, with a commit nobody else has. */
function clone(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  git(root, 'clone', '-q', project, p);
  git(p, 'config', 'user.email', 't@t.example');
  git(p, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(p, 'work'), 'unpushed\n');
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'unpushed');
}

describe('what the folder\'s own .git says', () => {
  const noProcess = async () => [];
  const wts = (...p: string[]) => path.join(project, '.worktrees', ...p);

  it('10. lists nothing of a project whose git cannot list its worktrees, and removes nothing', async () => {
    file(wts('stray', 'x.txt'), 10);
    fs.renameSync(path.join(project, '.git', 'HEAD'), path.join(project, '.git', 'HEAD.aside'));
    try {
      expect((await listOrphanFolders({ projects: [project], owned: [] })).folders).toEqual([]);
      const report = await removeShown({ projects: [project], owned: [], processCwds: noProcess });
      expect(report.removed).toBe(0);
    } finally {
      fs.renameSync(path.join(project, '.git', 'HEAD.aside'), path.join(project, '.git', 'HEAD'));
    }
    expect(fs.existsSync(path.join(wt, 'a.txt'))).toBe(true);
    expect(fs.existsSync(wts('stray', 'x.txt'))).toBe(true);
  });

  it('16. names the project git could not read, offers none of its folders, and still offers the others\'', async () => {
    const second = path.join(root, 'second');
    fs.mkdirSync(second);
    git(second, 'init', '-q', '-b', 'main');
    file(path.join(second, '.worktrees', 'left-over', 'x.txt'), 10);
    file(wts('stray', 'x.txt'), 10);
    fs.renameSync(path.join(project, '.git', 'HEAD'), path.join(project, '.git', 'HEAD.aside'));
    try {
      const listing = await listOrphanFolders({ projects: [project, second], owned: [] });
      expect(listing.unreadProjects).toEqual([project]);
      expect(listing.folders.map(f => f.path)).toEqual([path.join(second, '.worktrees', 'left-over')]);
      expect(listing.count).toBe(1);
    } finally {
      fs.renameSync(path.join(project, '.git', 'HEAD.aside'), path.join(project, '.git', 'HEAD'));
    }
    expect((await listOrphanFolders({ projects: [project, second], owned: [] })).unreadProjects).toEqual([]);
  });

  it('11. never lists a repository of its own, nor a .git that names no gitdir, and removes neither', async () => {
    clone(wts('bench-clone'));
    file(wts('garbled', 'x.txt'), 10);
    fs.writeFileSync(wts('garbled', '.git'), 'not a pointer\n');
    forgotten(wts('really-forgotten'));

    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual(['really-forgotten']);
    await removeShown({ projects: [project], owned: [], processCwds: noProcess });
    expect(fs.readFileSync(wts('bench-clone', 'work'), 'utf8')).toBe('unpushed\n');
    expect(fs.existsSync(wts('garbled', 'x.txt'))).toBe(true);
    expect(fs.existsSync(wts('really-forgotten'))).toBe(false);
  });

  it("12. never lists another repository's live worktree, and leaves it to that repository", async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 't@t.example');
    git(other, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'b');
    git(other, 'worktree', 'add', '-q', wts('other-repo'), '-b', 'other-live');
    fs.writeFileSync(wts('other-repo', 'work'), 'uncommitted\n');

    expect((await listOrphanFolders({ projects: [project], owned: [] })).folders).toEqual([]);
    await removeShown({ projects: [project], owned: [], processCwds: noProcess });
    expect(fs.readFileSync(wts('other-repo', 'work'), 'utf8')).toBe('uncommitted\n');
    expect(git(other, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  });

  it('13. never removes a repository nested deep under a folder with no .git, nor lists that folder whole', async () => {
    clone(wts('bench', 'runs', 'repo'));
    file(wts('bench', 'runs', 'log.txt'), 10);
    file(wts('bench', 'notes.md'), 10);

    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual([]);
    await removeShown({ projects: [project], owned: [], processCwds: noProcess });
    expect(fs.readFileSync(wts('bench', 'runs', 'repo', 'work'), 'utf8')).toBe('unpushed\n');
  });

  it('17. never offers a folder holding a repository inside its node_modules, a scoped package included', async () => {
    clone(wts('with-pkg', 'node_modules', 'pkg'));
    clone(wts('with-scoped', 'node_modules', '@scope', 'pkg'));
    file(wts('plain', 'node_modules', 'dep', 'index.js'), 10);

    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual(['plain']);
    await removeShown({ projects: [project], owned: [], processCwds: noProcess });
    expect(fs.readFileSync(wts('with-pkg', 'node_modules', 'pkg', 'work'), 'utf8')).toBe('unpushed\n');
    expect(fs.readFileSync(wts('with-scoped', 'node_modules', '@scope', 'pkg', 'work'), 'utf8')).toBe('unpushed\n');
  });

  it('18. keeps an orphan with a folder below it that cannot be read', async () => {
    file(wts('locked', 'inner', 'x.txt'), 10);
    const restore = makeUnreadable(wts('locked', 'inner'), 0o755);
    try {
      expect((await listOrphanFolders({ projects: [project], owned: [] })).folders).toEqual([]);
    } finally {
      restore();
    }
  });

  it('18. keeps an orphan with more below it than the search looks through', async () => {
    // One past a bound of 100: the 50 001 files the real bound takes timed out
    // under load (30 s, then afterEach's 10 s, at a load average of 176).
    const many = wts('huge', 'many');
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i <= 100; i++) fs.writeFileSync(path.join(many, String(i)), '');
    expect((await listOrphanFolders({ projects: [project], owned: [], searchLimit: 100 })).folders).toEqual([]);
    // And under the bound, the same folder is offered: the bound is what keeps it.
    expect((await listOrphanFolders({ projects: [project], owned: [], searchLimit: 1_000 })).folders.map((f) => f.name)).toEqual(['huge']);
  });

  it('14. reads the processes again before each folder goes', async () => {
    file(wts('big', 'x.bin'), 300_000);
    file(wts('small', 'x.bin'), 10);
    const small = wts('small');
    // A process starts in the second folder once the first is gone.
    const report = await removeShown({
      projects: [project], owned: [],
      processCwds: async () => (fs.existsSync(wts('big')) ? [] : [{ pid: 7, command: 'node', cwd: small }]),
    });
    expect(report.removed).toBe(1);
    expect(report.kept).toEqual([{ path: small, project, reason: 'in-use', detail: 'node (7)' }]);
    expect(fs.existsSync(small)).toBe(true);
  });
});

describe('a folder that changed since the list', () => {
  it('6. one that took a repository while the others went is kept, and says why', async () => {
    const wts = (...p: string[]) => path.join(project, '.worktrees', ...p);
    file(wts('big', 'x.bin'), 300_000);
    file(wts('small', 'x.bin'), 10);
    const report = await removeShown({
      projects: [project], owned: [],
      processCwds: async () => {
        // The first folder gone, somebody clones into the second.
        if (!fs.existsSync(wts('big')) && !fs.existsSync(wts('small', 'inner'))) {
          fs.mkdirSync(wts('small', 'inner'));
          git(wts('small', 'inner'), 'init', '-q');
        }
        return [];
      },
    });
    expect(report.removed).toBe(1);
    expect(report.kept).toEqual([expect.objectContaining({ path: wts('small'), reason: 'failed' })]);
    expect(fs.existsSync(wts('small', 'inner', '.git'))).toBe(true);
  });
});

describe('what the window showed', () => {
  const noProcess = async () => [];
  const wts = (...p: string[]) => path.join(project, '.worktrees', ...p);

  it('19. removes only the folders the window showed, and nothing for an empty list', async () => {
    file(wts('shown', 'x.txt'), 10);
    const shown = (await listOrphanFolders({ projects: [project], owned: [] })).folders.map(f => f.path);
    // Settings stays open; a folder becomes an orphan meanwhile.
    file(wts('since', 'x.txt'), 10);

    expect((await removeOrphanFolders({ projects: [project], owned: [], paths: [], processCwds: noProcess })).removed).toBe(0);
    expect(fs.existsSync(wts('shown'))).toBe(true);

    const steps: number[][] = [];
    const report = await removeOrphanFolders({ projects: [project], owned: [], paths: shown, processCwds: noProcess, onProgress: p => steps.push([p.done, p.total]) });
    expect(report.removed).toBe(1);
    // One named, two orphans found: the progress counts what was named.
    expect(steps).toEqual([[1, 1]]);
    expect(fs.existsSync(wts('shown'))).toBe(false);
    expect(fs.existsSync(wts('since', 'x.txt'))).toBe(true);
  });

  it('19. keeps, and says so, a path the window names that is not an orphan now', async () => {
    file(wts('stray', 'x.txt'), 10);
    const outside = path.join(root, 'outside');
    file(path.join(outside, 'precious.txt'), 10);
    const asked = [wt, outside, wts('stray')];

    const steps: number[][] = [];
    const report = await removeOrphanFolders({ projects: [project], owned: [], paths: asked, processCwds: noProcess, onProgress: p => steps.push([p.done, p.total]) });

    expect(report.removed).toBe(1);
    // Three named, one orphan found: still three steps of three.
    expect(steps).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(report.kept.map(k => [k.path, k.reason])).toEqual([[wt, 'failed'], [outside, 'failed']]);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/live');
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('20. says why a folder could not be removed without its absolute path', async () => {
    file(wts('stuck', 'locked', 'f'), 10);
    const restore = makeUnremovable(wts('stuck', 'locked'), wts('stuck', 'locked', 'f'));
    try {
      const report = await removeShown({ projects: [project], owned: [], processCwds: noProcess });
      const refused = process.platform === 'win32' ? 'EPERM' : 'EACCES';
      expect(report.kept).toEqual([{ path: wts('stuck'), project, reason: 'failed', detail: `${refused} on ${path.join('locked', 'f')}` }]);
      for (const k of report.kept) expect(k.detail ?? '').not.toContain(root);
    } finally {
      restore();
    }
  });
});

describe('the processes on Linux', () => {
  it.skipIf(cannotSymlink())("15. are unknown when /proc cannot be read, or when Tars's own working directory is not among them", () => {
    const fake = fs.mkdtempSync(path.join(root, 'proc-'));
    expect(procCwds(path.join(fake, 'missing'), 999)).toBeNull();
    fs.mkdirSync(path.join(fake, '123'));
    fs.writeFileSync(path.join(fake, '123', 'comm'), 'node\n');
    fs.symlinkSync(root, path.join(fake, '123', 'cwd'));
    // hidepid: only some processes can be read, and not this one.
    expect(procCwds(fake, 999)).toBeNull();
    expect(procCwds(fake, 123)).toEqual([{ pid: 123, command: 'node', cwd: root }]);
  });
});

describe('the disk', () => {
  it('9. says the home disk\'s free and total space, and the 30 GB floor', () => {
    const disk = diskSpace(os.tmpdir())!;
    const s = fs.statfsSync(os.tmpdir());
    expect(disk.totalBytes).toBe(s.blocks * s.bsize);
    expect(Math.abs(disk.freeBytes - s.bavail * s.bsize)).toBeLessThan(512 * 1024 * 1024);
    expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes);
    expect(disk.floorBytes).toBe(30 * 1024 ** 3);
    expect(DISK_FLOOR_BYTES).toBe(disk.floorBytes);
  });
});
