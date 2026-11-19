import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createJanitor } from '../../../electron/services/janitor-state';
import { buildDiskReport } from '../../../electron/services/disk-report';
import type { JanitorWorld, JanitorOps } from '../../../electron/services/janitor-rules';

/**
 * Disk hygiene in the janitor's state (2.0.7): a scan an agent waits for at most a while, cleanup requests the owner
 * approves in one click, the report of what agents leave behind, and the periodic scan that makes it.
 *
 * How it fails, written before the code:
 * S1. An agent asking for a scan while one runs, or one that takes longer than its wait, waits for the whole scan:
 *     past the 30 s an MCP call waits it gets nothing (the owner's Mac, 19/11). It must be answered within its wait,
 *     told the scan runs, with what the last ended scan found in its project.
 * S2. A cleanup request deletes anything, or counts as the owner's approval.
 * S3. A request names an id the last scan did not show, or one outside the caller's project, and is recorded anyway:
 *     one click would then delete another project's folders.
 * S4. A request with no id, more than 200, a repeated one, or a reason that is not a short text is recorded.
 * S5. The window cannot approve a request in one call, or approving it deletes anything but its ids, approves it twice,
 *     or approves a request that is not there.
 * S6. The report is not made after a scan, or an agent reads another project's rows or agents.
 * S7. A periodic scan starts while one runs (two at once), or says nobody asked.
 * S8. (the Audit's L1 on #606, written before its code) A request names its items by id only: the window cannot show
 *     what each one is, its size, nor the rule it matched.
 * S9. (QA's spec on #606, F2, written before its code) Once approved, a request cannot say what became of each of its
 *     items (deleted and its bytes, kept or failed and why) nor what it freed; or it says so only until the next
 *     scan replaces the items the window showed; or a waiting request already claims an outcome or bytes freed.
 * S10. The window's approval of the same ids from the scan's list writes into a request it did not approve.
 * And of the report itself (services/disk-report.ts):
 * D1. A worktree's row lacks its agent: the fleet agent working in it, else the one the worktree tool's registry names.
 * D2. A worktree's caches (.next, release, test artefacts) are not measured; or an active worktree's node_modules is,
 *     which costs seconds for nothing anyone may delete: it is said in use (null).
 * D3. An item is not tied to its worktree or its agent, so a row cannot be approved.
 * D4. The machine's free disk, swap and swap growth are missing, or read 0 when nothing measured them (null).
 */

const DAY = 86_400_000;
let root: string;
let home: string;
let project: string;
let other: string;
let now: number;
let gone: string[];

function mk(p: string, days: number): string {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'f'), 'x'.repeat(4096));
  const t = new Date(now - days * DAY);
  fs.utimesSync(path.join(p, 'f'), t, t);
  fs.utimesSync(p, t, t);
  return p;
}
const wt = (p: string, n: string) => path.join(p, '.worktrees', n);

function world(slowDocker: { ms: number }): JanitorWorld {
  return {
    home, dataDir: path.join(home, '.tars'), privateDir: path.join(home, '.tars-private'), now, projects: [project, other],
    fleet: [{ id: 'w', projectPath: project, worktreePath: wt(project, 'active'), name: 'Harbor Worker', status: 'idle', sessions: [] }],
    processes: [],
    worktrees: async (p) => (p === project ? ['idle', 'active'] : ['old']).map(n => ({ path: wt(p, n), branch: `b/${n}`, locked: false })),
    dirty: async () => false, merged: async () => false, ignored: async () => [], operation: async () => null,
    named: () => false,
    docker: { images: async () => { await new Promise(r => setTimeout(r, slowDocker.ms)); return null; }, vm: false },
    sizeOf: async (p) => (fs.existsSync(p) ? 4096 : 0),
    tracking: async () => 'ignored',
  };
}

let slow: { ms: number };
const ops = (): JanitorOps => ({ rm: async (p) => { gone.push(p); fs.rmSync(p, { recursive: true, force: true }); }, removeWorktree: async () => {}, dockerRm: async () => {}, trim: async () => {}, log: () => {} });
function janitor() {
  return createJanitor({
    world: async () => world(slow), ops: ops(), logFile: path.join(root, 'janitor.log'), broadcast: () => {},
    report: async (w, items) => buildDiskReport(w, items, { machine: { diskFreeBytes: 1e9, swapUsedMb: null, swapGrowthMbPerMin: null }, registryOf: async () => ({}) }),
  });
}
const lead = () => ({ id: 'lead', name: 'Harbor Lead', project });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-state-')));
  home = path.join(root, 'home');
  project = path.join(home, 'projects', 'harbor');
  other = path.join(home, 'projects', 'quay');
  now = Date.now();
  gone = [];
  slow = { ms: 0 };
  fs.mkdirSync(path.join(wt(project, 'idle'), 'release'), { recursive: true });
  fs.writeFileSync(path.join(wt(project, 'idle'), 'release', 'App-1.0.0.dmg'), 'x'.repeat(4096));
  fs.writeFileSync(path.join(wt(project, 'idle'), 'release', 'builder-debug.yml'), 'x: 1\n');
  fs.writeFileSync(path.join(wt(project, 'idle'), 'release', 'latest-mac.yml'), 'version: 1\n');
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(project, 'idle'), 'release', 'latest-mac.yml'), t, t); }
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(project, 'idle'), 'release', 'App-1.0.0.dmg'), t, t); }
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(project, 'idle'), 'release', 'builder-debug.yml'), t, t); }
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(project, 'idle'), 'release'), t, t); }
  mk(path.join(wt(project, 'idle'), '.next'), 10);
  mk(path.join(wt(project, 'active'), 'node_modules', 'x'), 0);
  mk(path.join(wt(project, 'active'), 'release'), 0);
  fs.mkdirSync(path.join(wt(other, 'old'), 'release'), { recursive: true });
  fs.writeFileSync(path.join(wt(other, 'old'), 'release', 'App-1.0.0.dmg'), 'x'.repeat(4096));
  fs.writeFileSync(path.join(wt(other, 'old'), 'release', 'builder-debug.yml'), 'x: 1\n');
  fs.writeFileSync(path.join(wt(other, 'old'), 'release', 'latest-mac.yml'), 'version: 1\n');
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(other, 'old'), 'release', 'latest-mac.yml'), t, t); }
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(other, 'old'), 'release', 'App-1.0.0.dmg'), t, t); }
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(other, 'old'), 'release', 'builder-debug.yml'), t, t); }
  { const t = new Date(now - 10 * DAY); fs.utimesSync(path.join(wt(other, 'old'), 'release'), t, t); }
  for (const w of [wt(project, 'idle'), wt(other, 'old')]) { const t = new Date(now - 10 * DAY); fs.utimesSync(w, t, t); }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('a scan an agent waits for at most a while', () => {
  it('S1: answered within its wait while the scan runs, with the last ended scan\'s items of its project', async () => {
    const j = janitor();
    const ended = await j.scanFor(lead(), 30_000);
    expect(ended.running).toBe(false);
    expect(ended.items.length).toBeGreaterThan(0);
    slow.ms = 2_000;
    const started = Date.now();
    const asked = await j.scanFor({ id: 'lead2', name: 'Another', project }, 200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(asked.running).toBe(true);
    expect(asked.items.map(i => i.path).sort()).toEqual(ended.items.map(i => i.path).sort());
    expect(asked.items.every(i => (i.path ?? '').startsWith(project))).toBe(true);
    const later = await j.scanFor({ id: 'lead2', name: 'Another', project }, 10_000);
    expect(later.running).toBe(false);
  });
});

describe('cleanup requests', () => {
  it('S2, S3, S4: recorded only for ids of the last scan in the caller\'s project, deleting nothing', async () => {
    const j = janitor();
    await j.scan(null);
    const all = j.state().scan!.items;
    const mine = all.filter(i => i.path.startsWith(project)).map(i => i.id);
    const theirs = all.filter(i => i.path.startsWith(other)).map(i => i.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(j.request(lead(), [...mine, ...theirs], 'disk low')).toMatchObject({ ok: false, status: 403 });
    expect(j.request(lead(), ['not-an-id'], 'disk low')).toMatchObject({ ok: false, status: 403 });
    expect(j.request(lead(), [], 'disk low')).toMatchObject({ ok: false, status: 400 });
    expect(j.request(lead(), Array.from({ length: 201 }, (_, i) => `x${i}`), 'disk low')).toMatchObject({ ok: false, status: 400 });
    expect(j.request(lead(), mine, 'x'.repeat(301))).toMatchObject({ ok: false, status: 400 });
    expect(j.request(lead(), mine, 42 as unknown as string)).toMatchObject({ ok: false, status: 400 });
    const asked = j.request(lead(), [...mine, mine[0]], 'disk low');
    expect(asked).toMatchObject({ ok: true });
    const shown = j.state().cleanupRequests;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ by: 'Harbor Lead', project, why: 'disk low', state: 'waiting' });
    expect(shown[0].ids.sort()).toEqual([...mine].sort());
    // S8: each item as the window shows it.
    const byId = new Map(all.map(i => [i.id, i]));
    expect(shown[0].items.map(i => i.id).sort()).toEqual([...mine].sort());
    for (const item of shown[0].items) {
      const scanned = byId.get(item.id)!;
      expect(item).toEqual({ id: scanned.id, kind: scanned.kind, label: scanned.label, path: scanned.path, bytes: scanned.bytes, rule: scanned.rule });
    }
    expect(gone).toEqual([]);
  });

  it('S5: one call of the window approves exactly its ids, once; an unknown request is refused', async () => {
    const j = janitor();
    await j.scan(null);
    const mine = j.state().scan!.items.filter(i => i.path.startsWith(project));
    const asked = j.request(lead(), mine.map(i => i.id), 'disk low');
    if (!asked.ok) throw new Error('refused');
    await expect(j.approveRequest('jr-unknown')).rejects.toThrow();
    const report = await j.approveRequest(asked.id);
    expect(report.removed).toBe(mine.length);
    expect(gone.sort()).toEqual(mine.map(i => i.path).sort());
    expect(j.state().cleanupRequests[0].state).toBe('approved');
    await expect(j.approveRequest(asked.id)).rejects.toThrow();
    expect(fs.existsSync(path.join(wt(other, 'old'), 'release'))).toBe(true);
  });

  it('S9: an approved request keeps what became of each item and what it freed, past the next scan', async () => {
    const j = janitor();
    await j.scan(null);
    const mine = j.state().scan!.items.filter(i => i.path.startsWith(project));
    const cache = mine.find(i => i.kind === 'next-cache');
    if (!cache) throw new Error('no .next item in the fixture');
    expect(mine.length).toBeGreaterThan(1);
    const asked = j.request(lead(), mine.map(i => i.id), 'disk low');
    if (!asked.ok) throw new Error('refused');
    const waiting = j.state().cleanupRequests[0];
    expect(waiting.freedBytes).toBe(0);
    expect(waiting.items.every(i => i.outcome === undefined)).toBe(true);
    // By the time of the click, one item no longer matches its rule: it is kept, and says why.
    fs.writeFileSync(path.join(cache.path, 'fresh'), 'x');
    await j.approveRequest(asked.id);
    const approved = j.state().cleanupRequests[0];
    const deleted = mine.filter(i => i.id !== cache.id);
    for (const i of deleted) expect(approved.items.find(r => r.id === i.id)!.outcome).toEqual({ kind: 'deleted', bytes: i.bytes });
    expect(approved.items.find(r => r.id === cache.id)!.outcome).toMatchObject({ kind: 'kept', why: expect.stringMatching(/no longer matches/) });
    expect(approved.freedBytes).toBe(deleted.reduce((sum, i) => sum + (i.bytes ?? 0), 0));
    expect(approved.freedBytes).toBeGreaterThan(0);
    // Kept past the next scan, which replaces the items the window showed.
    await j.scan(null);
    const later = j.state().cleanupRequests[0];
    expect(later.items.map(i => i.outcome)).toEqual(approved.items.map(i => i.outcome));
    expect(later.freedBytes).toBe(approved.freedBytes);
  });

  it('S10: the window\'s approval of the same ids from the scan writes nothing into a request it did not approve', async () => {
    const j = janitor();
    await j.scan(null);
    const mine = j.state().scan!.items.filter(i => i.path.startsWith(project));
    const asked = j.request(lead(), mine.map(i => i.id), 'disk low');
    if (!asked.ok) throw new Error('refused');
    await j.approve(mine.map(i => i.id));
    expect(gone.length).toBeGreaterThan(0);
    const still = j.state().cleanupRequests[0];
    expect(still.state).toBe('waiting');
    expect(still.freedBytes).toBe(0);
    expect(still.items.every(i => i.outcome === undefined)).toBe(true);
  });
});

describe('the report and the periodic scan', () => {
  it('S6, D1, D2, D3: made after a scan, a worktree with its agent, its caches, its items; an active node_modules in use', async () => {
    const j = janitor();
    await j.scan(null);
    const report = j.state().report!;
    expect(report).toBeTruthy();
    const harbor = report.projects.find(p => p.project === project)!;
    const idle = harbor.worktrees.find(w => w.path === wt(project, 'idle'))!;
    const active = harbor.worktrees.find(w => w.path === wt(project, 'active'))!;
    expect(active.agent).toBe('Harbor Worker');
    expect(idle.bytes.release).toBeGreaterThan(0);
    expect(idle.bytes.next).toBeGreaterThan(0);
    expect(active.bytes.nodeModules).toBeNull();
    expect(idle.itemIds.length).toBeGreaterThanOrEqual(2);
    const scoped = j.reportFor(project);
    expect(scoped!.projects.map(p => p.project)).toEqual([project]);
    expect(scoped!.agents.every(a => a.project === project)).toBe(true);
  });

  it('D1: the worktree tool\'s registry names the agent of a worktree no fleet agent works in', async () => {
    const r = await buildDiskReport(world(slow), [], {
      machine: { diskFreeBytes: null, swapUsedMb: null, swapGrowthMbPerMin: null },
      registryOf: async (p) => (p === project ? { idle: 'Tars-QA' } : {}),
    });
    expect(r.projects.find(p => p.project === project)!.worktrees.find(w => w.path === wt(project, 'idle'))!.agent).toBe('Tars-QA');
  });

  it('D4: the machine\'s figures as measured, null when nothing measured them', async () => {
    const r = await buildDiskReport(world(slow), [], { machine: { diskFreeBytes: 5e9, swapUsedMb: 20_000, swapGrowthMbPerMin: 1_500 }, registryOf: async () => ({}) });
    expect(r.machine).toEqual({ diskFreeBytes: 5e9, swapUsedMb: 20_000, swapGrowthMbPerMin: 1_500 });
    const none = await buildDiskReport(world(slow), [], { machine: { diskFreeBytes: null, swapUsedMb: null, swapGrowthMbPerMin: null }, registryOf: async () => ({}) });
    expect(none.machine.swapUsedMb).toBeNull();
  });

  it('S7: a periodic scan says who started it, and never runs beside another', async () => {
    const j = janitor();
    slow.ms = 500;
    const first = j.scan(null, { by: 'Tars, every 6 hours' });
    const second = j.scan(null, { by: 'Tars, every 6 hours' });
    expect(j.state().scan?.askedBy).toBe('Tars, every 6 hours');
    await Promise.all([first, second]);
    expect(j.scansStarted()).toBe(1);
  });
});
