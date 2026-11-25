import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import { lastReportLine } from '@/lib/error-report-line';

/**
 * The line Settings shows beside "Send error reports" (2.0.4, #474's errorReports:last; frames
 * `Settings · Preferences · error reports, the last report` and the four Preferences frames).
 * Written before the code. Every way it can be wrong:
 * 1. No report kept (null): anything but "No report sent yet", such as a time or a kind made up.
 * 2. The time: "3 min ago" read as hours, a report from a minute ago said "0 min ago", one from an
 *    earlier day said in minutes or hours, yesterday's not said "yesterday at 18:02", a later day's
 *    not said in days, a time ahead of the clock (another machine's, a changed clock) said in the
 *    future or negative, an `at` that is not a date said as "NaN" or "Invalid Date".
 * 3. The kind: main's words shown raw ("agent-tool", "abrupt-end"), an uncaught error said "error",
 *    a kind main may add later dropped or shown as undefined.
 * 4. Sentry's answer: status 0 (none came) said "Sentry answered 0", a refusal (429) said as taken.
 * 5. The line naming anything of what the report carried: it has when, which kind, and the status.
 */

const NOW = new Date(2026, 9, 19, 12, 30, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('lastReportLine', () => {
  it('says no report was sent when main keeps none (1)', () => {
    expect(lastReportLine(null, NOW)).toBe('No report sent yet');
  });

  it('says minutes for the last hour, never 0 min, and just now under a minute (2)', () => {
    expect(lastReportLine({ at: ago(3 * MIN), kind: 'handled', status: 200 }, NOW)).toBe('Last report: 3 min ago (handled), Sentry answered 200');
    expect(lastReportLine({ at: ago(59 * MIN), kind: 'handled', status: 200 }, NOW)).toBe('Last report: 59 min ago (handled), Sentry answered 200');
    expect(lastReportLine({ at: ago(20_000), kind: 'handled', status: 200 }, NOW)).toBe('Last report: just now (handled), Sentry answered 200');
  });

  it('says today, yesterday at its time, then days, by the calendar (2)', () => {
    expect(lastReportLine({ at: new Date(2026, 9, 19, 9, 5).toISOString(), kind: 'handled', status: 200 }, NOW))
      .toBe('Last report: today at 09:05 (handled), Sentry answered 200');
    expect(lastReportLine({ at: new Date(2026, 9, 18, 18, 2).toISOString(), kind: 'agent-tool', status: 429 }, NOW))
      .toBe('Last report: yesterday at 18:02 (agent tool), Sentry answered 429');
    expect(lastReportLine({ at: new Date(2026, 9, 17, 23, 59).toISOString(), kind: 'abrupt-end', status: 200 }, NOW))
      .toBe('Last report: 2 days ago (abrupt end), Sentry answered 200');
  });

  it('never says a time ahead of the clock, nor an unreadable one (2)', () => {
    expect(lastReportLine({ at: new Date(NOW + 5 * MIN).toISOString(), kind: 'handled', status: 200 }, NOW))
      .toBe('Last report: just now (handled), Sentry answered 200');
    expect(lastReportLine({ at: 'not a date', kind: 'handled', status: 200 }, NOW)).toBe('Last report (handled), Sentry answered 200');
  });

  it('says each kind in words, a kind it does not know as main wrote it (3)', () => {
    const word = (kind: string) => lastReportLine({ at: ago(3 * MIN), kind, status: 200 }, NOW);
    expect(word('error')).toBe('Last report: 3 min ago (uncaught), Sentry answered 200');
    expect(word('handled')).toBe('Last report: 3 min ago (handled), Sentry answered 200');
    expect(word('agent-tool')).toBe('Last report: 3 min ago (agent tool), Sentry answered 200');
    expect(word('abrupt-end')).toBe('Last report: 3 min ago (abrupt end), Sentry answered 200');
    expect(word('diagnostic')).toBe('Last report: 3 min ago (diagnostic), Sentry answered 200');
    expect(word('something-new')).toBe('Last report: 3 min ago (something new), Sentry answered 200');
  });

  it('says Sentry did not answer for status 0, and the status it answered otherwise (4)', () => {
    expect(lastReportLine({ at: ago(12 * MIN), kind: 'error', status: 0 }, NOW)).toBe('Last report: 12 min ago (uncaught), no answer from Sentry');
    expect(lastReportLine({ at: ago(12 * MIN), kind: 'error', status: 429 }, NOW)).toBe('Last report: 12 min ago (uncaught), Sentry answered 429');
  });

  it('carries when, which kind and the status, and nothing else main might add (5)', () => {
    const extra = { at: ago(3 * MIN), kind: 'handled', status: 200, message: 'ENOENT /Users/someone/secret' } as unknown as Parameters<typeof lastReportLine>[0];
    expect(lastReportLine(extra, NOW)).toBe('Last report: 3 min ago (handled), Sentry answered 200');
  });
});
