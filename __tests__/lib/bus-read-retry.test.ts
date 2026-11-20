import '../setup/home-guard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUS_READ_MS, BUS_RETRY_MS, retryingRead } from '../../src/lib/bus-read';

/**
 * The Chat's room list, read from the bus by useBusRooms through retryingRead.
 *
 * The list was read once, given 10 s, and on a slow start that read ran out:
 * the page put "The bus did not answer, so this list is not the whole truth.
 * bus:listRooms, no answer in 10 s" where the rows would be, and read the list
 * again only on the next bus:message or a click on retry. The answer that came
 * at 12 s was thrown away. A person saw an empty Chat, and a slow CI
 * runner met it too. Written before the code, as the ways the read can fail:
 *
 * 1. An answer that comes after the 10 s is thrown away, and the list stays
 *    empty behind the note, though the bus did answer.
 * 2. A read that failed (the call refused, or an answer that says it failed) is
 *    not read again without a click or a message.
 * 3. It asks for ever: a bus that keeps failing is asked without end, rather
 *    than three more times, the last about 30 s after the first failure.
 * 4. It stacks reads: a try, a message's refresh or a click while a read is out
 *    sends a second one beside it, and a stale answer can land last.
 * 5. A refresh asked for while a read is out is lost, so a room that appeared
 *    with its first message stays missing.
 * 6. A read that does not answer in 10 s says nothing, and the list looks like
 *    a fleet that has not spoken yet (the note must stay).
 * 7. An answer does not end the tries: once the rooms are listed, a try still
 *    pending goes out anyway. And a read asked for (a message, a click) does not
 *    replace the try that was pending, so two go out.
 * 8. It carries on once the page is gone: a try or a late answer after unmount.
 */

type Answer = { rooms: string[]; error?: string };

/** A bus whose answers the test hands out, one call at a time. */
function bus() {
  const calls: Array<{ resolve: (a: Answer) => void; reject: (e: unknown) => void }> = [];
  const call = vi.fn(() => new Promise<Answer>((resolve, reject) => { calls.push({ resolve, reject }); }));
  return { calls, call };
}

/** What the page would show, from what the reader tells it. */
function page(call: () => Promise<Answer>) {
  const shown = { rooms: [] as string[], error: null as string | null, answers: 0, failures: 0 };
  const reader = retryingRead<Answer>({
    channel: 'bus:listRooms',
    call,
    failure: a => a.error,
    onAnswer: a => { shown.rooms = a.rooms; shown.error = a.error ?? null; shown.answers += 1; },
    onFailure: err => { shown.error = err instanceof Error ? err.message : String(err); shown.failures += 1; },
  });
  return { shown, reader };
}

const NO_ANSWER = 'bus:listRooms, no answer in 10 s';
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the room list, read from a slow bus', () => {
  it('says the bus did not answer at 10 s, and lists the rooms when the answer comes at 12 s (1, 6)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    await tick(BUS_READ_MS);
    expect(shown.error).toBe(NO_ANSWER);
    expect(shown.rooms).toEqual([]);

    await tick(2_000);
    b.calls[0].resolve({ rooms: ['orion', 'tars'] });
    await tick(0);
    expect(shown.rooms).toEqual(['orion', 'tars']);
    expect(shown.error).toBeNull();
    // Nobody clicked, no message came, and nothing more was asked.
    await tick(60_000);
    expect(b.call).toHaveBeenCalledTimes(1);
    reader.stop();
  });

  it('asks nothing more while a read is out, however long it takes (4)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    await tick(BUS_READ_MS + 120_000);
    expect(b.call).toHaveBeenCalledTimes(1);
    // A read that never answers ends in the note, with nothing left to fire.
    expect(shown.error).toBe(NO_ANSWER);
    expect(vi.getTimerCount()).toBe(0);
    reader.stop();
  });
});

describe('the room list, read from a bus that fails', () => {
  it('reads again by itself after a refusal, and lists the rooms (2)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    b.calls[0].reject(new Error("No handler registered for 'bus:listRooms'"));
    await tick(0);
    expect(shown.error).toMatch(/No handler registered/);

    await tick(BUS_RETRY_MS[0]);
    expect(b.call).toHaveBeenCalledTimes(2);
    b.calls[1].resolve({ rooms: ['orion'] });
    await tick(0);
    expect(shown.rooms).toEqual(['orion']);
    expect(shown.error).toBeNull();
    reader.stop();
  });

  it('reads again after an answer that says it failed (2)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    b.calls[0].resolve({ rooms: [], error: 'EBUSY: the journal is being written' });
    await tick(0);
    expect(shown.error).toBe('EBUSY: the journal is being written');

    await tick(BUS_RETRY_MS[0]);
    b.calls[1].resolve({ rooms: ['tars'] });
    await tick(0);
    expect(shown.rooms).toEqual(['tars']);
    expect(shown.error).toBeNull();
    reader.stop();
  });

  it('tries three more times, the last about 30 s after the first failure, then leaves the note (3)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    const failAll = async () => { for (const c of b.calls.splice(0)) c.reject(new Error('the bus is not ready')); await tick(0); };
    reader.read();
    await failAll();
    const at: number[] = [];
    for (let t = 0; t < 120_000; t += 500) {
      const before = b.call.mock.calls.length;
      await tick(500);
      if (b.call.mock.calls.length > before) at.push(t + 500);
      await failAll();
    }
    expect(b.call).toHaveBeenCalledTimes(1 + BUS_RETRY_MS.length);
    expect(BUS_RETRY_MS).toHaveLength(3);
    // Each wait longer than the last, the last try between 20 and 40 s in.
    expect(at[0]).toBeLessThan(at[1] - at[0]);
    expect(at[1] - at[0]).toBeLessThan(at[2] - at[1]);
    expect(at[2]).toBeGreaterThanOrEqual(20_000);
    expect(at[2]).toBeLessThanOrEqual(40_000);
    expect(shown.error).toBe('the bus is not ready');
    expect(vi.getTimerCount()).toBe(0);
    reader.stop();
  });

  it('asks nothing more once the rooms are listed, not even the try that was pending (7)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    await tick(BUS_READ_MS);
    expect(shown.error).toBe(NO_ANSWER);
    // The late answer lands while nothing else is out.
    b.calls[0].resolve({ rooms: ['orion'] });
    await tick(0);
    await tick(120_000);
    expect(b.call).toHaveBeenCalledTimes(1);
    expect(shown.rooms).toEqual(['orion']);
    reader.stop();
  });
});

describe('reads asked for, by a message or a click', () => {
  it('replaces the pending try with the read asked for, rather than sending both (7)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    b.calls[0].reject(new Error('the bus is not ready'));
    await tick(0);
    await tick(BUS_RETRY_MS[0] / 2);
    reader.read(); // a message landed: its refresh reads now
    expect(b.call).toHaveBeenCalledTimes(2);
    b.calls[1].resolve({ rooms: ['orion'] });
    await tick(0);
    await tick(120_000);
    expect(b.call).toHaveBeenCalledTimes(2);
    expect(shown.rooms).toEqual(['orion']);
    reader.stop();
  });

  it('sends no second read while one is out, and one more once it is back (4, 5)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    reader.read();
    reader.read();
    expect(b.call).toHaveBeenCalledTimes(1);
    b.calls[0].resolve({ rooms: ['orion'] });
    await tick(0);
    // The room a message brought is in the read that follows.
    expect(b.call).toHaveBeenCalledTimes(2);
    b.calls[1].resolve({ rooms: ['orion', 'tars'] });
    await tick(0);
    expect(shown.rooms).toEqual(['orion', 'tars']);
    await tick(120_000);
    expect(b.call).toHaveBeenCalledTimes(2);
    reader.stop();
  });

  it('a click on retry reads again at once when nothing is out', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    const failAll = async () => { for (const c of b.calls.splice(0)) c.reject(new Error('the bus is not ready')); await tick(0); };
    await failAll();
    for (const wait of BUS_RETRY_MS) { await tick(wait); await failAll(); }
    expect(b.call).toHaveBeenCalledTimes(4);
    reader.read();
    expect(b.call).toHaveBeenCalledTimes(5);
    b.calls[0].resolve({ rooms: ['orion'] });
    await tick(0);
    expect(shown.rooms).toEqual(['orion']);
    expect(shown.error).toBeNull();
    reader.stop();
  });
});

describe('once the page is gone', () => {
  it('sends no try after unmount (8)', async () => {
    const b = bus();
    const { reader } = page(b.call);
    reader.read();
    b.calls[0].reject(new Error('the bus is not ready'));
    await tick(0);
    reader.stop();
    await tick(120_000);
    expect(b.call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies no answer that lands after unmount, and says nothing at 10 s (8)', async () => {
    const b = bus();
    const { shown, reader } = page(b.call);
    reader.read();
    reader.stop();
    await tick(BUS_READ_MS);
    b.calls[0].resolve({ rooms: ['orion'] });
    await tick(0);
    expect(shown).toEqual({ rooms: [], error: null, answers: 0, failures: 0 });
  });
});
