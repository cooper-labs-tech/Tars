import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { scanJanitor, approveJanitor, type JanitorWorld, type JanitorOps } from '../../../electron/services/janitor-rules';
import { shortIdOf } from '../../../electron/services/agent-tmp';
import { pinPlatform } from '../providers/win-fake-disk';

/**
 * A disk janitor on a strict list, approved by the owner (2.0.5, lot 3 item H; brief lot3-disk-janitor-2810.md, the
 * orchestrator's additions of 28/10). The Mac fell to 68 MB free once, and to 5.7 GB on 27/10: 15 GB of Docker, 6 GB
 * of npx cache and 5 GB of .next were measured then.
 *
 * How it fails, written before the code (28/10):
 * J1. Something outside the list is proposed: a folder of no listed kind, a project's own source.
 * J2. Something on the never list is proposed: ~/.tars-private, ~/Documents, the uv cache, the Trash, Xcode, the iOS
 *     simulators and runtimes (~/Library/Developer), a Docker volume.
 * J3. A .next or a test artefact is proposed in a worktree an agent of the fleet works in, one with uncommitted work,
 *     one a process works in, or one touched in the last three days.
 * J4. A worktree is proposed that is not merged into its project's main branch, has uncommitted work, is locked, is
 *     a fleet agent's, has a process in it, or is the project itself.
 * J5. A test artefact a report names is proposed (the reports under ~/.tars/project-files cite their runs).
 * J6. An agent's temporary folder is proposed while its agent is in the fleet, or a process works in it.
 * J7. An npx cache entry touched in the last fourteen days, or in use, is proposed.
 * J8. A Docker image a container uses, even a stopped one, is proposed.
 * J9. The processes cannot be read (no lsof, Windows): anything that needs "nothing runs in it" is proposed then.
 * J10. An approved item that no longer matches its rule at the moment it goes (a process started in it, it was
 *      touched, an agent took the worktree, it gained uncommitted work) is deleted; an item not approved is deleted;
 *      an item goes by anything but its exact absolute path (a glob, a shell).
 * J11. A deletion is not logged with what it freed, or a refusal without why.
 * J12. A scan deletes something.
 * And for the window (the Frontend's contract on #539, `Resources (2.0.5) · disk`):
 * J13. An item does not say why it matched (its last change, the merged branch, the image's name), or the window
 *      cannot tell, item by item, what an approval did: deleted with its bytes, kept with why, failed with the error.
 * And from the Audit's gate of #542 (AUDIT-PR542.md), and the window's frames (#535, the Audit's Info 1 on #543):
 * J14. (M1) "Nothing runs in it" reads only working folders: six live sentry-mcp servers ran from an npx entry with
 *      their working folder elsewhere, and the entry was proposed. A process is in a folder by its working folder,
 *      its command line, or its executable and open files.
 * J15. (M2) A merged worktree goes with its ignored files (a .env.local, an e2e run), or in the middle of a rebase,
 *      which scripts/worktree.mjs refuses: rebuildable caches aside, it is not proposed.
 * J16. (L1) A project under ~/Documents, or a .worktrees linked into it, has an item proposed.
 * J17. (L2) A fleet agent's worktree saved in another case than the disk's is not recognised as its own.
 * J18. (L3) A merged worktree with a node_modules reads as just touched (its 20,000 entries), and is never proposed:
 *      the rebuildable caches are left out of the idle walk.
 * J19. (L4) A link planted on a parent between the re-check and the deletion is followed: right before it goes, the
 *      item's real path must be its path, and a folder.
 * J20. A worktree item does not give its details (branch, merged, idle days, clean), or its branch is in the rule's
 *      text, which the window groups by; or a scan does not say how far it is.
 * And from the Audit's re-check at aba0aa08:
 * J21. (M1) Every path of every process is resolved again for each candidate folder: about 8 s of synchronous work
 *      on the main thread per scan (545 processes, 8,628 paths). The world gives the paths resolved once, and the
 *      rules compare strings: a scan over thousands of processes stays well under a second.
 * And from the Audit's I-2 on #643 at 7fed2c3e1, about main's janitor-rules.ts:145 (confirmed by QA, uv 0.13.1
 * measured), written before the code:
 * J22. The uv cache is only ~/.cache/uv and ~/Library/Caches/uv on the never list, where uv puts it at $UV_CACHE_DIR,
 *      else $XDG_CACHE_HOME/uv, else ~/.cache/uv (on Windows %LOCALAPPDATA%\uv\cache): a project in a uv cache either
 *      variable moved, or a .worktrees linked into one, has an item proposed.
 * J23. The same trap in the other entries: the Trash is only the Finder's ~/.Trash, where Linux's (the freedesktop.org
 *      trash) is $XDG_DATA_HOME/Trash, else ~/.local/share/Trash: a project there has an item proposed.
 * J24. An empty or relative variable taken for a folder: '' is Tars's own working folder ('/' when the Finder started
 *      it), and the never list would hold the whole disk, so nothing would ever be proposed.
 * And from the Audit's Infos on #605 at 5297b7bc2 (reports/audit-605.md), written before the code:
 * J25. (I-1) uv's own config moves the cache for every uv, the agents' included: `cache-dir` in the user-level uv.toml,
 *      $XDG_CONFIG_HOME/uv/uv.toml (absolute) else ~/.config/uv/uv.toml (both measured on uv 0.13.1, which reads no
 *      ~/Library/Application Support/uv), and %APPDATA%\uv\uv.toml on Windows, is not read: a project in that cache
 *      has an item proposed. And it is read wrong: only an absolute value names a folder (uv 0.13.1 takes `~`, `$HOME`
 *      and a relative value as written, relative to the folder it runs in: measured), and a file uv cannot parse
 *      (uv refuses it), or one past 64 KiB, which no config is, must change nothing.
 * J26. (I-2) On Windows with LOCALAPPDATA unset or empty, the uv cache has no place on the list: the literal
 *      <home>\AppData\Local\uv\cache is missing.
 * J27. (I-3) A trash of another volume: projects.json names any folder, a project on a volume of its own included, so
 *      the janitor reaches other volumes today, and their trashes are not on the list: /Volumes/<v>/.Trashes on
 *      macOS, <mount>/.Trash-<uid> and <mount>/.Trash/<uid> on Linux, <drive>\$Recycle.Bin on Windows. A project in
 *      one has an item proposed.
 * And from the Audit's two hardening Infos on #605 at af2ee8be2, written before the code:
 * J28. (I-1) The uv.toml is checked by its path, then read by its path, so a file swapped in between is read all the
 *      same: a FIFO blocks the main process on its open (forever, with no writer), and a file grown past 64 KiB is
 *      read whole and its cache-dir taken. The open itself must never block on a FIFO, in place or swapped in, and
 *      what is checked must be what is read. A uv.toml that is a link to a file must still be read: uv 0.13.1 follows
 *      it (measured, bench uv-never/probe-uv-link.txt), and dotfile managers make them.
 * J29. (I-2) A cache-dir that hides everything, which any process of the user can write: "/", a drive root, the home,
 *      or an ancestor of the home (compared by real path, so a link to the home too) put on the never list empties
 *      every proposal. It must be ignored, with one line logged saying so, and a cache-dir inside the home still
 *      taken.
 */

const DAY = 86_400_000;
let root: string;
let home: string;
let project: string;
let now: number;
let deleted: string[];
let logged: string[];

const old = (p: string, days: number) => { const t = new Date(now - days * DAY); fs.utimesSync(p, t, t); };
function mk(p: string, ageDays = 10): string {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'f'), 'x');
  old(path.join(p, 'f'), ageDays);
  old(p, ageDays);
  return p;
}

type Over = Partial<{
  fleet: JanitorWorld['fleet']; processes: JanitorWorld['processes']; dirty: Set<string>; merged: Set<string>; locked: Set<string>;
  ignored: Record<string, string[]>; busy: Set<string>;
  named: string[]; images: Array<{ id: string; repo: string; sizeBytes: number; used: boolean }> | null; vm: boolean;
}>;

function world(over: Over = {}): JanitorWorld {
  const wt = (name: string) => path.join(project, '.worktrees', name);
  return {
    home, dataDir: path.join(home, '.tars'), privateDir: path.join(home, '.tars-private'), now,
    projects: [project],
    fleet: over.fleet ?? [{ id: 'agent-live', projectPath: project, worktreePath: wt('agents') }],
    processes: over.processes === undefined ? [{ pid: 7, command: 'zsh', paths: [wt('busy')] }] : over.processes,
    ignored: async (p) => (over.ignored ?? {})[path.basename(p)] ?? [],
    operation: async (p) => ((over.busy ?? new Set()).has(path.basename(p)) ? 'a rebase' : null),
    worktrees: async () => ['done', 'dirty', 'locked', 'agents', 'busy', 'fresh', 'open'].map(n => ({
      path: wt(n), branch: `b/${n}`, locked: (over.locked ?? new Set(['locked'])).has(n),
    })),
    dirty: async (p) => (over.dirty ?? new Set(['dirty'])).has(path.basename(p)),
    merged: async (_project, branch) => (over.merged ?? new Set(['b/done', 'b/dirty', 'b/locked', 'b/agents', 'b/busy', 'b/fresh'])).has(branch),
    named: (folder) => (over.named ?? []).some(n => folder.endsWith(n)),
    docker: { images: async () => (over.images === undefined ? [
      { id: 'sha256:unused', repo: 'old/thing:1', sizeBytes: 2e9, used: false },
      { id: 'sha256:used', repo: 'postgres:16', sizeBytes: 4e8, used: true },
    ] : over.images), vm: over.vm ?? true },
    sizeOf: async () => 1024,
  };
}

const outcomes: Array<[string, { kind: string; bytes?: number | null; why?: string | null }]> = [];
const ops = (): JanitorOps => ({
  done: (id, outcome) => { outcomes.push([id, outcome]); },
  rm: async (p) => { deleted.push(`rm ${p}`); fs.rmSync(p, { recursive: true, force: true }); },
  removeWorktree: async (_project, p) => { deleted.push(`worktree ${p}`); fs.rmSync(p, { recursive: true, force: true }); },
  dockerRm: async (id) => { deleted.push(`docker ${id}`); },
  trim: async () => { deleted.push('trim'); },
  log: (line) => { logged.push(line); },
});

beforeEach(() => {
  now = Date.now();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-')));
  home = path.join(root, 'home');
  project = path.join(home, 'projects', 'harbor');
  deleted = [];
  logged = [];
  outcomes.length = 0;
  mk(path.join(project, 'src'));
  for (const n of ['done', 'dirty', 'locked', 'agents', 'busy', 'open']) {
    mk(path.join(project, '.worktrees', n, '.next'));
    mk(path.join(project, '.worktrees', n, 'test-results'));
  }
  mk(path.join(project, '.worktrees', 'fresh', '.next'), 1);
  mk(path.join(project, '.worktrees', 'done', 'playwright-report'));
  // Each worktree's own time last: making a folder in it renews it.
  for (const n of ['done', 'dirty', 'locked', 'agents', 'busy', 'open']) old(path.join(project, '.worktrees', n), 10);
  mk(path.join(project, '.next'));
  mk(path.join(home, '.tars', 'tmp', shortIdOf('agent-gone')));
  mk(path.join(home, '.tars', 'tmp', shortIdOf('agent-live')));
  mk(path.join(home, '.npm', '_npx', 'oldhash'), 30);
  mk(path.join(home, '.npm', '_npx', 'newhash'), 3);
  for (const never of ['.tars-private/junk/.next', 'Documents/x/test-results', '.cache/uv/wheels', 'Library/Caches/uv', '.Trash/x/.next',
    'Library/Developer/Xcode/DerivedData', 'Library/Developer/CoreSimulator/Devices']) mk(path.join(home, never));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const keyOf = (i: { kind: string; path?: string; ref?: string }) => `${i.kind} ${i.path ? path.relative(home, i.path) : i.ref}`;

describe('the scan', () => {
  it('J1-J8. proposes exactly the listed kinds that match their rule, each with its size and rule', async () => {
    const items = await scanJanitor(world());
    expect(items.map(keyOf).sort()).toEqual([
      'agent-tmp .tars/tmp/' + shortIdOf('agent-gone'),
      'closed-worktree projects/harbor/.worktrees/done',
      'docker-image sha256:unused',
      'docker-vm-trim colima',
      'next-cache projects/harbor/.worktrees/done/.next',
      'next-cache projects/harbor/.worktrees/locked/.next',
      'next-cache projects/harbor/.worktrees/open/.next',
      'npx-cache .npm/_npx/oldhash',
      'test-artefacts projects/harbor/.worktrees/done/playwright-report',
      'test-artefacts projects/harbor/.worktrees/done/test-results',
      'test-artefacts projects/harbor/.worktrees/locked/test-results',
      'test-artefacts projects/harbor/.worktrees/open/test-results',
    ].sort());
    for (const i of items) {
      expect(i.rule, keyOf(i)).toBeTruthy();
      expect(i.id, keyOf(i)).toMatch(/^[0-9a-f]{16}$/);
      if (i.kind !== 'docker-vm-trim') expect(i.sizeBytes, keyOf(i)).toBeGreaterThan(0);
    }
    expect(deleted, 'J12').toEqual([]);
  });

  it('J5. a test artefact a report names is not proposed', async () => {
    const items = await scanJanitor(world({ named: ['done/playwright-report'] }));
    expect(items.map(keyOf)).not.toContain('test-artefacts projects/harbor/.worktrees/done/playwright-report');
  });

  it('J9. the processes unread, nothing that needs "nothing runs in it" is proposed', async () => {
    const items = await scanJanitor(world({ processes: null }));
    expect(items.map(i => i.kind).sort()).toEqual(['docker-image', 'docker-vm-trim']);
  });

  it('J8, J2. no Docker image a container uses, no volume ever, and no trim without a VM', async () => {
    const items = await scanJanitor(world({ images: null, vm: false }));
    expect(items.filter(i => i.kind.startsWith('docker'))).toEqual([]);
  });
});

describe('the approval', () => {
  it('J10, J11. deletes the approved items by their exact path, logs what each freed, and nothing else', async () => {
    const items = await scanJanitor(world());
    const pick = (k: string) => items.find(i => keyOf(i) === k)!.id;
    const report = await approveJanitor([pick('closed-worktree projects/harbor/.worktrees/done'), pick('npx-cache .npm/_npx/oldhash'), pick('docker-image sha256:unused')], () => world(), ops());
    expect(deleted).toEqual([
      `worktree ${path.join(project, '.worktrees', 'done')}`,
      `rm ${path.join(home, '.npm', '_npx', 'oldhash')}`,
      'docker sha256:unused',
    ]);
    expect(report.freedBytes).toBe(1024 + 1024 + 2e9);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatch(/closed-worktree .*\.worktrees\/done: freed 1024 bytes/);
    expect(fs.existsSync(path.join(project, '.worktrees', 'open', '.next')), 'not approved').toBe(true);
  });

  it('J10. an approved item that stopped matching is kept, and says why', async () => {
    const items = await scanJanitor(world());
    const id = (k: string) => items.find(i => keyOf(i) === k)!.id;
    const changed = () => world({
      processes: [{ pid: 9, command: 'next-server', paths: [path.join(project, '.worktrees', 'open')] }],
      fleet: [{ id: 'agent-live', projectPath: project, worktreePath: path.join(project, '.worktrees', 'locked') }, { id: 'agent-gone', projectPath: project }],
      dirty: new Set(['done']),
    });
    const report = await approveJanitor([
      id('next-cache projects/harbor/.worktrees/open/.next'), id('next-cache projects/harbor/.worktrees/locked/.next'),
      id('closed-worktree projects/harbor/.worktrees/done'), id('agent-tmp .tars/tmp/' + shortIdOf('agent-gone')), 'ffffffffffffffff',
    ], changed, ops());
    expect(deleted).toEqual([]);
    expect(report.kept.map(k => k.why)).toEqual([
      expect.stringMatching(/no longer matches/), expect.stringMatching(/no longer matches/), expect.stringMatching(/no longer matches/),
      expect.stringMatching(/no longer matches/), expect.stringMatching(/not in the scan/),
    ]);
    expect(logged).toHaveLength(5);
  });

  it('J10. a .next touched since the scan is kept', async () => {
    const items = await scanJanitor(world());
    const id = items.find(i => keyOf(i) === 'next-cache projects/harbor/.worktrees/open/.next')!.id;
    fs.writeFileSync(path.join(project, '.worktrees', 'open', '.next', 'g'), 'new');
    const report = await approveJanitor([id], () => world(), ops());
    expect([deleted, report.kept.length]).toEqual([[], 1]);
  });

  it('J13. each item says why it matched, and each approved item\'s outcome reaches the window', async () => {
    const items = await scanJanitor(world());
    for (const i of items) expect(i.why, keyOf(i)).toBeTruthy();
    expect(items.find(i => i.kind === 'closed-worktree')!.why).toMatch(/b\/done is merged/);
    expect(items.find(i => i.kind === 'docker-image')!.why).toMatch(/old\/thing:1/);
    const id = (k: string) => items.find(i => keyOf(i) === k)!.id;
    const failing = { ...ops(), rm: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
    await approveJanitor([id('docker-image sha256:unused'), id('npx-cache .npm/_npx/oldhash'), 'ffffffffffffffff'], () => world(), failing);
    expect(outcomes).toEqual([
      [id('docker-image sha256:unused'), { kind: 'deleted', bytes: 2e9 }],
      [id('npx-cache .npm/_npx/oldhash'), { kind: 'failed', why: 'the deletion failed: EBUSY' }],
      ['ffffffffffffffff', { kind: 'kept', why: 'it is not in the scan the window showed' }],
    ]);
  });
});

describe('the Audit\'s gate of #542, and the window\'s details', () => {
  it('J14. a process is in a folder by its working folder, its command line, or its executable and open files', async () => {
    const npx = path.join(home, '.npm', '_npx', 'oldhash');
    for (const proc of [
      { pid: 11, command: `node ${npx}/node_modules/.bin/sentry-mcp`, paths: [project] },
      { pid: 12, command: 'node', paths: [project, path.join(npx, 'node_modules', 'sentry', 'index.js')] },
    ]) {
      const items = await scanJanitor(world({ processes: [proc] }));
      expect(items.map(keyOf), proc.command).not.toContain('npx-cache .npm/_npx/oldhash');
    }
  });

  it('J15. a merged worktree with ignored files but the caches, or in the middle of an operation, is not proposed', async () => {
    const withEnv = await scanJanitor(world({ ignored: { done: ['.env.local', 'e2e-runs/'] } }));
    expect(withEnv.map(keyOf)).not.toContain('closed-worktree projects/harbor/.worktrees/done');
    const cachesOnly = await scanJanitor(world({ ignored: { done: ['node_modules/', '.next/', 'electron/dist/', 'next-env.d.ts'] } }));
    expect(cachesOnly.map(keyOf)).toContain('closed-worktree projects/harbor/.worktrees/done');
    const rebasing = await scanJanitor(world({ busy: new Set(['done']) }));
    expect(rebasing.map(keyOf)).not.toContain('closed-worktree projects/harbor/.worktrees/done');
  });

  it('J16. nothing under ~/Documents, a project there or a .worktrees linked into it', async () => {
    const docProject = path.join(home, 'Documents', 'proj');
    mk(path.join(docProject, '.worktrees', 'idle', '.next'));
    old(path.join(docProject, '.worktrees', 'idle'), 10);
    const linked = path.join(home, 'projects', 'linked');
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(path.join(docProject, '.worktrees'), path.join(linked, '.worktrees'));
    const w = world();
    w.projects = [docProject, linked];
    w.worktrees = async (p) => [{ path: path.join(p, '.worktrees', 'idle'), branch: 'b/done', locked: false }];
    const items = await scanJanitor(w);
    expect(items.filter(i => i.path && (i.path.includes('Documents') || i.path.includes('linked')))).toEqual([]);
  });

  it('J17. a fleet agent\'s worktree saved in another case is still its own', async () => {
    const upper = path.join(project, '.worktrees', 'agents').toUpperCase();
    if (!fs.existsSync(upper)) return; // a case-sensitive volume: no other spelling of it exists
    const items = await scanJanitor(world({ fleet: [{ id: 'agent-live', projectPath: project, worktreePath: path.join(project, '.worktrees', 'agents').toLowerCase() }] }));
    expect(items.map(keyOf).filter(k => k.includes('/agents/'))).toEqual([]);
  });

  it('J18. a merged worktree\'s rebuildable caches do not count for its idleness', async () => {
    mk(path.join(project, '.worktrees', 'done', 'node_modules', 'pkg'), 0);
    mk(path.join(project, '.worktrees', 'done', 'electron', 'dist'), 0);
    old(path.join(project, '.worktrees', 'done', 'electron'), 10);
    old(path.join(project, '.worktrees', 'done'), 10);
    const items = await scanJanitor(world());
    expect(items.map(keyOf)).toContain('closed-worktree projects/harbor/.worktrees/done');
  });

  it('J19. right before it goes, an item whose real path is no longer its path, or no folder, is kept', async () => {
    const items = await scanJanitor(world());
    const target = items.find(i => keyOf(i) === 'next-cache projects/harbor/.worktrees/open/.next')!;
    const outside = mk(path.join(home, 'Documents', 'x', '.next'));
    const report = await approveJanitor([target.id], () => world(), {
      ...ops(),
      // Planted after the re-check, as an agent racing the deletion would.
      beforeDelete: () => {
        fs.renameSync(path.join(project, '.worktrees', 'open'), path.join(project, '.worktrees', 'open-moved'));
        fs.symlinkSync(path.join(home, 'Documents', 'x'), path.join(project, '.worktrees', 'open'));
      },
    });
    expect(deleted).toEqual([]);
    expect(report.kept[0].why).toMatch(/is no longer where it was/);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('J20. a worktree item gives its details apart from the rule, and a scan says how far it is', async () => {
    const progress: Array<{ what: string; done: number; total: number; foundBytes: number }> = [];
    const items = await scanJanitor(world(), p => progress.push(p));
    const done = items.find(i => keyOf(i) === 'closed-worktree projects/harbor/.worktrees/done')!;
    expect(done.details).toEqual({ branch: 'b/done', merged: true, idleDays: expect.any(Number), clean: true });
    expect(done.details!.idleDays).toBeGreaterThanOrEqual(9);
    expect(done.rule).not.toContain('b/done');
    const open = items.find(i => keyOf(i) === 'next-cache projects/harbor/.worktrees/open/.next')!;
    expect(open.details).toMatchObject({ branch: 'b/open', merged: false, clean: true });
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toMatchObject({ done: progress.at(-1)!.total });
    expect(progress.at(-1)!.foundBytes).toBe(items.reduce((s, i) => s + i.sizeBytes, 0));
  });

  it('J21. thousands of processes\' paths are compared, not resolved again, for each folder', async () => {
    const processes = Array.from({ length: 5000 }, (_, i) => ({ pid: 1000 + i, command: `node /opt/app${i}/server.js`, paths: [`/opt/app${i}`, `/opt/app${i}/lib.dylib`] }));
    const realpath = fs.realpathSync.native;
    let calls = 0;
    (fs.realpathSync as unknown as { native: typeof realpath }).native = ((p: string) => { calls++; return realpath(p); }) as typeof realpath;
    try {
      const started = Date.now();
      const items = await scanJanitor(world({ processes }));
      const took = Date.now() - started;
      expect(items.length).toBeGreaterThan(5);
      expect(took, `${took} ms`).toBeLessThan(1_500);
      expect(calls, 'resolved a process path').toBeLessThan(500);
    } finally {
      (fs.realpathSync as unknown as { native: typeof realpath }).native = realpath;
    }
  });
});

describe('the never list where the tools really put things, from the environment Tars runs in (J22-J24)', () => {
  const VARS = ['HOME', 'UV_CACHE_DIR', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'LOCALAPPDATA', 'APPDATA'] as const;
  let saved: Record<string, string | undefined>;
  let cwd: string;
  let unpin = () => {};
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    process.env.HOME = home;
    cwd = process.cwd();
  });
  afterEach(() => {
    unpin();
    unpin = () => {};
    process.chdir(cwd);
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /**
   * What is proposed of a project in `dir` with an idle worktree, and of a listed project whose .worktrees links into
   * it (as J16). `before` runs right before the scan.
   */
  async function proposedIn(dir: string, label: string, before?: () => void) {
    const inside = path.join(dir, 'git-v0', 'checkouts', label);
    mk(path.join(inside, '.worktrees', 'idle', '.next'));
    old(path.join(inside, '.worktrees', 'idle'), 10);
    const linked = path.join(home, 'projects', `linked-${label}`);
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(path.join(inside, '.worktrees'), path.join(linked, '.worktrees'));
    const w = world();
    w.projects = [inside, linked];
    w.worktrees = async (p) => [{ path: path.join(p, '.worktrees', 'idle'), branch: 'b/done', locked: false }];
    before?.();
    return (await scanJanitor(w)).filter(i => i.path && (i.path.startsWith(dir) || i.path.includes(`linked-${label}`))).map(keyOf);
  }

  it('the same project anywhere else is proposed: the cases below prove something', async () => {
    process.env.UV_CACHE_DIR = path.join(root, 'uv-elsewhere');
    process.env.XDG_CACHE_HOME = path.join(root, 'xdg-cache');
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
    expect(await proposedIn(path.join(root, 'elsewhere'), 'control')).not.toEqual([]);
  });

  it('J22. the uv cache at $UV_CACHE_DIR', async () => {
    process.env.UV_CACHE_DIR = path.join(root, 'uv-elsewhere');
    expect(await proposedIn(path.join(root, 'uv-elsewhere'), 'uv-dir')).toEqual([]);
  });

  it('J22. the uv cache at $XDG_CACHE_HOME/uv', async () => {
    process.env.XDG_CACHE_HOME = path.join(root, 'xdg-cache');
    expect(await proposedIn(path.join(root, 'xdg-cache', 'uv'), 'xdg-uv')).toEqual([]);
  });

  it('J22. the uv cache at ~/.cache/uv and ~/Library/Caches/uv, still, with no variable', async () => {
    expect(await proposedIn(path.join(home, '.cache', 'uv'), 'home-uv')).toEqual([]);
    expect(await proposedIn(path.join(home, 'Library', 'Caches', 'uv'), 'mac-uv')).toEqual([]);
  });

  it('J22. on Windows, the uv cache at %LOCALAPPDATA%\\uv\\cache', async () => {
    unpin = pinPlatform('win32');
    process.env.LOCALAPPDATA = path.join(root, 'appdata-local');
    expect(await proposedIn(path.join(root, 'appdata-local', 'uv', 'cache'), 'win-uv')).toEqual([]);
  });

  it('J23. Linux\'s Trash at $XDG_DATA_HOME/Trash, and at ~/.local/share/Trash with no variable', async () => {
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
    expect(await proposedIn(path.join(root, 'xdg-data', 'Trash', 'files'), 'xdg-trash')).toEqual([]);
    delete process.env.XDG_DATA_HOME;
    expect(await proposedIn(path.join(home, '.local', 'share', 'Trash', 'files'), 'home-trash')).toEqual([]);
  });

  it('J24. an empty or relative variable is no folder: the never list does not take in Tars\'s working folder', async () => {
    process.chdir(root);
    process.env.UV_CACHE_DIR = '';
    process.env.XDG_CACHE_HOME = '';
    process.env.XDG_DATA_HOME = 'data';
    process.env.LOCALAPPDATA = '';
    expect(await proposedIn(path.join(root, 'elsewhere'), 'empty')).not.toEqual([]);
  });

  const uvToml = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  it('J25. the cache-dir of $XDG_CONFIG_HOME/uv/uv.toml', async () => {
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
    uvToml(path.join(root, 'xdg-config', 'uv', 'uv.toml'), `cache-dir = "${path.join(root, 'from-xdg-toml')}"\n`);
    expect(await proposedIn(path.join(root, 'from-xdg-toml'), 'xdg-toml')).toEqual([]);
  });

  it('J25. the cache-dir of ~/.config/uv/uv.toml, among the other keys of the file', async () => {
    uvToml(path.join(home, '.config', 'uv', 'uv.toml'), `# mine\nnative-tls = true\ncache-dir = "${path.join(root, 'from-home-toml')}"\n\n[[index]]\nurl = "https://example.org/simple"\n`);
    expect(await proposedIn(path.join(root, 'from-home-toml'), 'home-toml')).toEqual([]);
  });

  it('J25. on Windows, the cache-dir of %APPDATA%\\uv\\uv.toml', async () => {
    unpin = pinPlatform('win32');
    process.env.APPDATA = path.join(root, 'appdata-roaming');
    uvToml(path.join(root, 'appdata-roaming', 'uv', 'uv.toml'), `cache-dir = '${path.join(root, 'from-appdata-toml')}'\n`);
    expect(await proposedIn(path.join(root, 'from-appdata-toml'), 'appdata-toml')).toEqual([]);
  });

  it('J25. a relative, `~` or `$HOME` value, a file uv cannot parse, one past 64 KiB: each changes nothing', async () => {
    const file = path.join(home, '.config', 'uv', 'uv.toml');
    process.chdir(root);
    uvToml(file, 'cache-dir = "elsewhere-rel"\n');
    expect(await proposedIn(path.join(root, 'elsewhere-rel'), 'rel'), 'a relative value').not.toEqual([]);
    uvToml(file, 'cache-dir = "~/elsewhere-tilde"\n');
    expect(await proposedIn(path.join(home, 'elsewhere-tilde'), 'tilde'), 'a `~` value').not.toEqual([]);
    uvToml(file, 'cache-dir = "$HOME/elsewhere-env"\n');
    expect(await proposedIn(path.join(home, 'elsewhere-env'), 'env'), 'a `$HOME` value').not.toEqual([]);
    uvToml(file, `cache-dir = "${path.join(root, 'elsewhere-bad')}",\n`);
    expect(await proposedIn(path.join(root, 'elsewhere-bad'), 'bad'), 'a file uv cannot parse').not.toEqual([]);
    uvToml(file, `cache-dir = "${path.join(root, 'elsewhere-big')}"\n${'# padding\n'.repeat(7000)}`);
    expect(await proposedIn(path.join(root, 'elsewhere-big'), 'big'), 'a file past 64 KiB').not.toEqual([]);
  });

  it('J26. on Windows with LOCALAPPDATA unset or empty, <home>\\AppData\\Local\\uv\\cache', async () => {
    unpin = pinPlatform('win32');
    expect(await proposedIn(path.join(home, 'AppData', 'Local', 'uv', 'cache'), 'win-unset')).toEqual([]);
    process.env.LOCALAPPDATA = '';
    expect(await proposedIn(path.join(home, 'AppData', 'Local', 'uv', 'cache', 'x'), 'win-empty')).toEqual([]);
  });

  it('J27. the trash of another volume: .Trashes, .Trash-<uid>, .Trash/<uid>, $Recycle.Bin', async () => {
    expect(await proposedIn(path.join(root, 'Volumes', 'ext', '.Trashes', '501'), 'mac-volume')).toEqual([]);
    expect(await proposedIn(path.join(root, 'media', 'ext', '.Trash-1000', 'files'), 'linux-volume')).toEqual([]);
    expect(await proposedIn(path.join(root, 'media', 'shared', '.Trash', '1000', 'files'), 'linux-shared')).toEqual([]);
    expect(await proposedIn(path.join(root, 'D', '$Recycle.Bin', 'S-1-5-21-1'), 'windows-drive')).toEqual([]);
  });

  const userToml = () => path.join(home, '.config', 'uv', 'uv.toml');
  const nodeFs = createRequire(import.meta.url)('fs') as typeof fs;
  /** Runs `act` once, right after the first check of `file` by its path (statSync), or of a descriptor (fstatSync). */
  function afterTheCheck(file: string, act: () => void): () => void {
    const { statSync, fstatSync } = nodeFs;
    let acted = false;
    const once = () => { if (!acted) { acted = true; act(); } };
    nodeFs.statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      const st = (statSync as (...a: unknown[]) => fs.Stats)(p, ...rest);
      if (String(p) === file) once();
      return st;
    }) as typeof fs.statSync;
    nodeFs.fstatSync = ((fd: number, ...rest: unknown[]) => {
      const st = (fstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
      once();
      return st;
    }) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    return () => { nodeFs.statSync = statSync; nodeFs.fstatSync = fstatSync; syncBuiltinESMExports(); };
  }
  /**
   * A writer that opens `fifo` after `ms`, then every 250 ms, and closes it: a reader blocked on its open is let go (it
   * reads an end of file), so a blocking open costs `ms` rather than hanging the run.
   */
  const releaseAfter = (fifo: string, ms: number) => spawn(process.execPath, ['-e', `
    const fs = require('fs'); let tries = 0;
    const go = () => { try { fs.closeSync(fs.openSync(${JSON.stringify(fifo)}, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { if (++tries < 80) setTimeout(go, 250); } };
    setTimeout(go, ${ms});`], { stdio: 'ignore' });

  it('J28. a uv.toml grown past 64 KiB after its check is not read whole, nor taken', async () => {
    uvToml(userToml(), `cache-dir = "${path.join(root, 'grown')}"\n`);
    let undo = () => {};
    try {
      const proposed = await proposedIn(path.join(root, 'grown'), 'grown', () => {
        undo = afterTheCheck(userToml(), () => fs.appendFileSync(userToml(), '# padding\n'.repeat(7000)));
      });
      expect(proposed, 'the grown file was read whole and its cache-dir taken').not.toEqual([]);
    } finally {
      undo();
    }
  });

  it.skipIf(process.platform === 'win32')('J28. a FIFO swapped in after the check: nothing blocks, and what was checked is what is read', async () => {
    uvToml(userToml(), `cache-dir = "${path.join(root, 'from-checked')}"\n`);
    const releaser = releaseAfter(userToml(), 3000);
    let undo = () => {};
    const started = Date.now();
    try {
      const proposed = await proposedIn(path.join(root, 'from-checked'), 'swapped', () => {
        undo = afterTheCheck(userToml(), () => { fs.renameSync(userToml(), `${userToml()}.checked`); execFileSync('mkfifo', [userToml()]); });
      });
      expect(Date.now() - started, 'the open blocked on the FIFO swapped in').toBeLessThan(1500);
      expect(proposed, 'what was read is not what was checked').toEqual([]);
    } finally {
      undo();
      releaser.kill();
    }
  });

  it.skipIf(process.platform === 'win32')('J28. a uv.toml that is a FIFO: its open does not block', async () => {
    fs.mkdirSync(path.dirname(userToml()), { recursive: true });
    execFileSync('mkfifo', [userToml()]);
    const releaser = releaseAfter(userToml(), 3000);
    const started = Date.now();
    try {
      expect(await proposedIn(path.join(root, 'elsewhere-fifo'), 'fifo')).not.toEqual([]);
      expect(Date.now() - started, 'the open blocked on the FIFO').toBeLessThan(1500);
    } finally {
      releaser.kill();
    }
  });

  it('J28. a uv.toml that is a link to a file is read, as uv reads it', async () => {
    uvToml(path.join(root, 'dotfiles', 'uv.toml'), `cache-dir = "${path.join(root, 'from-linked')}"\n`);
    fs.mkdirSync(path.dirname(userToml()), { recursive: true });
    fs.symlinkSync(path.join(root, 'dotfiles', 'uv.toml'), userToml());
    expect(await proposedIn(path.join(root, 'from-linked'), 'linked-toml')).toEqual([]);
  });

  it('J29. a cache-dir of "/", the home, an ancestor of it or a link to it is ignored, and said once; one inside the home is taken', async () => {
    fs.symlinkSync(home, path.join(root, 'home-link'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [n, value] of ['/', home, path.dirname(home), path.join(root, 'home-link')].entries()) {
        uvToml(userToml(), `cache-dir = "${value}"\n`);
        warn.mockClear();
        expect(await proposedIn(path.join(root, `elsewhere-wide-${n}`), `wide-${n}`), `cache-dir = "${value}" hid every proposal`).not.toEqual([]);
        const said = warn.mock.calls.map(c => c.join(' ')).filter(l => l.includes(userToml()));
        expect(said, `cache-dir = "${value}" ignored without a word, or said more than once`).toHaveLength(1);
        expect(said[0]).toContain(value);
      }
      uvToml(userToml(), `cache-dir = "${path.join(home, 'my-uv-cache')}"\n`);
      expect(await proposedIn(path.join(home, 'my-uv-cache'), 'inside-home'), 'a cache-dir inside the home was ignored').toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

