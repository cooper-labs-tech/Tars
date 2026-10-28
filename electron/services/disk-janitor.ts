import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agents } from '../core/agent-manager';
import { DATA_DIR, PRIVATE_DIR } from '../constants';
import { diskUsage } from '../platform/disk-usage';
import { safeGit } from '../utils/safe-git';
import { retentionLog } from './agent-tmp';
import { processCwds } from './orphan-folders';
import { approveJanitor, scanJanitor, type JanitorItem, type JanitorOps, type JanitorReport, type JanitorWorld } from './janitor-rules';

/**
 * The disk janitor in the app (the rules: janitor-rules.ts). The window asks for a scan and shows it; the owner ticks
 * and approves; agents may ask for a scan through the local API (GET /api/janitor/scan), never approve. Every
 * deletion and every item kept at the approval is written to ~/.tars/logs/janitor.log.
 *
 * Its world, read anew for each scan and for each approved item just before it goes: the fleet's projects and their
 * worktrees (git, never a shell), every process's working folder (lsof, /proc), the reports under
 * ~/.tars/project-files (what they name), Docker's images and containers, and colima for the VM's trim. Docker and
 * colima are run by name from the PATH; under DOROTHY_E2E only, DOROTHY_DOCKER_BIN and DOROTHY_COLIMA_BIN name a
 * stand-in, so a test never reaches the machine's own Docker.
 */

export const JANITOR_LOG = path.join(DATA_DIR, 'logs', 'janitor.log');

function run(file: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
  });
}

function bin(name: 'docker' | 'colima'): string {
  const override = process.env.DOROTHY_E2E === '1' ? process.env[name === 'docker' ? 'DOROTHY_DOCKER_BIN' : 'DOROTHY_COLIMA_BIN'] : undefined;
  return override && path.isAbsolute(override) ? override : name;
}

/** "1.2GB", "512MB", "880kB": Docker's sizes, in bytes. */
function bytesOf(text: string): number {
  const m = /^([\d.]+)\s*([kKMGT]?)B$/.exec(text.trim());
  if (!m) return 0;
  const unit = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1;
  return Math.round(Number(m[1]) * unit);
}

async function dockerImages(): Promise<Array<{ id: string; repo: string; sizeBytes: number; used: boolean }> | null> {
  const images = await run(bin('docker'), ['image', 'ls', '--no-trunc', '--format', '{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}']);
  if (!images.ok) return null;
  const containers = await run(bin('docker'), ['ps', '-a', '--no-trunc', '--format', '{{.Image}}']);
  if (!containers.ok) return null;
  const used = new Set(containers.stdout.split('\n').map(s => s.trim()).filter(Boolean));
  return images.stdout.split('\n').filter(Boolean).map(line => {
    const [id, repo, size] = line.split('\t');
    const bare = repo.endsWith(':latest') ? repo.slice(0, -':latest'.length) : repo;
    return { id, repo, sizeBytes: bytesOf(size ?? ''), used: used.has(id) || used.has(repo) || used.has(bare) || used.has(id.replace(/^sha256:/, '')) };
  });
}

/** The reports' text, read once per world: whether a report cites a folder, by its path or its ~ path. */
function reportsText(): string {
  const root = path.join(DATA_DIR, 'project-files');
  let text = '';
  let files = 0;
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (st.isFile() && /\.(md|txt|json)$/.test(n) && st.size < 2 * 1024 * 1024 && files++ < 5_000) {
        try { text += fs.readFileSync(p, 'utf8') + '\n'; } catch { /* unreadable */ }
      }
    }
  };
  walk(root, 0);
  return text;
}

async function worktreesOf(project: string): Promise<Array<{ path: string; branch?: string; locked: boolean }> | null> {
  try {
    const { stdout } = await safeGit(project, ['worktree', 'list', '--porcelain']);
    const out: Array<{ path: string; branch?: string; locked: boolean }> = [];
    for (const block of stdout.split('\n\n')) {
      const lines = block.split('\n');
      const at = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!at) continue;
      const branch = lines.find(l => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
      out.push({ path: at, ...(branch ? { branch } : {}), locked: lines.some(l => l === 'locked' || l.startsWith('locked ')) });
    }
    return out;
  } catch {
    return null;
  }
}

async function mergedInto(project: string, branch: string): Promise<boolean | null> {
  for (const base of ['origin/main', 'main', 'origin/master', 'master']) {
    try { await safeGit(project, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]); } catch { continue; }
    try {
      await safeGit(project, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, base]);
      return true;
    } catch (err) {
      return (err as { code?: unknown }).code === 1 ? false : null;
    }
  }
  return null;
}

/** The projects scanned: the window's (those added by hand and those the agents work in), set at its start. */
let projectsOf: () => string[] = () => [...agents.values()].map(a => a.projectPath);
export function setJanitorProjects(projects: () => string[]): void {
  projectsOf = projects;
}

async function worldNow(measure = true): Promise<JanitorWorld> {
  const fleet = [...agents.values()].map(a => ({ id: a.id, projectPath: a.projectPath, ...(a.worktreePath ? { worktreePath: a.worktreePath } : {}) }));
  const projects = [...new Set(projectsOf().filter(p => p && fs.existsSync(p)))];
  const reports = reportsText();
  const home = os.homedir();
  const colima = await run(bin('colima'), ['status'], 15_000);
  return {
    home, dataDir: DATA_DIR, privateDir: PRIVATE_DIR, now: Date.now(), projects, fleet,
    cwds: await processCwds(),
    worktrees: worktreesOf,
    dirty: async (wt) => {
      try { return (await safeGit(wt, ['status', '--porcelain'])).stdout.trim().length > 0; } catch { return null; }
    },
    merged: mergedInto,
    named: (folder) => reports.includes(folder) || reports.includes(`~${folder.slice(home.length)}`),
    docker: { images: dockerImages, vm: colima.ok },
    // The re-check before a deletion does not measure again: the scan's size is what the owner approved.
    sizeOf: (p) => (measure ? diskUsage(p) : Promise.resolve(0)),
  };
}

const OPS: JanitorOps = {
  // By its exact absolute path; never a glob, never a shell.
  rm: async (p) => { fs.rmSync(p, { recursive: true }); },
  // As scripts/worktree.mjs removes one: git is never told --force.
  removeWorktree: async (project, p) => { await safeGit(project, ['worktree', 'remove', p]); },
  dockerRm: async (id) => {
    const r = await run(bin('docker'), ['image', 'rm', id]);
    if (!r.ok) throw new Error('docker image rm failed');
  },
  trim: async () => {
    const r = await run(bin('colima'), ['ssh', '--', 'sudo', 'fstrim', '-a'], 300_000);
    if (!r.ok) throw new Error('the trim failed');
  },
  log: (line) => retentionLog(`[janitor] ${line}`, JANITOR_LOG),
};

let busy = false;

/** What the janitor proposes now: read only. */
export async function janitorScan(): Promise<JanitorItem[]> {
  return scanJanitor(await worldNow());
}

/** The owner's approval, one at a time; a second approval while one runs is refused. */
export async function janitorApprove(ids: string[]): Promise<JanitorReport> {
  if (busy) throw new Error('an approval is already under way');
  busy = true;
  try {
    // The world is read anew for each approved item, just before it goes: the processes, the fleet, git.
    return await approveJanitor(ids, () => worldNow(false), OPS);
  } finally {
    busy = false;
  }
}
