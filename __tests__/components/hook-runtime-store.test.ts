import { describe, it, expect } from 'vitest';
import { mount, hooks } from './hook-runtime';

/**
 * useSyncExternalStore in the hook runtime, for a page that reads a store the window keeps outside React: Logs and the
 * Dashboard's panels read Tars's notices about an agent that way (src/hooks/useAgentNotices.ts, #626), and the
 * runtime threw for it, which turned Logs' three page tests red.
 *
 * How it can fail, written before the hook was served (QA, 21/11):
 * 1. The first render does not read the store: the component sees nothing, or another store's value.
 * 2. A change the store announces after the mount is not rendered: the component keeps the old snapshot.
 * 3. A change made between the render and the subscription is lost, which React itself guards against.
 * 4. An announcement whose snapshot did not change renders again, where React bails out on an identical snapshot.
 * 5. After unmount the component is still subscribed: a later announcement renders it again, or throws.
 * 6. A new subscribe function keeps the old subscription alive, or never subscribes the new one.
 * 7. A getSnapshot that returns a new value at every call loops quietly, where React refuses it: it must fail loudly.
 */

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return {
    listeners,
    subscribe,
    get: () => value,
    /** Changes the value without telling anyone: a change between a render and its subscription. */
    quietly: (next: T) => { value = next; },
    set: (next: T) => { value = next; for (const l of [...listeners]) l(); },
    announce: () => { for (const l of [...listeners]) l(); },
  };
}

describe('useSyncExternalStore in the hook runtime', () => {
  it('1. the first render reads the store', () => {
    const s = store('first');
    const m = mount(() => hooks.useSyncExternalStore(s.subscribe, s.get));
    expect(m.result).toBe('first');
  });

  it('2. a change the store announces after the mount is rendered', () => {
    const s = store(1);
    const m = mount(() => hooks.useSyncExternalStore(s.subscribe, s.get));
    s.set(2);
    expect(m.result).toBe(2);
    s.set(3);
    expect(m.result).toBe(3);
  });

  it('3. a change made between the render and the subscription is not lost', () => {
    const s = store('before');
    let rendered = 0;
    const m = mount(() => {
      const v = hooks.useSyncExternalStore(s.subscribe, s.get);
      // The first render changes the store before its subscription runs, as an IPC answer landing in between would.
      if (rendered++ === 0) s.quietly('between');
      return v;
    });
    expect(m.result).toBe('between');
  });

  it('4. an announcement with the same snapshot does not render again', () => {
    const s = store({ n: 1 });
    const m = mount(() => hooks.useSyncExternalStore(s.subscribe, s.get));
    const renders = m.renders;
    s.announce();
    s.announce();
    expect(m.renders).toBe(renders);
  });

  it('5. after unmount it is no longer subscribed, and a later change neither renders nor throws', () => {
    const s = store('a');
    const m = mount(() => hooks.useSyncExternalStore(s.subscribe, s.get));
    expect(s.listeners.size).toBe(1);
    m.unmount();
    expect(s.listeners.size).toBe(0);
    const renders = m.renders;
    expect(() => s.set('b')).not.toThrow();
    expect(m.renders).toBe(renders);
  });

  it('6. a new subscribe function moves the subscription: the old one ends, the new one is heard', () => {
    const first = store('one');
    const second = store('two');
    let which = first;
    const m = mount(() => hooks.useSyncExternalStore(which.subscribe, which.get));
    expect(first.listeners.size).toBe(1);
    which = second;
    m.rerender();
    expect(m.result).toBe('two');
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    second.set('two, changed');
    expect(m.result).toBe('two, changed');
  });

  it('7. a getSnapshot that returns a new value at every call fails loudly', () => {
    const s = store(0);
    expect(() => mount(() => hooks.useSyncExternalStore(s.subscribe, () => ({ fresh: s.get() })))).toThrow(/renders in a row|loop/);
  });
});
