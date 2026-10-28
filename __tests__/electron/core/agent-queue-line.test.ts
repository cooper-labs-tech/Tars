import { describe, it, expect } from 'vitest';
import { createOneTaskQueue, type QueueSnapshot } from '../../../electron/core/one-task';

/**
 * An agent's queue you can see, pause, reorder and keep (2.0.5, lot 2, item I of the resources plan; the DB brief
 * lot2-agent-queue-2810.md): the line of electron/core/one-task.ts, which holds every task and message waiting for
 * the agent's rest.
 *
 * What the projects' orchestrators hit on 27 and 28/10 (their tars-feedback-2810.md): six queued items to Kotsna-QA
 * that could be neither seen, cancelled nor moved; a "priority insert" landing behind items queued earlier; a stop
 * that emptied the queue; tasks lost at every restart of Tars, with no list of what was lost; task_status answering
 * "No such task" for a task Tars had announced.
 *
 * How the line fails, written before the code:
 * Q1 an item queued under the id its sender line names (a request's t-xxxxxxxx) gets another, so task_status and
 *    task_cancel by that id find nothing; or one id is queued twice;
 * Q2 a paused queue lets its head take the agent's turn; or pausing touches the turn in progress; or a resumed one
 *    does not let it go;
 * Q3 an item cannot be moved to the head, or before another; or a move reaches an item of another agent, or one that
 *    is not there, and says it did;
 * Q4 the line, each item's how, sender and what replays it, and which queues are paused, do not survive a snapshot
 *    and a restore (a restart of Tars); or a restore queues again an id the line already holds;
 * Q5 a change of the line (queued, taken, cancelled, moved, paused, resumed) is not told, so it is not saved;
 * Q6 a request typed straight into the agent's terminal is unknown to task_status: "No such task" for an id Tars
 *    announced (Kotsna, t-9aa78b94, 27/10);
 * Q7 the line is read out of order, or without who sent each item, since when and how it goes in.
 */

const AGENT = 'w';

describe('the line of an agent', () => {
  it('Q1: an item keeps the id its sender line names, and an id is queued once', () => {
    const q = createOneTaskQueue(0);
    const a = q.enqueue(AGENT, { title: 'review #81', requesterId: 'lead', how: 'message' }, 1, 't-0000000a');
    expect(a.ref).toBe('t-0000000a');
    expect(() => q.enqueue(AGENT, { title: 'again' }, 2, 't-0000000a')).toThrow(/already/);
    expect(q.queued(AGENT).map((t) => t.ref)).toEqual(['t-0000000a']);
    expect(q.lookup('t-0000000a')?.state).toBe('queued');
  });

  it('Q2: paused, its head waits; the turn in progress is untouched; resumed, it goes', () => {
    const q = createOneTaskQueue(0);
    q.runStarted(AGENT, { since: 1, taskRef: 't-00000001' });
    const next = q.enqueue(AGENT, { title: 'next' }, 2);
    q.pause(AGENT, 'by the owner', 3);
    expect(q.pausedOf(AGENT)).toEqual({ since: 3, why: 'by the owner' });
    // The run in hand is not touched.
    expect(q.busyRun(AGENT)?.taskRef).toBe('t-00000001');
    q.runEnded(AGENT);
    expect(q.takeTurn(AGENT, next.ref, undefined)).toBe(false);
    expect(q.mustQueue(AGENT, undefined)).toBe(true);
    q.resume(AGENT);
    expect(q.pausedOf(AGENT)).toBeUndefined();
    expect(q.takeTurn(AGENT, next.ref, undefined)).toBe(true);
  });

  it('Q2: a paused queue with nothing in it is still paused for what comes', () => {
    const q = createOneTaskQueue(0);
    q.pause(AGENT, 'stopped', 1);
    expect(q.mustQueue(AGENT, undefined)).toBe(true);
    const t = q.enqueue(AGENT, { title: 'later' }, 2);
    expect(q.takeTurn(AGENT, t.ref, undefined)).toBe(false);
  });

  it('Q3: moves an item to the head, or before another; refuses one not there or of another agent', () => {
    const q = createOneTaskQueue(0);
    const [a, b, c] = ['a', 'b', 'c'].map((x, i) => q.enqueue(AGENT, { title: x }, i));
    const other = q.enqueue('x', { title: 'other' }, 9);
    expect(q.move(c.ref)).toBe(true);
    expect(q.queued(AGENT).map((t) => t.title)).toEqual(['c', 'a', 'b']);
    expect(q.move(b.ref, a.ref)).toBe(true);
    expect(q.queued(AGENT).map((t) => t.title)).toEqual(['c', 'b', 'a']);
    expect(q.move(a.ref, other.ref)).toBe(false);
    expect(q.move('t-ffffffff')).toBe(false);
    expect(q.move(a.ref, 't-ffffffff')).toBe(false);
    expect(q.move(a.ref, a.ref)).toBe(false);
    expect(q.queued(AGENT).map((t) => t.title)).toEqual(['c', 'b', 'a']);
    expect(q.queued('x').map((t) => t.ref)).toEqual([other.ref]);
  });

  it('Q4: the line, each item and the pauses survive a snapshot and a restore; a known id is not queued again', () => {
    const q = createOneTaskQueue(0);
    q.enqueue(AGENT, { title: 'task one', requesterId: 'lead', how: 'task', from: 'Project Lead', replay: { kind: 'run-task', task: 'task one' } }, 10, 't-00000010');
    q.enqueue(AGENT, { title: 'msg two', requesterId: 'lead', how: 'message', from: 'Project Lead', replay: { kind: 'dispatch', message: 'msg two' } }, 20, 't-00000020');
    q.pause(AGENT, 'stopped', 30);
    const snap: QueueSnapshot = JSON.parse(JSON.stringify(q.snapshot()));

    const after = createOneTaskQueue(100);
    after.enqueue(AGENT, { title: 'already here' }, 50, 't-00000020');
    const restored = after.restore(snap);
    expect(restored.map((t) => t.ref)).toEqual(['t-00000010']);
    expect(after.queued(AGENT).map((t) => [t.ref, t.how, t.from, t.requesterId, t.queuedAt])).toEqual([
      ['t-00000020', undefined, undefined, undefined, 50],
      ['t-00000010', 'task', 'Project Lead', 'lead', 10],
    ]);
    expect(after.queued(AGENT)[1].replay).toEqual({ kind: 'run-task', task: 'task one' });
    expect(after.pausedOf(AGENT)).toEqual({ since: 30, why: 'stopped' });
  });

  it('Q5: every change of the line is told', () => {
    const q = createOneTaskQueue(0);
    const told: string[] = [];
    q.onChange(() => told.push('x'));
    const a = q.enqueue(AGENT, { title: 'a' }, 1);
    const b = q.enqueue(AGENT, { title: 'b' }, 2);
    q.move(b.ref);
    q.pause(AGENT, 'by the owner');
    q.resume(AGENT);
    q.cancel(a.ref);
    q.takeTurn(AGENT, b.ref, undefined);
    expect(told.length).toBe(7);
  });

  it('Q6: a request typed straight into the terminal is known to task_status as delivered', () => {
    const q = createOneTaskQueue(0);
    q.noteDelivered({ ref: 't-0000abcd', agentId: AGENT, requesterId: 'lead', title: 'go', queuedAt: 5 }, 'typed', 6);
    expect(q.lookup('t-0000abcd')).toMatchObject({ state: 'delivered', how: 'typed', at: 6, task: { requesterId: 'lead', agentId: AGENT } });
  });

  it('Q7: the line reads in order, with who sent each item, since when and how it goes in', () => {
    const q = createOneTaskQueue(0);
    q.enqueue(AGENT, { title: 'first', requesterId: 'lead', from: 'Project Lead', how: 'task' }, 1);
    q.enqueue(AGENT, { title: 'second', requesterId: 'other', from: 'Other Worker', how: 'message' }, 2);
    expect(q.queued(AGENT).map((t) => ({ title: t.title, from: t.from, how: t.how, queuedAt: t.queuedAt }))).toEqual([
      { title: 'first', from: 'Project Lead', how: 'task', queuedAt: 1 },
      { title: 'second', from: 'Other Worker', how: 'message', queuedAt: 2 },
    ]);
  });
});
