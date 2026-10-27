import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  parseVmStat, parseSwapUsage, parseMemoryPressure, parseMeminfo, swapGrowthPerMin, treeMemory,
  readMachine, readAgentTrees,
} from '../../../electron/services/health/machine';
import { cleanSample, onlyKnown, type HealthSample } from '../../../electron/services/health/samples';

/**
 * The machine's memory and disk, and each agent's, on Tars's own health samples (2.0.5, the owner's lot of 28/10,
 * item D of ressources-agents-proposition-2810.md). The shared heavy-run slot and the per-agent view (next lots)
 * read them; nothing shows them yet. A sample recorded only Tars's main process.
 *
 * Measured on 28/10 on this Mac at a load of 120: vm_stat 0.16 s, sysctl vm.swapusage 0.11 s, memory_pressure
 * 0.15 s, ps 0.19 s, run side by side; `top -l 1`, the one command that gives every process's footprint, 9 to 14 s:
 * far too dear every 5 minutes, so an agent's tree is weighed by RSS on macOS, by PSS on Linux (smaps_rollup).
 *
 * How it fails, written before the code:
 * 1. A command's output is misread: vm_stat's page size is taken for 4 KB when it says 16 KB, the compressor's
 *    pages ("occupied by", not "stored in") are not the ones counted, sysctl's swap or memory_pressure's free
 *    percentage are read off the wrong word; /proc/meminfo's MemAvailable or its swap.
 * 2. An output that is not the one expected (empty, cut, another version's) gives 0 or NaN, or throws: it gives
 *    null, "unknown", and the rest of the sample stands.
 * 3. The swap's growth per minute is given for the first sample, or after a clock set back, or from a previous
 *    sample whose swap is unknown.
 * 4. An agent's tree is weighed without its children, or with another agent's, or a process counted twice; an
 *    agent with no terminal gets a zero instead of no entry.
 * 5. Windows: a number is made up where the system gives none from a command line (swap, compression, load, the
 *    trees): unknown; the free memory os.freemem gives (the available memory there) is kept, and its share.
 * 6. What is read back from the file (in ~/.tars, which agents may write) keeps a field that is not one, an id that
 *    is not one, or a number that is not; and what leaves (an abrupt end's report, a diagnostic) names an agent:
 *    its trees leave without their ids.
 * 7. On this machine, the read gives no number at all, or does not say what it cost.
 */

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    12259.
Pages active:                                 311155.
Pages inactive:                               301954.
Pages speculative:                              8069.
Pages throttled:                                   0.
Pages wired down:                             254319.
Pages purgeable:                                 318.
"Translation faults":                    41091199754.
Pages copy-on-write:                      2539408058.
Pages zero filled:                       13064671018.
Pages reactivated:                       10822064526.
Pages purged:                              391051986.
File-backed pages:                            193786.
Anonymous pages:                              427392.
Pages stored in compressor:                  2570153.
Pages occupied by compressor:                 648280.
Decompressions:                          10298190777.
Compressions:                            11447702379.
Pageins:                                   685956406.
Pageouts:                                   41739018.
Swapins:                                   132282583.
Swapouts:                                  167755450.
`;
const SWAP = 'total = 14336.00M  used = 13281.00M  free = 1055.00M  (encrypted)\n';
const PRESSURE = 'The system has 25769803776 (1572864 pages with a page size of 16384).\nSystem-wide memory free percentage: 42%\n';
const MEMINFO = `MemTotal:       16303608 kB
MemFree:          812344 kB
MemAvailable:    9876544 kB
Buffers:          123456 kB
Cached:          7654321 kB
SwapTotal:       4194300 kB
SwapFree:        3145724 kB
`;

describe('what the system says, read', () => {
  it('1. macOS: vm_stat\'s pages at its own page size, the swap used, the free percentage', () => {
    const vm = parseVmStat(VM_STAT)!;
    expect(vm.pageBytes).toBe(16384);
    expect(vm.freeMb).toBeCloseTo(((12259 + 8069) * 16384) / 1048576, 1);
    expect(vm.compressedMb).toBeCloseTo((648280 * 16384) / 1048576, 1);
    expect(parseSwapUsage(SWAP)).toBe(13281);
    expect(parseMemoryPressure(PRESSURE)).toBe(42);
  });

  it('1. Linux: /proc/meminfo\'s available memory and the swap used', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ availableMb: Math.round(9876544 / 1024 * 10) / 10, totalMb: Math.round(16303608 / 1024 * 10) / 10, swapUsedMb: Math.round((4194300 - 3145724) / 1024 * 10) / 10 });
  });

  it('2. an output that is not the expected one is unknown, never 0 nor NaN', () => {
    for (const bad of ['', 'garbage', 'Mach Virtual Memory Statistics: (page size of x bytes)']) expect(parseVmStat(bad)).toBeNull();
    expect(parseSwapUsage('')).toBeNull();
    expect(parseSwapUsage('total = 0.00M  used = ?M')).toBeNull();
    expect(parseMemoryPressure('System-wide memory free percentage: %')).toBeNull();
    expect(parseMeminfo('MemTotal: x kB')).toBeNull();
  });

  it('3. the swap\'s growth per minute, from the previous sample only when both are known and in order', () => {
    expect(swapGrowthPerMin(undefined, { at: 120_000, swapUsedMb: 100 })).toBeNull();
    expect(swapGrowthPerMin({ at: 0, swapUsedMb: 100 }, { at: 120_000, swapUsedMb: 160 })).toBe(30);
    expect(swapGrowthPerMin({ at: 0, swapUsedMb: 160 }, { at: 60_000, swapUsedMb: 100 })).toBe(-60);
    expect(swapGrowthPerMin({ at: 120_000, swapUsedMb: 100 }, { at: 60_000, swapUsedMb: 160 })).toBeNull();
    expect(swapGrowthPerMin({ at: 0, swapUsedMb: null }, { at: 60_000, swapUsedMb: 160 })).toBeNull();
  });

  it('4. an agent\'s tree: its terminal and everything under it, once, and no entry without a terminal', () => {
    const table = [
      { pid: 100, ppid: 1, kb: 1024 }, { pid: 101, ppid: 100, kb: 2048 }, { pid: 102, ppid: 101, kb: 1024 },
      { pid: 200, ppid: 1, kb: 4096 }, { pid: 201, ppid: 200, kb: 1024 }, { pid: 300, ppid: 1, kb: 9999 },
    ];
    expect(treeMemory([{ id: 'a', pid: 100 }, { id: 'b', pid: 200 }, { id: 'gone', pid: 999 }], table)).toEqual([
      { id: 'a', processes: 3, mb: 4 },
      { id: 'b', processes: 2, mb: 5 },
    ]);
  });
});

describe('Windows', () => {
  it('5. the free memory the system gives; swap, compression, load and trees unknown', async () => {
    const m = await readMachine({ platform: 'win32' });
    expect(m.memFreeMb).toBeGreaterThan(0);
    expect(m.memFreePct).toBeGreaterThan(0);
    expect([m.compressedMb, m.swapUsedMb, m.swapGrowthMbPerMin, m.load1]).toEqual([null, null, null, null]);
    expect(await readAgentTrees([{ id: 'a', pid: process.pid }], 'win32')).toBeNull();
  });
});

describe('the file, read back and sent', () => {
  const base: HealthSample = { at: 1_000, heapUsedMb: 1, heapTotalMb: 2, rssMb: 3, loopP50Ms: 1, loopP95Ms: 2, slowest: [], agents: 1, running: 0, page: null };

  it('6. keeps the machine\'s numbers and the trees checked, and drops what is not one', () => {
    const raw = {
      ...base,
      machine: { memFreePct: 42, memFreeMb: 'lots', compressedMb: -1, swapUsedMb: 13281, swapGrowthMbPerMin: -12.5, diskFreeGb: 30.2, load1: 120, readMs: 210, extra: 'x' },
      agentTrees: { measure: 'rss', trees: [{ id: 'a-1', processes: 9, mb: 512 }, { id: '../etc', processes: 1, mb: 1 }, { id: 'b', processes: 'x', mb: 1 }] },
    };
    const clean = cleanSample(raw)!;
    expect(clean.machine).toEqual({ memFreePct: 42, memFreeMb: null, compressedMb: null, swapUsedMb: 13281, swapGrowthMbPerMin: -12.5, diskFreeGb: 30.2, load1: 120, readMs: 210 });
    expect(clean.agentTrees).toEqual({ measure: 'rss', trees: [{ id: 'a-1', processes: 9, mb: 512 }] });
    // A line from before 2.0.5 is still a sample.
    expect(cleanSample(base)).toMatchObject({ at: 1_000 });
  });

  it('6. what leaves keeps the trees\' weights and none of their ids', () => {
    const clean = cleanSample({ ...base, agentTrees: { measure: 'pss', trees: [{ id: 'a-1', processes: 9, mb: 512 }] } })!;
    const out = onlyKnown(clean, { channels: new Set(), pages: new Set() });
    expect(out.agentTrees).toEqual({ measure: 'pss', trees: [{ processes: 9, mb: 512 }] });
    expect(JSON.stringify(out)).not.toContain('a-1');
  });
});

const posix = describe.skipIf(process.platform === 'win32');

posix('on this machine', () => {
  it('7. every number the system gives here, and what the read cost', async () => {
    const m = await readMachine({});
    expect(m.memFreeMb).toBeGreaterThan(0);
    expect(m.diskFreeGb).toBeGreaterThan(0);
    expect(m.load1).not.toBeNull();
    expect(m.swapUsedMb).not.toBeNull();
    if (process.platform === 'darwin') {
      expect(m.memFreePct).toBeGreaterThan(0);
      expect(m.compressedMb).not.toBeNull();
    }
    expect(m.readMs).toBeGreaterThan(0);
  });

  it('4, 7. weighs a real tree: this process and a child of it', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      const read = (await readAgentTrees([{ id: 'me', pid: process.pid }]))!;
      expect(read.measure).toBe(process.platform === 'linux' ? 'pss' : 'rss');
      const me = read.trees.find(t => t.id === 'me')!;
      expect(me.processes).toBeGreaterThanOrEqual(2);
      expect(me.mb).toBeGreaterThan(10);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
