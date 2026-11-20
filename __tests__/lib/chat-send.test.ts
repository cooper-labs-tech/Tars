import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { clearsField, outcomeOf, stripOf, titleOf, workingLine } from '../../src/lib/chat-send';

/**
 * What a chat's page makes of a send (src/lib/chat-send.ts): chat:send's
 * answer (PR D), read for the page; the strip across the composer while a
 * message is on its way and after it; whether the words leave the field; and
 * "N of M working" above the list, from system:chatLimit. Frames: `Chat ·
 * chats · the composer, sending`, `· every slot working` and `· a new chat,
 * its first message`, in chat-redesign-a.pen. Written before the code. How it
 * can fail:
 * 1. an error answer is read as sent: the words leave the field and nothing
 *    says why;
 * 2. chat_limit is read as any refusal, and who works, with a Stop for each,
 *    is lost;
 * 3. a refusal's own reason is replaced by a sentence of the page's;
 * 4. an answer the page cannot read, or a call that threw, is read as sent;
 * 5. a held send is read as an error, or as nothing;
 * 6. the words are cleared after a refusal, or kept after a send that went in;
 * 7. while the orchestrator works nothing says the words wait for its turn, or
 *    a strip says so while it does not work;
 * 8. while sending, a launch says nothing (a new chat's runner takes seconds),
 *    or a send typed at once flashes a strip;
 * 9. N of M working shows before the limit is read, or its square runs at 0;
 * 10. a new chat's first message names it with more than one line, past the
 *     record's 80 characters, with its runs of spaces, or names it from
 *     nothing but spaces;
 * 11. a refusal whose reason is blank is shown with no reason, or a blank
 *     limit's sentence draws a block that says nothing (the Audit's G3 on PR
 *     392, written after the code, which already gives it the unread sentence:
 *     this case kills the mutant that drops that check).
 */

const limitAnswer = {
  error: 'chat_limit' as const,
  reason: '2 chats are already working, the most this Mac runs at once (10 GB of RAM, one chat per 5 GB). Wait for one to finish, or stop one.',
  limit: 2,
  ramGb: 10,
  working: [
    { chatId: 'c1', title: 'Main', since: '2026-10-13T09:00:00.000Z' },
    { chatId: 'c2', title: 'Release', since: '2026-10-13T09:05:00.000Z' },
  ],
};

describe('outcomeOf', () => {
  it('reads each way a send went in (5)', () => {
    for (const how of ['typed', 'held', 'launched'] as const) {
      expect(outcomeOf({ success: true, chatId: 'c1', runnerId: 'r1', how })).toEqual({ kind: 'sent', how });
    }
  });

  it('reads chat_limit with its reason and who works (2)', () => {
    expect(outcomeOf(limitAnswer)).toEqual({ kind: 'limit', reason: limitAnswer.reason, working: limitAnswer.working });
  });

  it('keeps a refusal\'s own reason (1, 3)', () => {
    const reason = 'Its terminal ended while the message waited: send it again.';
    expect(outcomeOf({ error: 'runner_failed', reason })).toEqual({ kind: 'refused', reason });
    expect(outcomeOf({ error: 'disk_full', reason: 'Under 2 GB free.' })).toEqual({ kind: 'refused', reason: 'Under 2 GB free.' });
  });

  it('never reads what it cannot read as sent, a throw included (4)', () => {
    for (const answer of [null, undefined, {}, { success: true }, { success: true, how: 'sideways' }, { error: 'runner_failed' }, 'sent', 42]) {
      const read = outcomeOf(answer);
      expect(read.kind, JSON.stringify(answer)).toBe('refused');
      expect((read as { reason: string }).reason.length).toBeGreaterThan(0);
    }
    expect(outcomeOf(new Error('the main process did not answer'))).toEqual({ kind: 'refused', reason: 'the main process did not answer' });
  });

  it('gives a refusal whose reason is blank a reason to read, a limit included (11)', () => {
    const blanks = [
      { error: 'runner_failed', reason: '' },
      { error: 'runner_failed', reason: '  \n ' },
      { error: 'chat_limit', reason: ' ', working: limitAnswer.working },
      new Error(''),
      new Error('   '),
    ];
    for (const answer of blanks) {
      const read = outcomeOf(answer);
      expect(read.kind, String(answer)).toBe('refused');
      expect((read as { reason: string }).reason.trim().length, JSON.stringify(answer)).toBeGreaterThan(0);
    }
  });
});

describe('clearsField', () => {
  it('clears the words only once they went in (6)', () => {
    expect(clearsField({ kind: 'sent', how: 'typed' })).toBe(true);
    expect(clearsField({ kind: 'sent', how: 'held' })).toBe(true);
    expect(clearsField({ kind: 'sent', how: 'launched' })).toBe(true);
    expect(clearsField({ kind: 'refused', reason: 'no' })).toBe(false);
    expect(clearsField(outcomeOf(limitAnswer))).toBe(false);
  });
});

describe('stripOf', () => {
  const at = (o: Partial<Parameters<typeof stripOf>[0]>) => stripOf({ outcome: null, sending: false, launching: false, working: false, ...o });

  it('says the words wait while the orchestrator works, and nothing when it does not (7)', () => {
    expect(at({ working: true })).toEqual({ tone: 'running', text: 'The orchestrator is working: your message goes in when its turn ends.' });
    expect(at({})).toBeNull();
  });

  it('says a launch is on its way, and nothing for a send typed at once (8)', () => {
    expect(at({ sending: true, launching: true })).toEqual({ tone: 'idle', hollow: true, text: 'Starting the orchestrator with your message.' });
    expect(at({ sending: true, launching: false })).toBeNull();
    expect(at({ sending: true, launching: false, working: true })).toBeNull();
  });

  it('says a held send is held, and a refusal with its reason, the words kept (3, 5)', () => {
    expect(at({ outcome: { kind: 'sent', how: 'held' } })).toEqual({
      tone: 'waiting',
      text: 'Held: something is typed in the orchestrator\'s terminal. Your message goes in once that field is clear.',
    });
    expect(at({ outcome: { kind: 'refused', reason: 'Its terminal ended while the message waited: send it again.' } })).toEqual({
      tone: 'error',
      emphasis: 'error',
      text: 'Not sent: Its terminal ended while the message waited: send it again. Your text is still here; press send to try again.',
    });
  });

  it('leaves the limit to its own block, and says nothing after a send that simply went in (2)', () => {
    expect(at({ outcome: outcomeOf(limitAnswer) })).toBeNull();
    expect(at({ outcome: { kind: 'sent', how: 'typed' } })).toBeNull();
    expect(at({ outcome: { kind: 'sent', how: 'launched' } })).toBeNull();
    // After a send that went in, the orchestrator at work says so again.
    expect(at({ outcome: { kind: 'sent', how: 'typed' }, working: true })?.tone).toBe('running');
  });
});

describe('workingLine', () => {
  it('shows nothing before the limit is read, and N of M after (9)', () => {
    expect(workingLine(null)).toBeNull();
    expect(workingLine({ limit: 2, working: 1 })).toEqual({ text: '1 of 2 working', tone: 'running' });
    expect(workingLine({ limit: 3, working: 3 })).toEqual({ text: '3 of 3 working', tone: 'running' });
  });

  it('keeps its square idle at 0 (9)', () => {
    expect(workingLine({ limit: 2, working: 0 })).toEqual({ text: '0 of 2 working', tone: 'idle' });
  });
});

describe('titleOf', () => {
  it('names a chat from the first line of its first message, 80 characters at most (10)', () => {
    expect(titleOf('Write the release notes for 1.9.7.')).toBe('Write the release notes for 1.9.7.');
    expect(titleOf('\n\n  Fix   the scroll   lock \nthen the tests')).toBe('Fix the scroll lock');
    const long = 'Look at every place the terminal grid loses its scroll position when an agent writes while you read';
    const cut = titleOf(long) as string;
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut.endsWith('\u2026')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1).endsWith(' ')).toBe(false);
    expect(titleOf('x'.repeat(120))).toBe(`${'x'.repeat(79)}\u2026`);
    expect(titleOf('   \n  ')).toBeNull();
  });
});
