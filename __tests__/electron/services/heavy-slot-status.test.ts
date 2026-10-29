import { describe, it, expect, vi } from 'vitest';

/**
 * The heavy-run slot's status as the window reads it (2.0.5, #539's Heavy runs view; the QA's F2 on #539): on macOS
 * `memFreeMb` is the free and speculative pages, while `memFreePct` is memory_pressure's share, which counts what the
 * system can reclaim. Side by side they contradicted each other (a few hundred MB "free" at 26 %).
 *
 * How it fails, written before the code (28/10):
 * M1. The status gives no figure the share speaks of: the free memory it means (the share of the total) and the
 *     total, so the view cannot read "6.2 GB, 26 % of 24 GB".
 * M2. A share the system cannot give (null) is turned into a made-up figure: the free memory it means is null.
 */

const { sample } = vi.hoisted(() => ({ sample: { memFreePct: 26 as number | null } }));
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), totalmem: () => 24 * 1024 * 1024 * 1024 }));
vi.mock('../../../electron/services/health/machine', () => ({
  readMachine: async () => ({
    memFreePct: sample.memFreePct, memFreeMb: 310, compressedMb: null, swapUsedMb: 0, swapGrowthMbPerMin: null,
    diskFreeGb: 100, load1: 1, readMs: 1,
  }),
}));
vi.mock('../../../electron/services/stall-watch', () => ({ readProcesses: async () => undefined }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

describe('the slot\'s status, its memory', () => {
  it('M1. gives the free memory the share speaks of, and the total', async () => {
    vi.resetModules();
    sample.memFreePct = 26;
    const { slotStatus } = await import('../../../electron/services/heavy-slot-runtime');
    const { machine } = await slotStatus();
    expect(machine).toMatchObject({ memFreePct: 26, memTotalMb: 24576, memFreeShareMb: 6390 });
  });

  it('M2. a share the system cannot give leaves that figure null', async () => {
    vi.resetModules();
    sample.memFreePct = null;
    const { slotStatus } = await import('../../../electron/services/heavy-slot-runtime');
    expect((await slotStatus()).machine).toMatchObject({ memFreePct: null, memFreeShareMb: null, memTotalMb: 24576 });
  });
});
