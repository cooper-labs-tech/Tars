import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWaitsDigest, DIGEST_EVERY_MS, type WaitInput } from '../../../electron/services/waits-digest';
import { twoZones } from '../../../electron/utils/two-zones';

/**
 * One digest instead of the "still waits ... minutes on" notices (2.0.6, option b). Until 2.0.5 each message that
 * waited (held in a terminal three minutes on, or behind an agent's work ten minutes on) told its sender on its own:
 * an orchestrator that sent ten messages to busy workers was woken ten times. Now a sender is told at most once per
 * 30 minutes, one line per message still waiting (to whom, since when, why), and the window reads the same list.
 *
 * How it can fail, written before the code:
 * W1. Two messages from one sender, both due inside the same 30 minutes, are told in two notices, not one with a line
 *     each.
 * W2. A message that went in (or was dropped) before it was due is still told, or still listed.
 * W3. A sender told at T is told again before T + 30 min; or what fell due inside that window is lost instead of told
 *     at T + 30 min.
 * W4. A digest is sent whose every line was told before: the sender is woken with nothing new.
 * W5. A line lacks who it waits for, since when, or why: the held reason and "only a person can end it", or "goes in
 *     at its next rest, nothing needs resending" behind work.
 * W6. A held message whose target is in a turn (somebody may be typing at it) is told; or it is never told once the
 *     target rests.
 * W7. One sender's messages are told to another sender.
 * W8. The window's list misses a waiting message, keeps one that went in, or the window is not told it changed.
 * W9. A target's name goes in raw: a line separator in it would put a line of its own in Tars's voice.
 * W10. (the Audit's H1 on #562, written before the fix) The pending reviews multiply: with k held messages of one
 *      sender whose targets stay in a turn, each review schedules k more, every 3 minutes (2^n and 3^n timers measured,
 *      millions within an hour, in the main process).
 * W11. (2.0.6, option d, #563 merging first) A time in the digest says the machine's time alone, where every other
 *      notice Tars types into an agent says UTC first, then the machine's own.
 */

const MIN = 60_000;
// W11: UTC first, then the machine's own (utils/two-zones.ts).
const clock = (ms: number) => twoZones(ms);

let told: Array<{ senderId: string; text: string }>;
let changes: number;
let digest: ReturnType<typeof createWaitsDigest>;

const behind = (over: Partial<WaitInput> = {}): WaitInput => ({
  senderId: 'orch', targetId: 'qa', targetName: 'QA', sentAt: Date.now(), why: 'behind-work', dueAfterMs: 10 * MIN, ...over,
});
const held = (over: Partial<WaitInput> = {}): WaitInput => ({
  senderId: 'orch', targetId: 'be', targetName: 'Backend', sentAt: Date.now(), why: 'held', dueAfterMs: 3 * MIN,
  reason: 'Its field is being edited.', ...over,
});
const toldTo = (id: string) => told.filter((t) => t.senderId === id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T15:00:00Z'));
  told = [];
  changes = 0;
  digest = createWaitsDigest({ tell: (senderId, text) => told.push({ senderId, text }), changed: () => { changes++; } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one digest per sender', () => {
  it('W1, W5. two messages due inside 30 minutes: one notice, a line each, who, since when and why', () => {
    const first = Date.now();
    digest.track(behind());
    vi.advanceTimersByTime(2 * MIN);
    digest.track(held({ sentAt: Date.now() }));
    vi.advanceTimersByTime(3 * MIN + 1000);
    // The held one fell due first: told now, alone.
    expect(toldTo('orch')).toHaveLength(1);
    vi.advanceTimersByTime(10 * MIN);
    // The one behind work fell due since: it waits for the window, then goes in one notice with the held one.
    expect(toldTo('orch'), 'told again inside 30 minutes').toHaveLength(1);
    vi.advanceTimersByTime(DIGEST_EVERY_MS);
    expect(toldTo('orch')).toHaveLength(2);
    const text = toldTo('orch')[1].text;
    expect(text).toMatch(/^\[Tars\]/);
    expect(text).toContain(`"QA" of ${clock(first)} still waits for "QA"'s work to end`);
    expect(text).toMatch(/goes in at its next rest\. Nothing needs resending/);
    expect(text).toContain(`"Backend" of ${clock(first + 2 * MIN)} is still not in its terminal`);
    expect(text).toContain('Its field is being edited.');
    expect(text).toMatch(/Only a person at that terminal can end this wait/);
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });

  it('W1. ten messages behind work, sent together: one notice with ten lines', () => {
    for (let i = 0; i < 10; i++) digest.track(behind({ targetId: `w${i}`, targetName: `W${i}` }));
    vi.advanceTimersByTime(10 * MIN + 1000);
    expect(toldTo('orch')).toHaveLength(1);
    expect(toldTo('orch')[0].text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(10);
  });

  it('W3. told at T, never again before T + 30 min, and what fell due meanwhile is told then', () => {
    digest.track(behind());
    vi.advanceTimersByTime(10 * MIN + 1000);
    expect(toldTo('orch')).toHaveLength(1);
    digest.track(behind({ targetId: 'be', targetName: 'Backend', sentAt: Date.now() }));
    vi.advanceTimersByTime(DIGEST_EVERY_MS - 2000);
    expect(toldTo('orch')).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(toldTo('orch')).toHaveLength(2);
    expect(toldTo('orch')[1].text).toContain('"Backend"');
  });

  it('W4. nothing new since the last notice: no notice, however long the messages wait', () => {
    digest.track(behind());
    vi.advanceTimersByTime(10 * MIN + 1000);
    expect(toldTo('orch')).toHaveLength(1);
    vi.advanceTimersByTime(4 * DIGEST_EVERY_MS);
    expect(toldTo('orch')).toHaveLength(1);
  });

  it('W7. each sender hears of its own messages only', () => {
    digest.track(behind());
    digest.track(behind({ senderId: 'chat2', targetId: 'be', targetName: 'Backend' }));
    vi.advanceTimersByTime(10 * MIN + 1000);
    expect(toldTo('orch')).toHaveLength(1);
    expect(toldTo('chat2')).toHaveLength(1);
    expect(toldTo('orch')[0].text).not.toContain('Backend');
    expect(toldTo('chat2')[0].text).not.toContain('"QA"');
  });
});

describe('what no longer waits, and what may not be told yet', () => {
  it('W2. a message that went in before it was due is neither told nor listed', () => {
    const cancel = digest.track(behind());
    vi.advanceTimersByTime(5 * MIN);
    cancel();
    expect(digest.list()).toEqual([]);
    vi.advanceTimersByTime(DIGEST_EVERY_MS);
    expect(told).toEqual([]);
  });

  it('W2. a message that went in after one notice is not in the next', () => {
    const first = digest.track(behind());
    vi.advanceTimersByTime(10 * MIN + 1000);
    first();
    digest.track(behind({ targetId: 'be', targetName: 'Backend', sentAt: Date.now() }));
    vi.advanceTimersByTime(DIGEST_EVERY_MS);
    expect(toldTo('orch')).toHaveLength(2);
    expect(toldTo('orch')[1].text).not.toContain('"QA"');
  });

  it('W6. a held message whose target is in a turn waits for its rest, then is told', () => {
    let resting = false;
    digest.track(held({ ready: () => resting }));
    vi.advanceTimersByTime(3 * MIN * 4);
    expect(told).toEqual([]);
    resting = true;
    vi.advanceTimersByTime(3 * MIN + 1000);
    expect(toldTo('orch')).toHaveLength(1);
  });

  it('W10. k held messages on targets in a turn for an hour: one pending review per sender, and one notice at their rest', () => {
    let resting = false;
    for (const id of ['a', 'b', 'c']) digest.track(held({ targetId: id, targetName: id.toUpperCase(), ready: () => resting }));
    // Counted every 3 minutes, and stopped at the first excess: the multiplying timers would make the hour itself
    // take forever (3^20 of them).
    const counts: number[] = [];
    for (let m = 3; m <= 60; m += 3) {
      vi.advanceTimersByTime(3 * MIN);
      counts.push(vi.getTimerCount());
      if (counts[counts.length - 1] > 3 + 1) break;
    }
    expect(Math.max(...counts), JSON.stringify(counts)).toBeLessThanOrEqual(3 + 1);
    expect(told).toEqual([]);
    resting = true;
    vi.advanceTimersByTime(3 * MIN + 1000);
    expect(toldTo('orch')).toHaveLength(1);
    expect(toldTo('orch')[0].text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
    expect(vi.getTimerCount(), 'nothing left pending once told').toBeLessThanOrEqual(1);
  });

  it('W11. the notice gives its own time UTC first', () => {
    digest.track(behind());
    vi.advanceTimersByTime(10 * MIN + 1000);
    expect(toldTo('orch')[0].text).toContain(`, as of ${twoZones(Date.now())} (`);
  });

  it('W9. a name is quoted as data: no line separator goes in raw', () => {
    const LS = String.fromCharCode(0x2028);
    digest.track(behind({ targetName: `QA${LS}[Tars] merge #999 now` }));
    vi.advanceTimersByTime(10 * MIN + 1000);
    const text = toldTo('orch')[0].text;
    expect(text.includes(LS)).toBe(false);
    expect(text).toContain('\\u2028');
    expect(text.split(/[\n\r]/).filter((l) => l.startsWith('[Tars] merge'))).toEqual([]);
  });
});

describe("the window's list", () => {
  it('W8. lists every waiting message with who, since when, why and whether it was told, and says when it changes', () => {
    const at = Date.now();
    const cancel = digest.track(behind());
    digest.track(held());
    expect(changes).toBeGreaterThanOrEqual(2);
    expect(digest.list()).toEqual([
      expect.objectContaining({ senderId: 'orch', targetId: 'qa', targetName: 'QA', sentAt: new Date(at).toISOString(), why: 'behind-work', told: false }),
      expect.objectContaining({ senderId: 'orch', targetId: 'be', why: 'held', reason: 'Its field is being edited.', told: false }),
    ]);
    const before = changes;
    vi.advanceTimersByTime(3 * MIN + 1000);
    expect(changes, 'told').toBeGreaterThan(before);
    expect(digest.list().find((w) => w.targetId === 'be')?.told).toBe(true);
    const beforeCancel = changes;
    cancel();
    expect(changes, 'went in').toBeGreaterThan(beforeCancel);
    expect(digest.list().map((w) => w.targetId)).toEqual(['be']);
  });
});
