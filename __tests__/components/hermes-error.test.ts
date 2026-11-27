import { describe, it, expect } from 'vitest';
import { describeHermesFailure, HERMES_ABSENT_TEXT, isHermesAbsent } from '@/components/KanbanBoard/hermes-error';

/**
 * Kanban is the Hermes board and has no local board to fall back to, so a dead
 * gateway has to explain itself. These lock in the two things that were wrong
 * before: the Electron IPC wrapper leaking on screen, and the gateway address
 * never being named.
 */

const IPC = "Error invoking remote method 'hermes:kanban:board': Error: ";

describe('describeHermesFailure', () => {
  it('names the gateway and the cause when nothing is listening', () => {
    const r = describeHermesFailure(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`, 'http://127.0.0.1:9119');
    expect(r.message).toContain('http://127.0.0.1:9119');
    expect(r.message).toMatch(/not answering/i);
    expect(r.message).not.toContain('invoking remote method');
  });

  it('strips the Electron IPC wrapper off the detail line', () => {
    const r = describeHermesFailure(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`, 'http://127.0.0.1:9119');
    expect(r.detail).toBe('connect ECONNREFUSED 127.0.0.1:9119');
  });

  it('separates a timeout from a refusal', () => {
    const r = describeHermesFailure(`${IPC}timeout`, 'http://100.64.0.1:9119');
    expect(r.message).toMatch(/did not answer in time/i);
    expect(r.message).toContain('http://100.64.0.1:9119');
  });

  it('flags an unresolvable host', () => {
    const r = describeHermesFailure(`${IPC}getaddrinfo ENOTFOUND hermes.example`, 'http://hermes.example:9119');
    expect(r.message).toMatch(/could not be resolved/i);
  });

  it('says the gateway is simply not configured', () => {
    const r = describeHermesFailure(`${IPC}Invalid gateway URL`, null);
    expect(r.message).toMatch(/no hermes gateway is configured/i);
    expect(r.message).not.toContain(' at ');
  });

  it('degrades to a plain sentence for an unknown cause', () => {
    const r = describeHermesFailure(`${IPC}something odd happened`, 'http://127.0.0.1:9119');
    expect(r.message).toBe('Could not reach Hermes at http://127.0.0.1:9119.');
    expect(r.detail).toBe('something odd happened');
  });

  it('omits the address when the base URL is unknown', () => {
    const r = describeHermesFailure(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`, null);
    expect(r.message).not.toContain(' at ');
  });
});

/**
 * The Kanban page with no Hermes at all (2.0.7, H3; frame `First run (2.0.7) · states`, its row `Kanban, with no
 * Hermes gateway`). Main answers `Hermes is not configured. Set it up in Settings.` (hermes-handlers.ts).
 *
 * How it can fail, written before the code:
 * 1. that answer is still shown as a failure, a warning and Retry, when nothing failed: Hermes is a tool apart;
 * 2. a gateway that is configured but down is taken for no Hermes, and the user is not told it went silent;
 * 3. the page does not say the rest of Tars works without it, nor how to have the board.
 */
describe('isHermesAbsent', () => {
  it('reads main\'s not-configured answer as no Hermes, not a failure (1)', () => {
    expect(isHermesAbsent('Hermes is not configured. Set it up in Settings.')).toBe(true);
  });

  it('a configured gateway that fails is not no Hermes (2)', () => {
    expect(isHermesAbsent(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`)).toBe(false);
    expect(isHermesAbsent('Could not read the Hermes board')).toBe(false);
    expect(isHermesAbsent('Hermes session expired: sign in again.')).toBe(false);
  });

  it('says the rest of Tars works without it, and the way to the board (3)', () => {
    expect(HERMES_ABSENT_TEXT).toMatch(/Without it, the rest of Tars works/);
    expect(HERMES_ABSENT_TEXT).toMatch(/install Hermes, start its gateway, then connect it in Settings, Hermes\.$/);
  });
});
