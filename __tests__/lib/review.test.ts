import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { cutNote, workspacesFrom, PATCH_LINES } from '../../src/lib/review';
import type { AgentStatus } from '../../src/types/electron';

/**
 * What the Review page lists and how it says a patch is cut, worked out apart
 * from the page (src/lib/review.ts). The page itself is driven in
 * __tests__/components/review-page.test.tsx. Written before the code, as the
 * ways it can fail:
 * 1. a project added in Tars that no agent works in is missing from the
 *    list; or it is listed while an agent works in it, or listed without
 *    saying no agent; or a folder Claude Code merely ran in floods the list;
 * 3. a patch past 4000 lines is cut without a word, or a patch that fits
 *    says it was cut, or the count is wrong. Since the page reads a tree's
 *    files without their patches (#247), only a picked file's patch is shown,
 *    and the note carries no hint to pick one.
 * (The numbers follow the page's test, where 2, 4 and 5 live.)
 */

function agent(over: Partial<AgentStatus>): AgentStatus {
  return { id: 'a', name: 'Agent', status: 'idle', projectPath: '/p/tars', skills: [], output: [], lastActivity: '', currentTask: '', ...over } as AgentStatus;
}

describe('the trees listed (1)', () => {
  const agents = [agent({ id: 'a1', name: 'Frontend', projectPath: '/p/tars', worktreePath: '/p/tars/.worktrees/feat/frontend', branchName: 'feat/frontend' })];
  it('lists a project added in Tars that no agent works in, saying so', () => {
    const list = workspacesFrom(agents, [{ path: '/p/tars', name: 'tars', custom: true }, { path: '/p/docs', name: 'docs', custom: true }]);
    const docs = list.find(w => w.repoPath === '/p/docs');
    expect(docs).toMatchObject({ projectName: 'docs', label: 'docs', agents: [] });
  });

  it('lists no project twice, and none an agent works in as having no agent', () => {
    const list = workspacesFrom(agents, [{ path: '/p/tars', name: 'tars', custom: true }]);
    expect(list.map(w => w.repoPath)).toEqual(['/p/tars/.worktrees/feat/frontend']);
  });

  it('leaves out the folders Claude Code merely ran in', () => {
    const list = workspacesFrom(agents, [{ path: '/Users/someone/scratch', name: 'scratch' }]);
    expect(list.map(w => w.repoPath)).toEqual(['/p/tars/.worktrees/feat/frontend']);
  });
});

describe('a patch cut short (3)', () => {
  it(`says nothing for a patch of ${PATCH_LINES} lines or fewer`, () => {
    expect(cutNote(PATCH_LINES)).toBeNull();
    expect(cutNote(12)).toBeNull();
  });
  it('says where a longer one stops, with no hint to pick a file: one is picked', () => {
    expect(cutNote(9310)).toBe('4000 of 9310 lines shown.');
    expect(cutNote(PATCH_LINES + 1)).toBe(`4000 of ${PATCH_LINES + 1} lines shown.`);
  });
});

