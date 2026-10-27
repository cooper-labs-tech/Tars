import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

/**
 * The machine's memory and disk, and each agent's, read for the health samples (2.0.5, the owner's lot of 28/10):
 * what the shared heavy-run slot and the per-agent view will read. Nothing shows them yet.
 *
 * Cheap on purpose, since it runs on a loaded machine: measured on 28/10 on this Mac at a load of 120, vm_stat
 * 0.16 s, sysctl vm.swapusage 0.11 s, memory_pressure 0.15 s and ps 0.19 s, run side by side, so about 0.2 s
 * every 5 minutes. `top -l 1`, the one command that gives every process's footprint on macOS, took 9 to 14 s:
 * an agent's tree is weighed by RSS there; on Linux by PSS (/proc/<pid>/smaps_rollup), RSS for a process whose
 * smaps cannot be read. Windows gives its free memory (os.freemem); swap, compression, load and the trees are
 * not read from a command line there: unknown, never made up. Every field a command could not give is null.
 */

export interface MachineSample {
  /** The share of memory free: memory_pressure's figure on macOS, MemAvailable over MemTotal on Linux. */
  memFreePct: number | null;
  /** Free (and speculative) pages on macOS, MemAvailable on Linux, os.freemem on Windows. */
  memFreeMb: number | null;
  /** The compressor's own pages (macOS); null elsewhere. */
  compressedMb: number | null;
  swapUsedMb: number | null;
  /** Since the previous sample; null for the first one, or when either swap is unknown. */
  swapGrowthMbPerMin: number | null;
  /** On the volume of the home folder. */
  diskFreeGb: number | null;
  load1: number | null;
  /** What this read cost, in ms. */
  readMs: number;
}

export interface AgentTree {
  /** The agent's id; never in what leaves (samples.ts, onlyKnown). */
  id?: string;
  processes: number;
  mb: number;
}

export interface AgentTrees {
  measure: 'rss' | 'pss';
  trees: AgentTree[];
}

const MB = 1024 * 1024;
const tenth = (v: number) => Math.round(v * 10) / 10;

/** vm_stat: its page size, the free and speculative pages, the pages the compressor occupies. */
export function parseVmStat(text: string): { pageBytes: number; freeMb: number; compressedMb: number } | null {
  const page = /page size of (\d+) bytes/.exec(text);
  const pages = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const free = pages('Pages free');
  const speculative = pages('Pages speculative');
  const compressor = pages('Pages occupied by compressor');
  if (!page || free === null || speculative === null || compressor === null) return null;
  const pageBytes = Number(page[1]);
  return { pageBytes, freeMb: tenth(((free + speculative) * pageBytes) / MB), compressedMb: tenth((compressor * pageBytes) / MB) };
}

/** `sysctl -n vm.swapusage`: `total = 14336.00M  used = 13281.00M  free = ...`. */
export function parseSwapUsage(text: string): number | null {
  const m = /used = ([\d.]+)M/.exec(text);
  return m ? tenth(Number(m[1])) : null;
}

/** `memory_pressure -Q`: `System-wide memory free percentage: 42%`. */
export function parseMemoryPressure(text: string): number | null {
  const m = /free percentage: (\d+)%/.exec(text);
  return m ? Number(m[1]) : null;
}

/** /proc/meminfo: the available memory, the total, and the swap used. */
export function parseMeminfo(text: string): { availableMb: number; totalMb: number; swapUsedMb: number } | null {
  const kb = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const available = kb('MemAvailable');
  const total = kb('MemTotal');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  if (available === null || total === null || swapTotal === null || swapFree === null) return null;
  return { availableMb: tenth(available / 1024), totalMb: tenth(total / 1024), swapUsedMb: tenth((swapTotal - swapFree) / 1024) };
}

type SwapPoint = { at: number; swapUsedMb: number | null };

/** MB of swap gained (or given back) per minute since `previous`; null when either is unknown or out of order. */
export function swapGrowthPerMin(previous: SwapPoint | undefined, now: SwapPoint): number | null {
  if (!previous || previous.swapUsedMb === null || now.swapUsedMb === null || now.at <= previous.at) return null;
  return tenth((now.swapUsedMb - previous.swapUsedMb) / ((now.at - previous.at) / 60_000));
}

/** Each agent's terminal and everything under it, weighed from a table of (pid, ppid, kB). No terminal, no entry. */
export function treeMemory(terminals: Array<{ id: string; pid: number }>, table: Array<{ pid: number; ppid: number; kb: number }>): AgentTree[] {
  const children = new Map<number, number[]>();
  const kb = new Map<number, number>();
  for (const row of table) {
    kb.set(row.pid, row.kb);
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  }
  const trees: AgentTree[] = [];
  for (const { id, pid } of terminals) {
    if (!kb.has(pid)) continue;
    const seen = new Set<number>();
    for (const stack = [pid]; stack.length;) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(...(children.get(p) ?? []));
    }
    const total = [...seen].reduce((sum, p) => sum + (kb.get(p) ?? 0), 0);
    trees.push({ id, processes: seen.size, mb: tenth(total / 1024) });
  }
  return trees;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 16 * MB }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function diskFreeGb(home: string): number | null {
  try {
    const s = fs.statfsSync(home);
    return tenth((Number(s.bavail) * Number(s.bsize)) / (1024 * MB));
  } catch {
    return null;
  }
}

/** One read of the machine's memory, swap, disk and load. Never throws: a field it could not read is null. */
export async function readMachine(opts: { platform?: NodeJS.Platform; home?: string; previous?: SwapPoint; now?: number }): Promise<MachineSample> {
  const started = performance.now();
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now();
  let memFreePct: number | null = null;
  let memFreeMb: number | null = null;
  let compressedMb: number | null = null;
  let swapUsedMb: number | null = null;
  if (platform === 'darwin') {
    const [vm, swap, pressure] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage']), run('memory_pressure', ['-Q'])]);
    const pages = vm === null ? null : parseVmStat(vm);
    memFreeMb = pages?.freeMb ?? null;
    compressedMb = pages?.compressedMb ?? null;
    swapUsedMb = swap === null ? null : parseSwapUsage(swap);
    memFreePct = pressure === null ? null : parseMemoryPressure(pressure);
  } else if (platform === 'linux') {
    let info: ReturnType<typeof parseMeminfo> = null;
    try { info = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { /* unknown */ }
    if (info) {
      memFreeMb = info.availableMb;
      memFreePct = info.totalMb > 0 ? Math.round((info.availableMb / info.totalMb) * 100) : null;
      swapUsedMb = info.swapUsedMb;
    }
  } else {
    memFreeMb = tenth(os.freemem() / MB);
    memFreePct = os.totalmem() > 0 ? Math.round((os.freemem() / os.totalmem()) * 100) : null;
  }
  return {
    memFreePct,
    memFreeMb,
    compressedMb,
    swapUsedMb,
    swapGrowthMbPerMin: swapGrowthPerMin(opts.previous, { at: now, swapUsedMb }),
    diskFreeGb: diskFreeGb(opts.home ?? os.homedir()),
    load1: platform === 'win32' ? null : tenth(os.loadavg()[0]),
    readMs: Math.max(1, Math.round(performance.now() - started)),
  };
}

function linuxTable(terminals: Array<{ pid: number }>): Array<{ pid: number; ppid: number; kb: number }> | null {
  let pids: number[];
  try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number); } catch { return null; }
  const parent = new Map<number, number>();
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      parent.set(pid, Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* gone */ }
  }
  // Only the processes under a terminal are weighed: smaps_rollup costs a walk of the process's mappings.
  const under = new Set(terminals.map(t => t.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!under.has(pid) && under.has(ppid)) { under.add(pid); grew = true; }
  }
  const table: Array<{ pid: number; ppid: number; kb: number }> = [];
  for (const pid of under) {
    if (!parent.has(pid)) continue;
    let kb: number | null = null;
    try { kb = Number(/^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? NaN); } catch { /* not readable */ }
    if (kb === null || !Number.isFinite(kb)) {
      try { kb = Number(/^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0); } catch { kb = 0; }
    }
    table.push({ pid, ppid: parent.get(pid)!, kb });
  }
  return table;
}

/**
 * The memory of each agent's whole tree: RSS from one `ps` on macOS, PSS from /proc on Linux. Null on Windows,
 * where no command line gives it cheaply, and when the table cannot be read.
 */
export async function readAgentTrees(terminals: Array<{ id: string; pid: number }>, platform: NodeJS.Platform = process.platform): Promise<AgentTrees | null> {
  if (platform === 'linux') {
    const table = linuxTable(terminals);
    return table ? { measure: 'pss', trees: treeMemory(terminals, table) } : null;
  }
  if (platform !== 'darwin') return null;
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  if (out === null) return null;
  const table = out.split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(cols => cols.length === 3 && cols.every(Number.isFinite))
    .map(([pid, ppid, kb]) => ({ pid, ppid, kb }));
  return { measure: 'rss', trees: treeMemory(terminals, table) };
}
