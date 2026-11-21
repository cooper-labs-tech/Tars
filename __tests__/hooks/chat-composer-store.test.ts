import '../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { composerOf, forgetSentOutcome, sendComposer, subscribeComposers, writeComposer } from '../../src/hooks/useChatComposer';

/**
 * A chat's composer, kept per chat for the whole window (src/hooks/useChatComposer.ts):
 * its words, the send on its way and what it came to. A chat's page is keyed by its
 * chat, so opening another chat unmounts the field, and a launch can take a minute
 * (git fetch, the worktree, its dependencies). The Audit's L1 on PR 392. Written
 * before the code. How it can fail:
 * 1. the words written in a chat's field are gone once its page is left;
 * 2. a send answered after its page was left is lost: a refusal says nothing when
 *    the chat is opened again, and its words are gone;
 * 3. a send still on its way is forgotten on the way back: the field is empty and
 *    open while the launch goes on, nothing says so, and the same words sent again
 *    reach the orchestrator twice;
 * 4. one chat's words, send or answer show in another chat;
 * 5. the words stay after a send that went in, or words written since the send
 *    left are cleared with them;
 * 6. a refusal, or a full limit, clears the words;
 * 7. a call that throws leaves the send on its way for ever, the field shut;
 * 8. a first message names its chat only while the page is open, names a chat its
 *    user named, or names one after a refusal; a name refused is lost;
 * 9. a held send's strip outlives the orchestrator's next turn, or that turn takes
 *    a refusal's reason away with it;
 * 10. blank words are sent;
 * 11. the page open on the chat is not told when the answer comes.
 */

type Pending = { chatId: string; text: string; answer: (value: unknown) => void; fail: (error: Error) => void };

/** The main process as the store meets it: chat:send answers when the test says, chat:rename keeps the title. */
class Main {
  sent: Pending[] = [];
  titles = new Map<string, string>();
  renameRefusal: string | null = null;
  api = {
    chat: {
      send: (request: { chatId: string; text: string }) => new Promise((answer, fail) => {
        this.sent.push({ chatId: request.chatId, text: request.text, answer, fail });
      }),
      rename: async ({ chatId, title }: { chatId: string; title: string }) => {
        if (this.renameRefusal) return { error: 'invalid_request', reason: this.renameRefusal };
        this.titles.set(chatId, title);
        return { success: true };
      },
      list: async () => ({ chats: [], problem: null }),
    },
    system: { chatLimit: async () => ({ limit: 2, working: 0 }) },
  };
}

const g = globalThis as unknown as { window?: { electronAPI: Main['api'] } };
let main: Main;
let chatN = 0;
/** A chat no other test has written in: the store is the window's, and lasts across tests. */
const freshChat = () => `chat-${(chatN += 1)}`;

beforeEach(() => {
  main = new Main();
  g.window = { electronAPI: main.api };
});
afterEach(() => {
  delete g.window;
});

describe('a chat\'s composer, kept per chat', () => {
  it('keeps the words written in a chat\'s field while no page of it is open (1)', () => {
    const chat = freshChat();
    expect(composerOf(chat)).toEqual({ text: '', sending: false, outcome: null, nameProblem: null });
    writeComposer(chat, 'Look at the release script.');
    expect(composerOf(chat).text).toBe('Look at the release script.');
  });

  it('keeps a refusal that answers after the page was left, with the words (2, 6)', async () => {
    const chat = freshChat();
    const page = subscribeComposers(() => {});
    writeComposer(chat, 'Patch the login timeout.');
    const going = sendComposer(chat, { nameIt: true });
    page();
    main.sent[0].answer({ error: 'runner_failed', reason: 'Its worktree could not be made: fatal: a branch named \'chat/1a2b3c4d\' already exists.' });
    await going;
    expect(composerOf(chat)).toEqual({
      text: 'Patch the login timeout.',
      sending: false,
      outcome: { kind: 'refused', reason: 'Its worktree could not be made: fatal: a branch named \'chat/1a2b3c4d\' already exists.' },
      nameProblem: null,
    });
    expect(main.titles.has(chat), 'a refused message names nothing').toBe(false);
  });

  it('keeps a full limit with who works, and the words (2, 6)', async () => {
    const chat = freshChat();
    writeComposer(chat, 'Write the docs.');
    const going = sendComposer(chat, { nameIt: true });
    const working = [{ chatId: 'c1', title: 'Main', since: '2026-10-13T09:00:00.000Z' }];
    main.sent[0].answer({ error: 'chat_limit', reason: '2 chats are already working.', working });
    await going;
    expect(composerOf(chat).outcome).toEqual({ kind: 'limit', reason: '2 chats are already working.', working });
    expect(composerOf(chat).text).toBe('Write the docs.');
  });

  it('finds a send still on its way on the way back, and never sends it twice (3)', async () => {
    const chat = freshChat();
    writeComposer(chat, 'Patch the login timeout.');
    const going = sendComposer(chat, { nameIt: false });
    expect(composerOf(chat)).toMatchObject({ text: 'Patch the login timeout.', sending: true, outcome: null });
    await sendComposer(chat, { nameIt: false });
    expect(main.sent.map(s => s.text)).toEqual(['Patch the login timeout.']);
    main.sent[0].answer({ success: true, chatId: chat, runnerId: 'r1', how: 'launched' });
    await going;
    expect(composerOf(chat)).toMatchObject({ text: '', sending: false, outcome: { kind: 'sent', how: 'launched' } });
  });

  it('keeps each chat to itself (4)', async () => {
    const a = freshChat();
    const b = freshChat();
    writeComposer(a, 'For A.');
    writeComposer(b, 'For B.');
    const going = sendComposer(a, { nameIt: false });
    expect(composerOf(b)).toEqual({ text: 'For B.', sending: false, outcome: null, nameProblem: null });
    main.sent[0].answer({ error: 'disk_full', reason: 'Under 2 GB free.' });
    await going;
    expect(main.sent.map(s => s.chatId)).toEqual([a]);
    expect(composerOf(b)).toEqual({ text: 'For B.', sending: false, outcome: null, nameProblem: null });
    expect(composerOf(a).outcome).toEqual({ kind: 'refused', reason: 'Under 2 GB free.' });
  });

  it('clears the words once they went in, but not words written since (5)', async () => {
    const chat = freshChat();
    writeComposer(chat, 'First.');
    const going = sendComposer(chat, { nameIt: false });
    main.sent[0].answer({ success: true, chatId: chat, runnerId: 'r1', how: 'typed' });
    await going;
    expect(composerOf(chat).text).toBe('');

    writeComposer(chat, 'Second.');
    const again = sendComposer(chat, { nameIt: false });
    writeComposer(chat, 'Third, written while the second was on its way.');
    main.sent[1].answer({ success: true, chatId: chat, runnerId: 'r1', how: 'typed' });
    await again;
    expect(composerOf(chat).text).toBe('Third, written while the second was on its way.');
  });

  it('reads a call that threw as a refusal, and opens the field again (7)', async () => {
    const chat = freshChat();
    writeComposer(chat, 'Patch it.');
    const going = sendComposer(chat, { nameIt: false });
    main.sent[0].fail(new Error('the main process did not answer'));
    await going;
    expect(composerOf(chat)).toMatchObject({ text: 'Patch it.', sending: false, outcome: { kind: 'refused', reason: 'the main process did not answer' } });
  });

  it('names a chat nobody named from its first message, page open or not, and keeps a name refused (8)', async () => {
    const named = freshChat();
    writeComposer(named, 'Fix the scroll lock\nthen the tests');
    const going = sendComposer(named, { nameIt: true });
    main.sent[0].answer({ success: true, chatId: named, runnerId: 'r1', how: 'launched' });
    await going;
    expect(main.titles.get(named)).toBe('Fix the scroll lock');

    const theirs = freshChat();
    writeComposer(theirs, 'Write the release notes.');
    const kept = sendComposer(theirs, { nameIt: false });
    main.sent[1].answer({ success: true, chatId: theirs, runnerId: 'r2', how: 'launched' });
    await kept;
    expect(main.titles.has(theirs), 'a chat its user named keeps its name').toBe(false);

    const refused = freshChat();
    main.renameRefusal = 'A title is one line of 80 characters at most.';
    writeComposer(refused, 'Write the docs.');
    const left = sendComposer(refused, { nameIt: true });
    main.sent[2].answer({ success: true, chatId: refused, runnerId: 'r3', how: 'launched' });
    await left;
    expect(composerOf(refused).nameProblem).toBe('This chat keeps its name: A title is one line of 80 characters at most.');
  });

  it('lets a held send\'s strip go when the orchestrator takes its turn, never a refusal (9)', async () => {
    const held = freshChat();
    writeComposer(held, 'Also the changelog.');
    const going = sendComposer(held, { nameIt: false });
    main.sent[0].answer({ success: true, chatId: held, runnerId: 'r1', how: 'held' });
    await going;
    expect(composerOf(held).outcome).toEqual({ kind: 'sent', how: 'held' });
    forgetSentOutcome(held);
    expect(composerOf(held).outcome).toBeNull();

    const refused = freshChat();
    writeComposer(refused, 'Patch it.');
    const no = sendComposer(refused, { nameIt: false });
    main.sent[1].answer({ error: 'runner_failed', reason: 'Its terminal ended.' });
    await no;
    forgetSentOutcome(refused);
    expect(composerOf(refused).outcome).toEqual({ kind: 'refused', reason: 'Its terminal ended.' });
  });

  it('sends no blank words (10)', async () => {
    const chat = freshChat();
    writeComposer(chat, '   \n ');
    await sendComposer(chat, { nameIt: true });
    expect(main.sent).toEqual([]);
    expect(composerOf(chat).sending).toBe(false);
  });

  it('tells the page open on the chat when the answer comes (11)', async () => {
    const chat = freshChat();
    const seen: string[] = [];
    const page = subscribeComposers(() => seen.push(composerOf(chat).outcome?.kind ?? (composerOf(chat).sending ? 'sending' : 'none')));
    writeComposer(chat, 'Patch it.');
    const going = sendComposer(chat, { nameIt: false });
    main.sent[0].answer({ error: 'runner_failed', reason: 'No.' });
    await going;
    page();
    expect(seen).toContain('sending');
    expect(seen[seen.length - 1]).toBe('refused');
  });
});
