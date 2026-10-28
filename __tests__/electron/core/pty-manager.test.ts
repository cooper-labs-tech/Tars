import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// pty-manager imports node-pty (native) and electron at module load — mock both
// so the module can be imported in the test environment.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

import { writeProgrammaticInput } from '../../../electron/core/pty-manager';
import type { IPty } from 'node-pty';

function makeFakePty() {
  const writes: string[] = [];
  const pty = {
    write: vi.fn((data: string) => {
      writes.push(data);
    }),
  } as unknown as IPty;
  return { pty, writes };
}

describe('writeProgrammaticInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a raw shell command as text + \\r in a single write (bracketPaste = false)', () => {
    const { pty, writes } = makeFakePty();
    writeProgrammaticInput(pty, "cd '/tmp' && claude");
    expect(writes).toEqual(["cd '/tmp' && claude\r"]);
  });

  it('delays the carriage return for a short single-line message (bracketPaste = true)', () => {
    // Regression: short Telegram/Slack messages must NOT be sent as an atomic
    // "text\r" — Claude Code's TUI treats that as a paste event and never
    // submits. The \r has to be a separate, delayed write.
    const { pty, writes } = makeFakePty();
    const msg = '[FROM TELEGRAM chat_id=123] hey, check the deploy';
    expect(msg.length).toBeLessThan(200);
    expect(msg).not.toContain('\n');

    writeProgrammaticInput(pty, msg, true);

    // Text is written immediately, but the \r has NOT been sent yet.
    // In bracket paste markers, short as it is, since 22/10.
    expect(writes).toEqual([`\x1b[200~${msg}\x1b[201~`]);

    vi.advanceTimersByTime(300);
    expect(writes).toEqual([`\x1b[200~${msg}\x1b[201~`, '\r']);
  });

  it('removes a closing paste marker written in its 7-bit form', () => {
    // The payload is a teammate's message: past a closing marker, the rest
    // stops being pasted content and arrives as typing, submitted by the \r
    // Tars sends 300 ms later.
    const { pty, writes } = makeFakePty();

    writeProgrammaticInput(pty, 'hello\n\u001b[201~/quit', true);

    expect(writes).toEqual(['\x1b[200~hello\n/quit\x1b[201~']);
  });

  it('removes a closing paste marker written in its 8-bit form, which has no bracket', () => {
    // \u009b IS ESC + '[', so the 8-bit marker is '\u009b201~' with no bracket
    // of its own: a pattern that requires one never matches it. Asserting the
    // exact text typed pins the marker gone rather than merely defused, which
    // is the difference between the first pass removing it and the second pass
    // eating the \u009b and printing a bare '201~'.
    const { pty, writes } = makeFakePty();

    writeProgrammaticInput(pty, 'hello\n\u009b201~/quit', true);

    expect(writes).toEqual(['\x1b[200~hello\n/quit\x1b[201~']);
  });

  it('wraps long/multi-line input in bracket paste markers with a delayed \\r', () => {
    const { pty, writes } = makeFakePty();
    const msg = 'line one\nline two';

    writeProgrammaticInput(pty, msg, true);
    expect(writes).toEqual(['\x1b[200~' + msg + '\x1b[201~']);

    vi.advanceTimersByTime(300);
    expect(writes).toEqual(['\x1b[200~' + msg + '\x1b[201~', '\r']);
  });
});
