import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import { insidePath, nothingFoundLine, progressLine, reviewProjects, searchRows } from '@/lib/review-repositories';
import type { AgentStatus } from '@/types/electron';

/**
 * What Review's left column says of every project and every repository (2.0.4, the window's part of #472; frames
 * `Review · projects and their repositories`, `· search`, `· states`). Written before the code. Every way it can be
 * wrong:
 * 1. The projects: one added in Tars or worked in by an agent left out, one listed twice (an agent's and the list's,
 *    or a trailing separator), a folder Claude Code merely ran in listed, an agent with no project counted, an order
 *    that moves between two reads.
 * 2. A repository's name: its whole path where the path inside its project is meant, a Windows path read wrong, the
 *    project itself named by an empty string, a worktree outside the project named by a path that leads up.
 * 3. Search results: a repository listed when only its files matched, a file named without its repository, a result
 *    moved out of the order main gave, a project named by its path.
 * 4. Nothing found: a sentence with "1 repositories" or "your 1 projects", or that hides the word looked for.
 * 5. A scan still running: a count of folders or repositories left out, or the folder named by its whole home path.
 */

const agent = (over: Partial<AgentStatus>) => ({ id: 'a', name: 'Agent', status: 'idle', projectPath: '/Users/you/tars', skills: [], output: [], lastActivity: '', currentTask: '', ...over }) as AgentStatus;

describe('reviewProjects (1)', () => {
  it('lists the projects added in Tars and those agents work in, once each, by name', () => {
    const projects = [
      { path: '/Users/you/meridian', name: 'meridian', custom: true },
      { path: '/Users/you/scratch', name: 'scratch' },
      { path: '/Users/you/atlas/', name: 'atlas', custom: true },
    ];
    const agents = [agent({ projectPath: '/Users/you/tars' }), agent({ id: 'b', projectPath: '/Users/you/meridian' }), agent({ id: 'c', projectPath: undefined as unknown as string })];
    expect(reviewProjects(agents, projects)).toEqual(['/Users/you/atlas', '/Users/you/meridian', '/Users/you/tars']);
    expect(reviewProjects(agents, projects)).toEqual(reviewProjects([...agents].reverse(), [...projects].reverse()));
  });
});

describe('insidePath (2)', () => {
  it('names a repository by its path inside its project, the project itself by its own name', () => {
    expect(insidePath('/Users/you/meridian', '/Users/you/meridian/services/a/b/indexer')).toBe('services/a/b/indexer');
    expect(insidePath('/Users/you/meridian', '/Users/you/meridian')).toBe('meridian');
    expect(insidePath('C:\\Users\\you\\meridian', 'C:\\Users\\you\\meridian\\sdk-js')).toBe('sdk-js');
    expect(insidePath('/Users/you/meridian', '/Users/you/.tars/worktrees/meridian-feat')).toBe('meridian-feat');
  });
});

describe('searchRows (3)', () => {
  it('lists a repository only for its name, each file with its repository, in main\'s order', () => {
    const rows = searchRows([
      { project: '/Users/you/meridian', repo: '/Users/you/meridian/sdk-js', branch: 'feat/indexer', nameMatch: false, files: ['src/indexer/client.ts', 'test/client.test.ts'] },
      { project: '/Users/you/meridian', repo: '/Users/you/meridian/client', branch: 'main', nameMatch: true, files: [] },
    ]);
    expect(rows).toEqual([
      { kind: 'file', project: 'meridian', repo: '/Users/you/meridian/sdk-js', label: 'sdk-js/src/indexer/client.ts', file: 'src/indexer/client.ts', branch: 'feat/indexer' },
      { kind: 'file', project: 'meridian', repo: '/Users/you/meridian/sdk-js', label: 'sdk-js/test/client.test.ts', file: 'test/client.test.ts', branch: 'feat/indexer' },
      { kind: 'repo', project: 'meridian', repo: '/Users/you/meridian/client', label: 'client', branch: 'main' },
    ]);
  });
});

describe('nothingFoundLine (4)', () => {
  it('names the word, and counts in the singular when it is one', () => {
    expect(nothingFoundLine('fetchTicker', 42, 5)).toBe('Nothing named fetchTicker in the 42 repositories of your 5 projects, nor in their changed files.');
    expect(nothingFoundLine('x', 1, 1)).toBe('Nothing named x in the one repository of your project, nor in its changed files.');
    expect(nothingFoundLine('x', 0, 2)).toBe('Nothing named x: no repository in your 2 projects.');
  });
});

describe('progressLine (5)', () => {
  it('counts the folders read and the repositories found, the folder from home', () => {
    expect(progressLine('/Users/you/meridian', 214, 19)).toBe('Looking through ~/meridian: 214 folders read, 19 repositories so far. Each shows as it is found.');
    expect(progressLine('/Users/you/meridian', 1, 1)).toBe('Looking through ~/meridian: 1 folder read, 1 repository so far. Each shows as it is found.');
  });
});
