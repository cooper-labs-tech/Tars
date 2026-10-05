import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import { panelAgentsKey } from '../../src/components/TerminalsView/utils/panelAgentsKey';
import type { AgentStatus, AgentTickItem, AgentWaking } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * What the pages read of an asleep agent (#322): `asleepSince` and `waking`,
 * on agent:list and on every agents:tick. Written before the code. How it can
 * fail:
 * 1. the tick carries both, and useElectronAgents patched only the status,
 *    the task, the CLI, fullscreen and the launch: an agent put to sleep read
 *    asleep with no time, and one woken never read waking;
 * 2. a list read again where only one of them moved was dropped, since the
 *    comparison names the fields it reads;
 * 3. the Dashboard's panel key leaves them out, so a panel never hears that
 *    its agent fell asleep or started waking.
 */

type Tick = (items: AgentTickItem[]) => void;

const ASLEEP = '2026-10-05T12:02:00.000Z';
const WAKING: AgentWaking = { by: 'Orchestrator', via: 'message', since: '2026-10-05T12:40:00.000Z' };

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'idle', projectPath: '/p', skills: [], output: [],
    lastActivity: '2026-10-05T12:00:00.000Z', currentTask: '', provider: 'claude', cliRunning: true,
    ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus, over: Partial<AgentTickItem> = {}): AgentTickItem {
  return {
    id: a.id, name: a.name ?? a.id, character: 'robot', status: a.status, displayStatus: 'ready', statusLine: '',
    currentTask: a.currentTask ?? '', projectName: 'p', lastActivity: a.lastActivity, provider: 'claude',
    cliRunning: a.cliRunning, leftFullscreen: false, launching: false, ...over,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('useElectronAgents carries asleep and waking', () => {
  let listed: AgentStatus[];
  let tick: Tick | undefined;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent()];
    const noop = () => () => {};
    g.window = {
      electronAPI: {
        agent: {
          list: vi.fn(async () => listed),
          onOutput: noop, onError: noop, onComplete: noop, onStatus: noop,
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

  it('a tick puts an agent to sleep with its time, wakes it with who woke it, and clears both (1)', () => {
    const a = hook.result.agents[0];
    tick!([tickItem(a, { status: 'asleep', displayStatus: 'asleep', cliRunning: false, asleepSince: ASLEEP })]);
    expect(hook.result.agents[0]).toMatchObject({ status: 'asleep', asleepSince: ASLEEP, cliRunning: false });

    tick!([tickItem(a, { status: 'idle', displayStatus: 'waking', cliRunning: true, waking: WAKING })]);
    expect(hook.result.agents[0].status).toBe('idle');
    expect(hook.result.agents[0].asleepSince).toBeUndefined();
    expect(hook.result.agents[0].waking).toEqual(WAKING);

    tick!([tickItem(a, { status: 'idle', displayStatus: 'ready', cliRunning: true })]);
    expect(hook.result.agents[0].waking).toBeUndefined();
  });

  it('a list read again where only asleepSince or waking moved replaces the one it had (2)', async () => {
    listed = [agent({ status: 'asleep', cliRunning: false, asleepSince: ASLEEP })];
    await hook.result.refresh();
    await settle();
    listed = [agent({ status: 'asleep', cliRunning: false, asleepSince: '2026-10-05T13:10:00.000Z' })];
    await hook.result.refresh();
    await settle();
    expect(hook.result.agents[0].asleepSince).toBe('2026-10-05T13:10:00.000Z');

    listed = [agent({ waking: WAKING })];
    await hook.result.refresh();
    await settle();
    listed = [agent({ waking: { ...WAKING, by: 'you', via: 'key' } })];
    await hook.result.refresh();
    await settle();
    expect(hook.result.agents[0].waking).toMatchObject({ by: 'you', via: 'key' });
  });
});

describe("the Dashboard's panel key hears of sleep and waking (3)", () => {
  const changes = (over: Partial<AgentStatus>, base: Partial<AgentStatus> = {}) =>
    panelAgentsKey([agent(base)]) !== panelAgentsKey([agent({ ...base, ...over })]);

  it('changes when an agent falls asleep at another time, starts waking, or is woken another way', () => {
    expect(changes({ asleepSince: '2026-10-05T13:10:00.000Z' }, { status: 'asleep', asleepSince: ASLEEP })).toBe(true);
    expect(changes({ waking: WAKING })).toBe(true);
    expect(changes({ waking: { ...WAKING, by: 'you', via: 'wake' } }, { waking: WAKING })).toBe(true);
    expect(changes({})).toBe(false);
  });
});
