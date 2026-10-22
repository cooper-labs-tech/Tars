import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPty } from 'node-pty';

/**
 * An Esc that cut a turn, and the field the CLI refills (the Audit's M2 on
 * #461 at 4804a90f). Read from the CLIs' own code, installed on this Mac:
 *  - Qwen Code 0.25.2, on a user's cancel: what the user queued during the turn
 *    (typed, then Enter) goes back into the field first; then, the field empty
 *    and nothing queued, the cancelled prompt is put back into it, unless a
 *    tool call is pending or running.
 *  - Claude Code 2.1.302, on a user's cancel with an empty field: the last
 *    user message is put back (`auto_restore_cancel`).
 * Tars took the field to be as it was before the Esc, typed its next task
 * after that text, and one Enter sent both: the cut task again, or the user's
 * own words.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  F1. Nothing but the Esc was typed since the task went in, and the CLI put
 *      that task back: the next task is sent with it (qwen, claude).
 *  F2. The user queued a message during the turn, and qwen moved it back into
 *      the field: the next task is typed after it and sent with it.
 *  F3. The user had typed in the field, then pressed Esc: the next task goes
 *      in although the field is not Tars's to clear.
 *  F4. Tars typed a message into the running turn, which qwen queued and moved
 *      back: the next task is sent with it.
 *  F5. Over-correction: the CLI put nothing back (a tool was running), and the
 *      next task still waits, or is not sent alone.
 *
 * The writer is the real one; the CLI is a field of its own that takes the
 * bytes as the CLIs do: a paste or keys into the field, a backspace out of it,
 * an Enter that submits (or queues, while a turn runs), and the Esc that cuts
 * the turn and refills the field, by the flavour's rule.
 *
 * Added after the Audit's re-check at 1368d779 (2026-10-19):
 *  F7. (L5) The guard "the field was empty before the Esc" is pinned by no test:
 *      the user's draft, set aside for a task and typed back, then a lone Esc,
 *      and Tars would backspace into the draft. (Since 22/10 no draft is set
 *      aside: the task waits behind it, and the Esc must not change that.)
 *  F8. (L6) A line and Enter the user typed while Tars wrote the task, held then
 *      replayed into the turn, not counted among the keys typed since: qwen
 *      moves it back on the Esc, and Tars would backspace into it.
 *
 * Added after the E2E of 759e43f6 (2026-10-19), before the fix:
 *  F9. The turn's UserPromptSubmit, which confirms the submission, lands after
 *      the Esc (the Esc came while Tars still held the field, and the hook's
 *      post raced it): it resets the draft to an empty field and takes the
 *      Esc's mark with it, the cut is not taken for one, and the next task is
 *      sent with the cut one the CLI put back (classic shell, 2 runs in 4).
 */

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: () => {} }));

import {
  PROGRAMMATIC_SUBMIT_DELAY_MS, TYPING_PAUSE_MS, messagesWaiting, noteSubmitted, noteTurnCut, rememberTerminalOwner, resetTerminalInput,
  setTurnProbe, setTurnInProgressProbe, writeHumanInput, writeProgrammaticInput,
} from '../../../electron/core/pty-manager';

type Flavour = 'qwen' | 'claude';

/** A CLI's input field, and what it submits, as qwen 0.25.2 and claude 2.1.302 handle these bytes. */
function fakeCli(flavour: Flavour, opts: { toolRunning?: boolean } = {}) {
  const cli = { field: '', queue: [] as string[], submitted: [] as string[], turn: false, last: '' };
  const write = (data: string) => {
    if (data === '\x1b') {
      if (!cli.turn) { cli.field = ''; return; }
      cli.turn = false;
      if (flavour === 'qwen') {
        const popped = cli.queue.splice(0).join('\n');
        if (popped) { cli.field = cli.field ? `${popped}\n${cli.field}` : popped; return; }
      }
      if (cli.field === '' && !opts.toolRunning) cli.field = cli.last;
      return;
    }
    if (data === '\r') {
      if (!cli.field) return;
      if (cli.turn) { cli.queue.push(cli.field); cli.field = ''; return; }
      cli.submitted.push(cli.field);
      cli.last = cli.field;
      cli.field = '';
      cli.turn = true;
      return;
    }
    const text = data.replace(/\x1b\[20[01]~/g, '');
    for (const ch of text) {
      if (ch === '\x7f') cli.field = cli.field.slice(0, -1);
      else if (ch === '\x03') cli.field = '';
      else if (ch >= ' ' || ch === '\n') cli.field += ch;
    }
  };
  const pty = { write } as unknown as IPty;
  return { cli, pty };
}

const T1 = 'TASK-ONE review the notes';
const T2 = 'TASK-TWO write the summary';
const origin = { agentId: 'qw' };
/** Past the pause a person's last key is given, the delayed carriage return and the probes. */
const settle = () => vi.advanceTimersByTime(TYPING_PAUSE_MS + PROGRAMMATIC_SUBMIT_DELAY_MS + 3000);
let made: ReturnType<typeof fakeCli>;

function start(flavour: Flavour, opts: { toolRunning?: boolean } = {}) {
  made = fakeCli(flavour, opts);
  rememberTerminalOwner(made.pty, 'qw');
  // Both probes, as the app wires them; with no task in hand they agree.
  setTurnProbe(() => made.cli.turn);
  setTurnInProgressProbe(() => made.cli.turn);
  expect(writeProgrammaticInput(made.pty, T1, true, origin)).toBe('written');
  settle();
  expect(made.cli.submitted).toEqual([T1]);
  return made;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  if (made) resetTerminalInput(made.pty);
  setTurnProbe(null);
  setTurnInProgressProbe(null);
  vi.useRealTimers();
});

describe('the next task after an Esc that cut a turn', () => {
  it.each<Flavour>(['qwen', 'claude'])('F1. %s put the cut task back: the next one is sent alone', (flavour) => {
    const { cli, pty } = start(flavour);
    writeHumanInput(pty, '\x1b');
    expect(cli.field, 'the CLI put the cut task back').toBe(T1);
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1, T2]);
  });

  it.each<Flavour>(['qwen', 'claude'])('F9. %s: the submission confirmed after the Esc still lets the cut be taken for one: the next task is sent alone', (flavour) => {
    const { cli, pty } = start(flavour);
    writeHumanInput(pty, '\x1b');
    expect(cli.field, 'the CLI put the cut task back').toBe(T1);
    // UserPromptSubmit of the cut turn, its post later than the Esc.
    noteSubmitted(pty);
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1, T2]);
  });

  it('F2. qwen moved the user\'s queued message back: the next task waits, and the message stays the user\'s', () => {
    const { cli, pty } = start('qwen');
    for (const ch of 'my own idea') writeHumanInput(pty, ch);
    writeHumanInput(pty, '\r');
    writeHumanInput(pty, '\x1b');
    expect(cli.field).toBe('my own idea');
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1]);
    expect(cli.field).toBe('my own idea');
    expect(messagesWaiting().find((w) => w.agentId === 'qw')).toBeDefined();
  });

  it.each<Flavour>(['qwen', 'claude'])('F3. %s: the user had typed in the field before the Esc: the next task waits', (flavour) => {
    const { cli, pty } = start(flavour);
    for (const ch of 'half a thought') writeHumanInput(pty, ch);
    writeHumanInput(pty, '\x1b');
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1]);
    expect(cli.field).toContain('half a thought');
  });

  it('F4. qwen moved a message Tars typed into the running turn back: the next task waits', () => {
    const { cli, pty } = start('qwen');
    writeProgrammaticInput(pty, 'NOTE for information', true, origin);
    settle();
    expect(cli.queue).toEqual(['NOTE for information']);
    writeHumanInput(pty, '\x1b');
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1]);
  });

  it.each<Flavour>(['qwen', 'claude'])('F5. %s put nothing back (a tool was running): the next task goes in, alone', (flavour) => {
    const { cli, pty } = start(flavour, { toolRunning: true });
    writeHumanInput(pty, '\x1b');
    expect(cli.field).toBe('');
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1, T2]);
  });

  it.each<Flavour>(['qwen', 'claude'])('F6. %s, a delegated task in hand (the agent holds messages while no turn runs): its turn is known opened, and after the Esc the next task goes in alone', (flavour) => {
    // As the app wires them (agent-manager.ts): a task in hand holds messages; only the CLI's own turn is a turn running.
    made = fakeCli(flavour);
    rememberTerminalOwner(made.pty, 'qw');
    setTurnProbe(() => true);
    setTurnInProgressProbe(() => made.cli.turn);
    const { cli, pty } = made;
    writeProgrammaticInput(pty, T1, true, origin);
    settle();
    expect(cli.submitted).toEqual([T1]);
    writeHumanInput(pty, '\x1b');
    writeProgrammaticInput(pty, T2, true, { ...origin });
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1, T2]);
  });

  it.each<Flavour>(['qwen', 'claude'])('F7. (the Audit\'s L5) %s: the user\'s draft in the field when a task comes, then a lone Esc: no task goes in, and the draft is not touched', (flavour) => {
    made = fakeCli(flavour);
    rememberTerminalOwner(made.pty, 'qw');
    setTurnProbe(() => made.cli.turn);
    setTurnInProgressProbe(() => made.cli.turn);
    const { cli, pty } = made;
    for (const ch of 'my draft') writeHumanInput(pty, ch);
    writeProgrammaticInput(pty, T1, true, origin);
    settle();
    expect(cli.submitted, 'the task waits behind the draft').toEqual([]);
    expect(cli.field, 'the draft untouched').toBe('my draft');
    // A turn of the agent's own runs, and the person's Esc cuts it.
    cli.turn = true;
    writeHumanInput(pty, '\x1b');
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([]);
    expect(cli.field).toBe('my draft');
  });

  it('F8. (the Audit\'s L6) qwen: a line and Enter typed while Tars writes the task, queued by qwen and moved back by the Esc: the next task waits, the line kept', () => {
    made = fakeCli('qwen');
    rememberTerminalOwner(made.pty, 'qw');
    setTurnProbe(() => made.cli.turn);
    setTurnInProgressProbe(() => made.cli.turn);
    const { cli, pty } = made;
    writeProgrammaticInput(pty, T1, true, origin);
    // In Tars's write window, before its Enter: held, then replayed after it, into the running turn.
    for (const ch of 'mine') writeHumanInput(pty, ch);
    writeHumanInput(pty, '\r');
    settle();
    expect(cli.submitted).toEqual([T1]);
    expect(cli.queue, 'qwen queued the user\'s line').toEqual(['mine']);
    writeHumanInput(pty, '\x1b');
    expect(cli.field).toBe('mine');
    writeProgrammaticInput(pty, T2, true, origin);
    noteTurnCut(pty);
    settle();
    expect(cli.submitted).toEqual([T1]);
    expect(cli.field).toBe('mine');
  });
});

