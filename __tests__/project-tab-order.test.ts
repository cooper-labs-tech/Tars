import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import { applyOrder } from '../src/components/TerminalsView/hooks/useProjectTabOrder';

/**
 * The order of the project tabs.
 *
 * A stored order is a preference, not a list of what exists: agents come and
 * go, so the ranking will always be partly stale. The rule that has to hold is
 * that it never decides which projects appear. A project the user has never
 * dragged must still show up, and a project whose last agent was removed must
 * not linger as a tab pointing at nothing.
 */

describe('ranking the project tabs', () => {
  it('follows the stored order', () => {
    expect(applyOrder(['/a', '/b', '/c'], ['/c', '/a', '/b'])).toEqual(['/c', '/a', '/b']);
  });

  it('keeps the live order when nothing has been arranged', () => {
    expect(applyOrder(['/a', '/b'], [])).toEqual(['/a', '/b']);
  });

  it('puts a project that has never been ranked at the end', () => {
    expect(applyOrder(['/a', '/b', '/new'], ['/b', '/a'])).toEqual(['/b', '/a', '/new']);
  });

  it('drops a ranked project that no longer has an agent', () => {
    expect(applyOrder(['/a'], ['/gone', '/a'])).toEqual(['/a']);
  });

  it('never invents a tab from the stored order alone', () => {
    expect(applyOrder([], ['/a', '/b'])).toEqual([]);
  });

  it('returns each live project exactly once', () => {
    // A stored list holding a duplicate must not double a tab, which would
    // give two panels the same React key.
    const out = applyOrder(['/a', '/b'], ['/a', '/a', '/b']);
    expect(out).toEqual(['/a', '/b']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('loses nothing when the stored order is unrelated', () => {
    const live = ['/x', '/y', '/z'];
    expect(applyOrder(live, ['/p', '/q']).sort()).toEqual(live.slice().sort());
  });
});
