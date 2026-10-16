import { describe, it, expect } from 'vitest';
import { diagnosticLine } from '../../src/lib/diagnostic';

/**
 * The line under Settings > Preferences > Diagnostic once main has answered
 * `diagnostic:send` (Noah's go on monitoring, 15/10). Frame: `Settings ·
 * Preferences · diagnostic`, and its light copy. Written before the code. How
 * it can fail:
 * 1. the count: "1 samples", or a count that is not a whole number of samples
 *    read as one;
 * 2. the times: main's ISO times shown as they come, in UTC, instead of in
 *    local time; a time without its date, so a send that spans midnight reads
 *    backwards; a date of another year without its year;
 * 3. a time that does not read as one shown as "Invalid Date" (#284 met it on
 *    the Usage page), rather than leaving the times out;
 * 4. a refusal: main's sentence changed, cut, or dropped, or an empty one
 *    leaving an empty line; a sentence that carries a line break or a
 *    direction mark breaks the line or turns it around;
 * 5. an answer of another shape (an older main, a broken bridge: nothing,
 *    null, a string) read as sent.
 */

const NOW = new Date(2026, 9, 15, 9, 30);
const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();

describe('sent (1, 2)', () => {
  it('says how many samples went, from when to when, in local time with the date', () => {
    expect(diagnosticLine({ sent: true, samples: 288, from: local(2026, 9, 14, 9, 5), to: local(2026, 9, 15, 9, 0) }, NOW))
      .toBe('Sent 288 samples from 14 Oct 09:05 to 15 Oct 09:00.');
  });

  it('says one sample, not one samples', () => {
    expect(diagnosticLine({ sent: true, samples: 1, from: local(2026, 9, 15, 9, 0), to: local(2026, 9, 15, 9, 0) }, NOW))
      .toBe('Sent 1 sample from 15 Oct 09:00 to 15 Oct 09:00.');
  });

  it('writes the year of a time in another year', () => {
    expect(diagnosticLine({ sent: true, samples: 3, from: local(2025, 11, 31, 23, 50), to: local(2026, 0, 1, 0, 0) }, new Date(2026, 0, 1, 0, 5)))
      .toBe('Sent 3 samples from 31 Dec 2025 23:50 to 1 Jan 00:00.');
  });

  it('reads main\'s UTC times as local ones', () => {
    const at = new Date(Date.UTC(2026, 9, 15, 7, 0));
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    expect(diagnosticLine({ sent: true, samples: 2, from: at.toISOString(), to: at.toISOString() }, NOW))
      .toBe(`Sent 2 samples from ${at.getDate()} Oct ${hh}:${mm} to ${at.getDate()} Oct ${hh}:${mm}.`);
  });
});

describe('a time that does not read (3)', () => {
  it('leaves the times out rather than writing Invalid Date', () => {
    const line = diagnosticLine({ sent: true, samples: 5, from: 'yesterday', to: '' }, NOW);
    expect(line).toBe('Sent 5 samples.');
    expect(line).not.toMatch(/Invalid|NaN/);
  });
});

describe('refused (4)', () => {
  it('shows main\'s sentence as it gives it', () => {
    for (const reason of [
      'A diagnostic was already sent in the last 24 hours.',
      'Nothing has been recorded yet: Tars records its health every 5 minutes.',
      'Sentry could not be reached. Nothing was sent.',
    ]) expect(diagnosticLine({ sent: false, reason }, NOW)).toBe(reason);
  });

  it('keeps it on one line, the right way round', () => {
    expect(diagnosticLine({ sent: false, reason: 'Sentry could not\nbe reached.‮' }, NOW)).toBe('Sentry could not be reached.');
  });

  it('says nothing was sent when main gives no sentence', () => {
    expect(diagnosticLine({ sent: false, reason: '' }, NOW)).toBe('Nothing was sent.');
    expect(diagnosticLine({ sent: false, reason: '  ' }, NOW)).toBe('Nothing was sent.');
  });
});

describe('an answer of another shape (5)', () => {
  it('never reads it as sent', () => {
    for (const answer of [undefined, null, 'sent', {}, { sent: 'yes' }, { sent: true }, { sent: true, samples: '288' }] as unknown[]) {
      expect(diagnosticLine(answer as never, NOW)).toBe('Nothing was sent.');
    }
  });
});
