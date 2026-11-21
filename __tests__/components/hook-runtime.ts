import type { ReactElement, ReactNode } from 'react';

/**
 * Hooks without a DOM.
 *
 * The suite runs in node with no DOM library, so a component can be rendered
 * to markup (react-dom/server) but never mounted: its effects never run and its
 * state never moves. What the loading and cliRunning tests assert is precisely
 * what happens after mount: an IPC answer arriving, a tick, a timer firing. So
 * the hooks a component calls are served here instead of by React, and the
 * component is called as a plain function. What it returns is the element tree
 * it hands React, one component deep: host elements and component elements
 * with their props, which is where a page's own branches live.
 *
 * A test file routes its component's hooks here with
 *
 *   vi.mock('react', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('react')>()),
 *     ...(await import('./hook-runtime')).hooks,
 *   }));
 *
 * Only the hooks those components call are served: useState, useRef, useMemo,
 * useCallback, useEffect, useLayoutEffect, useSyncExternalStore (Logs and the
 * Dashboard's panels read Tars's notices about an agent through it, #626;
 * hook-runtime-store.test.ts says how it may fail). The others throw, so a component
 * that starts depending on one fails loudly instead of reading a wrong value.
 * This module must not import from 'react' at run time: under that mock it
 * would import itself while the mock is still being built. Elements are
 * recognised by their `$$typeof` tag instead.
 */

const ELEMENT_TAGS = new Set([Symbol.for('react.transitional.element'), Symbol.for('react.element')]);
const isElement = (n: unknown): n is ReactElement<Record<string, unknown>> =>
  typeof n === 'object' && n !== null && ELEMENT_TAGS.has((n as { $$typeof?: symbol }).$$typeof as symbol);

type Deps = readonly unknown[] | undefined;
type Cleanup = void | (() => void);

type Slot =
  | { kind: 'state'; value: unknown; set: (next: unknown) => void }
  | { kind: 'ref'; ref: { current: unknown } }
  | { kind: 'memo'; deps: Deps; value: unknown }
  | { kind: 'effect'; deps: Deps; cleanup: Cleanup; ran: boolean }
  | { kind: 'store'; subscribe: unknown; getSnapshot: () => unknown; value: unknown; unsubscribe: Cleanup };

let active: Mounted<unknown> | null = null;
let cursor = 0;

const depsChanged = (prev: Deps, next: Deps) =>
  prev === undefined || next === undefined || prev.length !== next.length
  || next.some((d, i) => !Object.is(d, prev[i]));

class Mounted<R> {
  slots: Slot[] = [];
  pendingEffects: Array<() => void> = [];
  inRender = false;
  dirty = false;
  unmounted = false;
  renders = 0;
  output!: R;

  constructor(private readonly body: () => R) {}

  render(): void {
    if (this.unmounted) throw new Error('render after unmount');
    if (this.inRender) { this.dirty = true; return; }
    this.inRender = true;
    try {
      for (let pass = 0; ; pass++) {
        if (pass === 50) throw new Error('fifty renders in a row: an update loop');
        this.dirty = false;
        active = this as Mounted<unknown>;
        cursor = 0;
        try {
          this.output = this.body();
        } finally {
          active = null;
        }
        this.renders++;
        for (const run of this.pendingEffects.splice(0)) run();
        if (!this.dirty) return;
      }
    } finally {
      this.inRender = false;
    }
  }

  slot<K extends Slot['kind']>(kind: K, create: () => Extract<Slot, { kind: K }>): Extract<Slot, { kind: K }> {
    const index = cursor++;
    const existing = this.slots[index];
    if (!existing) {
      const created = create();
      this.slots[index] = created;
      return created;
    }
    if (existing.kind !== kind) {
      throw new Error(`hook ${index} was a ${existing.kind} and is now a ${kind}: hooks called conditionally`);
    }
    return existing as Extract<Slot, { kind: K }>;
  }

  unmount(): void {
    for (const s of this.slots) {
      if (s.kind === 'effect' && typeof s.cleanup === 'function') s.cleanup();
      if (s.kind === 'store' && typeof s.unsubscribe === 'function') s.unsubscribe();
    }
    this.unmounted = true;
  }
}

function current(name: string): Mounted<unknown> {
  if (!active) throw new Error(`${name} called outside mount(): this component was rendered by React, not by the hook runtime`);
  return active;
}

function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  const owner = current('useState');
  const s = owner.slot('state', () => {
    const slot: Extract<Slot, { kind: 'state' }> = {
      kind: 'state',
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
      set: (next) => {
        if (owner.unmounted) return;
        const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next;
        // React bails out on an identical value, and the components rely on
        // it: an updater that returns `prev` is how they skip a render.
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        owner.render();
      },
    };
    return slot;
  });
  return [s.value as T, s.set as (next: T | ((prev: T) => T)) => void];
}

function useRef<T>(initial: T): { current: T } {
  return current('useRef').slot('ref', () => ({ kind: 'ref', ref: { current: initial } })).ref as { current: T };
}

/** One memo slot. Not named like a hook, so lint reads the two below as what they serve, not as calls. */
function memoized<T>(name: string, factory: () => T, deps: Deps): T {
  const s = current(name).slot('memo', () => ({ kind: 'memo', deps: undefined, value: undefined }));
  if (s.deps === undefined || depsChanged(s.deps, deps)) {
    s.value = factory();
    s.deps = deps ?? [];
  }
  return s.value as T;
}

function useMemo<T>(factory: () => T, deps: Deps): T {
  return memoized('useMemo', factory, deps);
}

function useCallback<T>(fn: T, deps: Deps): T {
  return memoized('useCallback', () => fn, deps);
}

function useEffect(effect: () => Cleanup, deps?: Deps): void {
  const owner = current('useEffect');
  const s = owner.slot('effect', () => ({ kind: 'effect', deps: undefined, cleanup: undefined, ran: false }));
  if (s.ran && deps !== undefined && !depsChanged(s.deps, deps)) return;
  s.ran = true;
  s.deps = deps;
  owner.pendingEffects.push(() => {
    if (typeof s.cleanup === 'function') s.cleanup();
    s.cleanup = effect();
  });
}

/**
 * React's contract, as the components rely on it: every render reads the snapshot; the store is subscribed to after
 * the render, again whenever `subscribe` changes, and no longer after unmount; an announcement renders only when the
 * snapshot changed (Object.is); a change made between a render and its subscription is caught when it subscribes.
 * A getSnapshot returning a new value at every call throws, read twice as React reads it: React would loop on it.
 */
function useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T {
  const owner = current('useSyncExternalStore');
  const s = owner.slot('store', () => ({ kind: 'store', subscribe: undefined, getSnapshot, value: undefined, unsubscribe: undefined }));
  const value = getSnapshot();
  if (!Object.is(value, getSnapshot())) {
    throw new Error('useSyncExternalStore: getSnapshot returned a new value at its second call, and React would loop on it: cache the snapshot');
  }
  s.getSnapshot = getSnapshot;
  s.value = value;
  if (s.subscribe !== subscribe) {
    s.subscribe = subscribe;
    owner.pendingEffects.push(() => {
      if (typeof s.unsubscribe === 'function') s.unsubscribe();
      const onChange = () => {
        if (!owner.unmounted && !Object.is(s.getSnapshot(), s.value)) owner.render();
      };
      s.unsubscribe = subscribe(onChange);
      onChange();
    });
  }
  return s.value as T;
}

const unsupported = (name: string) => () => {
  throw new Error(`${name} is not served by the hook runtime: add it there before testing a component that calls it`);
};

export const hooks = {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect: useEffect,
  useContext: unsupported('useContext'),
  useReducer: unsupported('useReducer'),
  useSyncExternalStore,
  useTransition: unsupported('useTransition'),
  useDeferredValue: unsupported('useDeferredValue'),
  useId: unsupported('useId'),
  useImperativeHandle: unsupported('useImperativeHandle'),
  useInsertionEffect: unsupported('useInsertionEffect'),
  useOptimistic: unsupported('useOptimistic'),
  useActionState: unsupported('useActionState'),
  use: unsupported('use'),
};

export interface Mount<R> {
  /** What the last render returned. */
  readonly result: R;
  /** How many times the body has run. */
  readonly renders: number;
  /** Runs the body again, for props that changed outside it. */
  rerender(): void;
  unmount(): void;
}

/** Calls `body` as a component would be rendered, then runs its effects. */
export function mount<R>(body: () => R): Mount<R> {
  const m = new Mounted(body);
  m.render();
  return {
    get result() { return m.output; },
    get renders() { return m.renders; },
    rerender: () => m.render(),
    unmount: () => m.unmount(),
  };
}

/** Lets pending promise callbacks run: an IPC answer that has resolved lands after this. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** A promise the test resolves or rejects when it chooses: an IPC call still in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Every element in a tree, props included: `control={<X />}` is part of what renders. */
export function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!isElement(n)) return;
    found.push(n);
    for (const value of Object.values(n.props ?? {})) walk(value);
  };
  walk(node);
  return found;
}

/** The elements of a tree whose type is `type`: a component function or a tag name. */
export function ofType(node: unknown, type: unknown): ReactElement<Record<string, unknown>>[] {
  return elements(node).filter(el => el.type === type);
}

/** The text a tree spells out through its children, one component deep. */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
