import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
/**
 * A message waiting for a terminal, taken back because its request was
 * cancelled (core/task-cancel.ts; POST /api/tasks/:ref/cancel; PR D of 2.0.0):
 * withdrawWaiting in electron/core/pty-manager.ts. Written with its code, and
 * shown to bite by mutants (the bench of PR D).
 *
 * How it fails:
 * 1. The cancelled message is still typed once the person clears the field.
 * 2. Another request's message, waiting in the same terminal, goes with it.
 * 3. Its onDropped is called, so its asker is told the message was given up
 *    when it was cancelled; or its onWithdrawn is not called, so the route's
 *    "still held" reminder fires later about a message that no longer exists.
 * 4. The panel's count of what waits is not taken down.
 */
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import {
  TYPING_PAUSE_MS, messagesWaiting, rememberTerminalOwner, resetTerminalInput, setFieldProbe, withdrawWaiting,
  writeHumanInput, writeProgrammaticInput,
} from '../../../electron/core/pty-manager';

function makeTerminal() {
  const written: string[] = [];
  const pty = { write: (data: string) => { written.push(data); } } as never;
  return { pty, get typed() { return written.join(''); } };
}
let terminal: ReturnType<typeof makeTerminal>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T20:00:00.000Z'));
  terminal = makeTerminal();
  rememberTerminalOwner(terminal.pty, 'w1');
  setFieldProbe(null);
});
afterEach(() => {
  resetTerminalInput(terminal.pty);
  vi.useRealTimers();
});

/** A request's message, held behind the draft the person left in the field. */
function heldRequest(ref: string, text: string) {
  const hooks = { written: 0, dropped: 0, withdrawn: 0 };
  const outcome = writeProgrammaticInput(terminal.pty, text, true, {
    agentId: 'w1', from: 'Lead · Docs', sender: { kind: 'agent', id: 'rC', name: 'Lead · Docs' }, taskRef: ref,
    onWritten: () => { hooks.written += 1; },
    onDropped: () => { hooks.dropped += 1; },
    onWithdrawn: () => { hooks.withdrawn += 1; },
  });
  return { outcome, hooks };
}

describe('a message taken back before it went in', () => {
  it('1, 3, 4. is never typed, calls onWithdrawn and not onDropped, and stops counting as waiting', () => {
    writeHumanInput(terminal.pty, 'x');
    const { outcome, hooks } = heldRequest('t-0000000a', 'QUEUED>> later');
    expect(outcome).toBe('held');
    expect(messagesWaiting().find((w) => w.agentId === 'w1')?.waiting).toBe(1);
    expect(withdrawWaiting(terminal.pty, 't-0000000a')).toBe(1);
    expect(hooks).toEqual({ written: 0, dropped: 0, withdrawn: 1 });
    expect(messagesWaiting().find((w) => w.agentId === 'w1')).toBeUndefined();
    // The person clears the field: nothing of the cancelled message follows.
    writeHumanInput(terminal.pty, '\x7f');
    vi.advanceTimersByTime(TYPING_PAUSE_MS + 5_000);
    expect(terminal.typed).not.toContain('QUEUED>> later');
  });

  it("2. takes back that request's message only", () => {
    writeHumanInput(terminal.pty, 'x');
    const cancelled = heldRequest('t-0000000a', 'CANCELLED>> this one');
    const kept = heldRequest('t-0000000b', 'KEPT>> that one');
    expect(withdrawWaiting(terminal.pty, 't-0000000a')).toBe(1);
    expect(withdrawWaiting(terminal.pty, 't-0000000a')).toBe(0);
    expect(withdrawWaiting(terminal.pty, 't-ffffffff')).toBe(0);
    writeHumanInput(terminal.pty, '\x7f');
    vi.advanceTimersByTime(TYPING_PAUSE_MS + 5_000);
    expect(terminal.typed).not.toContain('CANCELLED>> this one');
    expect(terminal.typed).toContain('KEPT>> that one');
    expect(cancelled.hooks.withdrawn).toBe(1);
    expect(kept.hooks).toMatchObject({ withdrawn: 0, dropped: 0 });
  });

  it('a terminal Tars never wrote to holds nothing to take back', () => {
    expect(withdrawWaiting(makeTerminal().pty, 't-0000000a')).toBe(0);
  });
});
