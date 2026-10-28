import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanJanitor, approveJanitor, type JanitorWorld, type JanitorOps } from '../../../electron/services/janitor-rules';
import { shortIdOf } from '../../../electron/services/agent-tmp';

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

