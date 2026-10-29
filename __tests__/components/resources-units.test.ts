import { describe, expect, it } from 'vitest';
import { bytes, diskGb, gb } from '@/components/Resources/format';
import { diskLine, sizeLabel } from '@/lib/orphan-folders';

/**
 * The Resources page's unit for sizes and the disk: Tars's own, bytes / 1024³ written GB, as the heavy-run slot reads
 * the machine (health/machine.ts), applies its floor (15) and its alerts (10, 6, 3), and writes its why, and as
 * Settings · System shows the disk (the Audit's M1 at the re-check of PR 539).
 *
 * How it can fail, written before the change:
 * 1. the free disk is shown in 10⁹ bytes while the slot's floor beside it is in 1024³: 15.5 × 10⁹ bytes reads
 *    "15.5 GB", above a floor of 15, while the slot says 14.4 GB free and makes a run wait for disk;
 * 2. Settings' floor of 30 × 1024³ bytes reads "floor 32 GB" on the Disk view while Settings says 30 GB;
 * 3. a size above a gigabyte reads differently here and in Settings (sizeLabel), or a size under it in another MB;
 * 4. the disk's figure and the slot's why disagree by more than the rounding of a tenth.
 */

const GiB = 1024 ** 3;

describe('the Resources page reads sizes and the disk in Tars\'s unit', () => {
  it('shows 15.5 × 10⁹ bytes free as the slot does, under its floor of 15 (1)', () => {
    const free = diskGb(15.5e9);
    expect(gb(free)).toBe('14.4 GB');
    expect(free).toBeLessThan(15);
  });

  it('names Settings\' 30 GB floor 30, never 32 (2)', () => {
    expect(Math.round(diskGb(30 * GiB))).toBe(30);
    expect(diskLine({ freeBytes: 20 * GiB, totalBytes: 500 * GiB, floorBytes: 30 * GiB } as never).hint).toContain('Tars warns below 30 GB');
  });

  it('writes a size above a gigabyte as Settings does, and one under it in the same MB (3)', () => {
    for (const n of [GiB, 1.5 * GiB, 18.3 * GiB, 250 * GiB]) expect(bytes(n)).toBe(sizeLabel(n));
    expect(bytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(bytes(1.5e9)).toBe('1.4 GB');
  });

  it('agrees with the slot\'s figure to its tenth (4)', () => {
    // health/machine.ts: bavail * bsize / 1024³, to a tenth.
    const freeBytes = 18_730_000_000;
    const slotGb = Math.round((freeBytes / GiB) * 10) / 10;
    expect(Math.abs(diskGb(freeBytes) - slotGb)).toBeLessThan(0.05);
  });
});
