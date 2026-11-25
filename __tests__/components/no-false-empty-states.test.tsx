import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred, ofType, textOf, type Mount } from './hook-runtime';
import { LoadingState, PanelCaption } from '../../src/components/ui';
import ReviewPage from '../../src/app/review/page';
import { RepositoryColumn } from '../../src/components/Review/RepositoryColumn';
import LogsPage from '../../src/app/logs/page';
import TrayPanel from '../../src/components/TrayPanel/TrayPanel';
import type { AgentStatus, AgentTickItem, FleetEntry } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * "Nothing here" is an answer, so it waits for one (1.7.4).
 *
 * Review said "No agent has a working tree yet", Logs "0 agents · No agent has
 * produced output yet" and the tray panel "No agents configured" from their
 * first frame, while their first read was still in flight. Each now waits on
 * the loading ladder until its first answer, and says it has nothing only
 * after hearing so. Asserted before the answer and after it, with the answer
 * held in flight by the test, so neither half can pass on its own.
 */

const g = globalThis as unknown as { window?: unknown; document?: unknown };

function waits(tree: unknown, what: RegExp): boolean {
  return ofType(tree, LoadingState).some(el => el.props.loading === true && what.test(String(el.props.what)));
}

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1',
    name: 'Planner',
    status: 'idle',
    projectPath: '/tmp/tars-hermes',
    worktreePath: '/tmp/tars-hermes/.worktrees/plan',
    branchName: 'feat/plan',
    skills: [],
    output: [],
    lastActivity: '2026-09-17T10:00:00.000Z',
    ...over,
  } as AgentStatus;
}

describe('Review', () => {
  // Since 2.0.4 (#488) Review lists every repository of every project, the projects and the agent list read first,
  // then each project scanned (review.repositories). It hands them to its column, which says "No working tree yet"
  // for an empty list: so the page must not hand it one before both lists have answered. One component deep, the
  // page's side of that is whether it shows the column, and with which projects.
  let list: ReturnType<typeof deferred<AgentStatus[]>>;
  let page: Mount<ReturnType<typeof ReviewPage>>;
  const columns = () => ofType(page.result, RepositoryColumn);

  beforeEach(() => {
    list = deferred<AgentStatus[]>();
    g.window = {
      electronAPI: {
        agent: { list: vi.fn(() => list.promise) },
        fs: { listProjects: vi.fn(async () => []) },
        review: {
          diff: vi.fn(() => new Promise(() => {})),
          file: vi.fn(),
          repo: vi.fn(() => new Promise(() => {})),
          repositories: vi.fn(async (projectPath: string) => ({
            cached: {
              state: 'repository',
              skipped: [],
              repositories: [{ path: projectPath, branch: 'feat/plan', changed: [], base: null, ahead: null, agents: [{ id: 'a1', name: 'Planner' }] }],
            },
          })),
          search: vi.fn(),
          cancel: vi.fn(),
          onRepositoriesEvent: vi.fn(() => () => {}),
          onSearchEvent: vi.fn(() => () => {}),
        },
      },
    };
    page = mount(() => ReviewPage());
  });

  afterEach(() => {
    page.unmount();
    delete g.window;
  });

  it('waits on the ladder, not on the empty state, until the agent list answers', () => {
    expect(waits(page.result, /repositories/)).toBe(true);
    expect(columns()).toHaveLength(0);
  });

  it('says it has no working tree once the list answers with none', async () => {
    list.resolve([]);
    await settle();
    expect(columns()).toHaveLength(1);
    expect(columns()[0].props.projects).toEqual([]);
    expect(waits(page.result, /repositories/)).toBe(false);
  });

  it('lists the working trees once the list answers with some', async () => {
    list.resolve([agent()]);
    await settle();
    const projects = (columns()[0]?.props.projects ?? []) as Array<{ path: string; repositories: Array<{ branch: string }> }>;
    expect(projects.map(p => p.path)).toEqual(['/tmp/tars-hermes']);
    expect(projects[0]?.repositories.map(r => r.branch)).toEqual(['feat/plan']);
    expect(waits(page.result, /repositories/)).toBe(false);
  });

  it('does not wait forever when the list fails', async () => {
    list.reject(new Error('ipc gone'));
    await settle();
    expect(waits(page.result, /repositories/)).toBe(false);
  });
});

describe('Logs', () => {
  const EMPTY = 'No agent has produced output yet.';
  let fleet: ReturnType<typeof deferred<{ agents: FleetEntry[] }>>;
  let page: Mount<ReturnType<typeof LogsPage>>;

  beforeEach(() => {
    fleet = deferred<{ agents: FleetEntry[] }>();
    g.window = {
      electronAPI: {
        logs: { fleet: vi.fn(() => fleet.promise), search: vi.fn(async () => ({ lines: [], scanned: 0, truncated: false })), tail: vi.fn() },
      },
    };
    g.document = { visibilityState: 'visible' };
    page = mount(() => LogsPage());
  });

  afterEach(() => {
    page.unmount();
    delete g.window;
    delete g.document;
  });

  // The fleet panel's caption, exactly: text taken from the whole page runs
  // into its neighbours, and a word boundary check on it cannot fail.
  const caption = () => ofType(page.result, PanelCaption).map(c => textOf(c.props.children as never));

  it('counts no agents and says nothing is empty until the fleet answers', () => {
    expect(waits(page.result, /output/)).toBe(true);
    expect(textOf(page.result)).not.toContain(EMPTY);
    expect(caption()).toEqual(['agents']);
  });

  it('says 0 agents and that none has produced output once the fleet answers with none', async () => {
    fleet.resolve({ agents: [] });
    await settle();
    expect(caption()).toEqual(['0 agents']);
    expect(textOf(page.result)).toContain(EMPTY);
    expect(waits(page.result, /output/)).toBe(false);
  });

  it('lists the fleet once it answers with agents', async () => {
    fleet.resolve({ agents: [{ agentId: 'a1', agentName: 'Planner', projectPath: '/tmp/tars-hermes', status: 'idle', lines: 12 } as FleetEntry] });
    await settle();
    const text = textOf(page.result);
    expect(caption()).toEqual(['1 agent']);
    expect(text).toContain('Planner');
    expect(text).not.toContain(EMPTY);
    expect(waits(page.result, /output/)).toBe(false);
  });
});

describe('the tray panel', () => {
  const EMPTY = 'No agents configured';
  type Tick = (items: AgentTickItem[]) => void;
  let list: ReturnType<typeof deferred<AgentStatus[]>>;
  let tick: Tick | undefined;
  let panel: Mount<ReturnType<typeof TrayPanel>>;

  beforeEach(() => {
    list = deferred<AgentStatus[]>();
    tick = undefined;
    g.window = {
      electronAPI: {
        agent: {
          list: vi.fn(() => list.promise),
          onTick: (cb: Tick) => { tick = cb; return () => {}; },
        },
      },
    };
    g.document = { body: { style: {} } };
    panel = mount(() => TrayPanel());
  });

  afterEach(() => {
    panel.unmount();
    delete g.window;
    delete g.document;
  });

  it('waits on the ladder, not on "No agents configured", before its first list or tick', () => {
    expect(waits(panel.result, /agents/)).toBe(true);
    expect(textOf(panel.result)).not.toContain(EMPTY);
  });

  it('says no agents once the list answers with none', async () => {
    list.resolve([]);
    await settle();
    expect(textOf(panel.result)).toContain(EMPTY);
    expect(waits(panel.result, /agents/)).toBe(false);
  });

  it('takes a tick that arrives before the list as the answer', () => {
    expect(tick).toBeTypeOf('function');
    tick!([]);
    expect(textOf(panel.result)).toContain(EMPTY);
    expect(waits(panel.result, /agents/)).toBe(false);
  });

  it('lists what the list answers', async () => {
    list.resolve([agent({ name: 'Reviewer' })]);
    await settle();
    expect(textOf(panel.result)).not.toContain(EMPTY);
    expect(waits(panel.result, /agents/)).toBe(false);
    expect(ofType(panel.result, (await import('../../src/components/TrayPanel/TrayAgentItem')).default)).toHaveLength(1);
  });
});
