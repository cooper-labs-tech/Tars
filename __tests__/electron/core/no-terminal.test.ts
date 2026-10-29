import { describe, it, expect, vi } from 'vitest';
import { NoTerminalLeft } from '../../../electron/core/pty-pool';
import { markNoTerminal, noTerminalAnswer } from '../../../electron/core/no-terminal';
import type { AgentStatus } from '../../../electron/types';

/**
 * An agent the machine had no terminal for says why, whatever started it (2.0.6, item 1; the Frontend's finding on
 * #553, 29/10: at fab678b90 a window's start that hit NoTerminalLeft rejected and left the agent as it was, so its
 * card and its pane line, which show `error` while the status is 'error', had nothing to say).
 *
 * How it fails, written before the code (29/10):
 * N1. The agent is left as it was: no status 'error', no `error`, nothing saved, nothing told to the window.
 * N2. An asleep agent is set 'error': its asleep mark (asleepSince) and the session it slept in stay, the wake that
 *     clears them runs only after a terminal opened (core/agent-asleep.ts wakeFromSleep), and it would read asleep
 *     for good. It keeps 'asleep', which its next message or key retries, with the reason in `error`.
 * N3. Any other failure is taken for this one: the agent is marked and told something false.
 * N4. The window's start rejects instead of answering: it must answer { success: false, error, code: 'no_terminal' },
 *     and any other failure is left to throw as before.
 */

const full = new NoTerminalLeft({ inUse: 510, max: 511, tars: 30, open: 30 }, 'darwin');
const agentAt = (status: AgentStatus['status']): AgentStatus => ({ id: 'a1', name: 'Harbor Worker', status, projectPath: '/p' } as AgentStatus);

describe('an agent the machine had no terminal for', () => {
  it('N1. is set error with the reason, saved, and the window told', () => {
    const agent = agentAt('idle');
    const save = vi.fn();
    const announce = vi.fn();
    expect(markNoTerminal(agent, full, save, announce)).toBe(true);
    expect(agent.status).toBe('error');
    expect(agent.error).toBe(full.message);
    expect(save).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(agent);
  });

  it('N2. asleep, it keeps asleep with the reason', () => {
    const agent = { ...agentAt('asleep'), asleepSince: '2026-10-29T10:00:00.000Z' };
    const save = vi.fn();
    const announce = vi.fn();
    expect(markNoTerminal(agent, full, save, announce)).toBe(true);
    expect(agent.status).toBe('asleep');
    expect(agent.asleepSince).toBe('2026-10-29T10:00:00.000Z');
    expect(agent.error).toBe(full.message);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('N3. any other failure changes nothing', () => {
    const agent = agentAt('idle');
    const save = vi.fn();
    const announce = vi.fn();
    expect(markNoTerminal(agent, new Error('posix_spawnp failed.'), save, announce)).toBe(false);
    expect(agent).toEqual(agentAt('idle'));
    expect(save).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('N4. the window\'s start is answered with the reason and its code; any other failure is not', () => {
    expect(noTerminalAnswer(full)).toEqual({ success: false, error: full.message, code: 'no_terminal' });
    expect(noTerminalAnswer(new Error('boom'))).toBeUndefined();
  });
});
