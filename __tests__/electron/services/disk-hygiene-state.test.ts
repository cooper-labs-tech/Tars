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
  mk(path.join(wt(project, 'idle'), 'release'), 10);
  mk(path.join(wt(project, 'idle'), '.next'), 10);
  mk(path.join(wt(project, 'active'), 'node_modules', 'x'), 0);
  mk(path.join(wt(project, 'active'), 'release'), 0);
  mk(path.join(wt(other, 'old'), 'release'), 10);
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
