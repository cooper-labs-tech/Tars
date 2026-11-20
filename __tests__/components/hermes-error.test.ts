import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { describeHermesFailure } from '@/components/KanbanBoard/hermes-error';

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
