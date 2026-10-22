import { describe, it, expect } from 'vitest';
import { createKeepAwake, keepAwakeMode } from '../../../electron/services/keep-awake';
import type { AgentStatus, AppSettings } from '../../../electron/types';

/**
 * Keeping the Mac awake while an agent works (services/keep-awake.ts, 2.0.5): Electron's powerSaveBlocker with
 * 'prevent-app-suspension', the setting keepAwake 'while-working' (the default), 'always' or 'never'.
 *
 * How it fails, written before the code:
 * 1. While working: no blocker while an agent is running, or one per running agent, or one left when none runs.
 * 2. Only `running` is work: an agent waiting, idle, asleep, stopped, completed or in error keeps it awake.
 * 3. 'always' does not block with no agent at work; 'never' blocks while agents run.
 * 4. A missing or unknown setting is not read as 'while-working'.
 * 5. A change of the setting is not applied at the next sync (always to never stops the blocker).
 * 6. The blocker is the display one ('prevent-display-sleep'), which keeps the screen on for nothing.
 * 7. A blocker the system ended on its own (isStarted false) is taken as still running, and never started again.
 * 8. The state the window reads does not say the mode, whether the Mac is kept awake, and since when.
 */

function blocker() {
  let next = 1;
  const live = new Set<number>();
  const calls: string[] = [];
  return {
    calls, live,
    start(type: string) { calls.push(`start:${type}`); const id = next++; live.add(id); return id; },
    stop(id: number) { calls.push(`stop:${id}`); live.delete(id); },
    isStarted(id: number) { return live.has(id); },
  };
}

const agent = (status: AgentStatus['status']) => ({ status }) as AgentStatus;

function setup(mode?: unknown, statuses: AgentStatus['status'][] = []) {
  const b = blocker();
  const s = { keepAwake: mode } as unknown as AppSettings;
  let fleet = statuses.map(agent);
  const k = createKeepAwake({ blocker: b, settings: () => s, agents: () => fleet });
  return { b, k, s, setFleet: (st: AgentStatus['status'][]) => { fleet = st.map(agent); } };
}

describe('keepAwake', () => {
  it('4. reads a missing or unknown setting as while-working', () => {
    expect(keepAwakeMode({} as AppSettings)).toBe('while-working');
    expect(keepAwakeMode({ keepAwake: 'sometimes' } as unknown as AppSettings)).toBe('while-working');
    expect(keepAwakeMode({ keepAwake: 'always' } as AppSettings)).toBe('always');
    expect(keepAwakeMode({ keepAwake: 'never' } as AppSettings)).toBe('never');
  });

  it('1 and 6. while working: one app-suspension blocker while any agent runs, none once none does', () => {
    const { b, k, setFleet } = setup(undefined, ['idle']);
    expect(k.sync().active).toBe(false);
    setFleet(['running', 'running', 'idle']);
    expect(k.sync().active).toBe(true);
    k.sync();
    expect(b.calls).toEqual(['start:prevent-app-suspension']);
    setFleet(['idle', 'idle']);
    expect(k.sync().active).toBe(false);
    expect(b.calls).toEqual(['start:prevent-app-suspension', 'stop:1']);
    expect(b.live.size).toBe(0);
  });

  it('2. only running is work', () => {
    for (const s of ['waiting', 'idle', 'asleep', 'stopped', 'completed', 'error'] as const) {
      const { k } = setup('while-working', [s]);
      expect(k.sync().active, s).toBe(false);
    }
  });

  it('3. always blocks with no agent at work, never blocks with agents running', () => {
    expect(setup('always', []).k.sync().active).toBe(true);
    const never = setup('never', ['running']);
    expect(never.k.sync().active).toBe(false);
    expect(never.b.calls).toEqual([]);
  });

  it('5. a change of the setting applies at the next sync', () => {
    const { b, k, s } = setup('always', []);
    expect(k.sync().active).toBe(true);
    (s as unknown as { keepAwake: string }).keepAwake = 'never';
    expect(k.sync().active).toBe(false);
    expect(b.live.size).toBe(0);
  });

  it('7. a blocker the system ended is started again while it is still wanted', () => {
    const { b, k } = setup('always', []);
    k.sync();
    b.live.clear();
    expect(k.sync().active).toBe(true);
    expect(b.calls).toEqual(['start:prevent-app-suspension', 'start:prevent-app-suspension']);
  });

  it('8. the state says the mode, whether the Mac is kept awake, and since when', () => {
    const { k, setFleet } = setup('while-working', ['idle']);
    expect(k.state()).toEqual({ mode: 'while-working', active: false });
    setFleet(['running']);
    const on = k.sync();
    expect(on).toMatchObject({ mode: 'while-working', active: true });
    expect(Date.parse(on.since!)).not.toBeNaN();
    expect(k.state()).toEqual(on);
  });
});
