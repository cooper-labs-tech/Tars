/**
 * Who a worker's message reaches when it names its orchestrator rather than an
 * id (ORCHESTRATOR-PER-CHAT.md v2.2, 4.3 "Replies"; the Audit's R5 on v2; PR D
 * of 2.0.0): electron/core/reply-target.ts, read by /dispatch and /message.
 *
 * With several chats, the agent that asked a worker for its current task may
 * be a chat's runner, not the project's orchestrator. A worker that answers
 * "the orchestrator", by the role word or by its name, means whoever asked it;
 * one that answers by an id means that id.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. An explicit agent id is rerouted: a worker writing to the persistent
 *    orchestrator about something else reaches a chat instead (R5).
 * 2. "requester", "orchestrator" or the orchestrator's name reach the
 *    persistent orchestrator while a chat's runner asked for the current task,
 *    so chat A's result lands in Main.
 * 3. "orchestrator" reaches a plain worker that asked (a worker is not an
 *    orchestrator), instead of the project's orchestrator.
 * 4. A worker with no current task, writing to "requester", reaches nobody,
 *    instead of the project's orchestrator.
 * 5. The words resolve without a caller (the shared token), or to another
 *    project's orchestrator, or a chat's runner is taken for the project's
 *    orchestrator.
 * 6. A word that is none of these reaches anyone.
 */
import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { replyTargetOf, type ReplyAgent } from '../../../electron/core/reply-target';

const fleetOf = (...agents: ReplyAgent[]) => new Map(agents.map((a) => [a.id, a]));
const lead: ReplyAgent = { id: 'o1', name: 'Tars-Orchestrator', projectPath: '/p', role: 'orchestrator' };
const runner: ReplyAgent = { id: 'r1', name: 'Tars-Orchestrator · Release', projectPath: '/p', role: 'worker', kind: 'chat' };
const otherLead: ReplyAgent = { id: 'o2', name: 'Other-Orchestrator', projectPath: '/q', role: 'orchestrator' };
const peer: ReplyAgent = { id: 'w2', name: 'QA', projectPath: '/p', role: 'worker' };
const worker = (requestedBy?: string): ReplyAgent => ({ id: 'w1', name: 'Backend', projectPath: '/p', role: 'worker', ...(requestedBy ? { requestedBy: { agentId: requestedBy } } : {}) });

describe('a reply by id', () => {
  it('1. reaches that id, whoever asked for the current task', () => {
    const fleet = fleetOf(lead, runner, worker('r1'));
    expect(replyTargetOf('o1', 'w1', fleet)).toEqual({ agentId: 'o1', how: 'id' });
    expect(replyTargetOf('r1', 'w1', fleet)).toEqual({ agentId: 'r1', how: 'id' });
  });
});

describe("a reply to the orchestrator's role or name", () => {
  it("2. reaches the chat's runner that asked for the current task", () => {
    const fleet = fleetOf(lead, runner, worker('r1'));
    for (const word of ['requester', 'orchestrator', 'Orchestrator', 'Tars-Orchestrator', ' tars-orchestrator ']) {
      expect(replyTargetOf(word, 'w1', fleet), word).toEqual({ agentId: 'r1', how: 'requester' });
    }
  });

  it('2. reaches the persistent orchestrator when it is the one that asked', () => {
    const fleet = fleetOf(lead, runner, worker('o1'));
    expect(replyTargetOf('orchestrator', 'w1', fleet)).toEqual({ agentId: 'o1', how: 'requester' });
  });

  it('3. "orchestrator" never reaches a plain worker that asked; "requester" does', () => {
    const fleet = fleetOf(lead, peer, worker('w2'));
    expect(replyTargetOf('orchestrator', 'w1', fleet)).toEqual({ agentId: 'o1', how: 'orchestrator' });
    expect(replyTargetOf('requester', 'w1', fleet)).toEqual({ agentId: 'w2', how: 'requester' });
  });

  it("4. with no current task, reaches the project's orchestrator", () => {
    const fleet = fleetOf(lead, runner, worker());
    expect(replyTargetOf('requester', 'w1', fleet)).toEqual({ agentId: 'o1', how: 'orchestrator' });
    expect(replyTargetOf('orchestrator', 'w1', fleet)).toEqual({ agentId: 'o1', how: 'orchestrator' });
  });

  it("5. needs a caller, stays in the caller's project, and never takes a runner for the orchestrator", () => {
    expect(replyTargetOf('orchestrator', undefined, fleetOf(lead, worker('r1')))).toBeNull();
    // Another project's orchestrator is not this one's, by role or by name.
    expect(replyTargetOf('orchestrator', 'w1', fleetOf(otherLead, worker()))).toBeNull();
    expect(replyTargetOf('Other-Orchestrator', 'w1', fleetOf(otherLead, lead, worker()))).toBeNull();
    // A runner alone in the project is no orchestrator of it.
    expect(replyTargetOf('orchestrator', 'w1', fleetOf(runner, worker()))).toBeNull();
    // A link to an agent of another project is not followed.
    expect(replyTargetOf('requester', 'w1', fleetOf(lead, { ...otherLead, kind: 'chat', role: 'worker' }, worker('o2')))).toEqual({ agentId: 'o1', how: 'orchestrator' });
  });

  it('6. any other word reaches nobody', () => {
    expect(replyTargetOf('somebody', 'w1', fleetOf(lead, worker('r1')))).toBeNull();
    expect(replyTargetOf('', 'w1', fleetOf(lead, worker('r1')))).toBeNull();
  });
});
