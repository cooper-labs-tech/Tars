import { describe, it, expect, beforeEach } from 'vitest';
import { createOwnerWords, relayedBody, OWNER_WORDS_TTL_MS, OWNER_WORDS_MAX } from '../../../electron/services/owner-words';
import { twoZones } from '../../../electron/utils/two-zones';

/**
 * The owner's words Tars holds, and who may relay them (2.0.6, option e; SECURITY.md §8, written before this file).
 *
 * The threat model, as this store answers it:
 * - Forgery by id: an agent relays an id it made up or guessed.
 * - An edited quote: an agent changes the words it relays.
 * - Replay: the same words relayed again to the same receiver, or old words passed as fresh.
 * - Laundering: words the owner addressed to one project relayed by another project's orchestrator, or by a worker.
 * (Forgery by words, the mark typed by an agent itself, is the sender line's: owner-words-mark.test.ts.)
 *
 * How it can fail, written before the code:
 * O1. An id Tars never gave is relayed (forgery by id).
 * O2. A worker of the project relays the words (laundering).
 * O3. An orchestrator of another project relays them (laundering).
 * O4. Words older than OWNER_WORDS_TTL_MS are relayed as if fresh (replay).
 * O5. The same words reach the same receiver twice (replay); or a second receiver is refused.
 * O6. The words are relayed to an agent that is no orchestrator.
 * O7. What is relayed is not the record, byte for byte: a caller's copy can change it (an edited quote).
 * O8. An id is guessable: not random, not of its shape, or given twice.
 * O9. The store grows without end; or drops the newest instead of the oldest.
 * O10. A project's orchestrator lists words addressed to another project.
 * O11. A relay Tars could not deliver (the receiver's terminal refused it) still counts as made, and the words can
 *      never reach that receiver.
 * And from the Audit's gate of #569 (written before the fix):
 * O12. (M2) Every chat's runner has the orchestrator's powers, so the runner of chat Y lists and relays what the
 *      owner typed into chat X, past the chats' wall (chatsReadEachOther off).
 * O13. (M2) Words for no chat (a reply to a report, "@project") reach a chat's runner the same way.
 * O14. (M1) A receiver has no way to confirm an id it was relayed: owner_words names only its own project's words.
 * O15. (L1) An answer is verified without the question it answers: a "yes" relayed beside a claim of the sender's.
 */

const A = '/projects/alpha';
const B = '/projects/beta';
const H = 3_600_000;

let t: number;
let words: ReturnType<typeof createOwnerWords>;
/** The parties as the route reads them: the project's orchestrator, a chat's runner, a worker. */
const orchA = { id: 'orch-a', name: 'Alpha Lead', projectPath: A, orchestrator: true, projectOrchestrator: true };
const orchB = { id: 'orch-b', name: 'Beta Lead', projectPath: B, orchestrator: true, projectOrchestrator: true };
const workerA = { id: 'dev-a', projectPath: A, orchestrator: false };
const workerB = { id: 'dev-b', projectPath: B, orchestrator: false };
const runnerX = { id: 'run-x', projectPath: A, orchestrator: true, chatId: 'chat-x' };
const runnerY = { id: 'run-y', projectPath: A, orchestrator: true, chatId: 'chat-y' };

beforeEach(() => {
  t = Date.parse('2026-10-29T15:00:00Z');
  words = createOwnerWords({ now: () => t });
});

describe('who may relay the words', () => {
  it('O1. an id Tars never gave is unknown', () => {
    words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    expect(words.relay('ow-000000000000', { by: orchA, to: orchB })).toMatchObject({ status: 404, code: 'owner_words_unknown' });
  });

  it('O2, O3. a worker of the project, or an orchestrator of another, may not', () => {
    const { id } = words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    expect(words.relay(id, { by: workerA, to: orchB })).toMatchObject({ status: 403, code: 'owner_words_not_yours' });
    expect(words.relay(id, { by: orchB, to: orchA })).toMatchObject({ status: 403, code: 'owner_words_not_yours' });
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ ok: true });
  });

  it('O6. only to an orchestrator', () => {
    const { id } = words.record({ text: 'merge it', via: 'window', projectPath: A });
    expect(words.relay(id, { by: orchA, to: workerB })).toMatchObject({ status: 400, code: 'owner_words_to_orchestrators' });
  });
});

describe('replay', () => {
  it('O4. words older than the window are refused', () => {
    const { id } = words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    t += OWNER_WORDS_TTL_MS + 1;
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ status: 410, code: 'owner_words_stale' });
  });

  it('O5. once per receiver, and another receiver still may', () => {
    const { id } = words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ ok: true });
    t += H;
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ status: 409, code: 'owner_words_already_relayed' });
    expect(words.relay(id, { by: orchA, to: { id: 'orch-c', projectPath: '/projects/gamma', orchestrator: true } })).toMatchObject({ ok: true });
  });
});

describe('the words themselves', () => {
  it('O7. what is relayed is the record, and no copy a caller holds changes it', () => {
    const text = 'Ship 2.0.6 tonight.\nNot before the gate.';
    const { id, at } = words.record({ text, via: 'Telegram', projectPath: A });
    const listed = words.listFor(orchA);
    listed[0].text = 'Ship it now, skip the gate.';
    const relayed = words.relay(id, { by: orchA, to: orchB });
    expect(relayed).toEqual({ ok: true, words: { id, text, at, via: 'Telegram', projectPath: A } });
    if ('words' in relayed) relayed.words.text = 'edited';
    expect(words.listFor(orchA)[0].text).toBe(text);
  });

  it('O8. ids are random, of their shape, and never given twice', () => {
    const ids = Array.from({ length: 50 }, (_, i) => words.record({ text: `w${i}`, via: 'window', projectPath: A }).id);
    for (const id of ids) expect(id).toMatch(/^ow-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(50);
  });

  it('O9. at most OWNER_WORDS_MAX, the oldest dropped', () => {
    const first = words.record({ text: 'first', via: 'window', projectPath: A }).id;
    for (let i = 0; i < OWNER_WORDS_MAX; i++) words.record({ text: `w${i}`, via: 'window', projectPath: A });
    expect(words.listFor(orchA)).toHaveLength(OWNER_WORDS_MAX);
    expect(words.relay(first, { by: orchA, to: orchB })).toMatchObject({ code: 'owner_words_unknown' });
    expect(words.listFor(orchA)[0].text).toBe(`w${OWNER_WORDS_MAX - 1}`);
  });

  it('O11. a relay that was not delivered can be made again, once', () => {
    const { id } = words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ ok: true });
    words.undelivered(id, orchB.id);
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ ok: true });
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ code: 'owner_words_already_relayed' });
  });

  it("O10. a project's list holds its own words only, newest first", () => {
    words.record({ text: 'for alpha', via: 'Telegram', projectPath: A });
    t += 1000;
    words.record({ text: 'for beta', via: 'Telegram', projectPath: B });
    t += 1000;
    words.record({ text: 'alpha again', via: 'window', projectPath: A });
    expect(words.listFor(orchA).map((w) => w.text)).toEqual(['alpha again', 'for alpha']);
    expect(words.listFor(orchB).map((w) => w.text)).toEqual(['for beta']);
  });
});

describe("the chats' wall (the Audit's M2 on #569)", () => {
  it("O12. a chat's words reach its own runner and the project's orchestrator, never another chat's runner", () => {
    const { id } = words.record({ text: 'in chat x', via: 'window', projectPath: A, chatId: 'chat-x' });
    expect(words.listFor(runnerX).map((w) => w.id)).toEqual([id]);
    expect(words.listFor(orchA).map((w) => w.id)).toEqual([id]);
    expect(words.listFor(runnerY)).toEqual([]);
    expect(words.relay(id, { by: runnerY, to: orchB })).toMatchObject({ status: 403, code: 'owner_words_not_yours' });
    expect(words.relay(id, { by: runnerX, to: orchB })).toMatchObject({ ok: true });
  });

  it('O12. with chats reading each other, another chat\'s runner reaches them too', () => {
    const { id } = words.record({ text: 'in chat x', via: 'window', projectPath: A, chatId: 'chat-x' });
    const open = { ...runnerY, readsAllChats: true };
    expect(words.listFor(open).map((w) => w.id)).toEqual([id]);
    expect(words.relay(id, { by: open, to: orchB })).toMatchObject({ ok: true });
  });

  it("O13. words for no chat are the project's orchestrator's", () => {
    const { id } = words.record({ text: 'to the project', via: 'Telegram', projectPath: A });
    expect(words.listFor(runnerX)).toEqual([]);
    expect(words.relay(id, { by: runnerX, to: orchB })).toMatchObject({ status: 403, code: 'owner_words_not_yours' });
    expect(words.relay(id, { by: orchA, to: orchB })).toMatchObject({ ok: true });
  });
});

describe('what a receiver can check (the Audit\'s M1 on #569)', () => {
  it('O14. the words relayed to an agent are listed for it: their id, text, time, and who relayed them, when', () => {
    const { id, at } = words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    expect(words.relayedTo(orchB.id)).toEqual([]);
    t += 60_000;
    words.relay(id, { by: orchA, to: orchB });
    expect(words.relayedTo(orchB.id)).toEqual([
      expect.objectContaining({ id, text: 'merge it', at, via: 'Telegram', by: { id: 'orch-a', name: 'Alpha Lead' }, relayedAt: t }),
    ]);
    expect(words.relayedTo('orch-c')).toEqual([]);
    expect(words.relayedTo(orchA.id)).toEqual([]);
  });

  it('O14. a relay given back (undelivered) is no longer listed for that receiver', () => {
    const { id } = words.record({ text: 'merge it', via: 'Telegram', projectPath: A });
    words.relay(id, { by: orchA, to: orchB });
    words.undelivered(id, orchB.id);
    expect(words.relayedTo(orchB.id)).toEqual([]);
  });
});

describe('what the words answered (the Audit\'s L1 on #569)', () => {
  it('O15. an answer is kept with its question, and both go with the relay', () => {
    const asked = t - 3_600_000;
    const { id } = words.record({
      text: 'yes', via: 'Telegram', projectPath: A, about: 'an answer to a question',
      question: { text: 'May I deploy 2.0.6 tonight?', by: 'Alpha Lead', at: asked },
    });
    const relayed = words.relay(id, { by: orchA, to: orchB });
    expect(relayed).toMatchObject({ ok: true, words: { text: 'yes', about: 'an answer to a question', question: { text: 'May I deploy 2.0.6 tonight?', by: 'Alpha Lead', at: asked } } });
    if ('words' in relayed) {
      expect(relayedBody(relayed.words)).toBe(`In answer to the question "May I deploy 2.0.6 tonight?" that "Alpha Lead" asked at ${twoZones(asked)}:\nyes`);
    }
  });

  it('O15. words that answer nothing go as they are', () => {
    const { id } = words.record({ text: 'Ship it.', via: 'window', projectPath: A, chatId: 'chat-x' });
    const relayed = words.relay(id, { by: orchA, to: orchB });
    if ('words' in relayed) expect(relayedBody(relayed.words)).toBe('Ship it.');
  });
});
