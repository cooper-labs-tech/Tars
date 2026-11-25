import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The orchestrator's tools send each request with a clientRequestId, and a
 * retry of their own with the same one (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4
 * items 1 and 4; PR B). A call that timed out at 30 s was made again by the
 * agent, and the worker got the work typed in twice.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. A tool sends no clientRequestId: Tars has nothing to know its retry by.
 * 2. A send that timed out, or found Tars unreachable, is retried with a new
 *    id, or not retried: the retry is a new request, or the send is lost.
 * 3. A send Tars answered (a refusal, a conflict) is retried: an answer is
 *    not a failure to reach Tars.
 * 4. An id the agent passed is replaced by one the tool mints.
 * 5. The last attempt failing, the agent is not told the id to try again
 *    with, and its own retry is a new request.
 * 6. send_message drops the mode it was given, or reports a refusal
 *    (not_steerable, a conflict, another asker's work) as a message sent.
 * 7. delegate_task, answered that its run is a duplicate of one still going,
 *    waits on nothing or starts the task again; task_status does not read the
 *    task from Tars by its id or by the clientRequestId it was sent with.
 *
 * The real tools, loaded as the server loads them; only the API is replaced.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
  return {
    tools,
    // The handler is the last argument: a read-only tool passes its annotations before it (mcp-shared, #585).
    tool(name: string, ...rest: unknown[]) {
      tools.set(name, rest[rest.length - 1] as (args: Record<string, unknown>) => Promise<unknown>);
    },
  };
}

async function tool(name: string) {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  const found = server.tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;
const timeout = () => Object.assign(new Error('Tars did not answer'), { name: 'AbortError' });
const typed = { success: true, mode: 'message', previousStatus: 'idle', agent: { id: 'w1', name: 'Worker', status: 'running' } };

/** The body of every call to an endpoint matching `part`. */
const bodiesOf = (part: string) => mockApiRequest.mock.calls.filter(([e]) => String(e).includes(part)).map(([, , body]) => body as Record<string, unknown>);

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('a send of the orchestrator\'s tools', () => {
  it('1. carries a clientRequestId, a fresh one per call', async () => {
    mockApiRequest.mockResolvedValue(typed);
    const send = await tool('send_message');
    await send({ id: 'w1', message: 'one' });
    await send({ id: 'w1', message: 'two' });
    const [a, b] = bodiesOf('/dispatch').map((body) => body.clientRequestId);
    expect(typeof a).toBe('string');
    expect(String(a).length).toBeGreaterThanOrEqual(8);
    expect(b).not.toBe(a);
  });

  it('2. is tried again with the same id when Tars did not answer or could not be reached', async () => {
    mockApiRequest
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ...typed, duplicate: true });
    const result = await (await tool('send_message'))({ id: 'w1', message: 'review #280' });
    const ids = bodiesOf('/dispatch').map((body) => body.clientRequestId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(isError(result)).toBe(false);
  });

  it('3. is not tried again when Tars answered, even with a refusal', async () => {
    mockApiRequest.mockRejectedValue(new Error('Agent not found'));
    const result = await (await tool('send_message'))({ id: 'w1', message: 'review #280' });
    expect(bodiesOf('/dispatch')).toHaveLength(1);
    expect(isError(result)).toBe(true);
  });

  it('4. keeps the id the agent passed', async () => {
    mockApiRequest.mockResolvedValue(typed);
    await (await tool('send_message'))({ id: 'w1', message: 'review #280', clientRequestId: 'my-own-id-0001' });
    await (await tool('start_agent'))({ id: 'w1', prompt: 'review #280', clientRequestId: 'my-own-id-0002' });
    expect(bodiesOf('/dispatch').map((body) => body.clientRequestId)).toEqual(['my-own-id-0001']);
    expect(bodiesOf('/run-task').map((body) => body.clientRequestId)).toEqual(['my-own-id-0002']);
  });

  it('5. names its id when every attempt failed, so the agent can try again with it', async () => {
    mockApiRequest.mockRejectedValue(timeout());
    const result = await (await tool('send_message'))({ id: 'w1', message: 'review #280' });
    const id = String(bodiesOf('/dispatch')[0].clientRequestId);
    expect(bodiesOf('/dispatch')).toHaveLength(3);
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain(id);
    expect(text(result)).toContain('clientRequestId');
  });
});

describe('send_message\'s mode', () => {
  it('6. goes to Tars as given, and a refusal is reported as one', async () => {
    mockApiRequest.mockRejectedValueOnce(Object.assign(new Error('That agent\'s CLI cannot be interrupted: not_steerable'), { code: 'not_steerable' }));
    const result = await (await tool('send_message'))({ id: 'cx', message: 'now', mode: 'steer' });
    expect(bodiesOf('/dispatch')[0].mode).toBe('steer');
    expect(isError(result)).toBe(true);
    expect(text(result)).not.toMatch(/Sent message/);

    mockApiRequest.mockResolvedValueOnce({ ...typed, queued: true });
    const queued = await (await tool('send_message'))({ id: 'w1', message: 'after you', mode: 'queue' });
    expect(bodiesOf('/dispatch')[1].mode).toBe('queue');
    expect(text(queued)).toMatch(/queued/i);
  });
});

describe('a delegated run, and its status', () => {
  it('7. a retry answered as a duplicate of a run still going says so, and task_status reads it by id or by request', async () => {
    const taskId = '9a1f6c1e-0d4b-4f53-9a3e-2b1c0d9e8f70';
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) return { duplicate: true, started: true, taskId, outcome: 'running' };
      if (endpoint.startsWith('/api/tasks')) return { task: { id: taskId, agentId: 'oc', outcome: 'completed', stopReason: 'end_turn', result: 'reviewed' } };
      throw new Error(`unexpected ${endpoint}`);
    });
    const delegated = await (await tool('delegate_task'))({ id: 'oc', prompt: 'review the notes', clientRequestId: 'cr-acp-0001' });
    expect(bodiesOf('/dispatch')).toHaveLength(0);
    // Since 2.0.4 the run is waited on in the ledger: its end is the answer.
    expect(text(delegated)).toContain(taskId);
    expect(text(delegated)).toContain('reviewed');
    mockApiRequest.mockClear();

    const status = await tool('task_status');
    expect(text(await status({ taskId }))).toContain('reviewed');
    expect(text(await status({ clientRequestId: 'cr-acp-0001' }))).toContain('reviewed');
    const reads = mockApiRequest.mock.calls.map(([e]) => String(e)).filter((e) => e.startsWith('/api/tasks'));
    expect(reads).toEqual([`/api/tasks/${taskId}`, '/api/tasks?clientRequestId=cr-acp-0001']);
  });
});
