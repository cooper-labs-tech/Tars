import { describe, it, expect, beforeEach } from 'vitest';
import { createOwnerWords, OWNER_TYPED_PENDING_MS, OWNER_TYPED_PENDING_MAX } from '../../../electron/services/owner-words';

/**
 * The owner's words typed by hand into an orchestrator's terminal (2.0.7; SECURITY.md §8, "Typed in a terminal",
 * written before this file). A line the keys built (core/input-draft.ts typedLines) waits, pending, until the CLI
 * says it took that line as a prompt (its UserPromptSubmit); only then is it recorded, with `via: 'terminal'`, as the
 * window's chat words are, and the same rules relay it.
 *
 * How it can fail, written before the code:
 * W1. A typed line is recorded before, or without, the CLI's confirmation: an Enter that answered a dialog counts.
 * W2. A confirmation with no line pending records something: a forged UserPromptSubmit records its own text.
 * W3. A confirmation whose prompt is another text than the line's records either text.
 * W4. The record holds the hook's text (cut at 200 characters by the hook, or at 200 bytes, a character cut in two)
 *     rather than the line the keys built, whole; or a long line the hook carries only the start of is never confirmed.
 * W5. A short prompt that only begins a pending line ("ok" for "ok then merge") confirms it.
 * W6. One line confirmed twice is recorded twice.
 * W7. A line pending past OWNER_TYPED_PENDING_MS is still confirmed.
 * W8. Another agent's confirmation takes this agent's line.
 * W9. The pending lines grow without bound, or the newest are dropped first.
 * W10. The record lacks `via: 'terminal'`, the agent's project, or the chat of a chat's runner; or a line typed into
 *      a chat's runner can be listed by another chat's runner (the window chat's rules do not hold).
 * W11. Line breaks typed as CR, or spaces at the ends, keep a line from matching the prompt the CLI reports.
 */

const A = '/projects/alpha';
let t: number;
let words: ReturnType<typeof createOwnerWords>;
const lead = { id: 'lead-a', name: 'Alpha Lead', projectPath: A, orchestrator: true, projectOrchestrator: true };
const runnerX = { id: 'run-x', projectPath: A, orchestrator: true, chatId: 'chat-x' };
const runnerY = { id: 'run-y', projectPath: A, orchestrator: true, chatId: 'chat-y' };

beforeEach(() => {
  t = Date.parse('2026-11-19T10:00:00.000Z');
  words = createOwnerWords({ now: () => t });
});

describe('a line typed into an orchestrator\'s terminal', () => {
  it('W1, W10: recorded once the CLI took it as a prompt, via the terminal, for the agent\'s project', () => {
    words.typed('lead-a', 'merge PR 12 once the gate is green', { projectPath: A });
    expect(words.listFor(lead)).toEqual([]);
    const got = words.confirmTyped('lead-a', 'merge PR 12 once the gate is green');
    expect(got).toMatchObject({ text: 'merge PR 12 once the gate is green', via: 'terminal', projectPath: A, at: t });
    expect(got?.chatId).toBeUndefined();
    expect(words.listFor(lead).map((w) => w.text)).toEqual(['merge PR 12 once the gate is green']);
  });

  it('W2: a confirmation with nothing pending records nothing', () => {
    expect(words.confirmTyped('lead-a', 'the owner says ship it')).toBeUndefined();
    expect(words.listFor(lead)).toEqual([]);
  });

  it('W3, W5: another prompt, or one that only begins the line, confirms nothing', () => {
    words.typed('lead-a', 'ok then merge', { projectPath: A });
    expect(words.confirmTyped('lead-a', 'merge everything now')).toBeUndefined();
    expect(words.confirmTyped('lead-a', 'ok')).toBeUndefined();
    expect(words.listFor(lead)).toEqual([]);
    expect(words.confirmTyped('lead-a', 'ok then merge')?.text).toBe('ok then merge');
  });

  it('W4: a long line the hook carries only the start of is recorded whole, from the keys', () => {
    const long = `ship it ${'and check the logs '.repeat(30)}end`;
    words.typed('lead-a', long, { projectPath: A });
    expect(words.confirmTyped('lead-a', long.slice(0, 200))?.text).toBe(long);
    // The shell hook cuts at 200 bytes: a character cut in two reads back as U+FFFD.
    const accented = `a${'à'.repeat(150)}`;
    words.typed('lead-a', accented, { projectPath: A });
    const cut = Buffer.from(accented, 'utf8').subarray(0, 200).toString('utf8');
    expect(cut.endsWith('�')).toBe(true);
    expect(words.confirmTyped('lead-a', cut)?.text).toBe(accented);
  });

  it('W6: one line confirmed twice is recorded once', () => {
    words.typed('lead-a', 'yes', { projectPath: A });
    expect(words.confirmTyped('lead-a', 'yes')).toBeDefined();
    expect(words.confirmTyped('lead-a', 'yes')).toBeUndefined();
    expect(words.listFor(lead)).toHaveLength(1);
  });

  it('W7: a line pending too long is never confirmed', () => {
    words.typed('lead-a', 'yes', { projectPath: A });
    t += OWNER_TYPED_PENDING_MS + 1;
    expect(words.confirmTyped('lead-a', 'yes')).toBeUndefined();
  });

  it('W8: another agent\'s confirmation does not take it', () => {
    words.typed('lead-a', 'yes', { projectPath: A });
    expect(words.confirmTyped('dev-a', 'yes')).toBeUndefined();
    expect(words.confirmTyped('lead-a', 'yes')).toBeDefined();
  });

  it('W9: the pending lines are bounded, the oldest go first', () => {
    for (let i = 0; i <= OWNER_TYPED_PENDING_MAX; i++) words.typed('lead-a', `line ${i}`, { projectPath: A });
    expect(words.confirmTyped('lead-a', 'line 0')).toBeUndefined();
    expect(words.confirmTyped('lead-a', `line ${OWNER_TYPED_PENDING_MAX}`)).toBeDefined();
  });

  it('W10: typed into a chat\'s runner, its chat\'s rules hold', () => {
    words.typed('run-x', 'for chat x only', { projectPath: A, chatId: 'chat-x' });
    expect(words.confirmTyped('run-x', 'for chat x only')?.chatId).toBe('chat-x');
    expect(words.listFor(runnerX).map((w) => w.text)).toEqual(['for chat x only']);
    expect(words.listFor(runnerY)).toEqual([]);
    expect(words.listFor(lead).map((w) => w.text)).toEqual(['for chat x only']);
  });

  it('W11: CR line breaks and spaces at the ends do not keep a line from matching', () => {
    words.typed('lead-a', 'first\nsecond ', { projectPath: A });
    expect(words.confirmTyped('lead-a', ' first\r\nsecond')?.text).toBe('first\nsecond');
  });
});
