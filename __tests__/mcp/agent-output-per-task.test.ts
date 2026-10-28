import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * get_agent_output, per task (2.0.5; the DB brief fix-answer-per-task-2810.md, the orchestrators' feedback of 28/10).
 *
 * How it fails, written before the code:
 * O1 given a task id, it answers the agent's last copy, another task's answer, instead of that task's;
 * O2 without one, it says "No clean output captured yet" once the agent started its next item, while its last task's
 *    answer is kept; or the hooks' 4000 byte copy is given when the whole answer is kept;
 * O3 its answer disagrees with task_status for the same task.
 * The real tool, its calls to Tars answered by a stand-in.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

async function tool(name: string) {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  registerAgentTools({ tool: (n: string, _d: unknown, _s: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => { tools.set(n, handler); } } as never);
  return tools.get(name)!;
}
type Result = { content: { text: string }[]; isError?: boolean };

const REPORT = `Report: PR #658 updated. ${'Detail. '.repeat(700)}\n\nSaving the durable lessons to memory.`;
const TASKS: Record<string, unknown> = {
  't-0000aaaa': { task: { id: 't-0000aaaa', agentId: 'w', outcome: 'completed', result: REPORT } },
  't-0000bbbb': { task: { id: 't-0000bbbb', agentId: 'w', outcome: 'completed', result: 'The second answer.' } },
};

beforeEach(() => {
  vi.resetModules();
  mockApiRequest = vi.fn(async (endpoint: string) => {
    const task = /^\/api\/tasks\/([^/?]+)/.exec(endpoint);
    if (task) return TASKS[task[1]];
    // Working on its next item: the hooks' copy is gone, its last ended task's answer is kept.
    return { agent: { id: 'w', name: 'Worker', status: 'running', lastAnswer: { taskId: 't-0000bbbb', result: 'The second answer.' } } };
  });
});

describe('get_agent_output', () => {
  it('O1, O3: given a task id, that task\'s answer, whole, as task_status has it', async () => {
    const out = await (await tool('get_agent_output'))({ id: 'w', taskId: 't-0000aaaa' }) as Result;
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toContain(REPORT);
    expect(out.content[0].text).toContain('t-0000aaaa');
    expect(out.content[0].text).not.toContain('The second answer.');
  });

  it('O2: without one, its last task\'s answer, not "No clean output captured yet"', async () => {
    const out = await (await tool('get_agent_output'))({ id: 'w' }) as Result;
    expect(out.content[0].text).toContain('The second answer.');
    expect(out.content[0].text).toContain('t-0000bbbb');
    expect(out.content[0].text).not.toMatch(/No clean output/);
  });
});
