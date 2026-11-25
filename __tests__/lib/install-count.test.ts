import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { installsLabel } from '../../src/lib/install-count';

/**
 * How many times a skill was installed, as the Extensions page writes it
 * (src/lib/install-count.ts), the way the frame `Extensions · Skills` writes
 * it: one decimal always, in K or M ("3.0M", "27.9K", "2.0K"). Written before
 * the code. How it can fail:
 * 1. a count on a round thousand loses its decimal while the next one keeps
 *    its own: "1113K" beside "1300.1K", as the page read on 12/10;
 * 2. a count of a million or more reads in thousands: "1300.1K", "3731.1K";
 * 3. rounding carries a count past its unit and leaves it there: 999,950 read
 *    "1000K" rather than "1.0M";
 * 4. a count under a thousand gains a unit or a decimal: 940 read "0.9K" or
 *    "940.0";
 * 5. a count the page cannot vouch for (none, not a number, not finite,
 *    negative, from a listing kept in a folder every agent can write) prints
 *    "NaN", "Infinity" or "-1", where the listing's own text is there to show;
 * 6. the built-in list, which carries a text and no count, loses its text.
 */

const at = (installsNum: unknown, installs = 'listed') => installsLabel({ installs, installsNum } as { installs: string; installsNum?: number });

describe('installsLabel', () => {
  it('keeps the decimal of a count on a round thousand, as its neighbour keeps its own (1)', () => {
    expect(at(1_113_000, '1113K')).toBe('1.1M');
    expect(at(1_300_100, '1300.1K')).toBe('1.3M');
    expect(at(933_000, '933K')).toBe('933.0K');
    expect(at(2_000, '2K')).toBe('2.0K');
  });

  it('writes a count of a million or more in millions, as the frame does (2)', () => {
    expect(at(3_731_100)).toBe('3.7M');
    expect(at(3_000_000)).toBe('3.0M');
    expect(at(27_900)).toBe('27.9K');
    expect(at(2_400_000_000)).toBe('2.4B');
  });

  it('carries a count that rounds up into the next unit (3)', () => {
    expect(at(999_950)).toBe('1.0M');
    expect(at(999_949)).toBe('999.9K');
    expect(at(999_950_000)).toBe('1.0B');
    expect(at(999.6)).toBe('1.0K');
  });

  it('writes a count under a thousand as it is (4)', () => {
    expect(at(940)).toBe('940');
    expect(at(999)).toBe('999');
    expect(at(0)).toBe('0');
  });

  it('shows the listing\'s own text for a count it cannot vouch for (5)', () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, '1113000']) {
      expect(at(bad, '12K')).toBe('12K');
    }
  });

  it('keeps the text of the built-in list, which has no count (6)', () => {
    expect(installsLabel({ installs: '36.8K' })).toBe('36.8K');
  });
});
