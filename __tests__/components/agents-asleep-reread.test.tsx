import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import type { AgentStatus, AgentTickItem } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * An asleep agent's reason reaches the window as main has it (2.0.6, item 1; the Audit's X1 on #557): a wake refused
 * for lack of a terminal leaves the agent asleep with the reason in `error` (core/no-terminal.ts), announced by an
 * agent:status that still says asleep; and a reason main cleared must not come back the next time the agent falls
 * asleep. Neither the status event nor the tick carries `error`: only the full record does.
 *
 * How it can fail, written before the change:
 * 1. an agent:status saying asleep is patched in place, so a refused wake on an agent already asleep shows no reason;
 * 2. a tick that takes an agent into asleep is patched in place, so the copy keeps the reason of an earlier refusal
 *    that main has cleared since, and the card shows it again;
 * 3. the reread happens on every event or tick that says asleep, an agent:list round trip each time for nothing.
 */

type Tick = (items: AgentTickItem[]) => void;
type StatusEvent = { agentId: string; status: string; timestamp?: string };

const SAID = 'No terminal can be opened on this machine: 510 of 511 are in use.';

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Planner', status: 'asleep', projectPath: '/tmp/project', skills: [], output: [],
    lastActivity: '2026-10-29T10:00:00.000Z', provider: 'claude', cliRunning: false, ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus, over: Partial<AgentTickItem> = {}): AgentTickItem {
  return {
    id: a.id, name: a.name ?? a.id, character: 'robot', status: a.status, displayStatus: a.status, statusLine: '',
    currentTask: a.currentTask ?? '', projectName: 'project', lastActivity: a.lastActivity, provider: 'claude', cliRunning: a.cliRunning,
    asleepSince: a.asleepSince, ...over,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('an asleep agent is read again, so its reason is main\'s', () => {
  let listed: AgentStatus[];
  let tick: Tick | undefined;
  let status: ((e: StatusEvent) => void) | undefined;
  let list: ReturnType<typeof vi.fn>;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent({ asleepSince: '2026-10-29T10:00:00.000Z' })];
    const noop = () => () => {};
    list = vi.fn(async () => listed);
    g.window = {
      electronAPI: {
        agent: {
          list, onOutput: noop, onError: noop, onComplete: noop,
          onStatus: (cb: (e: StatusEvent) => void) => { status = cb; return () => { status = undefined; }; },
          onTick: (cb: Tick) => { tick = cb; return () => { tick = undefined; }; },
        },
      },
    };
    hook = mount(() => useElectronAgents());
    await settle();
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('a refused wake, announced as asleep, brings its reason (1)', async () => {
    listed = [agent({ asleepSince: '2026-10-29T10:00:00.000Z', error: SAID })];
    status!({ agentId: 'a1', status: 'asleep', timestamp: '2026-10-29T10:05:00.000Z' });
    await settle();
    expect(hook.result.agents[0].error).toBe(SAID);
  });

  it('falling asleep again reads the record, so a reason main cleared does not come back (2)', async () => {
    // Refused once and read with its reason, then woken: the copy keeps the old reason while the agent runs.
    hook.unmount();
    listed = [agent({ asleepSince: '2026-10-29T10:00:00.000Z', error: SAID })];
    hook = mount(() => useElectronAgents());
    await settle();
    expect(hook.result.agents[0].error).toBe(SAID);
    tick!([tickItem(hook.result.agents[0], { status: 'running' })]);
    expect(hook.result.agents[0].status).toBe('running');
    // Main cleared the reason when a terminal opened; the agent falls asleep again.
    listed = [agent({ asleepSince: '2026-10-29T11:00:00.000Z', error: undefined })];
    tick!([tickItem(listed[0])]);
    await settle();
    expect(hook.result.agents[0]).toMatchObject({ status: 'asleep' });
    expect(hook.result.agents[0].error).toBeUndefined();
  });

  it('a tick where an asleep agent stays asleep reads nothing (3)', async () => {
    const calls = list.mock.calls.length;
    tick!([tickItem(hook.result.agents[0])]);
    await settle();
    expect(list.mock.calls.length).toBe(calls);
  });
});
