import { describe, it, expect } from 'vitest';
import { oneReadingAtATime } from '../../../electron/core/one-reading-at-a-time';

/**
 * usage:tasks reads at most once at a time (2026-10-13). The Usage page asks for the cost of each task again at each
 * new figure, before the last answer is in: measured on the machine's own data, 62 asks in 10 minutes, each a reading
 * of 12.9 s at the median, overlapping, and the main process's heap at 1 to 2.2 GB. Whatever the renderer does,
 * overlapping asks must never multiply the reading.
 *
 * How it fails, written before the code:
 * 1. Two asks for the same thing while one reading runs read twice: the second must get that same answer.
 * 2. Asks for different things (another window, a project) read at the same time: the next must start only after the
 *    one running has ended.
 * 3. An ask after the answer came gets the old answer, or none: it must start a new reading.
 * 4. A reading that fails blocks every ask after it, or its failure is handed to an ask that came after it ended.
 * 5. An ask waiting behind another reading, for the same thing as one already waiting, reads twice.
 */

/** A reading that ends when the test says, and records when each started. */
function bench() {
  const log: string[] = [];
  const ends = new Map<string, Array<(v: unknown) => void>>();
  const fails = new Map<string, Array<(e: unknown) => void>>();
  let n = 0;
  const read = (q: { w: string }) => {
    n += 1;
    const id = `${q.w}#${n}`;
    log.push(`start ${id}`);
    return new Promise<{ id: string }>((resolve, reject) => {
      ends.set(q.w, [...(ends.get(q.w) ?? []), () => { log.push(`end ${id}`); resolve({ id }); }]);
      fails.set(q.w, [...(fails.get(q.w) ?? []), (e) => { log.push(`fail ${id}`); reject(e); }]);
    });
  };
  // Ending or failing a reading takes both of its handles off.
  const end = (w: string) => { fails.get(w)?.shift(); ends.get(w)?.shift()?.(undefined); };
  const fail = (w: string) => { ends.get(w)?.shift(); fails.get(w)?.shift()?.(new Error(`${w} broke`)); };
  const tick = () => new Promise((r) => setImmediate(r));
  /** Until a reading of `w` has started: one after a failure starts a few turns of the loop later. */
  const started = async (w: string, count = 1) => {
    for (let i = 0; i < 50 && b.log.filter((l) => l.startsWith(`start ${w}#`)).length < count; i += 1) await tick();
  };
  const b = { log, read, end, fail, tick, started };
  return b;
}

describe('one reading at a time', () => {
  it('1. two asks for the same thing while it reads: one reading, one answer', async () => {
    const b = bench();
    const ask = oneReadingAtATime(b.read, (q) => q.w);
    const first = ask({ w: 'day' });
    await b.tick();
    const second = ask({ w: 'day' });
    await b.tick();
    b.end('day');
    const [x, y] = await Promise.all([first, second]);
    expect(x).toBe(y);
    expect(b.log).toEqual(['start day#1', 'end day#1']);
  });

  it('2. asks for different things: the next starts after the one running ends', async () => {
    const b = bench();
    const ask = oneReadingAtATime(b.read, (q) => q.w);
    const day = ask({ w: 'day' });
    const week = ask({ w: 'week' });
    await b.tick();
    expect(b.log).toEqual(['start day#1']);
    b.end('day');
    await day;
    await b.tick();
    expect(b.log).toEqual(['start day#1', 'end day#1', 'start week#2']);
    b.end('week');
    expect(await week).toEqual({ id: 'week#2' });
  });

  it('3. an ask after the answer came starts a new reading', async () => {
    const b = bench();
    const ask = oneReadingAtATime(b.read, (q) => q.w);
    const first = ask({ w: 'day' });
    await b.tick();
    b.end('day');
    await first;
    const again = ask({ w: 'day' });
    await b.tick();
    b.end('day');
    expect(await again).toEqual({ id: 'day#2' });
  });

  it('4. a reading that fails: its asks are told, the next ask reads', async () => {
    const b = bench();
    const ask = oneReadingAtATime(b.read, (q) => q.w);
    const broken = ask({ w: 'day' });
    const waiting = ask({ w: 'week' });
    await b.tick();
    b.fail('day');
    await expect(broken).rejects.toThrow('day broke');
    await b.started('week');
    b.end('week');
    expect(await waiting).toEqual({ id: 'week#2' });
    const later = ask({ w: 'day' });
    await b.started('day', 2);
    b.end('day');
    expect(await later).toEqual({ id: 'day#3' });
  });

  it('5. two asks waiting behind another reading, for the same thing: one reading', async () => {
    const b = bench();
    const ask = oneReadingAtATime(b.read, (q) => q.w);
    const day = ask({ w: 'day' });
    const weekA = ask({ w: 'week' });
    const weekB = ask({ w: 'week' });
    await b.tick();
    b.end('day');
    await day;
    await b.tick();
    b.end('week');
    const [x, y] = await Promise.all([weekA, weekB]);
    expect(x).toBe(y);
    expect(b.log.filter((l) => l.startsWith('start week'))).toEqual(['start week#2']);
  });
});
