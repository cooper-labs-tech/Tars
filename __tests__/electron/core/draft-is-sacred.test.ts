import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPty } from 'node-pty';

/**
 * JeanBrasse's draft is sacred: Tars never clears, edits or submits text he typed (his report of 22/10, on Tars 2.0.3
 * and Claude Code 2.1.306: « ça a delete mon message »). A task-end notice arrived while he was writing a long
 * message in the orchestrator's terminal; the beginning of his draft went, and the orchestrator received the notice
 * with the tail of his draft behind it, submitted: "...then carry on.grer ca avec Pencil en plus. ...".
 *
 * Measured on 22/10 on Claude Code 2.1.306 in a real terminal (the bench of PR "draft kept"): its prompt takes mouse
 * clicks, and a click moves the caret. The draft model ignored mouse reports, so it still put the caret at the end;
 * Tars then sent no Right and one Backspace per character, which took the text before the click, pasted the message
 * there and pressed Enter: "MSGFROMTARS then carry on.gamma delta epsilon" went out, the draft's tail behind it.
 * Setting a draft aside and typing it back can only be as exact as the model, and the model cannot see the screen.
 *
 * How it can fail, written before the fix (22/10):
 *  D1. A message is written into a field that holds a draft (one line, several lines, the caret moved, after a
 *      click), or any key of the draft is deleted or typed again.
 *  D2. The draft and the message go out in one submission.
 *  D3. The message is dropped instead of waiting.
 *  D4. The message still waits once the person has sent the draft: an Enter on a draft the model follows, or an
 *      Enter the submit hook proves on one it does not.
 *  D5. The wait is silent: the window is not told a message is waiting.
 *  D6. A click inside a draft leaves the model sure of the caret, so that keys typed after it (Backspaces up to an
 *      empty field, as the model counts) let a message in while the field still holds text.
 *  D7. Over-correction: a wheel scroll, a mouse motion, a button release, a focus report, or a click on an empty
 *      field make the model unsure, and messages wait behind a field that is empty.
 *  D8. A field the person emptied (Backspace to nothing, Ctrl+C) still holds the message back.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const broadcasts: Array<{ channel: string; payload: unknown }> = [];
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { broadcasts.push({ channel, payload }); },
}));

import { emptyDraft, feedDraft } from '../../../electron/core/input-draft';
import {
  PROGRAMMATIC_SUBMIT_DELAY_MS,
  TYPING_PAUSE_MS,
  draftOf,
  noteSubmitted,
  resetTerminalInput,
  writeHumanInput,
  writeProgrammaticInput,
} from '../../../electron/core/pty-manager';

const NOTE = 'Message from Tars: [Tars] "Tars-Backend" has finished its turn. Read what it produced, then carry on.';

let written: string[] = [];
let pty: IPty;

beforeEach(() => {
  vi.useFakeTimers();
  broadcasts.length = 0;
  written = [];
  pty = { write: (data: string) => { written.push(data); } } as unknown as IPty;
});

afterEach(() => {
  resetTerminalInput(pty);
  vi.useRealTimers();
});

const types = (text: string) => { for (const ch of text) writeHumanInput(pty, ch); };
/** A click where xterm sends one with SGR mouse mode on: a press and a release. */
const click = (col: number, row: number, button = 0) => {
  writeHumanInput(pty, `\x1b[<${button};${col};${row}M`);
  writeHumanInput(pty, `\x1b[<${button};${col};${row}m`);
};
/** Long past the typing pause and every delay a write has. */
const later = () => vi.advanceTimersByTime(TYPING_PAUSE_MS * 4 + PROGRAMMATIC_SUBMIT_DELAY_MS + 5000);
const waitingNotices = () => broadcasts.filter(b => b.channel === 'agent:message-waiting').map(b => b.payload as { waiting: number });

/** What Tars itself wrote into the terminal, apart from the person's own keys (which writeHumanInput passes on). */
function tarsWrote(humanKeys: string[]): string[] {
  const rest = [...written];
  for (const key of humanKeys) {
    const at = rest.indexOf(key);
    if (at >= 0) rest.splice(at, 1);
  }
  return rest;
}

const DRAFTS: Array<[string, () => string[]]> = [
  ['one line', () => { const keys = [...'je pense quil faut gerer ca avec Pencil']; keys.forEach(k => writeHumanInput(pty, k)); return keys; }],
  ['several lines', () => {
    const keys = [...'premiere ligne', '\x1b\r', ...'deuxieme ligne', '\x1b\r', ...'troisieme'];
    keys.forEach(k => writeHumanInput(pty, k));
    return keys;
  }],
  ['the caret moved left', () => {
    const keys = [...'alpha beta gamma delta', ...Array(6).fill('\x1b[D')];
    keys.forEach(k => writeHumanInput(pty, k));
    return keys;
  }],
  ['a click inside it', () => {
    const keys = [...'alpha beta gamma delta epsilon'];
    keys.forEach(k => writeHumanInput(pty, k));
    click(14, 38);
    return [...keys, '\x1b[<0;14;38M', '\x1b[<0;14;38m'];
  }],
];

describe('a message that arrives while a draft is in the field', () => {
  for (const [name, typeDraft] of DRAFTS) {
    it(`D1 D2 D3. ${name}: nothing of Tars's is written, the draft is not touched, and the message waits`, () => {
      const keys = typeDraft();
      expect(writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' })).not.toBe('refused');
      later();
      expect(tarsWrote(keys)).toEqual([]);
      expect(written.join('')).not.toContain('\x7f');
      expect(written.join('')).not.toContain(NOTE);
    });
  }

  it('D5. the window is told that a message is waiting', () => {
    types('je pense quil faut');
    writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' });
    later();
    expect(waitingNotices().at(-1)).toMatchObject({ waiting: 1 });
  });
});

describe('once the person has sent the draft', () => {
  it('D4. an Enter on a draft the model follows lets the message in, alone, after it', () => {
    types('je pense quil faut');
    writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' });
    later();
    writeHumanInput(pty, '\r');
    later();
    const stream = written.join('');
    expect(stream.indexOf(NOTE)).toBeGreaterThan(stream.indexOf('je pense quil faut\r'));
    expect(stream).not.toContain('\x7f');
    expect(waitingNotices().at(-1)).toMatchObject({ waiting: 0 });
  });

  it('D4. an Enter on a draft the model lost, proved by the submit hook, lets the message in', () => {
    types('je pense quil faut');
    click(5, 38);
    types(' encore');
    writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' });
    later();
    writeHumanInput(pty, '\r');
    later();
    expect(written.join('')).not.toContain(NOTE);
    noteSubmitted(pty);
    later();
    expect(written.join('')).toContain(NOTE);
  });
});

describe('the mouse', () => {
  it('D6. a click inside a draft: Backspaces counted to nothing do not let a message into what is left', () => {
    types('abcdef');
    click(3, 38);
    for (let i = 0; i < 6; i++) writeHumanInput(pty, '\x7f');
    expect(draftOf(pty).state).not.toBe('known');
    writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' });
    later();
    expect(written.join('')).not.toContain(NOTE);
  });

  it('D7. a wheel, a motion, a release, a focus report and a click on an empty field leave an empty field known', () => {
    const d = [
      '\x1b[<64;10;5M', '\x1b[<65;10;5M', // wheel up and down
      '\x1b[<35;12;6M', // motion with no button
      '\x1b[<0;12;6m', // a release alone
      '\x1b[I', '\x1b[O', // focus in and out
      '\x1b[<0;3;38M', '\x1b[<0;3;38m', // a click on the empty field
      '\x1b[M #!', // a click in the X10 encoding
    ].reduce(feedDraft, emptyDraft());
    expect(d).toEqual(emptyDraft());
  });

  it('D6. a click in the X10 encoding inside a draft makes the model unsure too', () => {
    expect(feedDraft(feedDraft(emptyDraft(), 'abc'), '\x1b[M #!').state).toBe('unknown');
  });

  it('D7. a wheel or a motion over a draft leaves it known, caret where it was', () => {
    const typed = feedDraft(emptyDraft(), 'abc');
    expect(['\x1b[<64;10;5M', '\x1b[<35;12;6M', '\x1b[<0;12;6m'].reduce(feedDraft, typed)).toEqual(typed);
  });
});

describe('a field the person emptied', () => {
  it('D8. Backspace to nothing: the message goes in at the pause', () => {
    types('oups');
    for (let i = 0; i < 4; i++) writeHumanInput(pty, '\x7f');
    writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' });
    later();
    expect(written.join('')).toContain(NOTE);
  });

  it('D8. Ctrl+C: the message goes in at the pause', () => {
    types('oups');
    writeHumanInput(pty, '\x03');
    writeProgrammaticInput(pty, NOTE, true, { agentId: 'orch', from: 'Tars' });
    later();
    expect(written.join('')).toContain(NOTE);
  });
});
