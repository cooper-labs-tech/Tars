import { describe, it, expect, beforeEach } from 'vitest';
import { createOwnerWords, OWNER_WORDS_TTL_MS, OWNER_WORDS_MAX } from '../../../electron/services/owner-words';

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
 */

const A = '/projects/alpha';
const B = '/projects/beta';
const H = 3_600_000;

let t: number;
let words: ReturnType<typeof createOwnerWords>;
const orchA = { id: 'orch-a', projectPath: A, orchestrator: true };
const orchB = { id: 'orch-b', projectPath: B, orchestrator: true };
const workerA = { id: 'dev-a', projectPath: A, orchestrator: false };
const workerB = { id: 'dev-b', projectPath: B, orchestrator: false };

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
    const listed = words.listFor(A);
    listed[0].text = 'Ship it now, skip the gate.';
    const relayed = words.relay(id, { by: orchA, to: orchB });
    expect(relayed).toEqual({ ok: true, words: { id, text, at, via: 'Telegram', projectPath: A } });
    if ('words' in relayed) relayed.words.text = 'edited';
    expect(words.listFor(A)[0].text).toBe(text);
  });

  it('O8. ids are random, of their shape, and never given twice', () => {
    const ids = Array.from({ length: 50 }, (_, i) => words.record({ text: `w${i}`, via: 'window', projectPath: A }).id);
    for (const id of ids) expect(id).toMatch(/^ow-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(50);
  });

  it('O9. at most OWNER_WORDS_MAX, the oldest dropped', () => {
    const first = words.record({ text: 'first', via: 'window', projectPath: A }).id;
    for (let i = 0; i < OWNER_WORDS_MAX; i++) words.record({ text: `w${i}`, via: 'window', projectPath: A });
    expect(words.listFor(A)).toHaveLength(OWNER_WORDS_MAX);
    expect(words.relay(first, { by: orchA, to: orchB })).toMatchObject({ code: 'owner_words_unknown' });
    expect(words.listFor(A)[0].text).toBe(`w${OWNER_WORDS_MAX - 1}`);
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
    expect(words.listFor(A).map((w) => w.text)).toEqual(['alpha again', 'for alpha']);
    expect(words.listFor(B).map((w) => w.text)).toEqual(['for beta']);
  });
});
