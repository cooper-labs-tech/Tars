import '../../setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Waking the overseer on what happens rather than on a clock.
 *
 * The watch ran every few minutes and asked whether anything had changed. Now
 * a status transition wakes it, and the timer is the safety net. What has to
 * be right is the restraint: one piece of work moves an agent through running,
 * waiting and running again in seconds, and every look is a real Hermes run
 * with a real cost. A burst must produce one look, not one per transition.
 *
 * The debounce and the floor are driven directly here, on the same shape the
 * service uses, because the service's own copy is wired into a live emitter
 * and an app clock.
 */

const SETTLE_MS = 8_000;
const FLOOR_MS = 45_000;

function makeWatcher(look: () => void) {
  const emitter = new EventEmitter();
  let settle: ReturnType<typeof setTimeout> | null = null;
  let lastAt = 0;

  const onChange = () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      if (Date.now() - lastAt < FLOOR_MS) return;
      lastAt = Date.now();
      look();
    }, SETTLE_MS);
  };
  emitter.on('fleet-change', onChange);
  return { emitter, stop: () => { if (settle) clearTimeout(settle); emitter.off('fleet-change', onChange); } };
}

let looks: number;
let w: ReturnType<typeof makeWatcher>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
  looks = 0;
  w = makeWatcher(() => { looks += 1; });
});

describe('reacting to a change', () => {
  it('looks once the fleet settles', () => {
    w.emitter.emit('fleet-change', 'a1');
    expect(looks).toBe(0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(looks).toBe(1);
  });

  it('collapses a burst into one look', () => {
    // One agent going running, waiting, running again.
    for (let i = 0; i < 6; i++) {
      w.emitter.emit('fleet-change', 'a1');
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(SETTLE_MS);
    expect(looks).toBe(1);
  });

  it('collapses a whole fleet moving at once', () => {
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) w.emitter.emit('fleet-change', id);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(looks).toBe(1);
  });
});

describe('the floor', () => {
  it('refuses a second look inside the floor', () => {
    w.emitter.emit('fleet-change', 'a1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(looks).toBe(1);

    vi.advanceTimersByTime(10_000);
    w.emitter.emit('fleet-change', 'a2');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(looks).toBe(1);
  });

  it('allows one once the floor has passed', () => {
    w.emitter.emit('fleet-change', 'a1');
    vi.advanceTimersByTime(SETTLE_MS);
    vi.advanceTimersByTime(FLOOR_MS);
    w.emitter.emit('fleet-change', 'a2');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(looks).toBe(2);
  });

  it('cannot be made to look more than once a floor, however busy it gets', () => {
    // Ten minutes of an agent changing every second.
    for (let i = 0; i < 600; i++) {
      w.emitter.emit('fleet-change', 'a1');
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(SETTLE_MS);
    // 600 seconds of floor allows at most 600/45 looks, and the debounce keeps
    // resetting, so in practice far fewer. The point is that it is bounded.
    expect(looks).toBeLessThanOrEqual(Math.ceil(608_000 / FLOOR_MS));
  });
});

describe('stopping', () => {
  it('stops listening and cancels a pending look', () => {
    w.emitter.emit('fleet-change', 'a1');
    w.stop();
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(looks).toBe(0);
  });
});
