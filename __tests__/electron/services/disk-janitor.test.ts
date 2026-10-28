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
  fleet: JanitorWorld['fleet']; cwds: JanitorWorld['cwds']; dirty: Set<string>; merged: Set<string>; locked: Set<string>;
  named: string[]; images: Array<{ id: string; repo: string; sizeBytes: number; used: boolean }> | null; vm: boolean;
}>;

function world(over: Over = {}): JanitorWorld {
  const wt = (name: string) => path.join(project, '.worktrees', name);
  return {
    home, dataDir: path.join(home, '.tars'), privateDir: path.join(home, '.tars-private'), now,
    projects: [project],
    fleet: over.fleet ?? [{ id: 'agent-live', projectPath: project, worktreePath: wt('agents') }],
    cwds: over.cwds === undefined ? [{ pid: 7, command: 'zsh', cwd: wt('busy') }] : over.cwds,
    worktrees: async () => ['done', 'dirty', 'locked', 'agents', 'busy', 'fresh', 'open'].map(n => ({
      path: wt(n), branch: `b/${n}`, locked: (over.locked ?? new Set(['locked'])).has(n),
    })),
    dirty: async (p) => (over.dirty ?? new Set(['dirty'])).has(path.basename(p)),
    merged: async (_project, branch) => (over.merged ?? new Set(['b/done', 'b/dirty', 'b/locked', 'b/agents', 'b/busy', 'b/fresh'])).has(branch),
    named: (base) => (over.named ?? []).some(n => n === base),
    docker: { images: async () => (over.images === undefined ? [
      { id: 'sha256:unused', repo: 'old/thing:1', sizeBytes: 2e9, used: false },
      { id: 'sha256:used', repo: 'postgres:16', sizeBytes: 4e8, used: true },
    ] : over.images), vm: over.vm ?? true },
    sizeOf: async () => 1024,
  };
}

const ops = (): JanitorOps => ({
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
  mk(path.join(project, 'src'));
  for (const n of ['done', 'dirty', 'locked', 'agents', 'busy', 'open']) {
    mk(path.join(project, '.worktrees', n, '.next'));
    mk(path.join(project, '.worktrees', n, 'test-results'));
    old(path.join(project, '.worktrees', n), 10);
  }
  mk(path.join(project, '.worktrees', 'fresh', '.next'), 1);
  mk(path.join(project, '.worktrees', 'done', 'playwright-report'));
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
    const items = await scanJanitor(world({ named: ['playwright-report'] }));
    expect(items.map(keyOf)).not.toContain('test-artefacts projects/harbor/.worktrees/done/playwright-report');
  });

  it('J9. the processes unread, nothing that needs "nothing runs in it" is proposed', async () => {
    const items = await scanJanitor(world({ cwds: null }));
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
      cwds: [{ pid: 9, command: 'next-server', cwd: path.join(project, '.worktrees', 'open') }],
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
});
