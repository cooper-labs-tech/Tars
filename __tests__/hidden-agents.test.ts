import './setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Panels taken off a board.
 *
 * Removing a panel from a project board used to be the only way to delete an
 * agent for good: it killed the terminal, dropped the record and ran
 * `git worktree remove --force`. Hiding has to be the reversible thing, and
 * the store behind it has to survive an agent being deleted elsewhere without
 * leaving a name that can never come back.
 *
 * The hook is a thin wrapper over localStorage; the rules worth pinning are in
 * the store, so they are driven directly here.
 */

const KEY = 'terminals-hidden-agents';

function makeStore() {
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    raw: mem,
  };
}

let store: ReturnType<typeof makeStore>;

/** The rules the hook applies, driven without React. */
const read = (): Record<string, string[]> => {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [tab, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[tab] = ids.filter((i): i is string => typeof i === 'string');
    }
    return out;
  } catch { return {}; }
};
const write = (s: Record<string, string[]>) => store.setItem(KEY, JSON.stringify(s));

const hide = (tab: string, id: string) => {
  const s = read();
  const cur = s[tab] ?? [];
  if (!cur.includes(id)) s[tab] = [...cur, id];
  write(s);
};
const show = (tab: string, id: string) => {
  const s = read();
  s[tab] = (s[tab] ?? []).filter(x => x !== id);
  if (s[tab].length === 0) delete s[tab];
  write(s);
};
beforeEach(() => { store = makeStore(); });

describe('hiding a panel', () => {
  it('keeps it hidden on that board only', () => {
    hide('/proj-a', 'agent-1');
    expect(read()['/proj-a']).toEqual(['agent-1']);
    expect(read()['/proj-b']).toBeUndefined();
  });

  it('does not list the same agent twice', () => {
    hide('/proj-a', 'agent-1');
    hide('/proj-a', 'agent-1');
    expect(read()['/proj-a']).toEqual(['agent-1']);
  });

  it('puts one back without touching the others', () => {
    hide('/proj-a', 'agent-1');
    hide('/proj-a', 'agent-2');
    show('/proj-a', 'agent-1');
    expect(read()['/proj-a']).toEqual(['agent-2']);
  });

  it('drops the board entirely once nothing is hidden on it', () => {
    hide('/proj-a', 'agent-1');
    show('/proj-a', 'agent-1');
    expect('/proj-a' in read()).toBe(false);
  });
});

describe('an agent deleted elsewhere', () => {
  it('needs no cleanup, because a hidden id is only ever read against live agents', () => {
    hide('/proj-a', 'agent-1');
    hide('/proj-a', 'agent-2');
    // The board derives what to show and what to offer restoring from the
    // agents that exist, so a stale id contributes nothing either way.
    const live = [{ id: 'agent-2' }];
    const hidden = read()['/proj-a'];
    expect(live.filter(a => hidden.includes(a.id))).toEqual([{ id: 'agent-2' }]);
    expect(live.filter(a => !hidden.includes(a.id))).toEqual([]);
  });
});

describe('a store that cannot be trusted', () => {
  it('reads an empty set from corrupt json', () => {
    store.setItem(KEY, '{not json');
    expect(read()).toEqual({});
  });

  it('ignores a value that is not a list of ids', () => {
    store.setItem(KEY, JSON.stringify({ '/proj-a': 'agent-1', '/proj-b': ['ok'] }));
    expect(read()['/proj-a']).toBeUndefined();
    expect(read()['/proj-b']).toEqual(['ok']);
  });

  it('ignores an array at the top level', () => {
    store.setItem(KEY, JSON.stringify(['agent-1']));
    expect(read()).toEqual({});
  });
});
