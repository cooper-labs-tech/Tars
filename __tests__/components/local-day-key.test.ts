import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { localDayKey } from '@/lib/usage-dates';

/**
 * Which calendar day a chart bar belongs to.
 *
 * The chart labelled its bars with the LOCAL date and looked their money up by
 * the UTC date. East of Greenwich those differ for part of every day, so every
 * bar carried the previous day's spend under the current day's label - and the
 * "latest day" card, which looks the day up by its own key, disagreed with the
 * bar the user was hovering. Reported as "$254.14 in LATEST DAY but $446.20 in
 * the chart for 23 August"; $446.20 was the 22nd.
 *
 * These assertions run against the helper the Usage page actually calls, so a
 * regression to toISOString() in src/app/usage/page.tsx fails here.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const utcDayKey = (d: Date) => d.toISOString().slice(0, 10);

describe('local day key', () => {
  it('agrees with what getDate() would label the bar', () => {
    const d = new Date(2026, 7, 23, 0, 30);          // 23 Aug, 00:30 local
    expect(localDayKey(d).endsWith(`-${pad(d.getDate())}`)).toBe(true);
  });

  it('is the whole point: UTC disagrees just after local midnight, east of Greenwich', () => {
    // Constructed from local components, so this is 00:30 wherever the test runs.
    const justAfterMidnight = new Date(2026, 7, 23, 0, 30);
    const offsetMinutes = justAfterMidnight.getTimezoneOffset();   // negative east of UTC
    if (offsetMinutes < 0) {
      // Tbilisi is UTC+4: 00:30 on the 23rd is 20:30 on the 22nd in UTC.
      expect(utcDayKey(justAfterMidnight)).not.toBe(localDayKey(justAfterMidnight));
    } else if (offsetMinutes > 0) {
      // West of Greenwich the mismatch happens late in the day instead.
      const lateEvening = new Date(2026, 7, 23, 23, 30);
      expect(utcDayKey(lateEvening)).not.toBe(localDayKey(lateEvening));
    } else {
      // At UTC itself the two keyings coincide; there is nothing to disagree about.
      expect(utcDayKey(justAfterMidnight)).toBe(localDayKey(justAfterMidnight));
    }
  });

  it('keys local midnight as that same day, whatever the offset', () => {
    // This is the exact shape the chart builds: a Date at local midnight.
    // toISOString() on it returns the previous day east of Greenwich.
    const midnight = new Date(2026, 7, 23);
    midnight.setHours(0, 0, 0, 0);
    expect(localDayKey(midnight)).toBe('2026-08-23');
  });

  it('walks back a fortnight without ever repeating or skipping a day', () => {
    const anchor = new Date(2026, 7, 23);
    anchor.setHours(0, 0, 0, 0);
    const keys = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(anchor);
      d.setDate(anchor.getDate() - (13 - i));
      return localDayKey(d);
    });
    expect(new Set(keys).size).toBe(14);
    expect(keys[13]).toBe('2026-08-23');
    expect(keys[0]).toBe('2026-08-10');
  });

  it('survives a month boundary', () => {
    const d = new Date(2026, 8, 1);                   // 1 Sep
    d.setDate(d.getDate() - 1);
    expect(localDayKey(d)).toBe('2026-08-31');
  });

  it('pads single digits, so keys sort lexicographically', () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    const sorted = ['2026-01-05', '2026-01-10', '2026-02-01'].slice().sort();
    expect(sorted).toEqual(['2026-01-05', '2026-01-10', '2026-02-01']);
  });
});
