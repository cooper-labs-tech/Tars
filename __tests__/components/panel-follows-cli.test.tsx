import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, ofType, textOf, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import TerminalPanelHeader from '../../src/components/TerminalsView/components/TerminalPanelHeader';
import ContextMenu from '../../src/components/TerminalsView/components/ContextMenu';
import type { AgentStatus, AgentTickItem } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Dashboard pane offers stop while a CLI runs in its terminal (1.7.4).
 *
 * A failed turn leaves claude at its prompt in error, and an agent at rest or
 * done keeps its session, so a pane that read the status offered start, and a
 * click typed `cd '...' && claude ...` into the running claude. The main
 * process now says whether a CLI runs (`cliRunning`, on agent:list and every
 * agents:tick), and three things carry it to the button: the list comparison
 * and the tick patch in useElectronAgents, then the header's ··· menu (since
 * 2.0.5, #515: no longer a button of the header) and the context menu.
 * The status never moves when claude exits or starts at its prompt, so each
 * link is asserted with cliRunning as the only field that changes.
 */

type Tick = (items: AgentTickItem[]) => void;

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1',
    name: 'Planner',
    status: 'idle',
    projectPath: '/tmp/project',
    skills: [],
    output: [],
    lastActivity: '2026-09-17T10:00:00.000Z',
    currentTask: 'Plan the lot',
    provider: 'claude',
    cliRunning: false,
    ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus, over: Partial<AgentTickItem> = {}): AgentTickItem {
  return {
    id: a.id,
    name: a.name ?? a.id,
    character: 'robot',
    status: a.status,
    displayStatus: 'idle',
    statusLine: '',
    currentTask: a.currentTask ?? '',
    projectName: 'project',
    lastActivity: a.lastActivity,
    provider: 'claude',
    cliRunning: a.cliRunning,
    ...over,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('useElectronAgents carries cliRunning to the panes', () => {
  let listed: AgentStatus[];
  let tick: Tick | undefined;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent(), agent({ id: 'a2', name: 'Reviewer' })];
    tick = undefined;
    const noop = () => () => {};
    g.window = {
      electronAPI: {
        agent: {
          list: vi.fn(async () => listed),
          onOutput: noop,
          onError: noop,
          onComplete: noop,
          onStatus: noop,
          onTick: (cb: Tick) => { tick = cb; return () => { tick = undefined; }; },
        },
      },
    };
    hook = mount(() => useElectronAgents());
    await settle();
    expect(hook.result.agents.map(a => a.cliRunning)).toEqual([false, false]);
    expect(tick, 'the hook subscribes to agents:tick').toBeTypeOf('function');
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('a tick where only cliRunning changes updates that agent, and back again after /exit', () => {
    const [a1, a2] = hook.result.agents;
    tick!([tickItem(a1, { cliRunning: true }), tickItem(a2)]);
    expect(hook.result.agents[0]).toMatchObject({ id: 'a1', status: 'idle', currentTask: 'Plan the lot', cliRunning: true });
    expect(hook.result.agents[1].cliRunning).toBe(false);

    tick!([tickItem(a1, { cliRunning: false }), tickItem(a2)]);
    expect(hook.result.agents[0]).toMatchObject({ id: 'a1', status: 'idle', cliRunning: false });
  });

  it('a claude left at its prompt by a failed turn reads as running in error', async () => {
    // Entering error refetches the full record, which is where the reason is.
    listed = [agent({ status: 'error', error: 'API Error: 403', cliRunning: true }), listed[1]];
    tick!([tickItem(listed[0]), tickItem(listed[1])]);
    await settle();
    expect(hook.result.agents[0]).toMatchObject({ status: 'error', cliRunning: true });
  });

  it('a tick that changes nothing renders nothing, so the check above is not a render on every tick', () => {
    const before = hook.result.agents;
    const renders = hook.renders;
    tick!(before.map(a => tickItem(a)));
    expect(hook.result.agents).toBe(before);
    expect(hook.renders).toBe(renders);
  });

  it('agent:list where only cliRunning changes replaces the list', async () => {
    const before = hook.result.agents;
    listed = [agent({ cliRunning: true }), agent({ id: 'a2', name: 'Reviewer' })];
    await hook.result.refresh();
    await settle();
    expect(hook.result.agents).toBe(listed);
    expect(hook.result.agents[0].cliRunning).toBe(true);
    expect(before[0].cliRunning).toBe(false);
  });

  it('agent:list where only the role changes replaces the list, so a demoted orchestrator shows at once', async () => {
    // Added at the QA gate of #129: another agent's save can take this one's
    // role, and a role change moves nothing else on the record.
    listed = [agent({ role: 'orchestrator' }), agent({ id: 'a2', name: 'Reviewer', role: 'worker' })];
    await hook.result.refresh();
    await settle();
    listed = [agent({ role: 'worker' }), agent({ id: 'a2', name: 'Reviewer', role: 'orchestrator' })];
    await hook.result.refresh();
    await settle();
    expect(hook.result.agents).toBe(listed);
    expect(hook.result.agents.map(x => x.role)).toEqual(['worker', 'orchestrator']);
  });

  it('agent:list where nothing changes keeps the list it has', async () => {
    const before = hook.result.agents;
    listed = [agent(), agent({ id: 'a2', name: 'Reviewer' })];
    await hook.result.refresh();
    await settle();
    expect(hook.result.agents).toBe(before);
  });
});

// Since 2.0.5 (#515) start and stop are no longer a button of the header but the first item of its ··· menu
// ("Panel actions"), so the menu is opened as a user opens it and the one item read there. What is pinned is
// unchanged: one control, following cliRunning, never the status; and none left in the header itself.
describe('the pane header menu\'s start or stop follows the terminal, not the status', () => {
  const onStart = vi.fn();
  const onStop = vi.fn();
  const noop = () => {};
  const action = /^(start|stop|wake)\b/;
  // An open menu listens on the window for a click outside it and for Escape.
  beforeEach(() => { g.window = { addEventListener: noop, removeEventListener: noop }; });
  afterEach(() => { delete g.window; });

  function item(a: AgentStatus) {
    onStart.mockClear();
    onStop.mockClear();
    const header = mount(() => TerminalPanelHeader({
      agent: a,
      isFullscreen: false,
      isBroadcasting: false,
      tabType: 'project',
      onStart,
      onStop,
      onWake: noop,
      onFullscreen: noop,
      onExitFullscreen: noop,
      onClear: noop,
      onRemove: noop,
      onContextMenu: noop,
    }));
    const buttons = () => ofType(header.result, 'button');
    expect(buttons().filter(b => action.test(textOf(b.props.children as never))), 'no start, stop or wake in the header').toHaveLength(0);
    const menu = buttons().find(b => b.props['aria-label'] === 'Panel actions');
    expect(menu, 'the panel actions menu').toBeDefined();
    (menu!.props.onClick as () => void)();
    const found = buttons().filter(b => action.test(textOf(b.props.children as never)));
    expect(found, 'exactly one start/stop item in the menu').toHaveLength(1);
    const b = { text: textOf(found[0].props.children as never), title: found[0].props.title };
    (found[0].props.onClick as () => void)();
    header.unmount();
    return b;
  }

  for (const status of ['idle', 'completed', 'error', 'waiting', 'running'] as const) {
    it(`offers stop while a CLI runs, in ${status}`, () => {
      const b = item(agent({ status, cliRunning: true, error: status === 'error' ? 'API Error: 403' : undefined }));
      expect(b.text).toBe('stop');
      expect(b.title).toBe('Stop this agent');
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
    });

    it(`offers start once only the shell is left, in ${status}`, () => {
      const b = item(agent({ status, cliRunning: false }));
      expect(b.text).toBe('start claude');
      expect(b.title).toBe('Start claude in this terminal');
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onStop).not.toHaveBeenCalled();
    });
  }

  // agent-stopped.test.tsx's 6, in the menu since #515: a stopped agent has nothing left to stop, and a second
  // stop from the window would file the stop under you and replace who and why.
  it('offers start to a stopped agent, never a second stop', () => {
    const b = item(agent({ status: 'stopped', cliRunning: false }));
    expect(b.text).toBe('start claude');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('the pane context menu follows the terminal, not the status', () => {
  beforeEach(() => { g.window = { innerWidth: 1440, innerHeight: 900 }; });
  afterEach(() => { delete g.window; });

  function firstItem(a: AgentStatus) {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onClose = vi.fn();
    const tree = ContextMenu({
      state: { open: true, agentId: a.id, x: 20, y: 20 },
      agent: a,
      onClose,
      onStart,
      onStop,
      onClear: vi.fn(),
      onFullscreen: vi.fn(),
      onCopyOutput: vi.fn(),
    });
    const item = ofType(tree, 'button').find(b => /(Start|Stop) Agent/.test(textOf(b.props.children as never)));
    expect(item, 'the start/stop item').toBeDefined();
    (item!.props.onClick as () => void)();
    return { label: textOf(item!.props.children as never), onStart, onStop, onClose };
  }

  for (const status of ['idle', 'completed', 'error', 'waiting', 'running'] as const) {
    it(`says Stop Agent and stops while a CLI runs, in ${status}`, () => {
      const m = firstItem(agent({ status, cliRunning: true }));
      expect(m.label).toBe('Stop Agent');
      expect(m.onStop).toHaveBeenCalledWith('a1');
      expect(m.onStart).not.toHaveBeenCalled();
      expect(m.onClose).toHaveBeenCalled();
    });

    it(`says Start Agent and starts once only the shell is left, in ${status}`, () => {
      const m = firstItem(agent({ status, cliRunning: false }));
      expect(m.label).toBe('Start Agent');
      expect(m.onStart).toHaveBeenCalledWith('a1');
      expect(m.onStop).not.toHaveBeenCalled();
    });
  }
});
