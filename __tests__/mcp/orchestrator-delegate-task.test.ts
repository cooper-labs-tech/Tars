import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// delegate_task never hands a task twice, and keeps its caller listening.
// Its auto-continue path ("Yes, continue" typed for a waiting agent) went
// with the terminal fallback in 2.0.4: the task goes into the agent's own
// terminal through run-task, and a question the agent asks is its answer.
// ============================================================================

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

// Minimal fake McpServer that just captures the registered tool handlers,
// the same pattern agent-routes.test.ts uses for RouteApp.
function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  return {
    tools,
    tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.set(name, handler);
    },
  };
}

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('delegate_task after an ACP run that started (sessions that died while they waited, 2026-09-23)', () => {
  // How this fails, written before the code:
  // 1. A run stopped at its limit came back 502, apiRequest threw, and the
  //    fallback typed the same brief into the agent's terminal: the task ran
  //    twice ("the brief reached two sessions", said the agents themselves).
  // 2. The HTTP wait running out while the run was still working did the same.
  // 3. The orchestrator is not told the run was stopped at its limit, nor
  //    which background work was stopped when the agent answered.
  // 4. A run that never started (no ACP mode, a launch that fails) no longer
  //    falls back to the terminal, and the task is not run at all.
  async function loadDelegateTask() {
    const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
    const server = makeFakeServer();
    registerAgentTools(server as never);
    return server.tools.get('delegate_task')!;
  }
  const dispatched = () => mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch')).length;
  type Result = { content: { text: string }[]; isError?: boolean };

  it('reports a run stopped at its limit, with what it had done, and does not send the brief again', async () => {
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) {
        return {
          ok: false, started: true, stopReason: 'turn_limit', text: 'Two of three repos compared.',
          toolCalls: ['until grep -q DONE out; do sleep 10; done'],
          error: "stopped at the run's limit of 3600 s while the agent was still working",
        };
      }
      throw new Error(`unexpected ${endpoint}`);
    });

    const result = await delegateTask({ id: 'a1', prompt: 'compare the repos', timeoutSeconds: 3600 }) as Result;

    expect(dispatched(), 'the brief was typed into the terminal as well').toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Two of three repos compared.');
    expect(result.content[0].text).toContain("stopped at the run's limit of 3600 s");
  });

  it('does not send the brief again after a run that started and said nothing', async () => {
    // The sandbox's own turn-limit run: stopped mid-command before any text.
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) {
        return { ok: false, started: true, stopReason: 'turn_limit', text: '', toolCalls: ['pnpm build'], error: "stopped at the run's limit of 30 s" };
      }
      throw new Error(`unexpected ${endpoint}`);
    });

    const result = await delegateTask({ id: 'a1', prompt: 'build', timeoutSeconds: 30 }) as Result;

    expect(dispatched(), 'the brief was typed into the terminal as well').toBe(0);
    expect(result.content[0].text).toContain('(the agent produced no text)');
  });

  it('does not send the brief again when its own wait runs out while the run works', async () => {
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) {
        const abort = new Error('This operation was aborted');
        abort.name = 'AbortError';
        throw abort;
      }
      throw new Error(`unexpected ${endpoint}`);
    });

    // Asked again with the same id for the grace period, never typed (2.0.4).
    vi.useFakeTimers();
    const pending = delegateTask({ id: 'a1', prompt: 'upgrade', timeoutSeconds: 600 }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const result = await pending;
    vi.useRealTimers();

    expect(dispatched()).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/may still be working/);
  });

});

describe('delegate_task keeps its caller listening while it waits', () => {
  // Claude Code gives up on an MCP call that sends nothing for 30 minutes
  // (measured on 2.1.280 with the limit lowered: "sent no response or progress
  // for 30s; aborting"), and a progress notification resets that clock: the
  // same 150 s call completed when it sent one every 5 s. delegate_task sent
  // none, so every delegation longer than 30 minutes was abandoned by the
  // orchestrator while the agent went on working (Parallel, 2026-09-23: four
  // "sent no response or progress for 18xx s; aborting").
  //
  // How this fails, written before the code:
  // 1. No progress is sent during a long wait, and the caller aborts.
  // 2. Progress is sent without a progressToken, which the protocol forbids.
  // 3. The progress timer outlives the call.
  async function loadWithExtra() {
    const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
    const tools = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
    registerAgentTools({ tool: (name: string, _d: string, _s: unknown, h: typeof tools extends Map<string, infer H> ? H : never) => tools.set(name, h) } as never);
    return tools.get('delegate_task')!;
  }

  it('sends progress while an ACP run works, and stops when it answers', async () => {
    vi.useFakeTimers();
    try {
      const delegateTask = await loadWithExtra();
      let finish: (v: unknown) => void = () => {};
      mockApiRequest.mockImplementation((endpoint: string) => {
        if (endpoint.includes('/run-task')) return new Promise(resolve => { finish = resolve; });
        throw new Error(`unexpected ${endpoint}`);
      });
      const sent: Array<{ method: string; params: { progressToken: unknown } }> = [];
      const extra = { _meta: { progressToken: 7 }, sendNotification: async (n: never) => { sent.push(n); } };

      const call = delegateTask({ id: 'a1', prompt: 'long work', timeoutSeconds: 3600 }, extra);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const during = sent.length;
      finish({ ok: true, started: true, stopReason: 'end_turn', text: 'done', toolCalls: [] });
      await call;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(during, 'no progress in ten minutes of waiting').toBeGreaterThanOrEqual(5);
      expect(sent.every(n => n.method === 'notifications/progress' && n.params.progressToken === 7)).toBe(true);
      expect(sent.length, 'progress kept coming after the answer').toBe(during);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing to a caller that asked for no progress', async () => {
    vi.useFakeTimers();
    try {
      const delegateTask = await loadWithExtra();
      let finish: (v: unknown) => void = () => {};
      mockApiRequest.mockImplementation((endpoint: string) => {
        if (endpoint.includes('/run-task')) return new Promise(resolve => { finish = resolve; });
        throw new Error(`unexpected ${endpoint}`);
      });
      const sent: unknown[] = [];

      const call = delegateTask({ id: 'a1', prompt: 'long work', timeoutSeconds: 600 }, { sendNotification: async (n: unknown) => { sent.push(n); } });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      finish({ ok: true, started: true, text: 'done', toolCalls: [] });
      await call;

      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('wait_for_agent keeps its caller listening while it waits too', () => {
  // The QA's F8 of the 2.0.5 final verification: the shared servers' spec, OPERATIONS and the Audit all took
  // wait_for_agent's keep-alive for granted, and it had none. Only delegate_task sent progress. A wait_for_agent on an
  // agent in a long turn, any timeoutSeconds being accepted, sent nothing until it ended, and Claude Code gives a call
  // silent for 30 minutes up.
  //
  // How this fails, written before the code:
  // 1. No progress is sent while it waits on an agent at work, and the caller aborts past 30 minutes.
  // 2. Progress is sent without a progressToken, which the protocol forbids.
  // 3. The progress timer outlives the call.
  async function loadWait() {
    const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
    const tools = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
    registerAgentTools({ tool: (name: string, _d: string, _s: unknown, h: typeof tools extends Map<string, infer H> ? H : never) => tools.set(name, h) } as never);
    return tools.get('wait_for_agent')!;
  }

  it('1, 2, 3. sends progress while the agent works, with the token, and stops when it answers', async () => {
    vi.useFakeTimers();
    try {
      const waitForAgent = await loadWait();
      let finish: (v: unknown) => void = () => {};
      mockApiRequest.mockImplementation((endpoint: string) => {
        if (endpoint.includes('/wait')) return new Promise(resolve => { finish = resolve; });
        if (endpoint === '/api/agents/b') return Promise.resolve({ agent: { name: 'Harbor Tester' } });
        throw new Error(`unexpected ${endpoint}`);
      });
      const sent: Array<{ method: string; params: { progressToken: unknown } }> = [];
      const extra = { _meta: { progressToken: 'keep' }, sendNotification: async (n: never) => { sent.push(n); } };

      const call = waitForAgent({ id: 'b', timeoutSeconds: 3600 }, extra);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const during = sent.length;
      finish({ status: 'idle', lastCleanOutput: 'done' });
      await call;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(during, 'no progress in five minutes of waiting').toBeGreaterThanOrEqual(4);
      expect(sent.every(n => n.method === 'notifications/progress' && n.params.progressToken === 'keep')).toBe(true);
      expect(sent.length, 'progress kept coming after the answer').toBe(during);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2. sends nothing to a caller that asked for no progress', async () => {
    vi.useFakeTimers();
    try {
      const waitForAgent = await loadWait();
      let finish: (v: unknown) => void = () => {};
      mockApiRequest.mockImplementation((endpoint: string) => {
        if (endpoint.includes('/wait')) return new Promise(resolve => { finish = resolve; });
        if (endpoint === '/api/agents/b') return Promise.resolve({ agent: { name: 'Harbor Tester' } });
        throw new Error(`unexpected ${endpoint}`);
      });
      const sent: unknown[] = [];

      const call = waitForAgent({ id: 'b', timeoutSeconds: 600 }, { sendNotification: async (n: unknown) => { sent.push(n); } });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      finish({ status: 'idle' });
      await call;

      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
