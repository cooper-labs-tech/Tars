import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * delegate_task after its connection to Tars was dropped (2.0.4).
 *
 * The defect: delegate_task held ONE POST /api/agents/:id/run-task open for
 * the whole ACP run, and the route only answered when the run ended. Node's
 * fetch (undici) cuts a request that has no response headers after 300 s as
 * `TypeError: fetch failed`, which is not an AbortError, and the tool read it
 * as "no run started": it typed the same task into the agent's terminal (a
 * second copy, five minutes after the first), or, since receipts, was refused
 * 409 clientRequestId_conflict and told its caller nothing had been sent while
 * the run kept working.
 *
 * Every way this can fail, written before the code:
 *  F1. A transport failure on run-task (fetch failed, reset, refused, our own
 *      wait running out) is read as "no run started" and the task goes to
 *      /dispatch: typed a second time, or refused as a conflict.
 *  F2. A request waits longer than one segment: run-task held for the whole
 *      run, or a wait on the task held past undici's 300 s.
 *  F3. After a transport failure the tool gives up at once instead of asking
 *      Tars again about the same clientRequestId, so a run that started is
 *      reported as lost while it works.
 *  F4. Asking again starts a second run: the retry carries another
 *      clientRequestId, or another payload.
 *  F5. Tars unreachable past the grace period: the tool throws, or says
 *      nothing was sent, instead of saying the run may still be working and
 *      how to follow it (task_status with the id).
 *  F6. The run that started is waited on, but its real end (answer, stop
 *      reason, tokens, cost, task id) is not what the caller gets, or a run
 *      that ended badly is not flagged as an error.
 *  F7. A run still going at the caller's deadline is reported as done, or the
 *      tool falls back to the terminal then.
 *  F8. (Gone in 2.0.4 with the terminal fallback: run-task is the terminal,
 *      and a refusal of Tars is the answer, F9.)
 *  F9. Tars answered with a refusal that is not "no run" (a clientRequestId
 *      conflict, a permission escalation denied, a cross-project refusal, a
 *      server error, a 502 that says a run started) and the tool dispatches
 *      anyway.
 *  F10. delegate_task's model never reaches the run: run-task's body has no
 *      model.
 *  F11. The agent did not take the model, and the result does not say so.
 *  F12. undici's real cut is not what the tool classifies: the error it
 *      raises is assumed to be an AbortError, or to carry an HTTP status.
 *
 * Added after the Audit's gate on f09ad4c9, before their fixes:
 *  F13. allowCrossProject: true never reaches run-task, so Tars refuses the
 *      run 403 as cross-project and that refusal is the result: the caller
 *      passed the flag and nothing runs (M1).
 *  F14. The agent did not take the model, and the result says it ran on its
 *      own model whether or not it did: the agent's own model is not named,
 *      or is claimed when it was not taken either (M2).
 *
 * Added for a task that waits its turn (2.0.4, one task at a time), which
 * lives in Tars's memory and is dropped by a restart, before the code:
 *  F15. Tars restarted while the task was queued (the Tars answering proves
 *      another instance, so the wait goes without the token and is refused):
 *      the tool retries for 90 s, then says Tars could not be reached, that
 *      the run may still be working and not to delegate it again; the task,
 *      which never started, is never asked again.
 *  F16. The same while the task was being started: said as surely never run,
 *      or as still working.
 *  F17. This same Tars answers 404 for the queued task: retried for 90 s and
 *      said unreachable, instead of what Tars answered.
 *  F18. Tars out of reach past the grace period while the task was queued:
 *      said as a task that ran and may still be working, with no word that
 *      a restart drops a queued task.
 *  F19. Over-correction: a run that had started, whose wait meets another
 *      Tars, is said lost and to be asked again: the ledger keeps it, and
 *      asking again could run it twice.
 *  F20. Over-correction: a 401 from the Tars that started the CLI, while the
 *      task was queued, is said to be a restart.
 *
 * Added with the QA's F1 on the 2.0.5 train (#536 keeps the queue across a
 * restart, paused), before the code:
 *  F21. The task was queued when Tars restarted: said never started and to be
 *      asked again, while the new Tars keeps it, paused, and gives it once the
 *      queue is resumed: the asker that follows the answer sends it twice, and
 *      it runs twice. Or Tars out of reach is said to drop a queued task.
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

async function loadDelegateTask() {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  return server.tools.get('delegate_task')!;
}

/** What undici raises when it cuts a request: a TypeError, no status. */
function fetchFailed(): Error {
  return new TypeError('fetch failed');
}

/** What apiRequest raises when Tars answered with a refusal. */
function answered(status: number, body: Record<string, unknown>): Error {
  return Object.assign(new Error(String(body.error ?? `API error: ${status}`)), { status, body });
}

/** What apiRequest raises when the port proved another Tars than the one that started this CLI: sent without the token, refused. */
function refusedByAnotherTars(): Error {
  return Object.assign(answered(401, { error: 'Unauthorized' }), { anotherTars: true });
}

type Result = { content: { text: string }[]; isError?: boolean };
const calls = (part: string) => mockApiRequest.mock.calls.filter((c) => String(c[0]).includes(part));

const ENDED = { id: 't-1', agentId: 'a1', outcome: 'completed', stopReason: 'end_turn', result: 'the real answer', usage: { inputTokens: 100, outputTokens: 20, costUSD: 0.5 }, toolCalls: ['Read'] };

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
  vi.useRealTimers();
});

describe('delegate_task never types a task after a run may have started', () => {
  it('1. (F1, F3, F4, F6) run-task cut by the transport: asks again with the same id and payload, waits on the run, returns its real end, never dispatches', async () => {
    let runTaskCalls = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) {
        runTaskCalls += 1;
        if (runTaskCalls === 1) throw fetchFailed();
        return { started: true, duplicate: true, outcome: 'running', taskId: 't-1' };
      }
      if (endpoint.startsWith('/api/tasks/t-1')) return { task: ENDED };
      throw new Error(`unexpected ${endpoint}`);
    });
    const result = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600, clientRequestId: 'req-fixed-1' }) as Result;

    expect(calls('/dispatch')).toHaveLength(0);
    const bodies = calls('/run-task').map((c) => c[2] as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].clientRequestId).toBe('req-fixed-1');
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('the real answer');
    expect(result.content[0].text).toContain('ended: end_turn');
    expect(result.content[0].text).toContain('120 tokens');
    expect(result.content[0].text).toContain('$0.5000');
    expect(result.content[0].text).toContain('task t-1');
  });

  it('2. (F2) no request waits longer than a segment well under 300 s, whatever the timeout asked', async () => {
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1' };
      if (endpoint.startsWith('/api/tasks/t-1')) {
        waits += 1;
        return { task: waits < 3 ? { ...ENDED, outcome: 'running' } : ENDED, timeout: waits < 3 };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    await (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 3600 });

    for (const c of mockApiRequest.mock.calls) {
      const timeoutMs = c[3] as number | undefined;
      expect(timeoutMs, String(c[0])).toBeDefined();
      expect(timeoutMs!, String(c[0])).toBeLessThanOrEqual(180_000);
      const wait = /[?&]wait=(\d+)/.exec(String(c[0]));
      if (wait) expect(Number(wait[1])).toBeLessThanOrEqual(120);
    }
    expect(calls('/run-task')[0][2]).toMatchObject({ answer: 'started' });
  });

  it('3. (F5) Tars unreachable past the grace period: says the run may still be working and how to follow it, never dispatches', async () => {
    vi.useFakeTimers();
    mockApiRequest.mockImplementation(async () => { throw fetchFailed(); });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600, clientRequestId: 'req-fixed-3' }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const result = await pending;

    expect(calls('/dispatch')).toHaveLength(0);
    expect(calls('/run-task').length).toBeGreaterThan(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/may still be working/);
    expect(result.content[0].text).toContain('task_status({ clientRequestId: "req-fixed-3" })');
    expect(result.content[0].text).not.toMatch(/nothing was sent/);
  });

  it('4. (F5) the wait on a started run loses Tars past the grace period: names the task to follow, never dispatches', async () => {
    vi.useFakeTimers();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1' };
      throw fetchFailed();
    });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600, clientRequestId: 'req-fixed-4' }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const result = await pending;

    expect(calls('/dispatch')).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/may still be working/);
    expect(result.content[0].text).toContain('t-1');
  });

  it('5. (F7) a run still going at the deadline is said to be running, with how to follow it, and nothing is dispatched', async () => {
    vi.useFakeTimers();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1' };
      if (endpoint.startsWith('/api/tasks/t-1')) {
        await new Promise((r) => setTimeout(r, 10_000));
        return { task: { ...ENDED, outcome: 'running' }, timeout: true };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 30 }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const result = await pending;

    expect(calls('/dispatch')).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/still working/);
    expect(result.content[0].text).toContain('task_status');
  });

  it('6. (F6) a run that ended badly is flagged as an error, with its reason', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1' };
      if (endpoint.startsWith('/api/tasks/t-1')) return { task: { ...ENDED, outcome: 'stopped', stopReason: 'interrupted', error: 'its turn was interrupted' } };
      throw new Error(`unexpected ${endpoint}`);
    });
    const result = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it' }) as Result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ended: interrupted');
    expect(result.content[0].text).toContain('its turn was interrupted');
  });
});

describe('delegate_task takes every refusal of Tars as its answer', () => {
  function dispatchAnswers() {
    return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
  }

  it.each([
    ['a clientRequestId conflict', answered(409, { error: 'clientRequestId x was already used for another request: nothing was sent.', code: 'clientRequestId_conflict' })],
    ['a permission escalation denied', answered(409, { error: 'held to plan', code: 'permission_escalation_denied', retryWithDispatch: false })],
    ['a cross-project refusal', answered(403, { error: 'agent a1 belongs to another project' })],
    ['a server error', answered(500, { error: 'Internal error' })],
    ['a 502 that says a run started', answered(502, { error: 'the run broke', started: true })],
  ])('8. (F9) %s: nothing is typed, and the refusal is the answer', async (_label, refusal) => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw refusal;
      if (endpoint.includes('/dispatch')) return dispatchAnswers();
      throw new Error(`unexpected ${endpoint}`);
    });
    const result = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it' }) as Result;
    expect(calls('/dispatch')).toHaveLength(0);
    expect(result.isError).toBe(true);
  });
});

describe('delegate_task\'s model', () => {
  it('9. (F10, F11) reaches the run, and a model the agent did not take is said', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1', model: { asked: 'haiku', taken: false } };
      if (endpoint.startsWith('/api/tasks/t-1')) return { task: ENDED };
      throw new Error(`unexpected ${endpoint}`);
    });
    const result = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it', model: 'haiku' }) as Result;
    expect(calls('/run-task')[0][2]).toMatchObject({ model: 'haiku' });
    expect(result.content[0].text).toMatch(/not on haiku/);
  });
});

describe('delegate_task\'s model, refused', () => {
  function refusedThen(model: Record<string, unknown>) {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1', model };
      if (endpoint.startsWith('/api/tasks/t-1')) return { task: ENDED };
      throw new Error(`unexpected ${endpoint}`);
    });
  }

  it('9b. (F14) the agent\'s session already open: says the model was not taken, and names its own', async () => {
    refusedThen({ asked: 'gpt-5', taken: false, own: 'opus' });
    const result = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it', model: 'gpt-5' }) as Result;
    expect(result.content[0].text).toMatch(/not on gpt-5: the agent's session was already open/);
    expect(result.content[0].text).toMatch(/its own model, opus\./);
  });

});

describe('delegate_task to another project, allowed', () => {
  it('11. (F13) allowCrossProject: true reaches run-task, the run starts, and its end is the answer; without it, still refused', async () => {
    // Tars as mayActIn answers (agent-routes.ts): 403 unless the body says allowCrossProject: true.
    mockApiRequest.mockImplementation(async (endpoint: string, _method: string, body?: Record<string, unknown>) => {
      if (endpoint.includes('/run-task') || endpoint.includes('/dispatch')) {
        if (body?.allowCrossProject !== true) throw answered(403, { error: 'Cross-project access denied: agent "a1" belongs to project /other.' });
        if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1' };
      }
      if (endpoint.startsWith('/api/tasks/t-1')) return { task: ENDED };
      throw new Error(`unexpected ${endpoint}`);
    });
    const allowed = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it', allowCrossProject: true }) as Result;
    expect(calls('/run-task')[0][2]).toMatchObject({ allowCrossProject: true });
    expect(calls('/dispatch')).toHaveLength(0);
    expect(allowed.isError, allowed.content[0].text).toBe(false);
    expect(allowed.content[0].text).toContain('the real answer');

    mockApiRequest.mockClear();
    const refused = await (await loadDelegateTask())({ id: 'a1', prompt: 'do it' }) as Result;
    expect(calls('/run-task')[0][2]).not.toHaveProperty('allowCrossProject');
    expect(calls('/dispatch')).toHaveLength(0);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Cross-project access denied/);
  });
});

describe('undici\'s own cut, as the tool meets it', () => {
  it('10. (F12) a request with no response headers past headersTimeout is a TypeError "fetch failed", no AbortError and no status', async () => {
    const server = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ headersTimeout: 300 });
    try {
      const err = await fetch(`http://127.0.0.1:${port}/api/agents/a1/run-task`, { method: 'POST', body: '{}', dispatcher } as RequestInit)
        .then(() => null, (e: unknown) => e as Error & { status?: number; cause?: { code?: string } });
      expect(err).toBeInstanceOf(TypeError);
      expect(err!.name).not.toBe('AbortError');
      expect(err!.message).toBe('fetch failed');
      expect(err!.cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');
      expect(err!.status).toBeUndefined();
    } finally {
      await dispatcher.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('delegate_task on a task waiting its turn, when Tars restarts', () => {
  const QUEUED = { ok: true, started: false, queued: true, outcome: 'queued', taskId: 't-0000abcd', queuedBehind: 'task t-1 from "Lead", since 2026-10-18T01:00:00.000Z', queuedAt: '2026-10-18T01:00:05.000Z' };
  const view = (outcome: string) => ({ id: 't-0000abcd', agentId: 'a1', outcome, queuedBehind: QUEUED.queuedBehind, queuedAt: QUEUED.queuedAt });

  /** run-task answers queued; then each wait on the task gives the next of `waits`, the last one again and again. */
  function queuedThen(...waits: Array<() => unknown>) {
    let n = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return QUEUED;
      if (endpoint.startsWith('/api/tasks/t-0000abcd')) return waits[Math.min(n++, waits.length - 1)]();
      if (endpoint.includes('/dispatch')) return { success: true, mode: 'message', agent: { id: 'a1', status: 'running' } };
      throw new Error(`unexpected ${endpoint}`);
    });
  }

  /** What the tool answered within `ms` of fake time, or that it still waits. */
  async function within(pending: Promise<Result>, ms: number): Promise<Result | 'still waiting'> {
    let done: Result | undefined;
    void pending.then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(ms);
    return done ?? 'still waiting';
  }

  it('12. (F15, F21) the task was queued: says at once that Tars restarted, that the task is kept, paused, and goes in once resumed: never to ask it again', async () => {
    vi.useFakeTimers();
    queuedThen(
      () => ({ task: view('queued'), timeout: true }),
      () => { throw fetchFailed(); },
      () => { throw refusedByAnotherTars(); },
    );
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600, clientRequestId: 'req-fixed-12' }) as Promise<Result>;
    const result = await within(pending, 10_000);
    await vi.advanceTimersByTimeAsync(200_000);

    expect(result, 'still waiting after 10 s: the restart was read as Tars out of reach').not.toBe('still waiting');
    const said = (result as Result).content[0].text;
    expect((result as Result).isError).toBe(true);
    expect(said).toContain('Tars restarted');
    expect(said).toContain('t-0000abcd');
    expect(said).toContain('kept');
    expect(said).toContain('paused');
    expect(said).toContain('resumed');
    expect(said).toContain('task_status');
    expect(said).not.toMatch(/never started|asked again|ask for it again/);
    expect(said).not.toMatch(/may still be working|rather than delegating the task again|could not be reached/);
    expect(calls('/dispatch')).toHaveLength(0);
  });

  it('13. (F16) the task was being started: says Tars restarted and that it may not have run, never that it is working', async () => {
    vi.useFakeTimers();
    queuedThen(() => ({ task: view('starting'), timeout: true }), () => { throw refusedByAnotherTars(); });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600 }) as Promise<Result>;
    const result = await within(pending, 10_000);
    await vi.advanceTimersByTimeAsync(200_000);

    expect(result).not.toBe('still waiting');
    const said = (result as Result).content[0].text;
    expect(said).toContain('Tars restarted');
    expect(said).toContain('may not have run');
    expect(said).toContain('ask for it again');
    expect(said).not.toMatch(/never started|may still be working|could not be reached/);
    expect(calls('/dispatch')).toHaveLength(0);
  });

  it('14. (F17) this same Tars answers 404 for it: what Tars answered is said at once, as never started', async () => {
    vi.useFakeTimers();
    const why = 'No such task. Tars started at 2026-10-18T01:30:00.000Z, and keeps no task that was still waiting its turn before then.';
    queuedThen(() => { throw answered(404, { error: why }); });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600 }) as Promise<Result>;
    const result = await within(pending, 10_000);
    await vi.advanceTimersByTimeAsync(200_000);

    expect(result).not.toBe('still waiting');
    const said = (result as Result).content[0].text;
    expect((result as Result).isError).toBe(true);
    expect(said).toContain(why);
    expect(said).toContain('never started');
    expect(said).not.toMatch(/could not be reached|may still be working/);
    expect(calls('/dispatch')).toHaveLength(0);
  });

  it('15. (F18) Tars out of reach past the grace period while it was queued: says it had not started, and what a restart does to it', async () => {
    vi.useFakeTimers();
    queuedThen(() => { throw fetchFailed(); });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600, clientRequestId: 'req-fixed-15' }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const result = await pending;

    const said = result.content[0].text;
    expect(result.isError).toBe(true);
    expect(said).toContain('t-0000abcd');
    expect(said).toContain('had not started');
    expect(said).toContain('restart');
    expect(said).toContain('task_status');
    // F21: a restart keeps it, paused (#536).
    expect(said).toContain('kept');
    expect(said).not.toContain('not kept');
    expect(said).not.toMatch(/ran on agent|may still be working/);
    expect(calls('/dispatch')).toHaveLength(0);
  });

  it('16. (F19) a run that had started meets another Tars: never said lost, nor to be asked again', async () => {
    vi.useFakeTimers();
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { started: true, outcome: 'running', taskId: 't-1' };
      if (endpoint.startsWith('/api/tasks/t-1')) throw refusedByAnotherTars();
      throw new Error(`unexpected ${endpoint}`);
    });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600 }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const said = (await pending).content[0].text;

    expect(said).not.toMatch(/Tars restarted|never started|asked again/);
    expect(said).toMatch(/may still be working/);
    expect(calls('/dispatch')).toHaveLength(0);
  });

  it("17. (F20) a 401 from the CLI's own Tars while it was queued is not said to be a restart", async () => {
    vi.useFakeTimers();
    queuedThen(() => { throw answered(401, { error: 'Unauthorized' }); });
    const pending = (await loadDelegateTask())({ id: 'a1', prompt: 'do it', timeoutSeconds: 600 }) as Promise<Result>;
    await vi.advanceTimersByTimeAsync(200_000);
    const said = (await pending).content[0].text;

    expect(said).not.toContain('Tars restarted');
    expect(said).toContain('had not started');
    expect(calls('/dispatch')).toHaveLength(0);
  });
});
