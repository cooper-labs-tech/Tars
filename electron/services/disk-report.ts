import * as fs from 'fs';
import * as path from 'path';
import { shortIdOf } from './agent-tmp';
import type { JanitorItem, JanitorWorld } from './janitor-rules';

/**
 * What agents leave behind on the disk, per project and per agent (2.0.7; an orchestrator's report of 19/11 from the
 * owner's Mac: 4.6 GB of .next in seven worktrees idle for a week went by hand, 5.4 GB sat in the agents' temporary
 * folders, and swap grew by 1.5 GB a minute). Made after each scan of the janitor, which a timer runs every 6 hours
 * (services/disk-janitor.ts), from the same world, and shown in the window, by GET /api/disk/report and disk_report.
 *
 * A worktree's row: its agent (the fleet agent working in it, else the one the worktree tool's registry names), its
 * branch, how long nothing changed in it, what its caches take (.next, release/, test artefacts; node_modules only
 * for a worktree idle 7 days, null for one in use: measuring it costs seconds and nothing would be proposed), and the
 * ids of the janitor's items in it, which the owner approves in one click. An agent's row: what its temporary folders
 * take, and the ids of the items in them. The machine: free disk, swap used and its growth, as measured, null when
 * nothing measured them.
 */

const DAY = 86_400_000;
const NODE_MODULES_IDLE_DAYS = 7;

export type DiskReportMachine = { diskFreeBytes: number | null; swapUsedMb: number | null; swapGrowthMbPerMin: number | null };

export type DiskReportWorktree = {
  path: string;
  name: string;
  agent: string | null;
  branch: string | null;
  idleDays: number;
  bytes: { next: number | null; release: number | null; testArtefacts: number | null; nodeModules: number | null };
  itemIds: string[];
};

export type DiskReport = {
  at: number;
  machine: DiskReportMachine;
  projects: Array<{ project: string; bytes: number; worktrees: DiskReportWorktree[] }>;
  agents: Array<{ id: string; name: string; project: string; status: string | null; tmpBytes: number; itemIds: string[] }>;
  /** What the janitor proposes, all items. */
  proposedBytes: number;
};

const inside = (p: string, dir: string) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const isDir = (p: string) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/** The newest change of a folder's own entries and itself, a shallow read: enough to tell a week-old worktree. */
function shallowChange(dir: string): number {
  let newest = 0;
  try { newest = fs.lstatSync(dir).mtimeMs; } catch { return 0; }
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return newest; }
  for (const n of names) {
    if (n === 'node_modules' || n === '.next' || n === 'release' || n === '.git') continue;
    try { newest = Math.max(newest, fs.lstatSync(path.join(dir, n)).mtimeMs); } catch { /* gone */ }
  }
  return newest;
}

/** The worktree tool's registry (.worktrees/.registry.json): which agent made each worktree, by its name. */
export async function registryOf(project: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(project, '.worktrees', '.registry.json'), 'utf8')) as Record<string, { agent?: unknown }>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v?.agent === 'string').map(([k, v]) => [k, v.agent as string]));
  } catch {
    return {};
  }
}

export async function buildDiskReport(
  world: JanitorWorld,
  items: JanitorItem[],
  opts: { machine: DiskReportMachine; registryOf: (project: string) => Promise<Record<string, string>> },
): Promise<DiskReport> {
  const size = async (p: string) => (isDir(p) ? world.sizeOf(p) : null);
  const projects: DiskReport['projects'] = [];
  for (const project of world.projects) {
    const list = (await world.worktrees(project)) ?? [];
    const registry = await opts.registryOf(project);
    const worktrees: DiskReportWorktree[] = [];
    for (const w of list) {
      const own = path.resolve(w.path) === path.resolve(project);
      const name = own ? path.basename(project) : path.relative(project, w.path);
      const fleet = world.fleet.find(a => path.resolve(a.worktreePath || a.projectPath) === path.resolve(w.path) && (a.worktreePath || own));
      const changed = shallowChange(w.path);
      const idleDays = changed ? Math.floor((world.now - changed) / DAY) : 0;
      const tests = [await size(path.join(w.path, 'test-results')), await size(path.join(w.path, 'playwright-report'))];
      worktrees.push({
        path: w.path, name, branch: w.branch ?? null, idleDays,
        agent: fleet?.name ?? registry[path.basename(w.path)] ?? null,
        bytes: {
          next: await size(path.join(w.path, '.next')),
          release: await size(path.join(w.path, 'release')),
          testArtefacts: tests.every(t => t === null) ? null : tests.reduce<number>((s, t) => s + (t ?? 0), 0),
          nodeModules: idleDays >= NODE_MODULES_IDLE_DAYS && !own ? await size(path.join(w.path, 'node_modules')) : null,
        },
        itemIds: items.filter(i => i.path && inside(i.path, w.path) && !(own && list.some(o => o.path !== w.path && inside(i.path!, o.path)))).map(i => i.id),
      });
    }
    const bytes = worktrees.reduce((s, w) => s + Object.values(w.bytes).reduce<number>((a, b) => a + (b ?? 0), 0), 0);
    projects.push({ project, bytes, worktrees });
  }
  const agents: DiskReport['agents'] = [];
  for (const a of world.fleet) {
    const root = path.join(world.dataDir, 'tmp', shortIdOf(a.id));
    agents.push({
      id: a.id, name: a.name || a.id, project: a.projectPath, status: a.status ?? null,
      tmpBytes: (await size(root)) ?? 0,
      itemIds: items.filter(i => i.path && inside(i.path, root)).map(i => i.id),
    });
  }
  return { at: world.now, machine: { ...opts.machine }, projects, agents, proposedBytes: items.reduce((s, i) => s + i.sizeBytes, 0) };
}

/** The report as an agent of a project reads it: that project's rows and agents, the machine's figures. */
export function reportForProject(report: DiskReport, project: string): DiskReport {
  return { ...report, projects: report.projects.filter(p => p.project === project), agents: report.agents.filter(a => a.project === project) };
}
