import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { shortIdOf } from './agent-tmp';

/**
 * The disk janitor's rules (2.0.5, lot 3 item H; brief lot3-disk-janitor-2810.md, with the orchestrator's additions of
 * 28/10). A scan proposes, by rule, only what is on this list, each item with its size and the rule that matched, and
 * never deletes anything. The owner ticks and approves in the window; each approved item is checked again against its
 * rule at the moment it goes, deleted by its exact absolute path (never a glob, never a shell), and logged with what
 * it freed.
 *
 * The list:
 * - next-cache: the `.next` of a project's worktree (under `.worktrees/`), untouched for 3 days;
 * - test-artefacts: `test-results` and `playwright-report` of a worktree, untouched for 3 days, that no report names;
 * - closed-worktree: a worktree whose branch is merged into its project's main branch, clean, unlocked, idle a day,
 *   removed by `git worktree remove` (never --force), as scripts/worktree.mjs does;
 * - npx-cache: an entry of ~/.npm/_npx untouched for 14 days;
 * - docker-image: an image no container uses, a stopped one included (`docker image rm`, never -f, never a volume);
 * - docker-vm-trim: a trim of the Docker VM (colima), which gives the disk back what the VM freed;
 * - agent-tmp: the temporary folders (~/.tars/tmp/<id>) of an agent no longer in the fleet.
 * Never, whatever matches: ~/.tars-private, ~/Documents, the uv cache, the Trash, ~/Library/Developer (Xcode, the iOS
 * runtimes and simulators), a Docker volume, a project's own folder, anything inside a worktree a fleet agent works
 * in, one with uncommitted work, or one a process works in. When the processes cannot be read (no lsof, Windows),
 * nothing that needs "nothing runs in it" is proposed.
 */

export type JanitorKind = 'next-cache' | 'test-artefacts' | 'closed-worktree' | 'npx-cache' | 'docker-image' | 'docker-vm-trim' | 'agent-tmp';

export type JanitorItem = {
  id: string;
  kind: JanitorKind;
  /** What goes: a folder's absolute path. */
  path?: string;
  /** A Docker image's id, or `colima` for the trim. */
  ref?: string;
  /** The worktree or the project it is in. */
  project?: string;
  label: string;
  sizeBytes: number;
  rule: string;
};

export interface JanitorWorld {
  home: string;
  dataDir: string;
  privateDir: string;
  now: number;
  projects: string[];
  fleet: Array<{ id: string; projectPath: string; worktreePath?: string }>;
  /** Every process's working folder, or null when they cannot be read. */
  cwds: Array<{ pid: number; command: string; cwd: string }> | null;
  worktrees(project: string): Promise<Array<{ path: string; branch?: string; locked: boolean }> | null>;
  /** Uncommitted work in it; null when git cannot say. */
  dirty(worktree: string): Promise<boolean | null>;
  /** Merged into the project's main branch; null when git cannot say. */
  merged(project: string, branch: string): Promise<boolean | null>;
  /** A report names this folder (by its path, as reports cite their runs). */
  named(folder: string): boolean;
  docker: { images(): Promise<Array<{ id: string; repo: string; sizeBytes: number; used: boolean }> | null>; vm: boolean };
  sizeOf(p: string): Promise<number>;
}

export interface JanitorOps {
  rm(p: string): Promise<void>;
  removeWorktree(project: string, p: string): Promise<void>;
  dockerRm(id: string): Promise<void>;
  trim(): Promise<void>;
  log(line: string): void;
}

const DAY = 86_400_000;
const CACHE_IDLE_DAYS = 3;
const WORKTREE_IDLE_DAYS = 1;
const NPX_IDLE_DAYS = 14;
/** Past this many entries the newest change is not looked for further, and the folder reads as just touched. */
const WALK_MAX = 20_000;

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const idOf = (kind: string, what: string) => createHash('sha256').update(`${kind}\0${what}`).digest('hex').slice(0, 16);
const isDir = (p: string) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/** The newest change in a folder, links not followed; `now` past WALK_MAX entries (as if just touched). */
function newestChange(dir: string, now: number): number {
  let newest = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const at = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.lstatSync(at); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (++seen > WALK_MAX) return now;
    if (!st.isDirectory()) continue;
    let names: string[] = [];
    try { names = fs.readdirSync(at); } catch { continue; }
    for (const n of names) stack.push(path.join(at, n));
  }
  return newest;
}

/** The never list: folders nothing is ever proposed in. */
function never(world: JanitorWorld): string[] {
  const h = world.home;
  return [
    world.privateDir, path.join(h, 'Documents'), path.join(h, '.cache', 'uv'), path.join(h, 'Library', 'Caches', 'uv'),
    path.join(h, '.Trash'), path.join(h, 'Library', 'Developer'), '/Library/Developer',
  ].map(real);
}

/** Why a folder is not the janitor's to propose, or undefined. */
function kept(world: JanitorWorld, p: string, worktree?: string): string | undefined {
  const at = real(p);
  if (never(world).some(n => inside(at, n))) return 'it is on the never list';
  if (world.cwds === null) return 'the processes cannot be read';
  const user = world.cwds.find(c => inside(real(c.cwd), worktree ? real(worktree) : at));
  if (user) return `${user.command} (${user.pid}) works in it`;
  if (worktree && world.fleet.some(a => real(a.worktreePath || a.projectPath) === real(worktree))) return 'an agent of the fleet works in it';
  return undefined;
}

async function scanWorktrees(world: JanitorWorld, out: JanitorItem[]): Promise<void> {
  for (const project of world.projects) {
    const list = await world.worktrees(project);
    if (!list) continue;
    const base = real(path.join(project, '.worktrees'));
    for (const w of list) {
      const wt = real(w.path);
      if (!inside(wt, base) || wt === base || real(project) === wt) continue;
      if (kept(world, wt, wt)) continue;
      if ((await world.dirty(wt)) !== false) continue;
      const name = path.relative(project, wt);
      for (const [kind, dirName] of [['next-cache', '.next'], ['test-artefacts', 'test-results'], ['test-artefacts', 'playwright-report']] as const) {
        const p = path.join(wt, dirName);
        if (!isDir(p)) continue;
        if (newestChange(p, world.now) > world.now - CACHE_IDLE_DAYS * DAY) continue;
        if (kind === 'test-artefacts' && world.named(p)) continue;
        out.push({
          id: idOf(kind, p), kind, path: p, project: wt, label: `${name}/${dirName}`, sizeBytes: await world.sizeOf(p),
          rule: kind === 'next-cache'
            ? `the .next of a worktree nothing runs in, untouched for ${CACHE_IDLE_DAYS} days`
            : `test artefacts of a worktree nothing runs in, untouched for ${CACHE_IDLE_DAYS} days, named by no report`,
        });
      }
      if (w.locked || !w.branch || (await world.merged(project, w.branch)) !== true) continue;
      if (newestChange(wt, world.now) > world.now - WORKTREE_IDLE_DAYS * DAY) continue;
      out.push({
        id: idOf('closed-worktree', wt), kind: 'closed-worktree', path: wt, project, label: name, sizeBytes: await world.sizeOf(wt),
        rule: `a worktree whose branch ${w.branch} is merged, clean, unlocked, idle a day, no agent's, nothing running in it`,
      });
    }
  }
}

async function scanFolders(world: JanitorWorld, out: JanitorItem[]): Promise<void> {
  const npx = path.join(world.home, '.npm', '_npx');
  let names: string[] = [];
  try { names = fs.readdirSync(npx); } catch { /* none */ }
  for (const n of names) {
    const p = path.join(npx, n);
    if (!isDir(p) || kept(world, p)) continue;
    if (newestChange(p, world.now) > world.now - NPX_IDLE_DAYS * DAY) continue;
    out.push({ id: idOf('npx-cache', p), kind: 'npx-cache', path: p, label: `~/.npm/_npx/${n}`, sizeBytes: await world.sizeOf(p), rule: `an npx cache entry untouched for ${NPX_IDLE_DAYS} days` });
  }
  const tmp = path.join(world.dataDir, 'tmp');
  const live = new Set(world.fleet.map(a => shortIdOf(a.id)));
  try { names = fs.readdirSync(tmp); } catch { names = []; }
  for (const n of names) {
    const p = path.join(tmp, n);
    if (!/^[0-9a-f]{10}$/.test(n) || live.has(n) || !isDir(p) || kept(world, p)) continue;
    out.push({ id: idOf('agent-tmp', p), kind: 'agent-tmp', path: p, label: `~/.tars/tmp/${n}`, sizeBytes: await world.sizeOf(p), rule: 'the temporary folders of an agent no longer in the fleet' });
  }
}

async function scanDocker(world: JanitorWorld, out: JanitorItem[]): Promise<void> {
  const images = await world.docker.images();
  for (const i of images ?? []) {
    if (i.used) continue;
    out.push({ id: idOf('docker-image', i.id), kind: 'docker-image', ref: i.id, label: i.repo, sizeBytes: i.sizeBytes, rule: 'a Docker image no container uses, a stopped one included' });
  }
  if (world.docker.vm) {
    out.push({ id: idOf('docker-vm-trim', 'colima'), kind: 'docker-vm-trim', ref: 'colima', label: 'the Docker VM (colima)', sizeBytes: 0, rule: 'a trim of the Docker VM, which gives the disk back what the VM freed' });
  }
}

/** What the janitor proposes now. Reads only: nothing is deleted. */
export async function scanJanitor(world: JanitorWorld): Promise<JanitorItem[]> {
  const out: JanitorItem[] = [];
  await scanWorktrees(world, out);
  await scanFolders(world, out);
  await scanDocker(world, out);
  last = new Map(out.map(i => [i.id, i]));
  return out;
}

/** The last scan's items, by id: only these can be approved. */
let last = new Map<string, JanitorItem>();

export type JanitorReport = { removed: number; freedBytes: number; kept: Array<{ id: string; label: string; why: string }> };

/**
 * The owner's approval: each approved item of the last scan, checked again against its rule just before it goes
 * (a world read anew for each), deleted by its exact path, and logged. Anything else is kept, and logged with why.
 */
export async function approveJanitor(ids: string[], worldNow: () => JanitorWorld | Promise<JanitorWorld>, ops: JanitorOps): Promise<JanitorReport> {
  const report: JanitorReport = { removed: 0, freedBytes: 0, kept: [] };
  for (const id of [...new Set(ids)]) {
    const asked = last.get(id);
    const keep = (label: string, why: string) => { report.kept.push({ id, label, why }); ops.log(`kept ${label}: ${why}`); };
    if (!asked) { keep(id, 'it is not in the scan the window showed'); continue; }
    const saved = last;
    const now = await scanJanitor(await worldNow());
    last = saved;
    const item = now.find(i => i.id === id);
    if (!item) { keep(`${asked.kind} ${asked.label}`, 'it no longer matches its rule (something runs in it, it was touched, an agent took it, or it has uncommitted work)'); continue; }
    try {
      if (item.kind === 'closed-worktree') await ops.removeWorktree(item.project!, item.path!);
      else if (item.kind === 'docker-image') await ops.dockerRm(item.ref!);
      else if (item.kind === 'docker-vm-trim') await ops.trim();
      else await ops.rm(item.path!);
      // What the owner saw it take: the re-check does not measure again.
      report.removed++;
      report.freedBytes += asked.sizeBytes;
      ops.log(`${item.kind} ${item.path ?? item.ref}: freed ${asked.sizeBytes} bytes`);
    } catch (err) {
      keep(`${item.kind} ${item.label}`, `the deletion failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  }
  return report;
}
