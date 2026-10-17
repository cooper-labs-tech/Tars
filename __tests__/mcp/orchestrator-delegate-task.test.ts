import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// delegate_task's auto-continue path: when the target agent hits a
// non-permission "waiting" state (Claude Code asking "should I continue?"),
// delegate_task answers "Yes, continue" on the caller's behalf so the
// orchestrator does not have to notice and nudge it itself.
//
// Bug: the retry loop was capped at exactly one attempt. An agent that asks
// a second (or third) confirmation question mid-task made delegate_task give
// up and report "still waiting", pushing the retry back onto the calling
// orchestrator - which is precisely the "have to ask 15 times" complaint.
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

describe('delegate_task auto-continue', () => {
  async function loadDelegateTask() {
    const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
    const server = makeFakeServer();
    registerAgentTools(server as never);
    return server.tools.get('delegate_task')!;
  }

  it('keeps auto-continuing through repeated confirmation prompts until the agent completes', async () => {
    const delegateTask = await loadDelegateTask();

    mockApiRequest.mockImplementation(async (endpoint: string, method?: string) => {
      // No ACP mode for this agent: falls straight to the /dispatch path.
      if (endpoint.includes('/run-task')) throw Object.assign(new Error('no ACP mode'), { status: 409, body: { error: 'no ACP mode', retryWithDispatch: true } });
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        // Asks for confirmation THREE times in a row before actually
        // finishing - a realistic Claude Code session mid multi-step task.
        const calls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/wait')).length;
        if (calls <= 3) return { status: 'waiting', waitingReason: 'idle' };
        return { status: 'completed', lastCleanOutput: 'all done' };
      }
      if (!method || method === 'GET') {
        return { agent: { status: 'completed', name: 'Worker', lastCleanOutput: 'all done' } };
      }
      return {};
    });

    const result = await delegateTask({ id: 'a1', prompt: 'do the multi-step task', timeoutSeconds: 300 }) as {
      content: { text: string }[];
      isError?: boolean;
    };

    // Must have auto-answered every confirmation, not just the first, and
    // ultimately report completion rather than giving up mid-task.
    const dispatchCalls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch'));
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(4); // 1 initial + 3 auto-continues
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('completed');
    expect(result.content[0].text).not.toContain('still waiting');
  });

  it('still bails out immediately on a permission dialog rather than typing into it', async () => {
    const delegateTask = await loadDelegateTask();

    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw Object.assign(new Error('no ACP mode'), { status: 409, body: { error: 'no ACP mode', retryWithDispatch: true } });
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        return { status: 'waiting', waitingReason: 'permission' };
      }
      return { agent: { status: 'waiting', name: 'Worker' } };
    });

    const result = await delegateTask({ id: 'a1', prompt: 'do something risky', timeoutSeconds: 300 }) as {
      content: { text: string }[];
      isError?: boolean;
    };

    const dispatchCalls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch'));
    // Exactly the one initial dispatch - never auto-answer a permission dialog.
    expect(dispatchCalls.length).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('PERMISSION dialog');
  });

  it('eventually gives up and hands back to the orchestrator if an agent never stops asking', async () => {
    const delegateTask = await loadDelegateTask();

    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw Object.assign(new Error('no ACP mode'), { status: 409, body: { error: 'no ACP mode', retryWithDispatch: true } });
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        return { status: 'waiting', waitingReason: 'idle' };
      }
      return { agent: { status: 'waiting', name: 'Worker' } };
    });

    const result = await delegateTask({ id: 'a1', prompt: 'never finishes', timeoutSeconds: 60 }) as {
      content: { text: string }[];
      isError?: boolean;
    };

    // Bounded, not infinite: some cap must still exist.
    const dispatchCalls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch'));
    expect(dispatchCalls.length).toBeGreaterThan(1);
    expect(dispatchCalls.length).toBeLessThan(20);
    expect(result.content[0].text.toLowerCase()).toContain('waiting');
  });
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

  it('says which background work the run stopped when the agent answered', async () => {
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) {
        return { ok: true, started: true, stopReason: 'end_turn', text: 'Builds are running.', toolCalls: ['pnpm build'], backgroundStopped: ['pnpm build', 'Monitor'] };
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
    expect(result.content[0].text).toMatch(/stopped when the run ended: pnpm build, Monitor/);
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

  it('still falls back to the terminal when no run started', async () => {
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw Object.assign(new Error('spawn npx ENOENT'), { status: 502, body: { error: 'spawn npx ENOENT', started: false } });
      if (endpoint.includes('/dispatch')) return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      if (endpoint.includes('/wait')) return { status: 'completed', lastCleanOutput: 'all done' };
      return { agent: { status: 'completed', name: 'Worker', lastCleanOutput: 'all done' } };
    });

    await delegateTask({ id: 'a1', prompt: 'upgrade', timeoutSeconds: 300 });

    expect(dispatched()).toBe(1);
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

describe('the run of a delegation whose caller gave no timeout (the Audit\'s M2 on #448)', () => {
  // How this fails, written before the code: the default was 300 s, so an
  // orchestrator that delegated a 40 minute build without timeoutSeconds had
  // the run cut at five minutes in the middle of its work ("stopped at the
  // run's limit of 300 s"), while the guide said a run of an hour was fine.
  // The default is run-task's own ceiling, an hour; a caller's value is kept.
  async function loadDelegateTask() {
    const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
    const server = makeFakeServer();
    registerAgentTools(server as never);
    return server.tools.get('delegate_task')!;
  }
  const asked = () => mockApiRequest.mock.calls
    .filter(c => String(c[0]).includes('/run-task'))
    .map(c => (c[2] as { timeoutSeconds?: number }).timeoutSeconds);

  it('asks run-task for an hour, the most it gives', async () => {
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { ok: true, started: true, stopReason: 'end_turn', text: 'built', toolCalls: [] };
      throw new Error(`unexpected ${endpoint}`);
    });

    await delegateTask({ id: 'a1', prompt: 'run the 40 minute build' });

    expect(asked()).toEqual([3600]);
  });

  it('keeps the timeout a caller gave', async () => {
    const delegateTask = await loadDelegateTask();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { ok: true, started: true, stopReason: 'end_turn', text: 'done', toolCalls: [] };
      throw new Error(`unexpected ${endpoint}`);
    });

    await delegateTask({ id: 'a1', prompt: 'a short check', timeoutSeconds: 120 });

    expect(asked()).toEqual([120]);
  });
});
