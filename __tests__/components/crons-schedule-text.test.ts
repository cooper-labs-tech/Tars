import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { formatSchedule } from '@/app/crons/schedule-text';

/**
 * Regression guard for the Schedules page crash.
 *
 * Hermes' /api/cron/jobs returns `schedule` as an object. The page used to put
 * it straight into JSX, which threw React error #31 during hydration and left
 * Chromium painting "This page couldn't load. Reload to try again, or go back."
 * Everything this helper returns must be a plain string.
 */
describe('formatSchedule', () => {
  it('renders the object Hermes actually sends for a cron job', () => {
    // Verbatim from a live gateway's /api/cron/jobs (its tailnet address left out).
    const out = formatSchedule({
      schedule: { kind: 'cron', expr: '*/15 * * * *', display: '*/15 * * * *' },
      schedule_display: '*/15 * * * *',
    });
    expect(out).toBe('*/15 * * * *');
    expect(typeof out).toBe('string');
  });

  it('renders an interval job', () => {
    expect(formatSchedule({
      schedule: { kind: 'interval', display: 'every 30m' },
    })).toBe('every 30m');
  });

  it('falls back to expr when the object carries no display', () => {
    expect(formatSchedule({ schedule: { kind: 'cron', expr: '0 2 * * *' } })).toBe('0 2 * * *');
  });

  it('still accepts a plain string, and prefers schedule_human', () => {
    expect(formatSchedule({ schedule: '0 9 * * *' })).toBe('0 9 * * *');
    expect(formatSchedule({ schedule_human: 'daily at 9', schedule: '0 9 * * *' }))
      .toBe('daily at 9');
  });

  it('never returns a non-string, whatever the gateway sends', () => {
    const odd: unknown[] = [
      undefined,
      null,
      {},
      { schedule: null },
      { schedule: {} },
      { schedule: '' },
      { schedule: { kind: 'cron', expr: 42 } },
      { schedule: { nested: { display: 'no' } } },
    ];
    for (const job of odd) {
      const out = formatSchedule((job ?? {}) as Parameters<typeof formatSchedule>[0]);
      expect(typeof out).toBe('string');
    }
    expect(formatSchedule({ schedule: {} })).toBe('no schedule');
  });
});
