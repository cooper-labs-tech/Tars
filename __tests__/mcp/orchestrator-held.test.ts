import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * send_message says when a message is held (start_agent and delegate_task hand a task through run-task since 2.0.4, which follows it in the terminal itself).
 *
 * /dispatch has answered `held: true` with a reason since 1.7.8 when the
 * target's field is in use: something typed and not sent, or a picker the
 * keys cannot follow. The MCP's result type did not declare it, so all three
 * tools answered "Sent message" or "Started", and delegate_task then waited on
 * a turn that had not begun. On 2026-09-22 three agents were held that way
 * until JeanBrasse pressed Ctrl+C in each, while the orchestrator had been told the
 * messages were sent.
 *
 * The real tools, loaded as the server loads them; only the API is replaced.
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

async function tool(name: string) {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  return server.tools.get(name)!;
}

const REASON = 'Somebody is typing in that terminal, has left something in its field, or has a command\'s panel open there.';
const text = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

/** /dispatch as the route answers a message it has queued. */
function dispatchAnswers(answer: Record<string, unknown>) {
  mockApiRequest.mockImplementation(async (endpoint: string) => {
    if (endpoint.includes('/run-task')) throw Object.assign(new Error('no ACP mode'), { status: 409, body: { error: 'no ACP mode', retryWithDispatch: true } });
    if (endpoint.includes('/dispatch')) {
      return { success: true, agent: { id: 'a1', name: 'Tars-QA', status: 'running' }, ...answer };
    }
    if (endpoint.includes('/wait')) return { status: 'completed', lastCleanOutput: 'done' };
    return { agent: { status: 'running', name: 'Tars-QA' } };
  });
}

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('a message the route has held', () => {
  it('is reported as held by send_message, not as sent', async () => {
    dispatchAnswers({ mode: 'message', previousStatus: 'idle', held: true, heldReason: REASON });

    const result = text(await (await tool('send_message'))({ id: 'a1', message: 'Gate #126' }));

    expect(result).toMatch(/^HELD: /);
    expect(result).toContain(REASON);
    expect(result).not.toContain('Sent message');
  });

});

describe('a message the route has typed in', () => {
  it('is still reported as sent by send_message', async () => {
    dispatchAnswers({ mode: 'message', previousStatus: 'waiting' });

    const result = text(await (await tool('send_message'))({ id: 'a1', message: 'Gate #126' }));

    expect(result).toContain('Sent message');
    expect(result).not.toContain('HELD');
  });

});
