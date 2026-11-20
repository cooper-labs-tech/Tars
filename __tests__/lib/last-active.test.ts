import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { lastActiveLabel } from '../../src/lib/last-active';

/**
 * lastActiveLabel (src/lib/last-active.ts): when a project or a session was
 * last active, as the Projects page writes it. Written before the code. A
 * custom project Claude Code has not run in has no date: projects.json keeps
 * bare paths, fs:list-projects sends none, and the page built `new Date('')`,
 * which every card printed as "Invalid Date" (the e2e reference projects.png
 * shows it). How it can fail:
 * 1. a date that could not be read (an empty string, a missing one, an invalid
 *    Date, NaN) prints "Invalid Date" or "NaNd ago" where nothing is known;
 * 2. moving the formatting out of the page changes what a known date prints:
 *    Today, Yesterday, so many days ago within a week, then the month and day.
 */

const NOW = new Date(2026, 9, 1, 15, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 86_400_000;

describe('lastActiveLabel', () => {
  it('knows nothing of a date that could not be read (1)', () => {
    for (const unread of ['', 'not a date', undefined, null, Number.NaN, new Date('')]) {
      expect(lastActiveLabel(unread as never, NOW), String(unread)).toBeNull();
    }
  });

  it('writes a known date as the page did (2)', () => {
    expect(lastActiveLabel(ago(60_000), NOW)).toBe('Today');
    expect(lastActiveLabel(ago(DAY + 60_000), NOW)).toBe('Yesterday');
    expect(lastActiveLabel(ago(3 * DAY + 60_000), NOW)).toBe('3d ago');
    expect(lastActiveLabel(new Date(2026, 8, 3, 9, 0), NOW)).toBe('Sep 3');
    // As the page receives them: a Date, an ISO string, a time in ms.
    expect(lastActiveLabel(ago(60_000).toISOString(), NOW)).toBe('Today');
    expect(lastActiveLabel(ago(60_000).getTime(), NOW)).toBe('Today');
  });
});
