import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { stopLine } from '../../src/lib/stop-line';
import type { AgentStatus } from '../../src/types/electron';

/**
 * stopLine (src/lib/stop-line.ts): the one sentence that says who stopped an
 * agent, when and why, wherever the agent is drawn. Frame: `Agent stopped ·
 * who and why` in design/tars-redesign.pen. Written before the code. How it
 * can fail:
 * 1. a line for an agent that is not stopped, from fields a stop left behind;
 * 2. the caller, the time or the reason lost on the way;
 * 3. a stop with no reason reads with a dangling colon, or says "undefined";
 * 4. a stop from another day reads as today's, or one from another year as
 *    this year's;
 * 5. a missing or broken stoppedAt, or a missing stoppedBy, prints
 *    "Invalid Date", "NaN" or "undefined";
 * 6. a name or a reason holding a character that hides or rearranges text
 *    (U+202E, a zero-width space, a line break) turns the sentence around or
 *    splits it: the name is any agent's, as its owner typed it;
 * 7. a name long enough to push the reason out of the line is drawn whole, or
 *    cut through a character;
 * 8. a reason of spaces reads as a reason.
 */

type Stop = Pick<AgentStatus, 'status' | 'stoppedBy' | 'stoppedAt' | 'stopReason'>;
const NOW = new Date(2026, 9, 1, 15, 0);
const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();
const stopped = (over: Partial<Stop> = {}): Stop => ({
  status: 'stopped',
  stoppedBy: 'Orchestrator',
  stoppedAt: at(2026, 9, 1, 14, 2),
  stopReason: 'frozen on a file read for 40 minutes',
  ...over,
});

/** What hides or rearranges text, or breaks a line: none of it may reach the screen. */
const HIDDEN = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

describe('stopLine', () => {
  it('says nothing of an agent that is not stopped, whatever a stop left behind (1)', () => {
    for (const status of ['idle', 'running', 'waiting', 'completed', 'error'] as const) {
      expect(stopLine(stopped({ status }), NOW), status).toBeNull();
    }
  });

  it('says who, when and why, in that order, for a stop of today (2)', () => {
    expect(stopLine(stopped(), NOW)).toBe('Stopped by Orchestrator at 14:02: frozen on a file read for 40 minutes');
  });

  it('pads the time, so 9:05 reads 09:05 (2)', () => {
    expect(stopLine(stopped({ stoppedBy: 'you', stoppedAt: at(2026, 9, 1, 9, 5), stopReason: undefined }), NOW)).toBe('Stopped by you at 09:05');
  });

  it('ends after the time when the stop gave no reason, or a reason of spaces (3, 8)', () => {
    for (const stopReason of [undefined, '', '   ', '\n\t']) {
      expect(stopLine(stopped({ stoppedBy: 'you', stoppedAt: at(2026, 9, 1, 9, 41), stopReason }), NOW)).toBe('Stopped by you at 09:41');
    }
  });

  it('gives the date of a stop from another day, and the year of one from another year (4)', () => {
    expect(stopLine(stopped({ stoppedBy: 'Tars', stoppedAt: at(2026, 8, 30, 23, 58), stopReason: 'the night run is over' }), NOW))
      .toBe('Stopped by Tars on 30 Sep at 23:58: the night run is over');
    expect(stopLine(stopped({ stoppedAt: at(2025, 8, 30, 23, 58), stopReason: undefined }), NOW))
      .toBe('Stopped by Orchestrator on 30 Sep 2025 at 23:58');
    // Midnight is a day boundary: two minutes before it is yesterday.
    expect(stopLine(stopped({ stoppedAt: at(2026, 8, 30, 23, 58), stopReason: undefined }), new Date(2026, 9, 1, 0, 0)))
      .toBe('Stopped by Orchestrator on 30 Sep at 23:58');
  });

  it('leaves out what it was not given, and never prints a placeholder (5)', () => {
    expect(stopLine(stopped({ stoppedAt: undefined }), NOW)).toBe('Stopped by Orchestrator: frozen on a file read for 40 minutes');
    expect(stopLine(stopped({ stoppedAt: 'not a date' }), NOW)).toBe('Stopped by Orchestrator: frozen on a file read for 40 minutes');
    expect(stopLine(stopped({ stoppedBy: undefined }), NOW)).toBe('Stopped at 14:02: frozen on a file read for 40 minutes');
    expect(stopLine(stopped({ stoppedBy: '  ' }), NOW)).toBe('Stopped at 14:02: frozen on a file read for 40 minutes');
    expect(stopLine({ status: 'stopped' }, NOW)).toBe('Stopped');
    for (const line of [stopLine(stopped({ stoppedAt: 'x' }), NOW), stopLine({ status: 'stopped' }, NOW)]) {
      expect(line).not.toMatch(/undefined|null|NaN|Invalid/);
    }
  });

  it('flattens what hides or rearranges text, in the name and in the reason, so the sentence reads in order (6)', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const line = stopLine(stopped({ stoppedBy: `QA${rlo}Lead`, stopReason: `two${zwsp}words\nand a second line` }), NOW)!;
    expect(line).not.toMatch(HIDDEN);
    expect(line).toBe('Stopped by QA Lead at 14:02: two words and a second line');
  });

  it('cuts a name past forty characters with an ellipsis, never through a character (7)', () => {
    const name = `${'x'.repeat(38)}\u{1F600}tail`;
    const line = stopLine(stopped({ stoppedBy: name, stopReason: undefined }), NOW)!;
    const who = line.slice('Stopped by '.length, line.indexOf(' at 14:02'));
    expect([...who]).toHaveLength(40);
    expect(who.endsWith('\u{1F600}…')).toBe(true);
    expect(line.endsWith(' at 14:02')).toBe(true);
  });
});
