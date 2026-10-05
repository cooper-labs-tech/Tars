import { describe, it, expect } from 'vitest';
import { relayView, RELAY_OFF_LINE } from '../../src/lib/hermes-relay';
import type { HermesRelayStatus } from '../../src/types/electron';

/**
 * relayView (src/lib/hermes-relay.ts): what the Telegram through Hermes row in
 * Settings, Hermes says of the relay's state (#285's HermesRelayStatus).
 * Frames: `Settings · Connection` and `Settings · Connection · Telegram through
 * Hermes` with its light copy. Written before the code. How it can fail:
 * 1. a state under another's word or tone: unreachable in the waiting colour,
 *    ready not green, a word written with its hyphen ("not-configured");
 * 2. off, or no status yet, shows a word, or anything but the warning that
 *    turning it on erases the bot's token;
 * 3. what waits is not said, said when nothing waits, or said "1 messages";
 * 4. a time from another day read as today's, or a missing or broken time
 *    printed as "Invalid Date", "NaN" or "undefined";
 * 5. a state this version does not know (a newer main) breaks the row, or
 *    reads as ready.
 */

const NOW = new Date(2026, 9, 1, 15, 0);
const at = (h: number, m: number) => new Date(2026, 9, 1, h, m).toISOString();
const status = (over: Partial<HermesRelayStatus>): HermesRelayStatus => ({ enabled: true, state: 'ready', waiting: 0, ...over });

describe('relayView', () => {
  it('says each state in its own word and tone, words without hyphens (1)', () => {
    const seen = (['ready', 'unreachable', 'not-configured', 'plugin-missing', 'unauthorized', 'no-connection'] as const)
      .map(state => { const v = relayView(status({ state }), NOW); return [state, v.word, v.tone]; });
    expect(seen).toEqual([
      ['ready', 'ready', 'running'],
      ['unreachable', 'unreachable', 'error'],
      ['not-configured', 'not configured', 'waiting'],
      ['plugin-missing', 'plugin missing', 'waiting'],
      ['unauthorized', 'unauthorized', 'error'],
      ['no-connection', 'no connection', 'waiting'],
    ]);
  });

  it('says what to do for each state, as the frame writes it (1)', () => {
    expect(relayView(status({ state: 'not-configured' }), NOW).line)
      .toBe("The tars-relay plugin on your Hermes has no Telegram user to write to. Set it in the plugin's settings on the server.");
    expect(relayView(status({ state: 'plugin-missing' }), NOW).line)
      .toBe('The tars-relay plugin is not installed on your Hermes. Install it there: Tars looks again every few seconds.');
    expect(relayView(status({ state: 'unauthorized' }), NOW).line).toBe('Hermes refused the dashboard token. Sign in again above.');
    expect(relayView(status({ state: 'no-connection' }), NOW).line).toBe('No Hermes connection is saved. Set one above, then save.');
  });

  it('gives off, and no status yet, no word and the warning (2)', () => {
    for (const v of [relayView(status({ enabled: false, state: 'off' }), NOW), relayView(null, NOW)]) {
      expect(v.word).toBeNull();
      expect(v.tone).toBeNull();
      expect(v.line).toBe(RELAY_OFF_LINE);
    }
    expect(RELAY_OFF_LINE).toContain("Turning it on erases the Tars bot's token and switches the bot off.");
  });

  it('says what waits for Hermes, in the singular and the plural, and nothing when nothing does (3)', () => {
    expect(relayView(status({ state: 'unreachable', waiting: 2 }), NOW).line).toBe('Hermes did not answer. 2 messages wait, and go when it answers.');
    expect(relayView(status({ state: 'unreachable', waiting: 1 }), NOW).line).toBe('Hermes did not answer. 1 message waits, and goes when it answers.');
    expect(relayView(status({ state: 'unreachable', waiting: 0 }), NOW).line).toBe('Hermes did not answer.');
  });

  it('dates the last send and reply, with the day when it is not today, and never a broken time (4)', () => {
    expect(relayView(status({ lastSentAt: at(14, 2), lastReplyAt: at(14, 5) }), NOW).line)
      .toBe('Hermes writes to you for Tars, and each reply reaches the orchestrator it answers. Last sent at 14:02, last reply at 14:05.');
    expect(relayView(status({ lastSentAt: new Date(2026, 8, 30, 23, 58).toISOString() }), NOW).line)
      .toMatch(/Last sent on 30 Sep at 23:58\.$/);
    expect(relayView(status({ lastSentAt: at(9, 5) }), NOW).line).toMatch(/Last sent at 09:05\.$/);
    const broken = relayView(status({ lastSentAt: 'never', lastReplyAt: undefined }), NOW).line;
    expect(broken).toBe('Hermes writes to you for Tars, and each reply reaches the orchestrator it answers.');
    expect(broken).not.toMatch(/Invalid|NaN|undefined/);
  });

  it('names a state it does not know, in the idle ink, and never calls it ready (5)', () => {
    const v = relayView(status({ state: 'paused' as HermesRelayStatus['state'], lastError: 'Paused by the server.' }), NOW);
    expect(v.word).toBe('paused');
    expect(v.tone).toBe('idle');
    expect(v.line).toBe('Paused by the server.');
  });
});
