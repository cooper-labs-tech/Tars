import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { snoozeUntil, snoozeLabel } from '../../src/lib/chat-snooze';

/**
 * When a snooze of the chat list ends, and how a snoozed row says it
 * (src/lib/chat-snooze.ts). Frame: `Shell · chats · a chat's actions ·
 * states` (For an hour, Until tomorrow, 9:00, Until Monday, 9:00; "until 9:00"
 * on the row). Written before the code. How it can fail, in local time (the
 * dates below are built in the zone the test runs in, as the window's are):
 * 1. "for an hour" is not an hour from now;
 * 2. "until tomorrow" lands today, or at another hour than 9:00, or at 9:00
 *    in another zone than the person's;
 * 3. "until Monday" on a Monday lands the same day; on a Sunday it skips a
 *    week; on a Saturday it lands on Sunday;
 * 4. a snoozed row's label gives no time, or a day when the snooze ends today,
 *    or no day when it ends another day;
 * 5. a snooze with no date, or one that does not parse, reads as a time.
 */

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min);

describe('snoozeUntil', () => {
  it('ends an hour from now (1)', () => {
    const now = local(2026, 9, 12, 14, 7);
    expect(snoozeUntil('hour', now).getTime() - now.getTime()).toBe(60 * 60_000);
  });

  it('ends tomorrow at 9:00, local, before 9:00 or after (2)', () => {
    expect(snoozeUntil('tomorrow', local(2026, 9, 12, 8, 30))).toEqual(local(2026, 9, 13, 9, 0));
    expect(snoozeUntil('tomorrow', local(2026, 9, 12, 22, 0))).toEqual(local(2026, 9, 13, 9, 0));
    expect(snoozeUntil('tomorrow', local(2026, 9, 31, 12, 0))).toEqual(local(2026, 10, 1, 9, 0));
  });

  it('ends on the next Monday at 9:00, never the same day (3)', () => {
    // 12 October 2026 is a Monday.
    expect(snoozeUntil('monday', local(2026, 9, 12, 8, 0))).toEqual(local(2026, 9, 19, 9, 0));
    expect(snoozeUntil('monday', local(2026, 9, 11, 20, 0))).toEqual(local(2026, 9, 12, 9, 0));
    expect(snoozeUntil('monday', local(2026, 9, 10, 10, 0))).toEqual(local(2026, 9, 12, 9, 0));
    expect(snoozeUntil('monday', local(2026, 9, 14, 10, 0))).toEqual(local(2026, 9, 19, 9, 0));
  });
});

describe('snoozeLabel', () => {
  it('says the time alone when the snooze ends today, the day too when it ends another (4)', () => {
    const now = local(2026, 9, 12, 8, 0);
    expect(snoozeLabel(local(2026, 9, 12, 9, 5).toISOString(), now)).toBe('until 9:05');
    expect(snoozeLabel(local(2026, 9, 13, 9, 0).toISOString(), now)).toBe('until Tue 9:00');
    expect(snoozeLabel(local(2026, 9, 19, 17, 30).toISOString(), now)).toBe('until Mon 17:30');
  });

  it('says nothing of a snooze with no date or one that does not parse (5)', () => {
    expect(snoozeLabel(null, local(2026, 9, 12))).toBeNull();
    expect(snoozeLabel('not a date', local(2026, 9, 12))).toBeNull();
  });
});
