import { describe, expect, it } from 'vitest';
import { freeMemory } from '@/components/Resources/format';

/**
 * Free memory on Resources · heavy runs, as the frame draws it (i3Fre: "6.2 GB" over "26 % of 24 GB · floor 20 %"):
 * one measure, the free memory the share speaks of, and the machine's total (the QA's F2 on PR 539).
 *
 * How it can fail, written before the change:
 * 1. the free-pages figure (memFreeMb) is shown above memory_pressure's share: "144 MB · 43 % free" on a 24 GB Mac,
 *    two measures that contradict each other;
 * 2. the figure is not the share's (memFreeShareMb), or not in Tars's unit (1024² per MB, 1024³ per GB);
 * 3. the total is not said, or not in whole GB ("24 GB");
 * 4. a figure the system could not give reads as zero or as another figure, never "not read";
 * 5. the floor is lost from the line.
 */

const mac = { memFreePct: 26, memFreeMb: 144, memFreeShareMb: 6348.8, memTotalMb: 24576 };

describe('free memory, one measure', () => {
  it('shows the share\'s free memory, never the free pages beside the share (1, 2)', () => {
    const { value, sub } = freeMemory(mac, 20);
    expect(value).toBe('6.2 GB');
    expect(value).not.toContain('144');
    expect(sub).toBe('26 % of 24 GB · floor 20 %');
  });

  it('says the total in whole GB (3)', () => {
    expect(freeMemory({ ...mac, memTotalMb: 16 * 1024, memFreeShareMb: 4096 }, 20).sub).toBe('26 % of 16 GB · floor 20 %');
  });

  it('says what it could not read, and falls back on no other figure (4)', () => {
    expect(freeMemory({ ...mac, memFreeShareMb: null }, 20).value).toBe('not read');
    expect(freeMemory({ ...mac, memTotalMb: null }, 20).sub).toBe('26 % free · floor 20 %');
    expect(freeMemory({ ...mac, memFreePct: null }, 20).sub).toBe('not read · floor 20 %');
    expect(freeMemory(null, 20)).toBeNull();
  });

  it('keeps the floor only when the slot gives one (5)', () => {
    expect(freeMemory(mac).sub).toBe('26 % of 24 GB');
  });
});
