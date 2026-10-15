import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import type { AgentStatus, AgentTickItem } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A stop, read whole. A stopped agent says who stopped it,
 * when and why (`stoppedBy`, `stoppedAt`, `stopReason`, core/agent-stop.ts),
 * which only its full record carries: the status event and the tick name the
 * status alone. The window read the record again only on agent:complete, which
 * comes when a stopped agent's terminal ends, so an agent stopped with no
 * terminal sent none and read "Stopped", by nobody, for no reason. Written
 * before the code. How it can fail:
 *
 * The list the pages read (useElectronAgents), as for an error:
 * 1. a status event saying stopped is patched, not read again: the stop's who,
 *    when and why never reach the page;
 * 2. the same through the tick, its event missed: an agent that has just
 *    entered stopped is patched, not read again;
 * 3. over-correction: an agent that stays stopped is read again on every
 *    tick, where entering stopped is read once.
 *
 * The Kanban sync's failures 4 and 5 (a stop is no task's end) went with the
 * sync itself, when the old local board was removed (JeanBrasse, 06/10).
 */

type Tick = (items: AgentTickItem[]) => void;
type Status = (event: { agentId: string; status: string; timestamp: string }) => void;

const STOP = { stoppedBy: 'Project Lead', stoppedAt: '2026-10-05T18:40:00.000Z', stopReason: 'frozen on a file read for 40 minutes' };

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'running', projectPath: '/p', skills: [], output: [],
    lastActivity: '2026-10-05T18:00:00.000Z', currentTask: 'Build the page', provider: 'claude', cliRunning: true,
    ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus, over: Partial<AgentTickItem> = {}): AgentTickItem {
  return {
    id: a.id, name: a.name ?? a.id, character: 'robot', status: a.status, displayStatus: 'working', statusLine: '',
    currentTask: a.currentTask ?? '', projectName: 'p', lastActivity: a.lastActivity, provider: 'claude',
    cliRunning: a.cliRunning, leftFullscreen: false, launching: false, ...over,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('useElectronAgents reads a stop whole', () => {
  let listed: AgentStatus[];
  let list: ReturnType<typeof vi.fn>;
  let tick: Tick | undefined;
  let status: Status | undefined;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent(), agent({ id: 'a2', name: 'Writer', status: 'idle', cliRunning: false })];
    list = vi.fn(async () => listed);
    const noop = () => () => {};
    g.window = {
      electronAPI: {
        agent: {
          list,
          onOutput: noop, onError: noop, onComplete: noop,
          onStatus: (cb: Status) => { status = cb; return () => { status = undefined; }; },
          onTick: (cb: Tick) => { tick = cb; return () => { tick = undefined; }; },
        },
      },
    };
    hook = mount(() => useElectronAgents());
    await settle();
    expect(hook.result.agents.map(a => a.status)).toEqual(['running', 'idle']);
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('a status event saying stopped reads who stopped it, when and why (1)', async () => {
    // An agent stopped with no terminal: no agent:complete follows.
    listed = [listed[0], agent({ id: 'a2', name: 'Writer', status: 'stopped', cliRunning: false, ...STOP })];
    status!({ agentId: 'a2', status: 'stopped', timestamp: STOP.stoppedAt });
    await settle();
    expect(hook.result.agents[1]).toMatchObject({ status: 'stopped', ...STOP });
  });

  it('so does a tick on which the agent has just entered stopped, its event missed (2)', async () => {
    listed = [agent({ status: 'stopped', currentTask: undefined, cliRunning: false, ...STOP }), listed[1]];
    tick!(listed.map(a => tickItem(a)));
    await settle();
    expect(hook.result.agents[0]).toMatchObject({ status: 'stopped', ...STOP });
  });

  it('once: an agent that stays stopped is not read again on every tick (3)', async () => {
    listed = [agent({ status: 'stopped', currentTask: undefined, cliRunning: false, ...STOP }), listed[1]];
    tick!(listed.map(a => tickItem(a)));
    await settle();
    const reads = list.mock.calls.length;
    tick!(listed.map(a => tickItem(a)));
    tick!(listed.map(a => tickItem(a)));
    await settle();
    expect(list.mock.calls.length).toBe(reads);
  });
});
