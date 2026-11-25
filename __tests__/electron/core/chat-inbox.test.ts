import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import { inboxAgentOf, setChatLookups } from '../../../electron/core/chat-inbox';
import type { AgentStatus } from '../../../electron/types';

/**
 * Who a note for "the project's orchestrator" goes to (PR F of 2.0.0): the
 * kanban's landing note, the error triage's, a stall nobody asked for.
 *
 * How it fails, written before the code:
 * 1. A project with no chats (the chats not loaded, no orchestrator migrated
 *    yet) sends its notes nowhere, where they went to its orchestrator.
 * 2. (The Audit's L3 on #386) A non-Main chat made the inbox before its first
 *    send has no runner: the notes go into the void, where they reached the
 *    orchestrator before. Until the chat has a runner, Main's orchestrator
 *    takes them.
 * 3. An inbox chat whose runner exists, asleep, is skipped for the
 *    orchestrator: the note belongs to that chat, and waits for it as a note
 *    waits for any agent at rest.
 * 4. Another project's orchestrator, or a chat's runner, is taken for this
 *    project's orchestrator.
 */
const agent = (over: Partial<AgentStatus> & { id: string }) => ({ status: 'idle', skills: [], output: [], lastActivity: '', ...over }) as AgentStatus;
const lead = agent({ id: 'lead', role: 'orchestrator', projectPath: '/work/tars' });
const otherLead = agent({ id: 'other', role: 'orchestrator', projectPath: '/work/other' });
const runner = agent({ id: 'run2', role: 'worker', kind: 'chat', projectPath: '/work/tars', status: 'asleep' });
const fleet = [runner, otherLead, lead];

afterEach(() => setChatLookups(undefined));

describe('the inbox a note goes to', () => {
  it('1, 4. the orchestrator of a project with no chats, its own and no other', () => {
    setChatLookups({ inbox: () => null, chatRunBy: () => undefined });
    expect(inboxAgentOf('/work/tars', fleet)).toBe(lead);
    expect(inboxAgentOf('/work/tars/', fleet)).toBe(lead);
    setChatLookups(undefined);
    expect(inboxAgentOf('/work/tars', fleet)).toBe(lead);
  });

  it('2. the orchestrator while the inbox chat has no runner yet', () => {
    setChatLookups({ inbox: () => ({ agent: undefined }), chatRunBy: () => undefined });
    expect(inboxAgentOf('/work/tars', fleet)).toBe(lead);
  });

  it('3. the inbox chat\'s runner once it has one, asleep or not', () => {
    setChatLookups({ inbox: () => ({ agent: runner }), chatRunBy: () => undefined });
    expect(inboxAgentOf('/work/tars', fleet)).toBe(runner);
  });
});
