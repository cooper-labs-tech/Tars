import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const foreground = vi.hoisted(() => ({ value: '2.1.280' }));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ pid: 7, get process() { return foreground.value; }, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() })),
}));
vi.mock('electron', () => ({ BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }) }));

import * as pm from '../../../electron/core/pty-manager';
import type { IPty } from 'node-pty';

/**
 * A message held for a terminal is typed only while a CLI still runs in it
 * (the Audit's gate of #231, finding 5).
 *
 * A message waits in a terminal's queue while somebody types in it, or a
 * dialog is up. It was checked for a running CLI when it was handed over, and
 * not again when it finally went in: if the CLI stopped meanwhile, the text
 * went to the shell's prompt, where each newline runs a line as a command.
 * That is any held message: a teammate's, a Telegram one, JeanBrasse's answer.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. The CLI stops while a message is held, and the message is typed into
 *    the shell.
 * 2. Its sender is never told it did not go.
 * 3. Over-correction: with the CLI still there, a held message never goes.
 * 4. What the writer is told for a real agent terminal is wrong: a terminal
 *    back at its shell reads as a CLI, or one running the CLI reads as
 *    stopped, or a terminal Tars did not start as an agent's is refused.
 */

let cliRunning = true;
function terminal() {
  const writes: string[] = [];
  const pty = { pid: 1, process: 'claude', write: (d: string) => { writes.push(d); } } as unknown as IPty;
  return { pty, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
  cliRunning = true;
  (pm as unknown as { setCliProbe?: (p: (t: IPty) => boolean) => void }).setCliProbe?.(() => cliRunning);
});
afterEach(() => vi.useRealTimers());

function heldMessage() {
  const { pty, writes } = terminal();
  // Somebody types, then empties the field: a pause, and nothing to put back.
  pm.writeHumanInput(pty, 'a');
  pm.writeHumanInput(pty, '\x7f');
  let dropped = false;
  const outcome = pm.writeProgrammaticInput(pty, 'first line\nrm -rf ~/work', true, {
    agentId: 'a1', from: 'Tars', sender: { kind: 'tars' }, onDropped: () => { dropped = true; },
  });
  return { writes, outcome, wasDropped: () => dropped };
}

describe('a held message', () => {
  it('1, 2. is not typed into the shell when the CLI stopped while it waited, and its sender is told', async () => {
    const m = heldMessage();
    expect(m.outcome).toBe('held');

    cliRunning = false;
    await vi.advanceTimersByTimeAsync(pm.TYPING_PAUSE_MS + 2_000);

    expect(m.writes.join('')).not.toContain('rm -rf');
    expect(m.wasDropped()).toBe(true);
  });

  it('3. still goes in when the CLI is there', async () => {
    const m = heldMessage();
    await vi.advanceTimersByTimeAsync(pm.TYPING_PAUSE_MS + 2_000);
    expect(m.writes.join('')).toContain('rm -rf ~/work');
    expect(m.wasDropped()).toBe(false);
  });
});

describe('whether an agent\'s CLI stopped', () => {
  it('4. is read from the terminal Tars started: stopped at its shell, not while the CLI runs, unknown otherwise', async () => {
    const { spawnAgentPty, cliStoppedIn } = await import('../../../electron/core/agent-pty');
    const t = spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24, env: {} });
    foreground.value = '2.1.280';
    expect(cliStoppedIn(t)).toBe(false);
    foreground.value = 'bash';
    expect(cliStoppedIn(t)).toBe(true);
    expect(cliStoppedIn({ process: 'bash' } as unknown as IPty)).toBe(false);
  });
});
