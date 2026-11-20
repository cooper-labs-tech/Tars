import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * task_cancel, the orchestrator MCP's way to take back work asked of another
 * agent before it went in (POST /api/tasks/:ref/cancel; core/task-cancel.ts;
 * PR D of 2.0.0). Written with its code, and shown to bite by mutants.
 *
 * How it fails:
 * 1. The id or the reason does not reach the route, or the reason is sent
 *    empty when none was given (the route then reads "a reason" where there
 *    is none).
 * 2. A refusal reaches the agent as a bare code ("not_your_task") or as a
 *    tool failure, instead of a sentence saying why and what it may do.
 * 3. A failure the route did not decide (Tars down) is passed off as a refusal.
 *
 * The real tool, loaded as the server loads it; only the API is replaced.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  return {
    tools,
    tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.set(name, handler);
    },
  };
}

async function taskCancel() {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  return server.tools.get('task_cancel')!;
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('task_cancel', () => {
  it('1. sends the id in the path and the reason only when there is one', async () => {
    mockApiRequest.mockResolvedValue({ success: true, cancelled: 't-0000000a', worker: { id: 'w1', name: 'Worker' } });
    const run = await taskCancel();
    expect(textOf(await run({ taskId: 't-0000000a', reason: 'the docs moved' }))).toContain("never went into Worker's terminal");
    expect(mockApiRequest).toHaveBeenLastCalledWith('/api/tasks/t-0000000a/cancel', 'POST', { reason: 'the docs moved' });
    await run({ taskId: 't-0000000a' });
    expect(mockApiRequest).toHaveBeenLastCalledWith('/api/tasks/t-0000000a/cancel', 'POST', {});
  });

  it('2. answers each refusal with why, as a problem the agent reads', async () => {
    const run = await taskCancel();
    for (const [code, words] of [
      ['not_your_task', 'another chat asked for it'],
      ['reason_required', 'needs a reason'],
      ['already_delivered', 'stop the agent to end it'],
      ['not_found', 'no agent holds a task with that id'],
    ] as const) {
      mockApiRequest.mockRejectedValueOnce(new Error(code));
      const answer = await run({ taskId: 't-0000000a' });
      expect(isError(answer), code).toBe(true);
      expect(textOf(answer), code).toContain(words);
      expect(textOf(answer), code).not.toBe(code);
    }
  });

  it('3. lets a failure the route did not decide be a failure', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('Tars did not answer at http://127.0.0.1:31415'));
    const run = await taskCancel();
    const answer = await run({ taskId: 't-0000000a' });
    expect(textOf(answer)).toContain('Tars did not answer');
  });
});
