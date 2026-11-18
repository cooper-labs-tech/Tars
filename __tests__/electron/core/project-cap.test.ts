import { describe, expect, it } from 'vitest';
import { capVerdict, parseCap, type CapMember } from '../../../electron/core/project-cap';

/**
 * A project's cap on its workers at work at once (core/project-cap.ts, 2.0.7): work handed to a worker beyond it waits
 * in the agent's queue, and goes in when a place frees, the oldest first.
 *
 * How it fails, written before the code:
 * 1. A cap of 0, a negative one, a fraction, a string, or more than 64 is taken; null does not clear it.
 * 2. With no cap, something waits.
 * 3. Below the cap with nothing older waiting, the work waits.
 * 4. At the cap (or over it, a cap lowered under the count at work), the work goes in.
 * 5. The agent's own turn is counted against its own next task: an agent at work ends, and its next task cannot take
 *    the place its turn just gave back.
 * 6. Another project's workers are counted.
 * 7. An orchestrator is counted, or its work waits for the cap (it directs the workers: holding it could hold the very
 *    work it waits on).
 * 8. A place that frees goes to a newer item while an older one of the project's other workers could take it: the
 *    oldest first. An older item that cannot go in anyway (its agent paused, or at work) does not hold the newer one.
 * 9. The reason the window and the asker read does not say the cap and how many are at work.
 */

const worker = (id: string, more: Partial<CapMember> = {}): CapMember => ({ id, projectPath: '/p', role: 'worker', atWork: false, ...more });

describe('parseCap', () => {
  it('1. takes a whole number from 1 to 64, or null to clear', () => {
    for (const bad of [0, -1, 1.5, '4', 65, Number.NaN, undefined, {}]) {
      expect(parseCap(bad), String(bad)).toMatchObject({ ok: false, code: 'invalid_cap' });
    }
    expect(parseCap(4)).toEqual({ ok: true, cap: 4 });
    expect(parseCap(1)).toEqual({ ok: true, cap: 1 });
    expect(parseCap(64)).toEqual({ ok: true, cap: 64 });
    expect(parseCap(null)).toEqual({ ok: true, cap: null });
  });
});

describe('capVerdict', () => {
  const me = worker('me');

  it('2. with no cap, nothing waits', () => {
    expect(capVerdict({ cap: undefined, agent: me, fleet: [me, worker('a', { atWork: true })], queuedAt: Infinity })).toBeUndefined();
  });

  it('3. below the cap with nothing older waiting, it goes in', () => {
    expect(capVerdict({ cap: 2, agent: me, fleet: [me, worker('a', { atWork: true })], queuedAt: Infinity })).toBeUndefined();
  });

  it('4. at the cap, and over a lowered one, it waits', () => {
    const fleet = [me, worker('a', { atWork: true }), worker('b', { atWork: true })];
    expect(capVerdict({ cap: 2, agent: me, fleet, queuedAt: Infinity })).toBeDefined();
    expect(capVerdict({ cap: 1, agent: me, fleet, queuedAt: Infinity })).toBeDefined();
  });

  it("5. the agent's own turn is not counted against its own next task", () => {
    const busyMe = worker('me', { atWork: true });
    expect(capVerdict({ cap: 1, agent: busyMe, fleet: [busyMe], queuedAt: 5 })).toBeUndefined();
  });

  it("6. another project's workers are not counted", () => {
    const fleet = [me, worker('x', { projectPath: '/other', atWork: true }), worker('y', { projectPath: '/other', atWork: true })];
    expect(capVerdict({ cap: 1, agent: me, fleet, queuedAt: Infinity })).toBeUndefined();
  });

  it('7. an orchestrator is neither counted nor held', () => {
    const orch = worker('o', { role: 'orchestrator', atWork: true });
    expect(capVerdict({ cap: 1, agent: me, fleet: [me, orch], queuedAt: Infinity })).toBeUndefined();
    const fleet = [orch, worker('a', { atWork: true })];
    expect(capVerdict({ cap: 1, agent: orch, fleet, queuedAt: Infinity })).toBeUndefined();
    // A chat's runner is no project orchestrator: it counts like any agent of the project.
    const runner = worker('r', { role: 'orchestrator', kind: 'chat', atWork: true });
    expect(capVerdict({ cap: 1, agent: me, fleet: [me, runner], queuedAt: Infinity })).toBeDefined();
  });

  it('8. a place that frees goes to the oldest item that could go in', () => {
    const older = worker('a', { waitingSince: 10 });
    const fleet = [me, older, worker('b', { atWork: true })];
    // One place free (2 - 1), and an older item could take it: mine waits.
    expect(capVerdict({ cap: 2, agent: me, fleet, queuedAt: 20 })).toBeDefined();
    // The older one is the oldest: it goes.
    expect(capVerdict({ cap: 2, agent: older, fleet, queuedAt: 10 })).toBeUndefined();
    // Two places free, one older item: mine goes as well.
    expect(capVerdict({ cap: 3, agent: me, fleet, queuedAt: 20 })).toBeUndefined();
    // An older item that cannot go in (paused, so no waitingSince) does not hold mine.
    const paused = worker('a');
    expect(capVerdict({ cap: 2, agent: me, fleet: [me, paused, worker('b', { atWork: true })], queuedAt: 20 })).toBeUndefined();
  });

  it('9. the reason says the cap and how many are at work', () => {
    const fleet = [me, worker('a', { atWork: true }), worker('b', { atWork: true })];
    expect(capVerdict({ cap: 2, agent: me, fleet, queuedAt: Infinity })).toBe("its project's cap: 2 of 2 agents at work");
    const older = worker('c', { waitingSince: 1 });
    expect(capVerdict({ cap: 3, agent: me, fleet: [...fleet, older], queuedAt: 9 }))
      .toBe("its project's cap: 2 of 3 agents at work, and 1 task of the project waiting longer goes first");
  });
});
