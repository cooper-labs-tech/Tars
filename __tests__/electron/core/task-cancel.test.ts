/**
 * Who may cancel a piece of work another agent holds, decided from the
 * caller's token (ORCHESTRATOR-PER-CHAT.md v2.2, 4.3; the Audit's M1 and R6;
 * PR D of 2.0.0): electron/core/task-cancel.ts, read by
 * POST /api/tasks/:ref/cancel and the MCP tool task_cancel.
 *
 * With several chats sharing the workers, chat B must not cancel what chat A
 * asked for. The project's persistent orchestrator, chat 1's runner and the
 * bots' inbox, may, with a reason, and the chat that asked is told.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. Another chat's runner cancels a task it did not ask for.
 * 2. The task's own requester cannot cancel it.
 * 3. The persistent orchestrator cancels without a reason (R6: the reason is
 *    what the owning chat is told), or cancels another project's task.
 * 4. A chat's runner passes for the persistent orchestrator.
 * 5. A caller with no identity (the shared token) cancels anything.
 * 6. A task already typed into the worker's terminal is "cancelled": Tars can
 *    no longer take it back, so saying it did is a lie.
 * 7. An id that is not a task's, or names none, finds one; or a non-owner
 *    learns whether a task is still queued before being refused.
 */
import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { cancelVerdict, type CancelFleetMember } from '../../../electron/core/task-cancel';

const queuedAt = '2026-10-12T08:00:00.000Z';
const fleet = (state: 'queued' | 'delivered' = 'queued'): CancelFleetMember[] => [
  { id: 'o1', projectPath: '/p', role: 'orchestrator' },
  { id: 'rA', projectPath: '/p', role: 'worker', kind: 'chat' },
  { id: 'rB', projectPath: '/p', role: 'worker', kind: 'chat' },
  { id: 'w1', projectPath: '/p', role: 'worker', taskQueue: [{ ref: 't-0000000a', requesterAgentId: 'rA', queuedAt, state }] },
  { id: 'o2', projectPath: '/q', role: 'orchestrator' },
];

describe('cancelling a queued task', () => {
  it('2. its own requester may', () => {
    expect(cancelVerdict('t-0000000a', 'rA', undefined, fleet())).toMatchObject({ ok: true, workerId: 'w1', by: 'requester' });
  });

  it("1, 4. another chat's runner may not: not_your_task", () => {
    expect(cancelVerdict('t-0000000a', 'rB', 'mine now', fleet())).toMatchObject({ ok: false, error: 'not_your_task' });
  });

  it("3. the project's persistent orchestrator may, with a reason, and only in its project", () => {
    expect(cancelVerdict('t-0000000a', 'o1', undefined, fleet())).toMatchObject({ ok: false, error: 'reason_required' });
    expect(cancelVerdict('t-0000000a', 'o1', '   ', fleet())).toMatchObject({ ok: false, error: 'reason_required' });
    expect(cancelVerdict('t-0000000a', 'o1', 'the release is off', fleet())).toMatchObject({ ok: true, workerId: 'w1', by: 'lead' });
    expect(cancelVerdict('t-0000000a', 'o2', 'not my project', fleet())).toMatchObject({ ok: false, error: 'not_your_task' });
  });

  it('5. a caller with no identity may not', () => {
    expect(cancelVerdict('t-0000000a', undefined, 'why not', fleet())).toMatchObject({ ok: false, error: 'not_your_task' });
  });
});

describe('cancelling what cannot be cancelled', () => {
  it('6. a task already in the worker\'s terminal answers already_delivered, to its owner', () => {
    expect(cancelVerdict('t-0000000a', 'rA', undefined, fleet('delivered'))).toMatchObject({ ok: false, error: 'already_delivered' });
  });

  it('7. an id that names no task answers not_found; a non-owner learns nothing of its state', () => {
    expect(cancelVerdict('t-ffffffff', 'rA', undefined, fleet())).toMatchObject({ ok: false, error: 'not_found' });
    for (const ref of ['', 'T-0000000A', 't-0000000a; rm', 42, undefined]) {
      const verdict = cancelVerdict(ref, 'rA', undefined, fleet());
      expect(verdict).toMatchObject({ ok: false, error: 'not_found' });
      // What a task id looks like, for a caller that sent something else.
      expect(verdict.ok === false && verdict.reason, String(ref)).toMatch(/t- and 8 hex/);
    }
    expect(cancelVerdict('t-0000000a', 'rB', undefined, fleet('delivered'))).toMatchObject({ ok: false, error: 'not_your_task' });
  });

  it('every refusal says why in a sentence', () => {
    const verdict = cancelVerdict('t-0000000a', 'rB', undefined, fleet());
    expect(verdict.ok === false && verdict.reason.length > 20).toBe(true);
  });
});
