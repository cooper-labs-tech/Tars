import { describe, it, expect } from 'vitest';

/**
 * Bugs found by using the app rather than reading it.
 *
 * A third block, on the Usage page's daily cost, used to live here: a copy of
 * the page's map that added token-stats.json's over-quota spend to each day.
 * It tested the copy, never the page, and the addition was a double count:
 * those sessions are in the transcripts already. The page no longer adds it;
 * usage-timeframe.test.tsx asserts that on the page itself.
 */

describe('a missing project folder', () => {
  // Start used to build `cd '<folder>' && claude ...` and write it into the
  // PTY. When the folder was gone bash printed "No such file or directory",
  // the && short-circuited, and the user was left at a shell prompt with no
  // indication that anything had failed. Six of JeanBrasse's agents pointed at a
  // folder that no longer existed.
  const canStart = (agent: { projectPath: string; worktreePath?: string }, exists: (p: string) => boolean) =>
    exists(agent.worktreePath || agent.projectPath);

  const present = (p: string) => p === '/Users/x/real' || p === '/Users/x/real/.worktrees/feat';

  it('refuses when the project folder is gone', () => {
    expect(canStart({ projectPath: '/Users/x/gone' }, present)).toBe(false);
  });

  it('checks the worktree, which is where the agent actually runs', () => {
    expect(canStart({ projectPath: '/Users/x/real', worktreePath: '/Users/x/real/.worktrees/gone' }, present)).toBe(false);
    expect(canStart({ projectPath: '/Users/x/real', worktreePath: '/Users/x/real/.worktrees/feat' }, present)).toBe(true);
  });

  it('allows the ordinary case', () => {
    expect(canStart({ projectPath: '/Users/x/real' }, present)).toBe(true);
  });
});

describe('Hermes schedule dates', () => {
  // Hermes is another system; its date fields are whatever it sends. One odd
  // row must not be able to take the page down.
  function formatNext(next: unknown): string {
    if (next === null || next === undefined || next === '') return '';
    try {
      const value = typeof next === 'number' && next < 1e12 ? next * 1000 : next as string | number;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return ` · next ${date.toLocaleString()}`;
    } catch {
      return '';
    }
  }

  it('renders an ISO string', () => {
    expect(formatNext('2026-08-24T09:00:00Z')).toContain('next');
  });

  it('treats a bare seconds timestamp as seconds, not 1970', () => {
    expect(formatNext(1787000000)).toContain('2026');
  });

  it('says nothing rather than "Invalid Date"', () => {
    for (const bad of ['', null, undefined, 'whenever', {}, []]) {
      expect(formatNext(bad), String(bad)).toBe('');
    }
  });
});
