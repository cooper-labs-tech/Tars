import { afterEach, describe, expect, it } from 'vitest';
import { parseSchedule, scheduleLine, windowAt, type ScheduleSpec } from '../../../electron/services/fleet-schedule';

/**
 * A project's hours (services/fleet-schedule.ts, 2.0.7): a daily window, a start and a stop in HH:MM, in UTC or in the
 * computer's local time, said explicitly; what the start does (resume the queues, or start the agents too).
 *
 * How it fails, written before the code:
 * 1. A schedule without its zone is taken (a zone guessed), or a zone other than 'UTC' and 'local' is taken.
 * 2. A time that is not HH:MM on 24 hours is taken: 25:00, 18:60, 7:5, 18h, '', 24:00, a number.
 * 3. A start equal to its stop is taken, as an empty window or as 24 hours, without saying which.
 * 4. onStart other than 'resume-queues' or 'start-agents' is taken; a missing onStart is not 'resume-queues'.
 * 5. An overnight window (18:00 to 04:00 UTC) is not open at 23:00 or at 03:59, or is open at 04:00 or at 17:59.
 * 6. At 02:00 the open window is said to begin today at 18:00, not yesterday's 18:00 (its stop would then be wrong).
 * 7. A window within one day (09:00 to 17:00) is read as crossing midnight.
 * 8. Outside a window, the next window is not the next one: today's when today's start is still ahead, tomorrow's
 *    once today's has passed.
 * 9. 'local' is read in UTC, or 'UTC' in the computer's time (a computer at UTC+4).
 * 10. A local window across a change of clocks (Paris, 29/03/2026, 02:00 to 03:00) does not last its real length
 *     (01:00 to 05:00 local that night is 3 hours), or a time the change skips throws.
 * 11. Two reads of the same window give it two different starts, so it would be opened twice.
 * 12. The line the window and the guide show does not say the hours and the zone, or has a dash of the forbidden kind.
 */

const UTC_NIGHT: ScheduleSpec = { start: '18:00', stop: '04:00', timeZone: 'UTC', onStart: 'resume-queues' };
const at = (iso: string) => Date.parse(iso);
const tzBefore = process.env.TZ;
afterEach(() => {
  if (tzBefore === undefined) delete process.env.TZ;
  else process.env.TZ = tzBefore;
});

describe('parseSchedule', () => {
  it('1. takes a zone only when it is said, and only UTC or local', () => {
    expect(parseSchedule({ start: '18:00', stop: '04:00' })).toMatchObject({ ok: false, code: 'zone_required' });
    expect(parseSchedule({ start: '18:00', stop: '04:00', timeZone: 'Europe/Paris' })).toMatchObject({ ok: false, code: 'zone_required' });
    expect(parseSchedule({ start: '18:00', stop: '04:00', timeZone: 'utc' })).toMatchObject({ ok: false, code: 'zone_required' });
    expect(parseSchedule({ start: '18:00', stop: '04:00', timeZone: 'UTC' })).toEqual({ ok: true, schedule: UTC_NIGHT });
    expect(parseSchedule({ start: '18:00', stop: '04:00', timeZone: 'local' })).toEqual({ ok: true, schedule: { ...UTC_NIGHT, timeZone: 'local' } });
  });

  it('2. takes HH:MM on 24 hours and nothing else', () => {
    for (const bad of ['25:00', '18:60', '7:5', '18h', '', '24:00', '18:00:00', ' 18:00', 1800, null]) {
      expect(parseSchedule({ start: bad, stop: '04:00', timeZone: 'UTC' }), String(bad)).toMatchObject({ ok: false, code: 'invalid_time' });
      expect(parseSchedule({ start: '04:00', stop: bad, timeZone: 'UTC' }), String(bad)).toMatchObject({ ok: false, code: 'invalid_time' });
    }
    expect(parseSchedule({ start: '00:00', stop: '23:59', timeZone: 'UTC' })).toMatchObject({ ok: true });
    expect(parseSchedule({ start: '07:05', stop: '09:30', timeZone: 'UTC' })).toMatchObject({ ok: true });
  });

  it('3. refuses a start equal to its stop', () => {
    expect(parseSchedule({ start: '18:00', stop: '18:00', timeZone: 'UTC' })).toMatchObject({ ok: false, code: 'empty_window' });
  });

  it('4. takes resume-queues (the default) or start-agents', () => {
    expect(parseSchedule({ ...UTC_NIGHT, onStart: undefined })).toEqual({ ok: true, schedule: UTC_NIGHT });
    expect(parseSchedule({ ...UTC_NIGHT, onStart: 'start-agents' })).toEqual({ ok: true, schedule: { ...UTC_NIGHT, onStart: 'start-agents' } });
    expect(parseSchedule({ ...UTC_NIGHT, onStart: 'start' })).toMatchObject({ ok: false, code: 'invalid_on_start' });
    expect(parseSchedule(null)).toMatchObject({ ok: false });
    expect(parseSchedule('18:00-04:00')).toMatchObject({ ok: false });
  });
});

describe('windowAt', () => {
  it('5. an overnight window is open from its start to just before its stop', () => {
    expect(windowAt(UTC_NIGHT, at('2026-11-19T23:00:00Z')).open).toBe(true);
    expect(windowAt(UTC_NIGHT, at('2026-11-20T03:59:59Z')).open).toBe(true);
    expect(windowAt(UTC_NIGHT, at('2026-11-19T18:00:00Z')).open).toBe(true);
    expect(windowAt(UTC_NIGHT, at('2026-11-20T04:00:00Z')).open).toBe(false);
    expect(windowAt(UTC_NIGHT, at('2026-11-19T17:59:59Z')).open).toBe(false);
  });

  it("6. after midnight, the open window is the one that began the evening before", () => {
    expect(windowAt(UTC_NIGHT, at('2026-11-20T02:00:00Z'))).toEqual({ open: true, start: at('2026-11-19T18:00:00Z'), end: at('2026-11-20T04:00:00Z') });
  });

  it('7. a window within one day stays in its day', () => {
    const day: ScheduleSpec = { start: '09:00', stop: '17:00', timeZone: 'UTC', onStart: 'resume-queues' };
    expect(windowAt(day, at('2026-11-19T12:00:00Z'))).toEqual({ open: true, start: at('2026-11-19T09:00:00Z'), end: at('2026-11-19T17:00:00Z') });
    expect(windowAt(day, at('2026-11-19T02:00:00Z')).open).toBe(false);
    expect(windowAt(day, at('2026-11-19T20:00:00Z')).open).toBe(false);
  });

  it('8. outside a window, the next one is the next to begin', () => {
    expect(windowAt(UTC_NIGHT, at('2026-11-19T12:00:00Z'))).toEqual({ open: false, start: at('2026-11-19T18:00:00Z'), end: at('2026-11-20T04:00:00Z') });
    const day: ScheduleSpec = { start: '09:00', stop: '17:00', timeZone: 'UTC', onStart: 'resume-queues' };
    expect(windowAt(day, at('2026-11-19T20:00:00Z'))).toEqual({ open: false, start: at('2026-11-20T09:00:00Z'), end: at('2026-11-20T17:00:00Z') });
  });

  it("9. 'local' is the computer's time, 'UTC' is UTC", () => {
    process.env.TZ = 'Asia/Tbilisi'; // UTC+4 all year
    const local: ScheduleSpec = { ...UTC_NIGHT, timeZone: 'local' };
    // 18:00 in Tbilisi is 14:00 UTC.
    expect(windowAt(local, at('2026-11-19T15:30:00Z'))).toEqual({ open: true, start: at('2026-11-19T14:00:00Z'), end: at('2026-11-20T00:00:00Z') });
    expect(windowAt(UTC_NIGHT, at('2026-11-19T15:30:00Z')).open).toBe(false);
  });

  it('10. a local window across a change of clocks lasts its real length, and a skipped time does not throw', () => {
    process.env.TZ = 'Europe/Paris'; // 29/03/2026: 02:00 CET becomes 03:00 CEST
    const night: ScheduleSpec = { start: '01:00', stop: '05:00', timeZone: 'local', onStart: 'resume-queues' };
    const w = windowAt(night, at('2026-03-29T01:30:00Z'));
    expect(w.open).toBe(true);
    expect(w.start).toBe(at('2026-03-29T00:00:00Z'));
    expect(w.end).toBe(at('2026-03-29T03:00:00Z'));
    expect((w.end - w.start) / 3_600_000).toBe(3);
    const skipped: ScheduleSpec = { start: '02:30', stop: '06:00', timeZone: 'local', onStart: 'resume-queues' };
    expect(() => windowAt(skipped, at('2026-03-29T01:00:00Z'))).not.toThrow();
    expect(Number.isFinite(windowAt(skipped, at('2026-03-29T01:00:00Z')).start)).toBe(true);
  });

  it('11. the same window read twice has the same start', () => {
    const a = windowAt(UTC_NIGHT, at('2026-11-19T20:00:00Z'));
    const b = windowAt(UTC_NIGHT, at('2026-11-20T03:00:00Z'));
    expect(a.start).toBe(b.start);
    expect(a.end).toBe(b.end);
  });
});

describe('scheduleLine', () => {
  it('12. says the hours and the zone, with no forbidden dash', () => {
    expect(scheduleLine(UTC_NIGHT)).toBe('every day from 18:00 to 04:00 UTC');
    expect(scheduleLine({ ...UTC_NIGHT, timeZone: 'local' })).toBe("every day from 18:00 to 04:00, the computer's local time");
    expect(scheduleLine(UTC_NIGHT)).not.toMatch(/[\u2013\u2014]/);
  });
});
