import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { agents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { diskUsage } from '../platform/disk-usage';
import { broadcastToAllWindows } from '../utils/broadcast';
import { TMP_ROOT, shortIdOf } from './agent-tmp';
import { buildFleetResources, type AgentResources, type FleetResources, type ProcessRow } from './fleet-resources';

/**
 * The fleet's resources in the app (the rules: fleet-resources.ts): one process table per read, at most every 2 s
 * (`ps -A -o pid,ppid,rss,%cpu,command` on macOS and Linux; none on Windows, where the figures read null), and the
 * disk of each agent's worktree and temporary folder measured only when the window asks (`resources:measureDisk`),
 * one folder at a time, its progress sent, the result kept with when. The window reads `resources:read` and is sent
 * `resources:changed`; the orchestrators read each agent's memory, CPU and processes through list_agents and
 * get_agent (agentResources).
 */

const TABLE_EVERY_MS = 2_000;
let table: { at: number; rows: ProcessRow[] | null } | undefined;
const disk = new Map<string, { bytes: number; at: number }>();
let measuring: FleetResources['measuring'] = null;

function readTable(): Promise<ProcessRow[] | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise(done => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu=,command='], { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      if (err) return done(null);
      const rows: ProcessRow[] = [];
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), kb: Number(m[3]), cpu: Number(m[4].replace(',', '.')), command: m[5] });
      }
      done(rows);
    });
  });
}

async function tableNow(): Promise<{ at: number; rows: ProcessRow[] | null }> {
  if (!table || Date.now() - table.at >= TABLE_EVERY_MS) table = { at: Date.now(), rows: await readTable() };
  return table;
}

const tmpOf = (id: string) => path.join(TMP_ROOT, shortIdOf(id));

/** The window's read: every project's agents with their figures, the disk as last measured. */
export async function readFleetResources(): Promise<FleetResources> {
  const t = await tableNow();
  const fleet = [...agents.values()].filter(a => a.kind !== 'chat').map(a => ({
    id: a.id, name: a.name || a.id, status: a.status, statusSince: a.statusSince, asleepSince: a.asleepSince,
    projectPath: a.projectPath, worktreePath: a.worktreePath,
    terminalPid: a.ptyId ? ptyProcesses.get(a.ptyId)?.pid : undefined,
  }));
  const built = buildFleetResources({ readAt: t.rows ? t.at : null, agents: fleet, table: t.rows, disk, tmpOf });
  return { ...built, measuring, error: t.rows || process.platform === 'win32' ? null : 'the process table could not be read' };
}

/** Each agent's memory, CPU and processes, for list_agents and get_agent. */
export async function agentResources(): Promise<Map<string, Pick<AgentResources, 'memMb' | 'cpuPct' | 'processes'>>> {
  const r = await readFleetResources();
  return new Map(r.projects.flatMap(p => p.agents).map(a => [a.id, { memMb: a.memMb, cpuPct: a.cpuPct, processes: a.processes }]));
}

const tell = () => { void readFleetResources().then(r => broadcastToAllWindows('resources:changed', r)).catch(() => undefined); };

/** The disk of every agent's worktree and temporary folder, measured now, one at a time; refused while one runs. */
export async function measureFleetDisk(): Promise<{ success: boolean; error?: string }> {
  if (measuring) return { success: false, error: 'the disk is being measured already' };
  const folders = [...new Set([...agents.values()].flatMap(a => [a.worktreePath, tmpOf(a.id)]).filter((p): p is string => !!p))];
  measuring = { done: 0, total: folders.length };
  tell();
  try {
    for (const f of folders) {
      // A folder that is not there is not measured: null, never a made-up 0.
      try { if (fs.existsSync(f)) disk.set(f, { bytes: await diskUsage(f), at: Date.now() }); else disk.delete(f); } catch { disk.delete(f); }
      measuring = { done: measuring.done + 1, total: folders.length };
      tell();
    }
    return { success: true };
  } finally {
    measuring = null;
    tell();
  }
}
