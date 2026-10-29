import { describe, it, expect } from 'vitest';
import { twoZones } from '../../../electron/utils/two-zones';

/**
 * Times in both zones in every notice Tars types into an agent (2.0.6, option d): UTC first, then the machine's own
 * time with its offset, "19:03 UTC (23:03 +04)". Until 2.0.5 each notice said the machine's time alone, and an agent
 * whose transcript, tools and CI speak UTC read hours off (the maintainer works at +04).
 *
 * How it can fail, written before the code:
 * Z1. The UTC time is the local one, or the local the UTC one.
 * Z2. The offset's sign is backwards (getTimezoneOffset is UTC minus local, in minutes).
 * Z3. A half-hour or quarter-hour zone loses its minutes (+05:30, +05:45, -03:30), or a whole-hour one grows them.
 * Z4. Across midnight the local hour wraps wrong ("23:30 UTC" at +04 is "03:30" local).
 * Z5. An hour or a minute under ten loses its leading zero.
 * Z6. A machine on UTC prints its time twice ("19:03 UTC (19:03 +00)").
 * Z7. Without an offset given, it is not the machine's own (the one the notice is typed on).
 */

const at = (iso: string) => Date.parse(iso);

describe('twoZones', () => {
  it('Z1, Z2. UTC first, then the local time with its offset', () => {
    expect(twoZones(at('2026-10-29T19:03:00Z'), 240)).toBe('19:03 UTC (23:03 +04)');
    expect(twoZones(at('2026-10-29T19:03:00Z'), -300)).toBe('19:03 UTC (14:03 -05)');
  });

  it('Z3. a zone off the hour keeps its minutes, a whole-hour one has none', () => {
    expect(twoZones(at('2026-10-29T19:03:00Z'), 330)).toBe('19:03 UTC (00:33 +05:30)');
    expect(twoZones(at('2026-10-29T19:03:00Z'), 345)).toBe('19:03 UTC (00:48 +05:45)');
    expect(twoZones(at('2026-10-29T19:03:00Z'), -210)).toBe('19:03 UTC (15:33 -03:30)');
    expect(twoZones(at('2026-10-29T19:03:00Z'), 60)).toBe('19:03 UTC (20:03 +01)');
  });

  it('Z4. across midnight, both ways', () => {
    expect(twoZones(at('2026-10-29T23:30:00Z'), 240)).toBe('23:30 UTC (03:30 +04)');
    expect(twoZones(at('2026-10-29T01:10:00Z'), -300)).toBe('01:10 UTC (20:10 -05)');
  });

  it('Z5. leading zeros', () => {
    expect(twoZones(at('2026-10-29T04:05:00Z'), 240)).toBe('04:05 UTC (08:05 +04)');
  });

  it('Z6. a machine on UTC says it once', () => {
    expect(twoZones(at('2026-10-29T19:03:00Z'), 0)).toBe('19:03 UTC');
  });

  it("Z7. with no offset given, the machine's own at that instant", () => {
    const ms = at('2026-10-29T19:03:00Z');
    expect(twoZones(ms)).toBe(twoZones(ms, -new Date(ms).getTimezoneOffset()));
  });
});
