import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * send_message, start_agent and delegate_task say when a message is held.
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
    if (endpoint.includes('/run-task')) throw new Error('no ACP mode');
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

  it('is reported as held by start_agent, not as started', async () => {
    dispatchAnswers({ mode: 'message', previousStatus: 'waiting', held: true, heldReason: REASON });

    const result = text(await (await tool('start_agent'))({ id: 'a1', prompt: 'Gate #126' }));

    expect(result).toMatch(/^HELD: /);
    expect(result).not.toMatch(/Sent message|Started agent/);
  });

  it('is reported as held by delegate_task at once, without waiting on a turn that has not begun', async () => {
    dispatchAnswers({ mode: 'message', previousStatus: 'idle', held: true, heldReason: REASON });

    const result = text(await (await tool('delegate_task'))({ id: 'a1', prompt: 'Gate #126', timeoutSeconds: 600 }));

    expect(result).toMatch(/^HELD: /);
    expect(result).toContain('wait_for_agent');
    expect(mockApiRequest.mock.calls.some(call => String(call[0]).includes('/wait')), 'it long-polled a turn that had not begun').toBe(false);
  });
});

describe('the answer delegate_task types when the agent stops at a question', () => {
  it('is reported as held too, not as a task still running', async () => {
    // The gate of #128: the task went in, the agent asked a question, and the
    // "Yes, continue" was held. The tool waited, then answered that the agent
    // was still running.
    let dispatches = 0;
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw new Error('no ACP mode');
      if (endpoint.includes('/dispatch')) {
        dispatches++;
        return dispatches === 1
          ? { success: true, mode: 'message', previousStatus: 'idle', agent: { id: 'a1', name: 'Tars-QA', status: 'running' } }
          : { success: true, mode: 'message', previousStatus: 'waiting', held: true, heldReason: REASON, agent: { id: 'a1', name: 'Tars-QA', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        waits++;
        return waits === 1 ? { status: 'waiting' } : { status: 'running', timeout: true };
      }
      return { agent: { status: 'running', name: 'Tars-QA' } };
    });

    const result = text(await (await tool('delegate_task'))({ id: 'a1', prompt: 'Gate #126', timeoutSeconds: 2 }));

    expect(dispatches).toBe(2);
    expect(waits, 'it waited on a turn the held answer never started').toBe(1);
    expect(result).toMatch(/^HELD: /);
    expect(result).toContain(REASON);
    expect(result).not.toMatch(/still running/);
  });
});

describe('a message the route has typed in', () => {
  it('is still reported as sent by send_message', async () => {
    dispatchAnswers({ mode: 'message', previousStatus: 'waiting' });

    const result = text(await (await tool('send_message'))({ id: 'a1', message: 'Gate #126' }));

    expect(result).toContain('Sent message');
    expect(result).not.toContain('HELD');
  });

  it('still makes delegate_task wait for the result', async () => {
    dispatchAnswers({ mode: 'message', previousStatus: 'waiting' });

    const result = text(await (await tool('delegate_task'))({ id: 'a1', prompt: 'Gate #126', timeoutSeconds: 600 }));

    expect(result).not.toContain('HELD');
    expect(mockApiRequest.mock.calls.some(call => String(call[0]).includes('/wait'))).toBe(true);
  });
});
