import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * How the orchestrator's tools say to follow a task that waits its turn
 * (one task at a time, 2.0.4), after the Audit's L3 on #449: wait_for_agent
 * follows the agent's current turn, which is the other task's, and a task
 * given with start_agent that waited its turn and went in read as starting for
 * ever.
 *
 * How it fails, written before the code (2026-10-18):
 * 1. start_agent's answer for a queued task sends its caller to wait_for_agent,
 *    which follows the task the agent works on now, not this one; or it does
 *    not name the task's id to follow with task_status.
 * 2. delegate_task, its task typed into the terminal and queued there, says
 *    the same.
 * 3. task_status of a task that waited its turn and went into the agent's
 *    terminal says it is still queued, or says nothing of where it went.
 * 4. (the Audit's H-A on 9d9a7ad9) delegate_task's auto-continue, the answer
 *    to the question its own task asked, is sent as a task: it then waits in
 *    the agent's queue behind any task there, which waits for that very turn.
 *    Since 2.0.4 delegate_task sends the task and nothing else: no
 *    auto-continue, no terminal fallback; the task goes into the agent's own
 *    terminal through run-task, and a question it asks is the agent's to put.
 * 5. (the Audit's M1 on #453) A delegated task that left work running in the
 *    background is answered without saying so: its asker believes it done
 *    and cannot tell a server still runs.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

async function tool(name: string) {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  // The handler is the last argument: a read-only tool passes its annotations before it (mcp-shared, #585).
  registerAgentTools({ tool: (n: string, ...rest: unknown[]) => { tools.set(n, rest[rest.length - 1] as (args: Record<string, unknown>) => Promise<unknown>); } } as never);
  return tools.get(name)!;
}

type Result = { content: { text: string }[]; isError?: boolean };

/** run-task's first answer for a task that waits its turn (2.0.4: start_agent and delegate_task both hand it there). */
const QUEUED = {
  ok: true, started: false, queued: true, outcome: 'queued', taskId: 't-0000beef',
  queuedBehind: 'task t-1 from "Lead", since 2026-10-18T01:00:00.000Z', queuedAt: '2026-10-18T01:01:00.000Z',
};

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('a task queued behind another, as the tools say to follow it', () => {
  it('1. start_agent: follow it with task_status by its id, not wait_for_agent', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return QUEUED;
      return { agent: { id: 'a1', name: 'Worker', status: 'running' } };
    });
    const said = ((await (await tool('start_agent'))({ id: 'a1', prompt: 'fix it' })) as Result).content[0].text;
    expect(said).toContain('Task t-0000beef is queued');
    expect(said).toContain('task_status({ taskId: "t-0000beef" })');
    expect(said).not.toMatch(/wait_for_agent follows it/);
  });

  it('2. delegate_task queued, its wait ended first: the same', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return QUEUED;
      if (endpoint.includes('/api/tasks/')) return { timeout: true, task: { id: 't-0000beef', agentId: 'a1', ...QUEUED } };
      return { agent: { id: 'a1', name: 'Worker', status: 'running' } };
    });
    const said = ((await (await tool('delegate_task'))({ id: 'a1', prompt: 'fix it', timeoutSeconds: 1 })) as Result).content[0].text;
    expect(said).toContain('Task t-0000beef is queued');
    expect(said).toContain('task_status({ taskId: "t-0000beef" })');
    expect(said).not.toMatch(/use wait_for_agent to follow it/);
  });

  it('4. delegate_task sends the task and nothing else: no answer to its question, nothing through /dispatch', async () => {
    let asked = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { ok: true, started: false, queued: false, outcome: 'starting', taskId: 't-0000beef' };
      // Its turn: running, the agent asking a question meanwhile, then its end.
      if (endpoint.includes('/api/tasks/')) return (asked++ === 0)
        ? { timeout: true, task: { id: 'task-1', agentId: 'a1', outcome: 'running' } }
        : { task: { id: 'task-1', agentId: 'a1', outcome: 'completed', stopReason: 'end_turn', result: 'done' } };
      return { agent: { id: 'a1', name: 'Worker', status: 'waiting', waitingReason: 'question' } };
    });
    const said = ((await (await tool('delegate_task'))({ id: 'a1', prompt: 'fix it' })) as Result).content[0].text;
    expect(said).toContain('done');
    const sent = mockApiRequest.mock.calls.filter((c) => c[1] === 'POST').map((c) => String(c[0]));
    expect(sent, 'what delegate_task typed or sent').toEqual(['/api/agents/a1/run-task']);
  });

  it('3. task_status of a task that waited its turn and went in: where it went, and how to follow it now', async () => {
    mockApiRequest.mockImplementation(async () => ({
      task: { id: 't-0000beef', agentId: 'a1', outcome: 'delivered', how: 'started', deliveredAt: '2026-10-18T01:05:00.000Z', source: 'terminal' },
    }));
    const said = ((await (await tool('task_status'))({ taskId: 't-0000beef' })) as Result).content[0].text;
    expect(said).toContain('t-0000beef');
    expect(said).toContain('went into its terminal');
    expect(said).toContain('session started on it');
    expect(said).toContain('2026-10-18T01:05:00.000Z');
    expect(said).toContain('wait_for_agent');
    expect(said).not.toMatch(/queued|starts once it is free/);
  });

  it('5. a task that left background work running says which, with its answer', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { ok: true, started: false, queued: false, outcome: 'starting', taskId: 't-0000beef' };
      if (endpoint.includes('/api/tasks/')) return { task: { id: 'task-1', agentId: 'a1', outcome: 'completed', stopReason: 'end_turn', result: 'The server runs on :3000.', backgroundLeft: ['bgserver2'] } };
      return { agent: { id: 'a1', name: 'Worker', status: 'idle' } };
    });
    const said = ((await (await tool('delegate_task'))({ id: 'a1', prompt: 'start the server' })) as Result);
    expect(said.isError).toBeFalsy();
    expect(said.content[0].text).toContain('The server runs on :3000.');
    expect(said.content[0].text).toContain('still running in the background: bgserver2');
  });
});

