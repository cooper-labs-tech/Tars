import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { cleanLine, clockOf, elapsedSince, sendersOf } from '../../src/lib/task-banner';

/**
 * The banner above an agent's terminal (design PR #451, on #453's contract): who gave the task in hand,
 * since when and for how long, its first line, and who gave the tasks that wait.
 *
 * Written before src/lib/task-banner.ts. The ways it can fail:
 * 1. A sender's name or a task's first line is free text (a task typed by anyone who can delegate):
 *    a line break, a right-to-left override or a zero-width character in it breaks or turns the line
 *    around on screen, as the QA measured on the message notice.
 * 2. A long name pushes the rest of the banner out of the pane; a cap that counts UTF-16 units cuts an
 *    emoji in half and draws a replacement character.
 * 3. The elapsed time reads "0 min" for a task that just began, "65 min" past an hour, or a negative
 *    duration when the main process's clock is a little ahead of the window's.
 * 4. A start time that does not parse draws "NaN min".
 * 5. The waiting tasks' senders repeat a name once per task ("Tars, Tars, Telegram"), or lose their order.
 * 6. Past two senders, the line grows with every task instead of saying how many more.
 */

describe('cleanLine (1, 2)', () => {
  it('flattens what breaks or turns a line around into one space', () => {
    expect(cleanLine('Make the grid\ngrow', 100)).toBe('Make the grid grow');
    expect(cleanLine('QA\u202Eevil', 100)).toBe('QA evil');
    expect(cleanLine('Lead\u200B\u200BEngineer', 100)).toBe('Lead Engineer');
    expect(cleanLine('  spaced  ', 100)).toBe('spaced');
  });
  it('caps at the given count of characters, never splitting an emoji', () => {
    expect(cleanLine('abcdef', 4)).toBe('abc…');
    expect(cleanLine('ab🙂🙂🙂', 4)).toBe('ab🙂…');
    expect(cleanLine('abc', 4)).toBe('abc');
  });
});

describe('elapsedSince (3, 4)', () => {
  const start = Date.parse('2026-10-18T14:02:00Z');
  it('says now under a minute, minutes under an hour, hours and minutes past it', () => {
    expect(elapsedSince('2026-10-18T14:02:00Z', start + 30_000)).toBe('now');
    expect(elapsedSince('2026-10-18T14:02:00Z', start + 4 * 60_000 + 59_000)).toBe('4 min');
    expect(elapsedSince('2026-10-18T14:02:00Z', start + 65 * 60_000)).toBe('1 h 05');
    expect(elapsedSince('2026-10-18T14:02:00Z', start + 120 * 60_000)).toBe('2 h');
  });
  it('says now for a start a little ahead of the window clock, and nothing for a date that does not parse', () => {
    expect(elapsedSince('2026-10-18T14:02:00Z', start - 5_000)).toBe('now');
    expect(elapsedSince('not a date', start)).toBe('');
  });
});

describe('clockOf (4)', () => {
  it('gives the local hour and minute, and nothing for a date that does not parse', () => {
    const d = new Date(2026, 9, 18, 9, 5);
    expect(clockOf(d.toISOString())).toBe('09:05');
    expect(clockOf('nope')).toBe('');
  });
});

describe('sendersOf (5, 6)', () => {
  const w = (from: string) => ({ ref: from, from, queuedAt: '2026-10-18T14:05:00Z', firstLine: 'x' });
  it('names each sender once, in the order their tasks run', () => {
    expect(sendersOf([w('Tars'), w('Tars'), w('Telegram')])).toBe('Tars, Telegram');
  });
  it('names two, then says how many more', () => {
    expect(sendersOf([w('Tars'), w('Telegram'), w('QA'), w('Lead')])).toBe('Tars, Telegram and 2 more');
    expect(sendersOf([])).toBe('');
  });
});
