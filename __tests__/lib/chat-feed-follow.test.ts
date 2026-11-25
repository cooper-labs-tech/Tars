import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { followChatFeed, RETRY_MS, CHAT_PAGE_LINES } from '../../src/lib/chat-feed-follow';
import type { ChatFeed } from '../../src/lib/chat-feed';
import type { ChatEvent, ChatHistory, ChatItem } from '../../src/types/electron';

/**
 * How a chat's page reads its conversation and follows it
 * (src/lib/chat-feed-follow.ts): chat:events heard from before chat:history
 * is asked, the snapshot read again after a gap or a failure, and the pages
 * before the first line read on demand. The reducer under it has its own
 * cases (chat-feed.test.ts). Written before the code, from the Audit's gate
 * of #378 (L2, L3). How it can fail:
 * 1. the window listens only after asking for the snapshot, so an event sent
 *    between the two is lost;
 * 2. an event heard while the snapshot is read is lost, or applied before it;
 * 3. a gap in the seq is not read again, or is read twice at once;
 * 4. a snapshot that fails, by an error or a throw, is never read again: the
 *    page stays on its error until it is opened again (L2);
 * 5. a chat that is gone (not_found) is read again and again;
 * 6. a read that succeeds after a failure leaves the error shown;
 * 7. once stopped, it still listens, still reads on a timer, or an answer
 *    still lands on the page;
 * 8. an earlier page asked from a first line that a re-read has since moved
 *    is merged, leaving a hole (L3);
 * 9. the waits between reads after failures do not grow, or grow forever.
 *
 * Written before the fix, from the mutation bench of L2 and L3:
 * 10. after a re-read that failed, each event reads again at once, past
 *     the wait, and a read may start beside the one the wait starts.
 *
 * Added after the code, for a mutant of the same bench that survived (F13):
 * 11. a read that answers leaves the waits where the failures before it took
 *     them, so the next failure waits longer than the first.
 */

type Call = { params: { chatId: string; before?: number; limit?: number }; listening: number; resolve: (v: unknown) => void; reject: (e: unknown) => void };

function source() {
  const listeners = new Set<(e: ChatEvent) => void>();
  const calls: Call[] = [];
  return {
    calls,
    listeners,
    emit: (e: ChatEvent) => listeners.forEach(l => l(e)),
    api: {
      history: (params: Call['params']) => new Promise<never>((resolve, reject) => {
        calls.push({ params, listening: listeners.size, resolve: resolve as (v: unknown) => void, reject });
      }),
      onEvent: (cb: (e: ChatEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    },
  };
}

function timers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    waits: () => [...pending.values()].map(t => t.ms),
    run: () => { const due = [...pending.values()]; pending.clear(); due.forEach(t => t.fn()); },
    api: {
      set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
      clear: (id: unknown) => { pending.delete(id as number); },
    },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const item = (n: number, text = `line ${n}`, id = `u${n}`): ChatItem => ({ id, n, sessionId: 's1', at: null, kind: 'text', text });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => item(from + i));
const history = (seq: number, items: ChatItem[], total = items.length ? items[items.length - 1].n + 1 : 0): ChatHistory => ({ seq, total, items });
const said = (seq: number, it: ChatItem, chatId = 'c1') => ({ seq, chatId, type: 'item', item: it }) as ChatEvent;

function follow() {
  const src = source();
  const clock = timers();
  const seen: { feed: ChatFeed | null; problem: string | null } = { feed: null, problem: null };
  const follower = followChatFeed('c1', src.api, {
    feed: f => { seen.feed = f; },
    problem: p => { seen.problem = p; },
  }, clock.api);
  const lines = () => (seen.feed?.items ?? []).map(i => i.n);
  return { src, clock, seen, follower, lines };
}

describe('followChatFeed', () => {
  it('listens before it asks for the snapshot (1), and applies what it heard meanwhile after it (2)', async () => {
    const { src, lines } = follow();
    expect(src.calls).toHaveLength(1);
    expect(src.calls[0].listening).toBe(1);
    expect(src.calls[0].params).toEqual({ chatId: 'c1', limit: CHAT_PAGE_LINES });
    src.emit(said(9, item(1, 'already in the snapshot')));
    src.emit(said(11, item(2)));
    src.calls[0].resolve(history(10, range(0, 1)));
    await settle();
    expect(lines()).toEqual([0, 1, 2]);
  });

  it('reads the snapshot again after a gap, once at a time (3)', async () => {
    const { src, lines } = follow();
    src.calls[0].resolve(history(10, range(0, 1)));
    await settle();
    src.emit(said(12, item(3)));
    expect(src.calls).toHaveLength(2);
    src.emit(said(13, item(4)));
    expect(src.calls).toHaveLength(2);
    src.calls[1].resolve(history(12, range(0, 3)));
    await settle();
    expect(lines()).toEqual([0, 1, 2, 3, 4]);
  });

  it('reads a snapshot that threw again by itself, and clears the error when it answers (4, 6)', async () => {
    const { src, clock, seen, lines } = follow();
    src.calls[0].reject(new Error('the main process did not answer'));
    await settle();
    expect(seen.problem).toBe('the main process did not answer');
    expect(clock.waits()).toEqual([RETRY_MS[0]]);
    clock.run();
    expect(src.calls).toHaveLength(2);
    src.calls[1].resolve(history(10, range(0, 2)));
    await settle();
    expect(lines()).toEqual([0, 1, 2]);
    expect(seen.problem).toBeNull();
  });

  it('reads again after an error answer too (4), but not for a chat that is gone (5)', async () => {
    const failing = follow();
    failing.src.calls[0].resolve({ error: 'chats_unavailable', reason: 'The chats could not be read.', seq: 3 });
    await settle();
    expect(failing.seen.problem).toBe('The chats could not be read.');
    expect(failing.clock.waits()).toEqual([RETRY_MS[0]]);

    const gone = follow();
    gone.src.calls[0].resolve({ error: 'not_found', reason: 'No chat has this id.', seq: 3 });
    await settle();
    expect(gone.seen.problem).toBe('No chat has this id.');
    expect(gone.clock.waits()).toEqual([]);
  });

  it('waits longer after each failure, up to its last wait (9)', async () => {
    const { src, clock } = follow();
    const waits: number[] = [];
    for (let i = 0; i < RETRY_MS.length + 2; i++) {
      src.calls[i].reject(new Error('no'));
      await settle();
      waits.push(...clock.waits());
      clock.run();
    }
    expect(waits).toEqual([...RETRY_MS, RETRY_MS[RETRY_MS.length - 1], RETRY_MS[RETRY_MS.length - 1]]);
    expect([...RETRY_MS].sort((a, b) => a - b)).toEqual(RETRY_MS);
  });

  it('stops listening, reading and landing answers once stopped (7)', async () => {
    const first = follow();
    first.src.calls[0].reject(new Error('no'));
    await settle();
    expect(first.clock.waits()).toHaveLength(1);
    first.follower.stop();
    expect(first.src.listeners.size).toBe(0);
    expect(first.clock.waits()).toEqual([]);

    const second = follow();
    second.follower.stop();
    second.src.calls[0].resolve(history(10, range(0, 2)));
    await settle();
    expect(second.seen.feed).toBeNull();
  });

  it('drops an earlier page asked before a re-read moved the first line (8)', async () => {
    const { src, follower, lines } = follow();
    src.calls[0].resolve(history(10, range(5, 9)));
    await settle();
    const earlier = follower.readEarlier();
    expect(src.calls[1].params).toEqual({ chatId: 'c1', before: 5, limit: CHAT_PAGE_LINES });
    src.emit(said(12, item(11)));
    expect(src.calls).toHaveLength(3);
    src.calls[2].resolve(history(30, range(12, 20)));
    await settle();
    src.calls[1].resolve(history(30, range(0, 4)));
    await earlier;
    expect(lines()).toEqual(range(12, 20).map(i => i.n));
  });

  it('waits after a re-read that failed, whatever events come meanwhile (10)', async () => {
    const { src, clock, lines } = follow();
    src.calls[0].resolve(history(10, range(0, 1)));
    await settle();
    src.emit(said(12, item(3)));
    expect(src.calls).toHaveLength(2);
    src.calls[1].reject(new Error('no'));
    await settle();
    src.emit(said(13, item(4)));
    src.emit(said(14, item(5)));
    expect(src.calls).toHaveLength(2);
    expect(clock.waits()).toEqual([RETRY_MS[0]]);
    clock.run();
    expect(src.calls).toHaveLength(3);
    src.calls[2].resolve(history(14, range(0, 5)));
    await settle();
    expect(lines()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('starts its waits over once a read answers (11)', async () => {
    const { src, clock } = follow();
    src.calls[0].reject(new Error('no'));
    await settle();
    clock.run();
    src.calls[1].resolve(history(10, range(0, 1)));
    await settle();
    src.emit(said(12, item(3)));
    src.calls[2].reject(new Error('no'));
    await settle();
    expect(clock.waits()).toEqual([RETRY_MS[0]]);
  });
});
