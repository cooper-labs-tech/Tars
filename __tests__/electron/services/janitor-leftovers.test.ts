import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanJanitor, approveJanitor, type JanitorWorld, type JanitorOps } from '../../../electron/services/janitor-rules';
import { shortIdOf } from '../../../electron/services/agent-tmp';

/**
 * What agents leave behind, proposed by the janitor (2.0.7; an orchestrator's report of 19/11 from the owner's Mac:
 * disk_scan timed out after 30 s and 4.6 GB of .next went by hand). Measured that night: the agents' temporary folders
 * held 5.4 GB (3 GB of old outputs in their current sessions' scratchpads, 0.4 GB in ended sessions'), no rule
 * proposed any of it for an agent still in the fleet; an electron-builder release/ held 475 MB; and a replay of the
 * scan took 57 s, 38.8 s of it walking the npx cache, while each approved item ran the whole scan again.
 *
 * How it fails, written before the code:
 * L1. An ended session's folder in a live agent's temporary folders (~/.tars/tmp/<id>/c/<user>/<project>/<session>,
 *     the session neither its current nor its resumable one) untouched for 3 days is not proposed; or the current one
 *     is; or, with no session known for the agent, its newest session is taken for ended.
 * L2. An entry of the current session's scratchpad, or of the agent's TMPDIR (t/), untouched for 7 days is not
 *     proposed; or a fresher one is; or one a report names, or a process works in, is.
 * L3. A release/ folder (electron-builder's output) of a project or a worktree, untouched for 3 days, nothing running
 *     in it, is not proposed; or a fresh one, or one a process works in, is.
 * L4. The node_modules of a worktree idle for 7 days (caches aside) is not proposed, because a node_modules of more
 *     than 20,000 entries reads as just touched; or that of an active worktree, of a fleet agent's, of one a process
 *     works in, or of the project itself, is.
 * L5. A temporary item does not carry its agent's project, so its project's orchestrator is never shown it.
 * L6. The npx cache is walked to its last file: an entry of 30,000 files takes seconds, under load tens.
 * L7. An approved item is checked again by the whole scan, Docker included: approving four items with a Docker that
 *     answers in 40 s took four whole scans. The re-check reads its own kind's rule, in its own place, only.
 * And from the Audit's M1 on #605 (written before its fix):
 * L8. Any folder named release/ is proposed as electron-builder's output: a user's own source release/ folder could
 *     go in one click. Only one git ignores, or does not track, with no tracked file in it, holding electron-builder's
 *     marker (builder-debug.yml, as the Tars checkout's release/ holds it, or builder-effective-config.yaml); at a
 *     project's root, only an ignored one (an untracked one is uncommitted work); and the re-check applies the same.
 */

const DAY = 86_400_000;
let root: string;
let home: string;
let project: string;
let now: number;

const old = (p: string, days: number) => { const t = new Date(now - days * DAY); fs.utimesSync(p, t, t); };
function mk(p: string, ageDays = 10, files = 1): string {
  fs.mkdirSync(p, { recursive: true });
  for (let i = 0; i < files; i++) { fs.writeFileSync(path.join(p, `f${i}`), 'x'); old(path.join(p, `f${i}`), ageDays); }
  old(p, ageDays);
  return p;
}
const ageTree = (dir: string, days: number) => {
  const walk = (p: string) => { const st = fs.lstatSync(p); if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n)); old(p, days); };
  walk(dir);
};

type Over = Partial<{ fleet: JanitorWorld['fleet']; processes: JanitorWorld['processes']; named: string[]; images: () => Promise<null>; tracking: Record<string, 'tracked' | 'ignored' | 'untracked'> }>;
const wt = (n: string) => path.join(project, '.worktrees', n);
const tmpOf = (id: string) => path.join(home, '.tars', 'tmp', shortIdOf(id));
const sessionsOf = (id: string) => path.join(tmpOf(id), 'c', 'claude-501', project.replace(/[^a-zA-Z0-9]/g, '-'));

function world(over: Over = {}): JanitorWorld {
  return {
    home, dataDir: path.join(home, '.tars'), privateDir: path.join(home, '.tars-private'), now, projects: [project],
    fleet: over.fleet ?? [{ id: 'live', projectPath: project, sessions: ['sess-now'] }],
    processes: over.processes === undefined ? [] : over.processes,
    worktrees: async () => ['idle', 'active', 'busy'].map(n => ({ path: wt(n), branch: `b/${n}`, locked: false })),
    dirty: async () => false,
    merged: async () => false,
    ignored: async () => [],
    operation: async () => null,
    named: (folder) => (over.named ?? []).some(n => folder === n),
    docker: { images: over.images ?? (async () => null), vm: false },
    sizeOf: async () => 1000,
    // As git says it: ignored unless a test says otherwise.
    tracking: async (dir) => over.tracking?.[dir] ?? 'ignored',
  };
}
/** A release/ as electron-builder leaves it: its marker inside. */
function release(dir: string, days: number, marker = 'builder-debug.yml'): string {
  mk(dir, days);
  if (marker) { fs.writeFileSync(path.join(dir, marker), 'x: 1\n'); old(path.join(dir, marker), days); old(dir, days); }
  return dir;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-leftovers-')));
  home = path.join(root, 'home');
  project = path.join(home, 'projects', 'harbor');
  now = Date.now();
  for (const n of ['idle', 'active', 'busy']) fs.mkdirSync(wt(n), { recursive: true });
  mk(path.join(wt('idle'), 'node_modules', 'left-pad'), 10);
  release(path.join(wt('idle'), 'release'), 10);
  ageTree(wt('idle'), 10);
  mk(path.join(wt('active'), 'node_modules', 'left-pad'), 10);
  release(path.join(wt('active'), 'release'), 1);
  mk(path.join(wt('active'), 'src'), 0);
  mk(path.join(wt('busy'), 'node_modules', 'left-pad'), 10);
  release(path.join(wt('busy'), 'release'), 10);
  ageTree(wt('busy'), 10);
  release(path.join(project, 'release'), 10);
  mk(path.join(sessionsOf('live'), 'sess-old', 'scratchpad', 'out-run'), 10);
  ageTree(path.join(sessionsOf('live'), 'sess-old'), 10);
  mk(path.join(sessionsOf('live'), 'sess-now', 'scratchpad', 'out-old'), 10);
  mk(path.join(sessionsOf('live'), 'sess-now', 'scratchpad', 'out-new'), 1);
  mk(path.join(tmpOf('live'), 't', 'traces'), 10);
  mk(path.join(tmpOf('live'), 't', 'compile-cache'), 1);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const kindsAt = async (w: JanitorWorld) => new Map((await scanJanitor(w)).filter(i => i.path).map(i => [i.path!, i]));

describe('what agents leave in their temporary folders', () => {
  it('L1, L2, L5: an ended session, old entries of the current one and of the TMPDIR; never fresh ones', async () => {
    const at = await kindsAt(world());
    expect(at.get(path.join(sessionsOf('live'), 'sess-old'))?.kind).toBe('session-scratchpad');
    expect(at.get(path.join(sessionsOf('live'), 'sess-now', 'scratchpad', 'out-old'))?.kind).toBe('agent-tmp-entry');
    expect(at.get(path.join(tmpOf('live'), 't', 'traces'))?.kind).toBe('agent-tmp-entry');
    for (const fresh of [path.join(sessionsOf('live'), 'sess-now'), path.join(sessionsOf('live'), 'sess-now', 'scratchpad', 'out-new'), path.join(tmpOf('live'), 't', 'compile-cache')]) {
      expect(at.get(fresh), fresh).toBeUndefined();
    }
    for (const item of [...at.values()].filter(i => i.kind === 'session-scratchpad' || i.kind === 'agent-tmp-entry')) expect(item.project).toBe(project);
  });

  it('L1: with no session known, the newest session is taken for current, never proposed', async () => {
    const at = await kindsAt(world({ fleet: [{ id: 'live', projectPath: project, sessions: [] }] }));
    // sess-now holds the freshest file: it is the current one.
    expect(at.get(path.join(sessionsOf('live'), 'sess-now'))).toBeUndefined();
    expect(at.get(path.join(sessionsOf('live'), 'sess-old'))?.kind).toBe('session-scratchpad');
  });

  it('L2: one a report names, or a process works in, is kept', async () => {
    const named = path.join(tmpOf('live'), 't', 'traces');
    const busy = path.join(sessionsOf('live'), 'sess-now', 'scratchpad', 'out-old');
    const at = await kindsAt(world({ named: [named], processes: [{ pid: 7, command: 'node run.js', paths: [busy] }] }));
    expect(at.get(named)).toBeUndefined();
    expect(at.get(busy)).toBeUndefined();
  });
});

describe('build outputs and caches of worktrees', () => {
  it('L3: an old release/ of a worktree or of the project; never a fresh one, nor one a process works in', async () => {
    const at = await kindsAt(world({ processes: [{ pid: 8, command: 'node', paths: [wt('busy')] }] }));
    expect(at.get(path.join(wt('idle'), 'release'))?.kind).toBe('release-folder');
    expect(at.get(path.join(project, 'release'))?.kind).toBe('release-folder');
    expect(at.get(path.join(wt('active'), 'release'))).toBeUndefined();
    expect(at.get(path.join(wt('busy'), 'release'))).toBeUndefined();
  });

  it('L4: the node_modules of a worktree idle 7 days, however many entries it holds; never an active, busy or agent\'s one', async () => {
    mk(path.join(wt('idle'), 'node_modules', 'big'), 10, 21_000);
    ageTree(wt('idle'), 10);
    const at = await kindsAt(world({
      fleet: [{ id: 'live', projectPath: project, sessions: ['sess-now'] }, { id: 'w2', projectPath: project, worktreePath: wt('active') }],
      processes: [{ pid: 8, command: 'node', paths: [wt('busy')] }],
    }));
    expect(at.get(path.join(wt('idle'), 'node_modules'))?.kind).toBe('worktree-node-modules');
    expect(at.get(path.join(wt('active'), 'node_modules'))).toBeUndefined();
    expect(at.get(path.join(wt('busy'), 'node_modules'))).toBeUndefined();
    expect(at.get(path.join(project, 'node_modules'))).toBeUndefined();
  }, 60_000);
});

describe('the scan\'s cost', () => {
  it('L6: an npx entry of 30,000 files is read in well under a second', async () => {
    const entry = path.join(home, '.npm', '_npx', 'bighash');
    mk(path.join(entry, 'node_modules', 'pkg'), 30, 30_000);
    ageTree(entry, 30);
    const started = Date.now();
    const items = await scanJanitor(world());
    expect(items.find(i => i.path === entry)?.kind).toBe('npx-cache');
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 120_000);

  it('L7: approving a folder does not run Docker\'s step again', async () => {
    let slow = false;
    const w = () => world({ images: async () => { if (slow) await new Promise(r => setTimeout(r, 3_000)); return null; } });
    const items = await scanJanitor(w());
    slow = true;
    const ids = items.filter(i => i.kind === 'release-folder' || i.kind === 'agent-tmp-entry').map(i => i.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const gone: string[] = [];
    const ops: JanitorOps = { rm: async (p) => { gone.push(p); }, removeWorktree: async () => {}, dockerRm: async () => {}, trim: async () => {}, log: () => {} };
    const started = Date.now();
    const report = await approveJanitor(ids, w, ops);
    expect(report.removed).toBe(ids.length);
    expect(Date.now() - started).toBeLessThan(2_500);
  }, 30_000);
});

describe('a release/ folder is electron-builder\'s output only on its evidence (the Audit\'s M1 on #605)', () => {
  it('L8: never one without the builder\'s marker, one git tracks anything in, or an untracked one at a project\'s root', async () => {
    const own = path.join(wt('idle'), 'release');
    fs.rmSync(path.join(own, 'builder-debug.yml'));
    old(own, 10);
    const ownAtRoot = path.join(project, 'release');
    const at = await kindsAt(world({ tracking: { [ownAtRoot]: 'tracked' } }));
    expect(at.get(own), 'no marker: a user\'s own release/').toBeUndefined();
    expect(at.get(ownAtRoot), 'tracked files inside').toBeUndefined();
    const untrackedRoot = await kindsAt(world({ tracking: { [ownAtRoot]: 'untracked' } }));
    expect(untrackedRoot.get(ownAtRoot), 'untracked at a project\'s root: uncommitted work').toBeUndefined();
  });

  it('L8: an ignored one with the marker, or an untracked one in a worktree; the other marker counts too', async () => {
    const effective = release(path.join(wt('idle'), 'release'), 10, 'builder-effective-config.yaml');
    const inWorktree = await kindsAt(world({ tracking: { [effective]: 'untracked' } }));
    expect(inWorktree.get(effective)?.kind).toBe('release-folder');
    expect((await kindsAt(world())).get(path.join(project, 'release'))?.kind).toBe('release-folder');
  });

  it('L8: the re-check applies the same rule: one git tracks since the scan is kept', async () => {
    const root = path.join(project, 'release');
    const items = await scanJanitor(world());
    const id = items.find(i => i.path === root)!.id;
    const gone: string[] = [];
    const ops: JanitorOps = { rm: async (p) => { gone.push(p); }, removeWorktree: async () => {}, dockerRm: async () => {}, trim: async () => {}, log: () => {} };
    const report = await approveJanitor([id], () => world({ tracking: { [root]: 'tracked' } }), ops);
    expect(gone).toEqual([]);
    expect(report.kept.map(k => k.id)).toEqual([id]);
  });
});
