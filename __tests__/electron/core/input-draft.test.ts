import { describe, it, expect } from 'vitest';
import {
  confirmSubmitted,
  emptyDraft,
  feedDraft,
  isKeystroke,
} from '../../../electron/core/input-draft';

/**
 * The model of what is in an agent's input field, rebuilt from the keys Tars
 * relays into it.
 *
 * It exists so a message can be kept out of a half-written prompt, which
 * means the only thing that matters about it is where it says "I know" and
 * where it says "I do not": a wrong "I know" clears a field Tars cannot put
 * back, and that is worse than never delivering anything. So most of what is
 * below is the giving-up half.
 *
 * Every behaviour asserted here was measured against Claude Code 2.1.273 in a
 * real PTY, keys sent as xterm sends them, each submission read from its
 * UserPromptSubmit hook. The measurements are quoted in input-draft.ts.
 */

/** As the panel sends it: one onData per key. */
function type(text: string) {
  return [...text].reduce((draft, ch) => feedDraft(draft, ch), emptyDraft());
}

describe('the draft model follows what it was measured to follow', () => {
  it('builds a line from the keys and leaves the caret at the end', () => {
    expect(type('salut')).toEqual({ text: 'salut', cursor: 5, state: 'known' });
  });

  it('inserts where the caret is, not at the end', () => {
    let draft = type('salut');
    draft = feedDraft(draft, '\x1b[D'.repeat(2));
    draft = feedDraft(draft, 'X');
    expect(draft.text).toBe('salXut');
    expect(draft.cursor).toBe(4);
  });

  it('takes Option+Enter as a newline and keeps the line it opened', () => {
    let draft = type('une');
    draft = feedDraft(draft, '\x1b\r');
    draft = feedDraft(draft, 'deux');
    expect(draft).toEqual({ text: 'une\ndeux', cursor: 8, state: 'known' });
  });

  it('takes a backslash before Enter as a newline, and the backslash goes', () => {
    let draft = type('une\\');
    draft = feedDraft(draft, '\r');
    expect(draft).toEqual({ text: 'une\n', cursor: 4, state: 'known' });
  });

  it('empties the field on Ctrl+C, whatever it held and whatever it knew', () => {
    const lost = feedDraft(type('salut'), '\x1bOP');
    expect(lost.state).toBe('unknown');
    expect(feedDraft(lost, '\x03')).toEqual({ text: '', cursor: 0, state: 'known' });
  });

  it('empties the field on Enter, which is what a submission does', () => {
    expect(feedDraft(type('salut'), '\r')).toEqual({ text: '', cursor: 0, state: 'known' });
  });

  it('crosses newlines with the arrows and stays on its line with Home and End', () => {
    let draft = feedDraft(feedDraft(type('une'), '\x1b\r'), 'deux');
    draft = feedDraft(draft, '\x01');
    expect(draft.cursor).toBe(4);
    draft = feedDraft(draft, '\x1b[D');
    expect(draft.cursor).toBe(3);
    draft = feedDraft(draft, '\x05');
    expect(draft.cursor).toBe(3);
  });

  it('joins the two lines when Backspace crosses the newline', () => {
    let draft = feedDraft(feedDraft(type('une'), '\x1b\r'), 'deux');
    draft = feedDraft(draft, '\x01');
    draft = feedDraft(draft, '\x7f');
    expect(draft.text).toBe('unedeux');
  });

  it('keeps a paste that stays inline, newlines and all', () => {
    const draft = feedDraft(type('avant '), '\x1b[200~une\rdeux\x1b[201~');
    expect(draft.text).toBe('avant une\ndeux');
  });

  it('does not count a mouse report or a focus report as a key', () => {
    expect(isKeystroke('\x1b[<64;40;12M')).toBe(false);
    expect(isKeystroke('\x1b[I')).toBe(false);
    expect(isKeystroke('\x1b[O')).toBe(false);
    expect(isKeystroke('a')).toBe(true);
    expect(feedDraft(type('salut'), '\x1b[<64;40;12M')).toEqual(type('salut'));
  });
});

describe('the draft model gives up rather than guess', () => {
  const unfollowable: Array<[string, string]> = [
    ['history, which replaces the whole field', '\x1b[A'],
    ['Tab, which completes with something Tars never saw', '\t'],
    ['a lone Esc, which arms a clear or opens the rewind dialog', '\x1b'],
    ['Ctrl+U, which kills to the start of the line and fills the kill ring', '\x15'],
    ['Option+Backspace, which deletes a word', '\x1b\x7f'],
    ['a function key nothing here models', '\x1bOP'],
  ];
  for (const [what, keys] of unfollowable) {
    it(`gives up on ${what}`, () => {
      expect(feedDraft(type('salut'), keys).state).toBe('unknown');
    });
  }

  it('gives up on a paste big enough to be folded into a placeholder', () => {
    expect(feedDraft(emptyDraft(), `\x1b[200~${'x'.repeat(900)}\x1b[201~`).state).toBe('unknown');
    expect(feedDraft(emptyDraft(), '\x1b[200~a\rb\rc\rd\x1b[201~').state).toBe('unknown');
  });

  it('gives up on a paste that is nothing but a newline, which is dropped one time in four', () => {
    expect(feedDraft(type('salut'), '\x1b[200~\r\x1b[201~').state).toBe('unknown');
  });

  it('gives up on the keys that could accept an inline suggestion instead of moving', () => {
    expect(feedDraft(type('salut'), '\x1b[C').state).toBe('unknown');
    expect(feedDraft(type('salut'), '\x05').state).toBe('unknown');
  });

  it('hedges on Enter after a slash, which may have opened a dialog rather than submitted', () => {
    const after = feedDraft(type('/model'), '\r');
    expect(after).toEqual({ text: '', cursor: 0, state: 'pending' });
    // And keeps following: the keys since are on top of an empty field either way.
    expect(feedDraft(after, 'abc').text).toBe('abc');
    // The hook that says a prompt was submitted is what settles it.
    expect(confirmSubmitted(after).state).toBe('known');
  });

  it('stays given up once it has given up', () => {
    const lost = feedDraft(type('salut'), '\t');
    expect(feedDraft(lost, 'encore').state).toBe('unknown');
  });

  it('is not given up for ever: Enter says the field emptied, whatever was in it', () => {
    // Without this the only way out was Ctrl+C, so a message held behind an
    // unknown field waited through a whole submission and a whole turn.
    const lost = feedDraft(type('salut'), '\t');
    const afterEnter = feedDraft(lost, '\r');
    expect(afterEnter).toEqual({ text: '', cursor: 0, state: 'pending' });
    // And it is followed again from there, so the keys typed between the
    // Enter and the hook are not lost.
    expect(feedDraft(afterEnter, 'la suite').text).toBe('la suite');
    expect(confirmSubmitted(feedDraft(afterEnter, 'la suite')))
      .toEqual({ text: 'la suite', cursor: 8, state: 'known' });
  });

  it('takes the hook as proof on its own, for a submission no Enter of ours explains', () => {
    const lost = feedDraft(type('salut'), '\t');
    expect(confirmSubmitted(lost)).toEqual({ text: '', cursor: 0, state: 'known' });
  });
});

/**
 * An Esc that cut a turn (2.0.4, the Audit's L1 on #461, found by
 * qwen-code.spec.ts). A lone Esc gives the field up: on an idle field it arms
 * "Esc again to clear" or opens the rewind dialog. In the middle of a turn it
 * cuts the turn instead (Claude Code, Qwen Code 0.25.2 measured on 2026-10-18)
 * and leaves the field as it was; the transcript then says so. Until now the
 * field stayed unknown, and the next task Tars had for the agent waited behind
 * it until somebody pressed Enter or Ctrl+C.
 *
 * The cut is read by the terminal's writer since F9 (pty-manager.ts,
 * noteTurnCut, from what Tars left in the field and what was typed since), not
 * from the draft: escCutTheTurn and the field it kept before the Esc, with E2
 * to E4, went with the Audit's L7 on #461. What stays is the draft's own part.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  E1. A lone Esc is taken as known: on an idle field it may have armed a clear.
 */
describe('an Esc that cut a turn', () => {
  it('E1. a lone Esc gives the field up', () => {
    expect(feedDraft(type('salut'), '\x1b').state).toBe('unknown');
  });
});
