import { describe, it, expect } from 'vitest';

/**
 * Which of mcp-orchestrator's agent tools are marked read-only (readOnlyHint), as the server registers them (2.0.7,
 * QA's gate of #579). Claude Code 2.1.321 runs an MCP call beside the other calls of one message only when its tool is
 * read-only (or its server sets mayOverlap): two waiting delegate_task calls in one message ran their agents one after
 * the other (reports/workflow-runs/parallel).
 *
 * How it fails, written with the marks (shown red on the commit before them, workflow-by-default.md):
 * R1. wait_for_agent or task_status, which only read, is not marked: an orchestrator following several agents waits
 *     on them one at a time.
 * R2. delegate_task, or any tool that changes something, is marked: the mark also tells a CLI it needs no permission.
 */

type Registered = { name: string; annotations?: Record<string, unknown> };

async function registered(): Promise<Registered[]> {
  const seen: Registered[] = [];
  const server = {
    // The SDK's tool(name, description, shape, [annotations,] handler): annotations sit before the handler.
    tool(name: string, _description: unknown, _shape: unknown, ...rest: unknown[]) {
      seen.push({ name, ...(rest.length === 2 ? { annotations: rest[0] as Record<string, unknown> } : {}) });
    },
  };
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  registerAgentTools(server as never);
  return seen;
}

describe('the agent tools Claude Code may run together', () => {
  it('R1. marks wait_for_agent and task_status read-only', async () => {
    const tools = await registered();
    for (const name of ['wait_for_agent', 'task_status']) {
      expect(tools.find(t => t.name === name)?.annotations, name).toEqual({ readOnlyHint: true });
    }
  });

  it('R2. marks no tool that changes anything, delegate_task first', async () => {
    const tools = await registered();
    expect(tools.find(t => t.name === 'delegate_task')).toBeDefined();
    expect(tools.filter(t => t.annotations).map(t => t.name).sort()).toEqual(['task_status', 'wait_for_agent']);
  });
});
