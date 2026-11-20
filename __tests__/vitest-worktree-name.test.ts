import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import { builtinsVitestCannotLoad } from './setup/vitest-root-prefix';

/**
 * Which built-in modules vitest cannot load, by where it is installed and where
 * it runs (setup/vitest-root-prefix.ts), in this repository's layout: vitest in
 * the repository's node_modules, and a worktree under .worktrees/ that has none
 * of its own. setup/worktree-name.ts fails every file when the list is not
 * empty.
 */
const DIST = '/Users/you/tars/node_modules/vitest/dist';
const worktree = (name: string) => `/Users/you/tars/.worktrees/${name}`;

describe('the built-in modules vitest cannot load', () => {
  it('are stream and string_decoder in a worktree named in 11 characters, as fe-appclean was', () => {
    const lost = builtinsVitestCannotLoad(DIST, worktree('fe-appclean'));
    expect(lost).toEqual(expect.arrayContaining(['stream', 'string_decoder']));
    expect(lost.every(name => name.startsWith('st'))).toBe(true);
  });

  it('are timers, tls and tty with a name of 12 characters', () => {
    const lost = builtinsVitestCannotLoad(DIST, worktree('fe-appclean2'));
    expect(lost).toEqual(expect.arrayContaining(['timers', 'tls', 'tty']));
    expect(lost).not.toContain('stream');
  });

  it('are none with names of 7, 10 or 13 characters, whose leftover starts no built-in', () => {
    for (const name of ['qa-gate', 'qa-gate-10', 'qa-gate-13-ch']) {
      expect(builtinsVitestCannotLoad(DIST, worktree(name)), name).toEqual([]);
    }
  });

  it('are none at the repository root, or in a worktree with its own install', () => {
    expect(builtinsVitestCannotLoad(DIST, '/Users/you/tars')).toEqual([]);
    expect(builtinsVitestCannotLoad(`${worktree('fe-appclean')}/node_modules/vitest/dist`, worktree('fe-appclean'))).toEqual([]);
  });
});
