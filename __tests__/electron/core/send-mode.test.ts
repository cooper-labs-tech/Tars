import { describe, it, expect } from 'vitest';

/**
 * The mode a message goes into an agent's terminal with (core/send-mode.ts), from the mode send_message was asked.
 *
 * How it fails, written before the code (t-7c3b02f7, Goose, 20/11):
 * 1. A message typed into a turn of a CLI that loses it: measured on Goose 1.60.1, text typed during its turn has its
 *    Enter dropped and waits in the field after the turn, never sent. With `auto` or `note-now`, such a message never
 *    arrives. For a CLI that says so (`noteDuringTurn: 'lost'`), both wait for the turn's end, as `queue` does.
 * 2. The other modes moved: a note waits (`queue`), steer and restart stay as asked (refused later where they do not
 *    apply), and a CLI that takes a typed message at its next tool round or after its turn keeps `auto` and `note-now`
 *    at once.
 */

import { sendModeOf } from '../../../electron/core/send-mode';

describe('the mode a message goes in with', () => {
  it("1: for a CLI that loses what is typed during a turn, auto and note-now wait for the turn's end", () => {
    expect(sendModeOf('auto', { workerNote: false, noteDuringTurn: 'lost' })).toBe('queue');
    expect(sendModeOf('note-now', { workerNote: false, noteDuringTurn: 'lost' })).toBe('queue');
    expect(sendModeOf('note', { workerNote: false, noteDuringTurn: 'lost' })).toBe('queue');
    expect(sendModeOf('steer', { workerNote: false, noteDuringTurn: 'lost' })).toBe('steer');
    expect(sendModeOf('restart', { workerNote: false, noteDuringTurn: 'lost' })).toBe('restart');
  });

  it('2: for the others, as before', () => {
    for (const noteDuringTurn of ['next-tool-round', 'after-the-turn', undefined] as const) {
      expect(sendModeOf('auto', { workerNote: false, noteDuringTurn })).toBe('auto');
      expect(sendModeOf('note-now', { workerNote: false, noteDuringTurn })).toBe('auto');
      expect(sendModeOf('note', { workerNote: false, noteDuringTurn })).toBe('queue');
      expect(sendModeOf('auto', { workerNote: true, noteDuringTurn })).toBe('queue');
      expect(sendModeOf('queue', { workerNote: false, noteDuringTurn })).toBe('queue');
    }
  });
});
