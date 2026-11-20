import { describe, it, expect } from 'vitest';
import { directiveOf } from '../e2e/fake-clis.mjs';

/**
 * What a turn's text asks of the recording stand-in (e2e/fake-clis.mjs), as a model reads it: the first of its
 * directives (DELEGATE, SEND, ECHO, APPROVE, HOLD), or nothing.
 *
 * Tars's own notices are information. A model reads what they quote and does not do it; the stand-in did. At #595's
 * acce74f09 it skipped Tars's "[Note for information from "Tars" ...]" only, and the CLI matrix's claude still ran
 * the task quoted in "[Tars] "B" ("x-b") has finished its turn (task t-..., "SEND x-a REPLY...")": it messaged
 * itself, behind the next pair's DELEGATE line (Tars-Backend-4's reading for #611, reports/matrix-no-answer.md).
 *
 * How it can fail, written on 2026-11-20 before the code:
 * D1. A task an agent hands it, typed alone or under the session's header "[Tars: you are agent ...]", is not done.
 * D2. A message from another agent that carries a directive is not done: the matrix's reply is B's SEND back to A.
 * D3. Tars's note for information quoting a task another project handed this one's agent (`...: HOLD q1.`) is done:
 *     B's orchestrator held its turn on the worker's release file and never came to rest (acce74f09).
 * D4. Tars's notice that an agent finished its turn, quoting that turn's task, is done: A sends the quoted SEND to
 *     itself (the matrix, 28 such notices in one run of 20/11).
 * D5. Either notice, typed as the first turn of a session Tars starts on it (under the header), is done.
 * D6. Another "[Tars] " notice that quotes a message (what still waits in the queues) is done.
 * D7. The owner's words that Tars relays ("Message from Tars: the owner's words of ..."), which are an order, are
 *     skipped as a notice.
 * D8. A task whose own text has a "[Tars] " line further down is skipped: only a notice's head makes it one.
 * D9. A text with no directive asks something.
 */

const header = '[Tars: you are agent "B-Orchestrator" (id b-o), orchestrator of project /w/b. Work autonomously without asking for confirmation and end with a clear report of your results.]\n\n';

describe("the stand-in's reading of a turn", () => {
  it('D1. does the task an agent hands it, alone or under the session header', () => {
    expect(directiveOf('DELEGATE x-codex ECHO ANSWERCLAUDECODEX')).toEqual({ verb: 'DELEGATE', arg: 'x-codex', rest: 'ECHO ANSWERCLAUDECODEX' });
    expect(directiveOf(`${header}Message from agent "A-Orchestrator" ("a-o"): \nECHO oo1`)).toMatchObject({ verb: 'ECHO', arg: 'oo1' });
    expect(directiveOf('HOLD q1')).toMatchObject({ verb: 'HOLD', arg: 'q1' });
  });

  it("D2. does a directive another agent's message carries", () => {
    expect(directiveOf('Message from agent "Claude Agent" ("x-claude"): \nSEND x-claude REPLYCLAUDECODEX'))
      .toEqual({ verb: 'SEND', arg: 'x-claude', rest: 'REPLYCLAUDECODEX' });
  });

  it("D3. reads Tars's note for information and does not do the task it quotes", () => {
    const note = 'Message from Tars: \n[Note for information from "Tars", the app you run in: it is not a task, and asks nothing of you unless your own work needs it.] "A-Worker" (a-w), of project /w/a, delegated a task to "B-Qwen" (b-qwen) through the owner\'s allowlist: HOLD q1.';
    expect(directiveOf(note)).toBeNull();
  });

  it("D4. reads Tars's notice that an agent finished its turn and does not do the task it quotes", () => {
    const notice = 'Message from Tars: \n[Tars] "Qwen Agent" ("x-qwen") has finished its turn (task t-634de693, "SEND x-claude REPLYCLAUDEQWENCODE"). Read what it produced with get_agent_output, then carry on.';
    expect(directiveOf(notice)).toBeNull();
  });

  it('D5. reads either notice as the first turn of a session Tars starts on it', () => {
    expect(directiveOf(`${header}Message from Tars: \n[Tars] "Gemini Agent" ("x-gemini") has finished its turn (task t-6956b031, "SEND x-claude REPLYCLAUDEGEMINI"). Read what it produced with get_agent_output, then carry on.`)).toBeNull();
    expect(directiveOf(`${header}Message from Tars: \n[Note for information from "Tars", the app you run in: it is not a task, and asks nothing of you unless your own work needs it.] "A-Other" (a-x) delegated a task to "B-Pi" (b-pi): ECHO pi1.`)).toBeNull();
  });

  it('D6. reads the other notices of Tars and does not do what they quote', () => {
    const waits = 'Message from Tars: \n[Tars] Your messages not yet in their terminal, as of 07:12 (Tars tells you at most every 30 minutes):\n- to "Codex Agent": "SEND x-claude REPLYCLAUDECODEX", held 4 minutes';
    expect(directiveOf(waits)).toBeNull();
  });

  it("D7. does the owner's words Tars relays", () => {
    const relayed = 'Message from Tars: the owner\'s words of 07:10, via Telegram, an answer, relayed by agent "Lead" ("o1"), verified by Tars (words ow-1a2b3c4d):\nECHO approved';
    expect(directiveOf(relayed)).toMatchObject({ verb: 'ECHO', arg: 'approved' });
  });

  it('D8. does a task whose own text has a "[Tars] " line further down', () => {
    expect(directiveOf('ECHO kept\n[Tars] is only quoted here')).toMatchObject({ verb: 'ECHO', arg: 'kept' });
  });

  it('D9. asks nothing of a text with no directive', () => {
    expect(directiveOf('Message from agent "Codex Agent" ("x-codex"): \nREPLYCLAUDECODEX')).toBeNull();
  });
});
