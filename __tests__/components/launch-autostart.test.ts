import '../setup/home-guard';
import { describe, it, expect } from 'vitest';

/**
 * Which agents a cold launch resumes.
 *
 * The old behaviour resumed every idle agent on every mount of the dashboard,
 * so leaving the page and coming back spawned sessions the user never asked
 * for. Removing it wholesale also removed the wanted half: open the app and
 * find the agents you left running.
 *
 * These two are separable, and this is the predicate that separates them.
 */

interface Candidate {
  id: string;
  status: string;
  ptyId?: string;
  pathMissing?: boolean;
}

/** Mirrors the filter in TerminalsView's launch effect. */
const resumable = (agents: Candidate[]) =>
  agents.filter(a => !a.ptyId && a.status === 'idle' && !a.pathMissing).map(a => a.id);

describe('launch autostart candidates', () => {
  it('resumes an idle agent with no terminal', () => {
    expect(resumable([{ id: 'a', status: 'idle' }])).toEqual(['a']);
  });

  it('leaves an agent that already has a live PTY alone', () => {
    // Resuming underneath a live session would push a second prompt into a
    // terminal that is mid-turn.
    expect(resumable([{ id: 'a', status: 'idle', ptyId: 'pty-1' }])).toEqual([]);
  });

  it('does not touch an agent that is running, waiting or errored', () => {
    expect(resumable([
      { id: 'r', status: 'running' },
      { id: 'w', status: 'waiting' },
      { id: 'e', status: 'error' },
    ])).toEqual([]);
  });

  it('skips an agent whose project directory is gone', () => {
    // loadAgents marks these; starting one spawns a CLI in a missing cwd.
    expect(resumable([{ id: 'a', status: 'idle', pathMissing: true }])).toEqual([]);
  });

  it('picks exactly the idle, unattached, present ones out of a mixed fleet', () => {
    expect(resumable([
      { id: 'keep1', status: 'idle' },
      { id: 'live', status: 'running', ptyId: 'p' },
      { id: 'attached', status: 'idle', ptyId: 'p2' },
      { id: 'missing', status: 'idle', pathMissing: true },
      { id: 'keep2', status: 'idle' },
    ])).toEqual(['keep1', 'keep2']);
  });
});

describe('launch, not navigation', () => {
  // A sessionStorage key set once per window is what makes this a launch
  // event. Re-entering the dashboard in the same session must be inert.
  const KEY = 'tars-launch-autostart-done';

  function shouldRun(store: Record<string, string>): boolean {
    if (store[KEY]) return false;
    store[KEY] = '1';
    return true;
  }

  it('runs on the first dashboard render of a window', () => {
    const store: Record<string, string> = {};
    expect(shouldRun(store)).toBe(true);
  });

  it('never runs again in the same window, however many times you navigate back', () => {
    const store: Record<string, string> = {};
    shouldRun(store);
    expect(shouldRun(store)).toBe(false);
    expect(shouldRun(store)).toBe(false);
  });

  it('runs again in a fresh window, which is a fresh launch', () => {
    expect(shouldRun({})).toBe(true);
  });
});
