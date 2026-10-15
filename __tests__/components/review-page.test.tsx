import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred, elements, textOf, type Mount } from './hook-runtime';
import ReviewPage from '../../src/app/review/page';
import type { AgentStatus, ReviewDiff } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Review page's own side of JeanBrasse's "the Review page only half works"
 * (01/10), from the Audit's DIAG-REVIEW.md. Frames: Review · dark, Review ·
 * light and Review · states, in design/tars-redesign.pen. The pure parts, the
 * list and the cut, are pinned in __tests__/lib/review.test.ts. Written before
 * the code, as the ways it can fail:
 * 1. a project added in Tars that no agent works in is missing from the
 *    list; or it is listed while an agent works in it, or listed without
 *    saying no agent; or a folder Claude Code merely ran in floods the list;
 * 2. a file whose patch main could not read says there is no textual change,
 *    or nothing, and never why;
 * 3. a picked file's patch past 4000 lines is cut without a word, or a patch
 *    that fits says it was cut, or the count is wrong;
 * 4. the answer for a tree no longer selected replaces the selected tree's
 *    files, and a file's patch that comes back after another file was picked
 *    replaces that file's;
 * 5. Refresh reads the selected tree again but not the list: a project or an
 *    agent added since never shows;
 * 6. the page asks review:diff for every patch of the tree, up to 2 MB over
 *    IPC, where it shows a file's patch only once that file is picked (#247's
 *    listOnly); or, with no file picked, it shows a patch at all, where the
 *    panel asks for a file (frame Review · states).
 */

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };

function agent(over: Partial<AgentStatus>): AgentStatus {
  return { id: 'a', name: 'Agent', status: 'idle', projectPath: '/p/tars', skills: [], output: [], lastActivity: '', currentTask: '', ...over } as AgentStatus;
}
function diffOf(repo: string, files: string[], patch = ''): ReviewDiff {
  return {
    repo, branch: 'main', baseBranch: null, ahead: 0, behind: 0,
    files: files.map(path => ({ path, status: 'modified', additions: 1, deletions: 0 })),
    totalAdditions: files.length, totalDeletions: 0, patch, truncated: false,
  } as ReviewDiff;
}

describe('the page', () => {
  let page: Mount<unknown>;
  let agents: AgentStatus[];
  let projects: Array<{ path: string; name: string; custom?: boolean }>;
  let diffCalls: Array<{ repo: string; opts?: { listOnly?: boolean }; answer: ReturnType<typeof deferred<{ success: boolean; diff?: ReviewDiff; error?: string }>> }>;
  let fileCalls: Array<{ file: string; answer: ReturnType<typeof deferred<{ success: boolean; patch?: string; error?: string }>> }>;

  const buttons = () => elements(page.result).filter(e => typeof e.props.onClick === 'function') as unknown as El[];
  const press = (text: string) => {
    const b = buttons().find(e => textOf(e.props.children as never).includes(text));
    expect(b, `a control reading ${text}`).toBeDefined();
    (b!.props.onClick as () => void)();
  };
  const shown = () => textOf(page.result as never);
  /** What the patch view is handed: it is a component of its own, so its lines are not in the page's text. */
  const patchShown = () => elements(page.result).filter(e => typeof e.props.patch === 'string').map(e => e.props.patch);

  beforeEach(async () => {
    agents = [
      agent({ id: 'a1', name: 'Frontend', projectPath: '/p/tars', worktreePath: '/p/tars/.worktrees/feat/frontend', branchName: 'feat/frontend' }),
      agent({ id: 'a2', name: 'Backend', projectPath: '/p/tars', worktreePath: '/p/tars/.worktrees/feat/backend', branchName: 'feat/backend' }),
    ];
    projects = [{ path: '/p/tars', name: 'tars', custom: true }];
    diffCalls = [];
    fileCalls = [];
    g.window = {
      electronAPI: {
        agent: { list: async () => agents },
        fs: { listProjects: async () => projects },
        review: {
          diff: (repo: string, _base?: string, opts?: { listOnly?: boolean }) => { const answer = deferred<{ success: boolean; diff?: ReviewDiff; error?: string }>(); diffCalls.push({ repo, opts, answer }); return answer.promise; },
          file: (_repo: string, file: string) => { const answer = deferred<{ success: boolean; patch?: string; error?: string }>(); fileCalls.push({ file, answer }); return answer.promise; },
        },
      },
    };
    page = mount(() => ReviewPage());
    await settle();
  });

  afterEach(() => {
    page.unmount();
    delete g.window;
  });

  it('lists the project no agent works in, under its name, saying no agent (1)', async () => {
    projects = [...projects, { path: '/p/docs', name: 'docs', custom: true }];
    page.unmount();
    page = mount(() => ReviewPage());
    await settle();
    expect(shown()).toContain('DOCS');
    expect(shown()).toContain('no agent');
  });

  it("says why a file's patch could not be read (2)", async () => {
    diffCalls[0].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/backend', ['a.ts']) });
    await settle();
    press('a.ts');
    await settle();
    fileCalls[0].answer.resolve({ success: false, error: 'not a git repository' });
    await settle();
    expect(shown()).toContain("Could not read this file's patch: not a git repository");
    expect(shown()).not.toContain('No textual change');
  });

  it('asks for the files alone, and with no file picked shows no patch and asks for one (6)', async () => {
    expect(diffCalls.map(c => c.opts)).toEqual([{ listOnly: true }]);
    // Even if a main of another version handed a patch back with the list.
    diffCalls[0].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/backend', ['a.ts'], '+a whole patch\n') });
    await settle();
    expect(patchShown()).toEqual([]);
    expect(shown()).toContain('Pick a file to read its patch.');
    press('feat/frontend');
    await settle();
    expect(diffCalls.map(c => c.opts)).toEqual([{ listOnly: true }, { listOnly: true }]);
  });

  it("says where a picked file's patch stops past 4000 lines, with no hint to pick one (3)", async () => {
    diffCalls[0].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/backend', ['a.ts']) });
    await settle();
    press('a.ts');
    await settle();
    fileCalls[0].answer.resolve({ success: true, patch: Array.from({ length: 4100 }, (_, i) => `+line ${i}`).join('\n') + '\n' });
    await settle();
    expect(shown()).toContain('4000 of 4100 lines shown.');
    expect(shown()).not.toContain('Pick a file');
  });

  it("keeps the selected tree's files when an older answer comes back late (4)", async () => {
    // Backend's tree is read first (the list sorts it before frontend); then frontend is picked.
    press('feat/frontend');
    await settle();
    expect(diffCalls.map(c => c.repo)).toEqual(['/p/tars/.worktrees/feat/backend', '/p/tars/.worktrees/feat/frontend']);
    diffCalls[1].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/frontend', ['front.ts']) });
    await settle();
    diffCalls[0].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/backend', ['back.ts']) });
    await settle();
    expect(shown()).toContain('front.ts');
    expect(shown()).not.toContain('back.ts');
  });

  it("keeps the picked file's patch when an earlier file's comes back late (4)", async () => {
    diffCalls[0].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/backend', ['one.ts', 'two.ts']) });
    await settle();
    press('one.ts');
    press('two.ts');
    await settle();
    fileCalls[1].answer.resolve({ success: true, patch: '+the second file' });
    await settle();
    fileCalls[0].answer.resolve({ success: true, patch: '+the first file' });
    await settle();
    expect(patchShown()).toEqual(['+the second file']);
  });

  it('reads the list again on Refresh, so a tree added since shows (5)', async () => {
    agents = [...agents, agent({ id: 'a3', name: 'QA', projectPath: '/p/tars', worktreePath: '/p/tars/.worktrees/feat/qa', branchName: 'feat/qa' })];
    expect(shown()).not.toContain('feat/qa');
    diffCalls[0].answer.resolve({ success: true, diff: diffOf('/p/tars/.worktrees/feat/backend', []) });
    await settle();
    press('Refresh');
    await settle();
    expect(shown()).toContain('feat/qa');
  });
});
