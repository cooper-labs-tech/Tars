import * as path from 'path';
import { redactCommandLine } from '../utils/redact-command-line';

/**
 * What each agent and each project costs, readable (2.0.5, lot 3 item D; brief lot3-agent-resources-2810.md; the
 * Frontend's contract on #539, `FleetResources`): per agent, the memory and CPU of its whole process tree and its
 * processes with their command lines masked, the disk of its worktree and of its temporary folder as last measured,
 * its status and since when; per project, the same summed. 1212's orchestrator could not tell which agents held the
 * memory (its tars-feedback-2810.md, item 8).
 *
 * This is the core, a pure function of the fleet, one process table and the disk measured so far
 * (fleet-resources-runtime.ts reads them). The disk is measured only when asked, never on a read.
 */

export type ProcessRow = { pid: number; ppid: number; kb: number; cpu: number; command: string };

export type FleetInput = {
  /** When the table was read; null when it could not be. */
  readAt: number | null;
  agents: Array<{
    id: string; name: string; status: string; statusSince?: string; asleepSince?: string;
    projectPath: string; worktreePath?: string; terminalPid?: number;
  }>;
  /** Every process, or null where the table cannot be read (Windows, a ps that failed). */
  table: ProcessRow[] | null;
  /** What was measured, by folder: its bytes and when. */
  disk: Map<string, { bytes: number; at: number }>;
  tmpOf: (agentId: string) => string;
};

export interface AgentProcess { name: string; pid: number; memMb: number | null; cpuPct: number | null; /** Secrets masked (redact-command-line.ts). */ command: string }
export interface MeasuredPath { path: string; bytes: number | null }
export interface AgentResources {
  id: string;
  name: string;
  /** working, waiting, idle, asleep, stopped, error */
  status: string;
  statusSince: number | null;
  memMb: number | null;
  cpuPct: number | null;
  processes: AgentProcess[];
  worktrees: MeasuredPath[];
  tmp: MeasuredPath | null;
}
export interface ProjectResources {
  path: string;
  name: string;
  agents: AgentResources[];
  /** The project's agents summed: null when no agent's figure could be read. */
  totals: { memMb: number | null; cpuPct: number | null; diskBytes: number | null; processes: number };
}
export interface FleetResources {
  /** When memory and CPU were read; null when they could not be. */
  readAt: number | null;
  /** When the disk was last measured; null before any. */
  diskMeasuredAt: number | null;
  measuring?: { done: number; total: number } | null;
  error?: string | null;
  projects: ProjectResources[];
}

const tenth = (n: number) => Math.round(n * 10) / 10;
const time = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

/** The program a command line runs: its first word's last part. */
function nameOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return path.basename(first) || first;
}

/** The status as the window words it. */
function statusOf(a: FleetInput['agents'][number]): string {
  if (a.asleepSince) return 'asleep';
  return a.status === 'running' ? 'working' : a.status;
}

function treeOf(root: number, children: Map<number, ProcessRow[]>, rows: Map<number, ProcessRow>): ProcessRow[] {
  const seen = new Set<number>();
  const out: ProcessRow[] = [];
  for (const stack = [root]; stack.length;) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.get(pid);
    if (row) out.push(row);
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return out;
}

export function buildFleetResources(input: FleetInput): FleetResources {
  const rows = new Map((input.table ?? []).map(r => [r.pid, r]));
  const children = new Map<number, ProcessRow[]>();
  for (const r of input.table ?? []) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const measured = (p: string): MeasuredPath => ({ path: p, bytes: input.disk.get(p)?.bytes ?? null });

  const agents = input.agents.map((a): { project: string; resources: AgentResources; memMb: number | null; cpuPct: number | null; processes: AgentProcess[]; worktrees: MeasuredPath[]; tmp: MeasuredPath | null } => {
    const tree = input.table && a.terminalPid && rows.has(a.terminalPid) ? treeOf(a.terminalPid, children, rows) : null;
    const processes = (tree ?? [])
      .map(r => ({ name: nameOf(r.command), pid: r.pid, memMb: tenth(r.kb / 1024), cpuPct: tenth(r.cpu), command: redactCommandLine(r.command) }))
      .sort((x, y) => (y.memMb ?? 0) - (x.memMb ?? 0));
    const resources: AgentResources = {
      id: a.id, name: a.name, status: statusOf(a), statusSince: time(a.asleepSince) ?? time(a.statusSince),
      memMb: tree ? tenth(tree.reduce((s, r) => s + r.kb, 0) / 1024) : null,
      cpuPct: tree ? tenth(tree.reduce((s, r) => s + r.cpu, 0)) : null,
      processes,
      worktrees: a.worktreePath ? [measured(a.worktreePath)] : [],
      tmp: measured(input.tmpOf(a.id)),
    };
    return { project: a.projectPath, resources, ...resources };
  });

  const byProject = new Map<string, typeof agents>();
  for (const a of agents) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a]);
  const sum = (xs: Array<number | null>) => (xs.some(x => x !== null) ? tenth(xs.reduce<number>((s, x) => s + (x ?? 0), 0)) : null);
  const projects = [...byProject].map(([p, list]): ProjectResources => {
    const disk = list.flatMap(a => [...a.worktrees, ...(a.tmp ? [a.tmp] : [])].map(m => m.bytes));
    return {
      path: p, name: path.basename(p),
      agents: list.map(a => a.resources),
      totals: {
        memMb: sum(list.map(a => a.memMb)), cpuPct: sum(list.map(a => a.cpuPct)),
        diskBytes: disk.some(b => b !== null) ? disk.reduce<number>((s, b) => s + (b ?? 0), 0) : null,
        processes: list.reduce((s, a) => s + a.processes.length, 0),
      },
    };
  });
  const times = [...input.disk.values()].map(d => d.at);
  return { readAt: input.readAt, diskMeasuredAt: times.length ? Math.max(...times) : null, projects };
}
