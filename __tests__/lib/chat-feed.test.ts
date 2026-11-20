import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { emptyFeed, applySnapshot, applyEvent, applyEarlier } from '../../src/lib/chat-feed';
import type { ChatEvent, ChatHistory, ChatItem, ChatView } from '../../src/types/electron';

/**
 * A chat's conversation as the page holds it (src/lib/chat-feed.ts): the
 * snapshot chat:history answers, then the chat:events after its seq (#371).
 * Frames: `Chat · chats · from its transcripts, working`. Written before the
 * code. How it can fail:
 * 1. an event already in the snapshot (its seq at or under the snapshot's) is
 *    applied again, and a line shows twice;
 * 2. another chat's event changes this chat's lines, record or runner;
 * 3. another chat's events, which take seq numbers from the same counter, are
 *    read as a gap, and the page reads its conversation again for nothing;
 * 4. a seq skipped (an event missed) is not noticed, and the page shows a
 *    conversation with a hole as if it were whole;
 * 5. a line told again with the same id (a transcript read again, the
 *    Backend's fix for live items) shows twice instead of being replaced;
 * 6. a line arriving with a place (n) before the last one ends up after it;
 * 7. events that arrive while the snapshot is being read are lost, or one
 *    older than the snapshot is applied on top of it;
 * 8. an earlier page shows a line twice, or moves the seq;
 * 9. a deleted chat, a renamed one or a runner's new state is not kept;
 * 10. reading the snapshot again after a gap keeps the old lines or the gap.
 *
 * Added after the code, at the Audit's gate of #378 (L1), each one killing a
 * mutant that survived the cases above:
 * 11. an event heard before any snapshot changes the feed (a gap read in
 *     it), where it has nothing to apply to (C2);
 * 12. an earlier page holding an older telling of a line told again live
 *     puts the older words back (C8);
 * 13. a first line at n = 1 is read as having nothing before it (C9).
 *
 * Written before the change, from the same gate (L3):
 * 14. a snapshot read again after a gap drops the earlier pages read
 *     before it, though its lines reach them, and the thread jumps;
 * 15. lines kept from before a re-read leave a hole when the re-read
 *     starts past them;
 * 16. an earlier page asked from a first line that a re-read has since
 *     moved is merged, leaving a hole between it and the new lines.
 *
 * Written before the fix, from the mutation bench of L2 and L3:
 * 17. while stale, each event makes a new feed: the page re-renders and
 *     its follower reads again per event, past its waits after a failure.
 *
 * Added after the code, for a mutant of the same bench that survived (R1):
 * 18. a re-read that begins right after the lines held, with none in common,
 *     drops the pages read before it.
 *
 * Written before the fix, from the Audit's gate of #371's third delta (a
 * Medium on #378): #371 tells a line again, the same id, when a line that
 * landed late in an earlier session moved it one place on.
 * 19. a line told again at another place keeps the place it held, and the
 *     thread reads hello, in b, late in a, where the transcripts say hello,
 *     late in a, in b;
 * 20. a line told at the place of one held goes after it, though that one
 *     has moved on and is told again next: the thread reads out of order
 *     until it is.
 *
 * Written before the fix, from the Audit's gate of #371's fourth delta (a
 * Medium on #378): #371 names in one `removed` event the lines of a session
 * whose transcript disappeared, before the lines that moved back are told
 * again.
 * 21. those lines stay, between the line that says the transcript is gone
 *     and the ones that moved back: the thread reads hello, gone line, in b
 *     1, later, in b 2, where the transcripts say hello, gone line, later;
 * 22. a removal drops lines it does not name, lines of another chat, or
 *     moves nothing when it names lines the page never read.
 *
 * Written before the fix, from the Audit's gate of #378's third delta (L1):
 * 23. a re-read after a gap keeps the earlier pages by their old places though
 *     a removal moved every line after it: a removed line stays, no line says
 *     its transcript is gone, and Show earlier goes, so nothing repairs it
 *     until the page is opened again (the Audit's probe P3).
 *
 * Added after the code, for a mutant of the Audit's that survived (its Info):
 * 24. a removal that names the first line held keeps it.
 */

const VIEW = (id: string, title = 'Main'): ChatView => ({
  id, projectPath: '/p/tars', number: 1, title, titleSource: 'user', runnerId: 'lead', sessionIds: [],
  pinned: false, snoozedUntil: null, settledAt: null, inbox: true,
  createdAt: '2026-10-13T08:00:00.000Z', updatedAt: '2026-10-13T08:00:00.000Z', lastActivityAt: '2026-10-13T08:00:00.000Z', runner: null,
});
const item = (n: number, text = `line ${n}`, id = `u${n}`): ChatItem => ({ id, n, sessionId: 's1', at: null, kind: 'text', text });
const history = (seq: number, items: ChatItem[], total = items.length): ChatHistory => ({ seq, total, items });
const ev = (seq: number, chatId: string, rest: Record<string, unknown>) => ({ seq, chatId, ...rest }) as ChatEvent;
const texts = (s: ReturnType<typeof emptyFeed>) => s.items.map(i => i.text);

describe('chat feed', () => {
  it('ignores an event already in the snapshot (1)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0), item(1)]));
    s = applyEvent(s, ev(10, 'c1', { type: 'item', item: item(1) }));
    s = applyEvent(s, ev(9, 'c1', { type: 'item', item: item(5, 'stale') }));
    expect(texts(s)).toEqual(['line 0', 'line 1']);
    expect(s.seq).toBe(10);
  });

  it('keeps another chat\'s events out of this one (2), and reads its seq as no gap (3)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0)]));
    s = applyEvent(s, ev(11, 'c2', { type: 'item', item: item(1, 'not mine') }));
    s = applyEvent(s, ev(12, 'c2', { type: 'meta', chat: VIEW('c2', 'Other') }));
    s = applyEvent(s, ev(13, 'c2', { type: 'state', runner: { id: 'x', status: 'running', live: true } }));
    s = applyEvent(s, ev(14, 'c1', { type: 'item', item: item(1, 'mine') }));
    expect(texts(s)).toEqual(['line 0', 'mine']);
    expect(s.chat).toBeNull();
    expect(s.runner).toBeUndefined();
    expect(s.stale).toBe(false);
    expect(s.seq).toBe(14);
  });

  it('notices a seq skipped, and applies nothing after it until the snapshot is read again (4)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0)]));
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(2, 'after a hole') }));
    expect(s.stale).toBe(true);
    expect(texts(s)).toEqual(['line 0']);
    s = applyEvent(s, ev(13, 'c1', { type: 'item', item: item(3) }));
    expect(texts(s)).toEqual(['line 0']);
  });

  it('replaces a line told again with the same id (5)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0), item(1, 'first telling', 'u1')]));
    s = applyEvent(s, ev(11, 'c1', { type: 'item', item: item(1, 'told again', 'u1') }));
    expect(texts(s)).toEqual(['line 0', 'told again']);
  });

  it('puts a line in its place by n (6)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0), item(2)]));
    s = applyEvent(s, ev(11, 'c1', { type: 'item', item: item(1) }));
    expect(s.items.map(i => i.n)).toEqual([0, 1, 2]);
  });

  it('applies what arrived while the snapshot was read, and only what is newer than it (7)', () => {
    const buffered = [ev(9, 'c1', { type: 'item', item: item(1, 'old') }), ev(11, 'c1', { type: 'item', item: item(2, 'new') })];
    const s = applySnapshot(emptyFeed('c1'), history(10, [item(0), item(1)]), buffered);
    expect(texts(s)).toEqual(['line 0', 'line 1', 'new']);
    expect(s.seq).toBe(11);
  });

  it('adds an earlier page before the first line, once, and keeps the seq (8)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(2), item(3)], 4));
    s = applyEarlier(s, history(10, [item(0), item(1), item(2)], 4), 2);
    expect(s.items.map(i => i.n)).toEqual([0, 1, 2, 3]);
    expect(s.seq).toBe(10);
    expect(s.hasEarlier).toBe(false);
  });

  it('keeps a deletion, a new record and the runner\'s state (9)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0)]));
    s = applyEvent(s, ev(11, 'c1', { type: 'meta', chat: VIEW('c1', 'Renamed') }));
    s = applyEvent(s, ev(12, 'c1', { type: 'state', runner: { id: 'lead', status: 'waiting', live: true } }));
    expect(s.chat?.title).toBe('Renamed');
    expect(s.runner).toEqual({ id: 'lead', status: 'waiting', live: true });
    s = applyEvent(s, ev(13, 'c1', { type: 'deleted' }));
    expect(s.deleted).toBe(true);
  });

  it('starts over from a snapshot read again after a gap (10)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0), item(1, 'kept before')]));
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(2) }));
    expect(s.stale).toBe(true);
    s = applySnapshot(s, history(14, [item(0), item(1, 'as it is now'), item(2)]));
    expect(s.stale).toBe(false);
    expect(texts(s)).toEqual(['line 0', 'as it is now', 'line 2']);
    expect(s.seq).toBe(14);
  });

  it('says whether there is more before the first line', () => {
    expect(applySnapshot(emptyFeed('c1'), history(10, [item(5), item(6)], 7)).hasEarlier).toBe(true);
    expect(applySnapshot(emptyFeed('c1'), history(10, [item(0), item(1)], 2)).hasEarlier).toBe(false);
  });

  it('applies nothing before the first snapshot, and leaves its seq to the snapshot (11)', () => {
    const empty = emptyFeed('c1');
    const before = applyEvent(empty, ev(3, 'c1', { type: 'item', item: item(0, 'too early') }));
    expect(before).toBe(empty);
    const s = applySnapshot(before, history(2, [item(0)]), [ev(3, 'c1', { type: 'item', item: item(1) })]);
    expect(texts(s)).toEqual(['line 0', 'line 1']);
  });

  it('keeps the newer telling of a line when an earlier page holds an older one (12)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(2, 'first telling', 'u2'), item(3)], 4));
    s = applyEvent(s, ev(11, 'c1', { type: 'item', item: item(2, 'told again', 'u2') }));
    s = applyEarlier(s, history(11, [item(0), item(1), item(2, 'first telling', 'u2')], 4), 2);
    expect(texts(s)).toEqual(['line 0', 'line 1', 'told again', 'line 3']);
  });

  it('says there is a line before a first line at n = 1 (13)', () => {
    expect(applySnapshot(emptyFeed('c1'), history(10, [item(1), item(2)], 3)).hasEarlier).toBe(true);
  });

  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => item(from + i));
  const places = (s: ReturnType<typeof emptyFeed>) => s.items.map(i => i.n);

  it('keeps the earlier pages read when a snapshot read again after a gap reaches them (14)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, range(5, 9), 10));
    s = applyEarlier(s, history(10, range(0, 4), 10), 5);
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(11) }));
    expect(s.stale).toBe(true);
    s = applySnapshot(s, history(14, range(7, 12), 13));
    expect(places(s)).toEqual(range(0, 12).map(i => i.n));
    expect(s.hasEarlier).toBe(false);
    expect(s.stale).toBe(false);
  });

  it('starts over when a snapshot read again begins past the lines held, leaving no hole (15)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, range(0, 9), 10));
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(11) }));
    s = applySnapshot(s, history(30, range(15, 20), 21));
    expect(places(s)).toEqual(range(15, 20).map(i => i.n));
    expect(s.hasEarlier).toBe(true);
  });

  it('drops an earlier page asked from a first line a re-read has since moved (16)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, range(5, 9), 10));
    // Show earlier asks from line 5; a gap's re-read starts past the lines held, at 12.
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(11) }));
    s = applySnapshot(s, history(30, range(12, 20), 21));
    s = applyEarlier(s, history(30, range(0, 4), 21), 5);
    expect(places(s)).toEqual(range(12, 20).map(i => i.n));
  });

  it('answers the feed itself to an event while stale (17)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0)]));
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(2) }));
    expect(s.stale).toBe(true);
    expect(applyEvent(s, ev(13, 'c1', { type: 'item', item: item(3) }))).toBe(s);
  });

  it('keeps the pages read when a re-read begins right after them (18)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, range(0, 6), 7));
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(8) }));
    s = applySnapshot(s, history(20, range(7, 12), 13));
    expect(places(s)).toEqual(range(0, 12).map(i => i.n));
  });

  // #371's own sequence (its test 12): session a gains a line after session
  // b's was told, and every line after it is told again one place on.
  it('moves a line told again at another place to that place (19)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0, 'hello', 'h'), item(1, 'in b', 'b')]));
    s = applyEvent(s, ev(11, 'c1', { type: 'item', item: item(1, 'late in a', 'late') }));
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(2, 'in b', 'b') }));
    expect(texts(s)).toEqual(['hello', 'late in a', 'in b']);
    expect(places(s)).toEqual([0, 1, 2]);
  });

  it('puts a line told at the place of one held before it, as that one has moved on (20)', () => {
    const inOrder = ['hello', 'late in a', 'the divider', 'in b'];
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0, 'hello', 'h'), item(1, 'the divider', 'd'), item(2, 'in b', 'b')]));
    s = applyEvent(s, ev(11, 'c1', { type: 'item', item: item(1, 'late in a', 'late') }));
    expect(texts(s), 'the late line alone told').toEqual(inOrder);
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(2, 'the divider', 'd') }));
    expect(texts(s), 'the divider told again').toEqual(inOrder);
    s = applyEvent(s, ev(13, 'c1', { type: 'item', item: item(3, 'in b', 'b') }));
    expect(texts(s)).toEqual(inOrder);
    expect(places(s)).toEqual([0, 1, 2, 3]);
  });

  // #371's case 13: session b's transcript disappears; its two lines are named
  // removed, then come the line saying it is gone and later, moved back.
  it('drops the lines a removal names, so the thread reads as the transcripts do (21)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0, 'hello', 'h'), item(1, 'in b 1', 'b1'), item(2, 'in b 2', 'b2'), item(3, 'later', 'l')]));
    s = applyEvent(s, ev(11, 'c1', { type: 'removed', itemIds: ['b1', 'b2'] }));
    expect(texts(s), 'the removal alone').toEqual(['hello', 'later']);
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: item(1, 'gone line', 'g') }));
    s = applyEvent(s, ev(13, 'c1', { type: 'item', item: item(2, 'later', 'l') }));
    expect(texts(s)).toEqual(['hello', 'gone line', 'later']);
    expect(places(s)).toEqual([0, 1, 2]);
    expect(s.seq).toBe(13);
  });

  it('drops only the lines a removal names, of its own chat, and moves its seq alone for lines never read (22)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(5, 'five', 'u5'), item(6, 'six', 'u6')], 7));
    s = applyEvent(s, ev(11, 'c2', { type: 'removed', itemIds: ['u5'] }));
    expect(texts(s), 'another chat\'s removal').toEqual(['five', 'six']);
    s = applyEvent(s, ev(12, 'c1', { type: 'removed', itemIds: ['u0', 'u1'] }));
    expect(texts(s), 'lines the page never read').toEqual(['five', 'six']);
    expect(s.seq).toBe(12);
    expect(s.stale).toBe(false);
    s = applyEvent(s, ev(13, 'c1', { type: 'removed', itemIds: ['u6'] }));
    expect(texts(s)).toEqual(['five']);
  });

  // The Audit's probe P3: an earlier page read, then b's transcript gone, its
  // removal missed in a gap, and the last four read again where they now are.
  it('starts over from a re-read whose lines moved, rather than keep earlier pages by their old places (23)', () => {
    const at = (n: number, id: string) => item(n, id, id);
    let s = applySnapshot(emptyFeed('c1'), history(10, [at(3, 'x3'), at(4, 'x4'), at(5, 'x5'), at(6, 'x6')], 7));
    s = applyEarlier(s, history(10, [at(0, 'h'), at(1, 'b1'), at(2, 'b2')], 7), 3);
    expect(places(s)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    s = applyEvent(s, ev(12, 'c1', { type: 'item', item: at(2, 'x3') }));
    expect(s.stale).toBe(true);
    s = applySnapshot(s, history(20, [at(2, 'x3'), at(3, 'x4'), at(4, 'x5'), at(5, 'x6')], 6));
    expect(texts(s)).toEqual(['x3', 'x4', 'x5', 'x6']);
    expect(places(s)).toEqual([2, 3, 4, 5]);
    expect(s.hasEarlier, 'Show earlier reads the rest again').toBe(true);
  });

  it('drops the first line held when a removal names it (24)', () => {
    let s = applySnapshot(emptyFeed('c1'), history(10, [item(0, 'b0', 'b0'), item(1, 'h', 'h')]));
    s = applyEvent(s, ev(11, 'c1', { type: 'removed', itemIds: ['b0'] }));
    expect(texts(s)).toEqual(['h']);
    expect(places(s)).toEqual([1]);
  });
});
