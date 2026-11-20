import '../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import { connectionLine, keySender, NOT_RUNNING_LINE } from '../../src/lib/terminal';

/**
 * Keys typed into an agent with no terminal (#164's Low, from the Audit's
 * gate). Since #164, looking at an idle agent opens no terminal, and
 * agent:input answers `{ success: false, error: 'PTY not found' }` for it. An
 * idle Dashboard panel, the agent dialog and the tray terminal still took keys,
 * their callers dropped that answer, and the dialog said "Connected to X" with
 * no terminal behind it. Written before the code, as the ways it can fail:
 * 1. keys main refuses go nowhere and nothing says so;
 * 2. it is said on every key, so a line of typing fills the panel with notices;
 * 3. keys that land are answered with a notice, or a refusal after keys landed
 *    is not said again;
 * 4. a send that fails outright is dropped as silently as a refusal was;
 * 5. the dialog says it is connected to an agent that has no terminal.
 */

const terminal = () => ({ written: [] as string[], write(s: string) { this.written.push(s); } });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('keys typed into an agent with no terminal', () => {
  it('says so in the terminal when main refuses them (1)', async () => {
    const term = terminal();
    const send = vi.fn(async () => ({ success: false, error: 'PTY not found' }));
    keySender(term, send)('x');
    await settle();
    expect(send).toHaveBeenCalledWith('x');
    expect(term.written).toEqual([NOT_RUNNING_LINE]);
    expect(NOT_RUNNING_LINE).toMatch(/start/i);
  });

  it('says it once for a run of refused keys, not once per key (2)', async () => {
    const term = terminal();
    const keys = keySender(term, async () => ({ success: false }));
    for (const k of 'hello') keys(k);
    await settle();
    expect(term.written).toEqual([NOT_RUNNING_LINE]);
  });

  it('says nothing for keys that land, and says it again once keys are refused after (3)', async () => {
    const term = terminal();
    let running = true;
    const keys = keySender(term, async () => ({ success: running }));
    keys('a');
    await settle();
    expect(term.written).toEqual([]);
    running = false;
    keys('b');
    keys('c');
    await settle();
    expect(term.written).toEqual([NOT_RUNNING_LINE]);
    running = true;
    keys('d');
    await settle();
    running = false;
    keys('e');
    await settle();
    expect(term.written).toEqual([NOT_RUNNING_LINE, NOT_RUNNING_LINE]);
  });

  it('says so when the send fails outright (4)', async () => {
    const term = terminal();
    keySender(term, async () => { throw new Error('ipc closed'); })('x');
    await settle();
    expect(term.written).toEqual([NOT_RUNNING_LINE]);
  });
});

describe("the dialog's first line (5)", () => {
  it('says connected only when the agent has a terminal', () => {
    expect(connectionLine('Alpha', true)).toContain('Connected to Alpha');
    expect(connectionLine('Alpha', false)).not.toContain('Connected');
    expect(connectionLine('Alpha', false)).toMatch(/Alpha is not running/);
  });
});
