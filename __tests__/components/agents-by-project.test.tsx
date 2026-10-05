import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, ofType, textOf, type Mount } from './hook-runtime';
import { groupByProject, projectLabels, useAgentFiltering } from '../../src/hooks/useAgentFiltering';
import AgentsPage from '../../src/app/agents/page';
import { AgentManagementCard } from '../../src/components/AgentList';
import { Chip, Dropdown, type DropdownOption } from '../../src/components/ui';
import type { AgentStatus } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Agents page, organised by project (PR #118).
 *
 * JeanBrasse could not sort his agents by project. The page now shows one section
 * per project, in the order he gave the Dashboard's tabs, and a picker that
 * leaves one project on the page. What has to hold, and what these tests pin:
 * the sections follow the tab order and never invent or lose a project; the
 * status chips count what they would show, inside the project on screen, with
 * a completed agent under Idle because its card says idle; the picker counts
 * every agent of each project whatever the chips say; the page does not stay
 * on a project that has lost its last agent; and Clear filters clears all
 * three filters.
 *
 * The page is called as a function under the hook runtime, so what is read is
 * the element tree it hands React: Chip, Dropdown and AgentManagementCard
 * elements with their props. Its data hooks and its dialogs are served here.
 */

const fleet = vi.hoisted(() => ({ agents: [] as AgentStatus[] }));

vi.mock('../../src/hooks/useElectron', () => ({
  useElectronAgents: () => ({
    agents: fleet.agents,
    isLoading: false,
    isElectron: true,
    createAgent: async () => ({ id: 'new' }),
    updateAgent: async () => {},
    startAgent: async () => {},
    stopAgent: async () => {},
    removeAgent: async () => {},
  }),
  useElectronFS: () => ({ projects: [], openFolderDialog: async () => null }),
  useElectronSkills: () => ({ installedSkills: [], refresh: () => {} }),
  isElectron: () => true,
}));
vi.mock('../../src/hooks/useElectronTemplates', () => ({ useElectronTemplates: () => ({ create: async () => ({ success: true }) }) }));
vi.mock('../../src/hooks/useClaude', () => ({ useClaude: () => ({ data: null }) }));
vi.mock('../../src/hooks/useSuperAgent', () => ({ useSuperAgent: () => ({ superAgent: null }) }));
// Dialogs the page mounts closed. The terminal one loads xterm, which needs a DOM.
vi.mock('../../src/components/NewChatModal', () => ({ default: () => null }));
vi.mock('../../src/components/AgentWorld/AgentTerminalDialog', () => ({ default: () => null }));
vi.mock('../../src/components/Templates/TemplatesManagerDialog', () => ({ TemplatesManagerDialog: () => null }));

const TARS = '/Users/you/tars';
const CAPITAL = '/Users/you/1212-Capital';
const SAKARTVELO = '/Users/you/sakartvelo';

let created = 0;
function agent(name: string, projectPath: string, over: Partial<AgentStatus> = {}): AgentStatus {
  created += 1;
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    status: 'idle',
    projectPath,
    skills: [],
    output: [],
    // Each agent newer than the last: the page sorts newest first, so the
    // sorted order and the order of arrival are never the same.
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, created)).toISOString(),
    lastActivity: new Date(Date.UTC(2026, 8, 1, 0, created)).toISOString(),
    ...over,
  } as AgentStatus;
}

const names = (list: AgentStatus[]) => list.map(a => a.name);

describe('groupByProject', () => {
  const a1 = agent('A1', '/p/a');
  const b1 = agent('B1', '/p/b');
  const a2 = agent('A2', '/p/a');
  const c1 = agent('C1', '/p/c');
  const a3 = agent('A3', '/p/a');

  it('lays the projects out in the order of the Dashboard tabs', () => {
    const groups = groupByProject([a1, b1, c1], ['/p/c', '/p/a', '/p/b']);
    expect(groups.map(g => g.path)).toEqual(['/p/c', '/p/a', '/p/b']);
  });

  it('puts a project the tabs have never ranked last, in the order its agents come', () => {
    const groups = groupByProject([c1, a1, b1], ['/p/b']);
    expect(groups.map(g => g.path)).toEqual(['/p/b', '/p/c', '/p/a']);
  });

  it('gives no section to a project with no agent left, even one the tabs still rank', () => {
    const groups = groupByProject([a1, b1], ['/p/gone', '/p/c', '/p/b', '/p/a']);
    expect(groups.map(g => g.path)).toEqual(['/p/b', '/p/a']);
    expect(groups.every(g => g.agents.length > 0)).toBe(true);
  });

  it('keeps each project\'s agents in the order they were sorted', () => {
    const groups = groupByProject([a3, b1, a1, c1, a2], ['/p/a', '/p/b', '/p/c']);
    expect(groups.map(g => [g.path, names(g.agents)])).toEqual([
      ['/p/a', ['A3', 'A1', 'A2']],
      ['/p/b', ['B1']],
      ['/p/c', ['C1']],
    ]);
  });

  it('shows nothing when nothing is left after the filters', () => {
    expect(groupByProject([], ['/p/a'])).toEqual([]);
  });
});

describe('projectLabels', () => {
  it('calls each project by its folder name when the names are unique', () => {
    const labels = projectLabels([TARS, CAPITAL]);
    expect([...labels.entries()]).toEqual([[TARS, 'tars'], [CAPITAL, '1212-Capital']]);
  });

  it('gives two projects that share a folder name their paths, and only those two', () => {
    const work = '/Users/you/work/tars';
    const labels = projectLabels([TARS, CAPITAL, work]);
    expect(labels.get(TARS)).toBe('~/tars');
    expect(labels.get(work)).toBe('~/work/tars');
    expect(labels.get(CAPITAL)).toBe('1212-Capital');
    expect(new Set(labels.values()).size).toBe(3);
  });
});

describe('useAgentFiltering', () => {
  const fleetOf = [
    agent('Runner', TARS, { status: 'running', branchName: 'feat/frontend' }),
    agent('Waiter', TARS, { status: 'waiting' }),
    agent('Rester', TARS, { status: 'idle' }),
    agent('Finisher', CAPITAL, { status: 'completed' }),
    agent('Breaker', CAPITAL, { status: 'error', branchName: 'feat/backend' }),
    agent('Halted', CAPITAL, { status: 'stopped', stoppedBy: 'you' }),
  ];

  const filter = (statusFilter: string | null, searchQuery = '', projectFilter: string | null = null) => {
    const m = mount(() => useAgentFiltering({ agents: fleetOf, projectFilter, statusFilter, searchQuery }));
    return names(m.result.filteredAgents).sort();
  };

  it('finds a completed agent under Idle, as its card calls it', () => {
    expect(filter('idle')).toEqual(['Finisher', 'Rester']);
  });

  it('keeps the other statuses to their own word', () => {
    expect(filter('running')).toEqual(['Runner']);
    expect(filter('waiting')).toEqual(['Waiter']);
    expect(filter('error')).toEqual(['Breaker']);
  });

  it('finds a stopped agent under Stopped, and never under Idle, the word of one never started', () => {
    expect(filter('stopped')).toEqual(['Halted']);
    expect(filter('idle')).not.toContain('Halted');
  });

  it('matches the filter field against the branch', () => {
    expect(filter(null, 'feat/backend')).toEqual(['Breaker']);
    expect(filter(null, 'FEAT/FRONTEND')).toEqual(['Runner']);
  });

  it('narrows to one project', () => {
    expect(filter(null, '', CAPITAL)).toEqual(['Breaker', 'Finisher', 'Halted']);
  });
});

describe('the Agents page', () => {
  const PICKER = 'Show the agents of one project';
  let page: Mount<ReturnType<typeof AgentsPage>>;
  let storedOrder: string | null;

  beforeEach(() => {
    storedOrder = null;
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'terminals-project-tab-order' ? storedOrder : null) });
  });

  afterEach(() => {
    page?.unmount();
    vi.unstubAllGlobals();
  });

  const open = (agents: AgentStatus[]) => {
    fleet.agents = agents;
    page = mount(() => AgentsPage());
  };
  const tree = () => page.result;

  const sections = () => ofType(tree(), 'section').map(s => ({
    path: String(s.key),
    heading: [...ofType(s, 'h2'), ...ofType(s, 'span')].map(el => textOf(el.props.children as never)),
    cards: ofType(s, AgentManagementCard).map(c => (c.props.agent as AgentStatus).name),
  }));
  const chips = () => ofType(tree(), Chip).map(c => textOf(c.props.children as never));
  const chip = (word: string) => ofType(tree(), Chip).find(c => textOf(c.props.children as never).startsWith(word))!;
  const picker = () => ofType(tree(), Dropdown).find(d => d.props.ariaLabel === PICKER)!;
  const pickerRows = () => (picker().props.options as DropdownOption[]).map(o => [o.value, o.label, o.hint]);
  const pick = (value: string) => (picker().props.onChange as (v: string) => void)(value);
  const search = (text: string) => {
    const field = ofType(tree(), 'input').find(i => i.props.placeholder === 'filter by name or branch')!;
    (field.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: text } });
  };

  // Seven agents in three projects, arriving tars first. Statuses as in the
  // frame `Agents · dark`, with a completed agent among the idle ones.
  const seven = () => [
    // The role, since #129: a name decides nothing.
    agent('Orchestrator', TARS, { status: 'running', role: 'orchestrator' }),
    agent('Frontend Engineer', TARS, { status: 'running', branchName: 'feat/frontend' }),
    agent('Backend Engineer', TARS, { status: 'waiting', branchName: 'feat/backend' }),
    agent('QA Engineer', TARS, { status: 'completed' }),
    agent('Analyst', CAPITAL, { status: 'error' }),
    agent('Modeller', CAPITAL, { status: 'idle' }),
    agent('Writer', SAKARTVELO, { status: 'running' }),
  ];

  it('gives each project a section, in the order the agents arrive when the tabs were never arranged', () => {
    open(seven());
    expect(sections().map(s => s.heading)).toEqual([
      ['tars', '~/tars', '4 agents'],
      ['1212-Capital', '~/1212-Capital', '2 agents'],
      ['sakartvelo', '~/sakartvelo', '1 agent'],
    ]);
  });

  it('follows the order stored by the Dashboard tabs, for the sections and the picker alike', () => {
    storedOrder = JSON.stringify([SAKARTVELO, TARS, CAPITAL]);
    open(seven());
    expect(sections().map(s => s.path)).toEqual([SAKARTVELO, TARS, CAPITAL]);
    expect(pickerRows().map(r => r[0])).toEqual(['all', SAKARTVELO, TARS, CAPITAL]);
  });

  it('keeps each section\'s cards in the page\'s order: an orchestrator first, then newest first', () => {
    open(seven());
    expect(sections()[0].cards).toEqual(['Orchestrator', 'QA Engineer', 'Backend Engineer', 'Frontend Engineer']);
  });

  it('offers six statuses, asleep between idle and stopped, stopped between them and error, and counts a completed agent under Idle', () => {
    open(seven());
    expect(chips()).toEqual(['All (7)', 'running (3)', 'waiting (1)', 'idle (2)', 'asleep (0)', 'stopped (0)', 'error (1)']);
    (chip('idle').props.onClick as () => void)();
    expect(sections().flatMap(s => s.cards).sort()).toEqual(['Modeller', 'QA Engineer']);
  });

  it('counts a stopped agent under Stopped, not Idle, and shows it alone under its chip', () => {
    open([...seven(), agent('Halted', CAPITAL, { status: 'stopped', stoppedBy: 'Project Lead' })]);
    expect(chips()).toEqual(['All (8)', 'running (3)', 'waiting (1)', 'idle (2)', 'asleep (0)', 'stopped (1)', 'error (1)']);
    (chip('stopped').props.onClick as () => void)();
    expect(sections().flatMap(s => s.cards)).toEqual(['Halted']);
  });

  it('counts an asleep agent under Asleep, not Idle, and shows it alone under its chip', () => {
    open([...seven(), agent('Dozing', CAPITAL, { status: 'asleep', asleepSince: '2026-10-05T12:02:00.000Z' })]);
    expect(chips()).toEqual(['All (8)', 'running (3)', 'waiting (1)', 'idle (2)', 'asleep (1)', 'stopped (0)', 'error (1)']);
    (chip('asleep').props.onClick as () => void)();
    expect(sections().flatMap(s => s.cards)).toEqual(['Dozing']);
  });

  it('counts the chips within the project on screen, so a count is what its chip would show', () => {
    open(seven());
    pick(TARS);
    expect(chips()).toEqual(['All (4)', 'running (2)', 'waiting (1)', 'idle (1)', 'asleep (0)', 'stopped (0)', 'error (0)']);
    expect(sections().map(s => s.path)).toEqual([TARS]);
    (chip('running').props.onClick as () => void)();
    expect(sections()).toEqual([{ path: TARS, heading: ['tars', '~/tars', '2 agents'], cards: ['Orchestrator', 'Frontend Engineer'] }]);
  });

  it('lists every project in the picker with its whole count, whatever the chips say', () => {
    open(seven());
    (chip('error').props.onClick as () => void)();
    expect(pickerRows()).toEqual([
      ['all', 'All projects', '7 agents'],
      [TARS, 'tars', '4 agents'],
      [CAPITAL, '1212-Capital', '2 agents'],
      [SAKARTVELO, 'sakartvelo', '1 agent'],
    ]);
    expect(picker().props.value).toBe('all');
  });

  it('names two projects that share a folder by their paths in the picker', () => {
    const other = '/Users/you/work/tars';
    open([...seven(), agent('Twin', other)]);
    expect(pickerRows().filter(r => r[0] === TARS || r[0] === other).map(r => r[1])).toEqual(['~/tars', '~/work/tars']);
  });

  it('finds an agent by its branch', () => {
    open(seven());
    search('feat/backend');
    expect(sections()).toEqual([{ path: TARS, heading: ['tars', '~/tars', '1 agent'], cards: ['Backend Engineer'] }]);
  });

  it('goes back to every project when the one on screen loses its last agent', () => {
    open(seven());
    pick(SAKARTVELO);
    expect(sections().map(s => s.path)).toEqual([SAKARTVELO]);
    expect(picker().props.value).toBe(SAKARTVELO);

    fleet.agents = fleet.agents.filter(a => a.projectPath !== SAKARTVELO);
    page.rerender();

    expect(picker().props.value).toBe('all');
    expect(sections().map(s => s.path)).toEqual([TARS, CAPITAL]);
    expect(chips()[0]).toBe('All (6)');
    expect(pickerRows().map(r => r[0])).toEqual(['all', TARS, CAPITAL]);
  });

  it('does not bring the old pick back when a new agent later joins that project', () => {
    // Added at the QA gate of #130: the pick was only ignored while its project
    // had no agent, and came back by itself with the project's next agent.
    open(seven());
    pick(SAKARTVELO);
    fleet.agents = fleet.agents.filter(a => a.projectPath !== SAKARTVELO);
    page.rerender();
    expect(picker().props.value).toBe('all');

    fleet.agents = [...fleet.agents, agent('Newcomer', SAKARTVELO)];
    page.rerender();

    expect(picker().props.value).toBe('all');
    expect(sections().map(s => s.path).sort()).toEqual([TARS, CAPITAL, SAKARTVELO].sort());
  });

  it('clears the status, the search and the project together', () => {
    open(seven());
    pick(CAPITAL);
    (chip('running').props.onClick as () => void)();
    search('nobody');
    expect(sections()).toEqual([]);
    const clear = ofType(tree(), 'button').find(b => textOf(b.props.children as never) === 'Clear filters')!;
    (clear.props.onClick as () => void)();

    expect(sections().map(s => s.path)).toEqual([TARS, CAPITAL, SAKARTVELO]);
    expect(picker().props.value).toBe('all');
    expect(chip('All').props.active).toBe(true);
    expect(ofType(tree(), 'input').find(i => i.props.placeholder === 'filter by name or branch')!.props.value).toBe('');
  });
});
