import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { clockOf } from '../../src/components/NewShell/chat-bits';

/**
 * The time a chat's page writes beside a name, in its head and over each
 * speaker's lines (src/components/NewShell/chat-bits.tsx, clockOf). Written
 * before the fix. How it can fail:
 * 1. an hour before ten written with one digit ("3:06"), where the
 *    permission ask under the same head writes "03:06", and every other time
 *    in the app has two digits;
 * 2. minutes before ten written with one digit ("10:5");
 * 3. a date that does not parse, or none, shown as "NaN:NaN" or as a time.
 */

describe('clockOf', () => {
  it('writes the hour with two digits, as the ask under the head does (1)', () => {
    expect(clockOf('2026-10-13T03:06:00')).toBe('03:06');
    expect(clockOf('2026-10-13T00:00:00')).toBe('00:00');
  });

  it('writes the minutes with two digits (2)', () => {
    expect(clockOf('2026-10-13T10:05:00')).toBe('10:05');
    expect(clockOf('2026-10-13T23:59:00')).toBe('23:59');
  });

  it('writes nothing for a date that does not parse, or none (3)', () => {
    expect(clockOf('not a date')).toBe('');
    expect(clockOf(null)).toBe('');
    expect(clockOf(undefined)).toBe('');
  });
});
