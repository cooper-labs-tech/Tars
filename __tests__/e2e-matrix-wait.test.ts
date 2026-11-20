import { describe, it, expect } from 'vitest';
// @ts-expect-error: the helper is plain JavaScript, with no declarations
import { lineInA } from '../e2e/matrix-wait.mjs';

/**
 * lineInA (e2e/matrix-wait.mjs): in the CLI matrix (e2e/cli-matrix.spec.ts), where the delegating agent A stands with
 * the DELEGATE line the spec typed into its terminal, read from A's records since (the stand-ins' logs). The spec waits
 * 45 s for the delegation's answer, and stops sooner only when A's own turn on the line ended without the call.
 *
 * How it can fail, written before the helper (QA's I5 on #601 and #607, 20/11: in 9 runs, 20 cells read "A called
 * delegate_task: no answer within 45 s" while the answer came back 2.8 to 6.6 s after the line, every time):
 *  1. An answer of a turn of A's that began before the line (B's reply from the pair before, Tars's note that B
 *     finished, which the line waits behind, as a typed line waits in a real CLI) ends the wait: the cell is red
 *     after about 2 s, and says 45 s.
 *  2. A's own turn on the line, ended without the call (not logged in), does not end the wait: 45 s lost for nothing.
 *  3. A line a question took (the folder's trust, the API key) does not end the wait.
 *  4. Another line's turn (a DELEGATE to another agent, or one whose tag only begins with this one's) is taken for
 *     this line's.
 *  5. A turn on the line that made the call is said to have ended without it.
 *  6. The 45 s are counted from the typing while the line waits behind other turns: a delegation given less than its
 *     45 s. The turn's start must be read, from its own record, or be unknown while it has not begun.
 *  7. codex's records (a turn's head and text, no answer of its own) end the wait early.
 */

const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 3, 0, 0) + s * 1000).toISOString();
const LINE = 'DELEGATE x-gemini ECHO ANSWERCLAUDEGEMINI';
const CALL = { tool: 'delegate_task', to: 'x-gemini' };

/** A's records after the line went in, as QA's red run of 20/11 03:00 logged them (claude to gemini, after codex). */
const BUSY = [
  { t: at(55.735), agent: 'x-claude', typed: LINE, head: LINE },
  { t: at(55.955), agent: 'x-claude', answer: 'ok' },
  { t: at(56.396), agent: 'x-claude', hook: 'Stop', exit: 0 },
  { t: at(56.396), agent: 'x-claude', turn: true, text: 'Message from Tars: \n[Tars] "Codex Agent" ("x-codex") has finished its turn (task t-62dd5855, "SEND x-claude REPLYCLAUDECODEX"). Read what it produced with get_agent_output, then carry on.' },
  { t: at(56.687), agent: 'x-claude', hook: 'UserPromptSubmit', exit: 0 },
  { t: at(57.591), agent: 'x-claude', mcp: true, tool: 'send_message', to: 'x-claude', calling: true },
  { t: at(57.631), agent: 'x-claude', mcp: true, tool: 'send_message', to: 'x-claude', isError: false, text: 'HELD: Your message for "Claude Agent" is waiting for its terminal' },
  { t: at(57.632), agent: 'x-claude', answer: 'send_message sent: HELD: Your message for "Claude Agent" is waiting for its terminal' },
  { t: at(57.933), agent: 'x-claude', hook: 'Stop', exit: 0 },
  { t: at(57.933), agent: 'x-claude', turn: true, text: LINE },
  { t: at(58.203), agent: 'x-claude', hook: 'UserPromptSubmit', exit: 0 },
  { t: at(59.107), agent: 'x-claude', mcp: true, tool: 'delegate_task', to: 'x-gemini', calling: true },
  { t: at(61.151), agent: 'x-claude', mcp: true, tool: 'delegate_task', to: 'x-gemini', isError: false, text: 'echo ANSWERCLAUDEGEMINI\n\n---\nended: end_turn | task a0e5325b' },
  { t: at(61.151), agent: 'x-claude', answer: 'delegate_task answered: echo ANSWERCLAUDEGEMINI' },
];
const OWN_TURN = BUSY.findIndex((r) => r.turn && r.text === LINE);

describe('where A stands with its DELEGATE line', () => {
  it('1, 5: turns of A that began before the line never end the wait, nor does its own turn once it called', () => {
    for (let n = 0; n <= BUSY.length; n++) {
      expect(lineInA(BUSY.slice(0, n), LINE, CALL).endedWithoutCall, `after ${n} records`).toBeNull();
    }
  });

  it('6: the turn on the line starts at its own record, unknown before', () => {
    expect(lineInA(BUSY.slice(0, OWN_TURN), LINE, CALL).turnStartedAt).toBeNull();
    expect(lineInA(BUSY.slice(0, OWN_TURN + 1), LINE, CALL).turnStartedAt).toBe(Date.parse(at(57.933)));
    expect(lineInA(BUSY, LINE, CALL).turnStartedAt).toBe(Date.parse(at(57.933)));
  });

  it('2: A\'s own turn on the line, ended without the call, ends the wait with what it answered', () => {
    const records = [
      { t: at(1), agent: 'x-claude', typed: LINE, head: LINE },
      { t: at(1.1), agent: 'x-claude', turn: true, text: LINE },
      { t: at(2), agent: 'x-claude', answer: 'Not logged in · Please run /login', failed: 'not logged in' },
    ];
    expect(lineInA(records, LINE, CALL)).toEqual({ turnStartedAt: Date.parse(at(1.1)), endedWithoutCall: 'Not logged in · Please run /login' });
    expect(lineInA(records.slice(0, 2), LINE, CALL).endedWithoutCall).toBeNull();
  });

  it('3: a line a question took ends the wait', () => {
    const trust = [{ t: at(1), agent: 'x-claude', typed: LINE, head: LINE }, { t: at(1), agent: 'x-claude', answered: 'trust', with: LINE }];
    const key = [{ t: at(1), agent: 'x-qwen', typed: LINE, head: LINE }, { t: at(1), agent: 'x-qwen', answered: 'api-key', with: 'No', lost: LINE }];
    for (const records of [trust, key]) {
      const read = lineInA(records, LINE, CALL);
      expect(read.turnStartedAt).toBeNull();
      expect(read.endedWithoutCall).toMatch(/question/);
    }
  });

  it('4: another line\'s turn is not this line\'s', () => {
    for (const other of ['DELEGATE x-codex ECHO ANSWERCLAUDEGEMINI', `${LINE}2`, 'DELEGATE x-gemini ECHO ANSWERCLAUDE']) {
      const records = [
        { t: at(1), agent: 'x-claude', typed: LINE, head: LINE },
        { t: at(1), agent: 'x-claude', turn: true, text: other },
        { t: at(2), agent: 'x-claude', answer: 'Not logged in · Please run /login' },
      ];
      expect(lineInA(records, LINE, CALL), other).toEqual({ turnStartedAt: null, endedWithoutCall: null });
    }
  });

  it('5: a turn on the line that called, its answer not yet back, has not ended without the call', () => {
    const records = [
      { t: at(1), agent: 'x-claude', turn: true, text: LINE },
      { t: at(2), agent: 'x-claude', mcp: true, tool: 'delegate_task', to: 'x-gemini', calling: true },
      { t: at(3), agent: 'x-claude', answer: 'delegate_task refused: Not delegated: Unauthorized' },
    ];
    expect(lineInA(records, LINE, CALL).endedWithoutCall).toBeNull();
  });

  it('7: codex\'s records, a turn with no answer of its own, never end the wait', () => {
    const records = [
      { t: at(1), turn: true, text: LINE, head: LINE, session: 's' },
      { t: at(2), mcp: true, handed: ['CLAUDE_MGR_API_TOKEN'], token: true },
    ];
    expect(lineInA(records, LINE, CALL)).toEqual({ turnStartedAt: Date.parse(at(1)), endedWithoutCall: null });
  });
});
