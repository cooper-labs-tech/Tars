import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A tool's calls to Tars name the tool (2.0.4, F3 of the maintainer's go of 2026-10-18): Tars reports an agent's tool
 * error with the tool it came from, and only the MCP server knows which tool is running when it calls Tars's API.
 * The servers register their tools through mcp-shared's registerTools and call Tars through its apiRequest; the name
 * goes between the two in an AsyncLocalStorage, and out as `X-Tars-Tool`.
 *
 * How it fails, written before the code (2026-10-19):
 * 1. A tool's call to Tars carries no tool name, or another tool's: two tools running at once must each send their own.
 * 2. A call made outside any tool (a server's own start, a timer) carries a name.
 * 3. A name reaches the header that is not the tool's registered name: anything the agent passed as an argument.
 * 4. Over-correction: the call no longer carries what it did (its caller headers), or the tool's answer changes.
 */

const sent: Array<{ url: string; headers: Record<string, string> }> = [];
let saved: string | undefined;

beforeEach(() => {
  sent.length = 0;
  saved = process.env.CLAUDE_MGR_API_URL;
  process.env.CLAUDE_MGR_API_URL = 'http://127.0.0.1:9';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    sent.push({ url, headers: init.headers });
    await new Promise(r => setTimeout(r, 5));
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.CLAUDE_MGR_API_URL;
  else process.env.CLAUDE_MGR_API_URL = saved;
});

async function loaded() {
  vi.resetModules();
  const { apiRequest } = await import('../../mcp-shared/src/tars-api');
  const { registerTools, text } = await import('../../mcp-shared/src/tools');
  const runs = new Map<string, (args: never, extra: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = { tool: (name: string, _d: never, _s: never, run: never) => { runs.set(name, run); } };
  return { apiRequest, registerTools, text, runs, server };
}

describe("a tool's calls to Tars", () => {
  it('1, 4. carry the name of the tool that makes them, each its own when two run at once', async () => {
    const { apiRequest, registerTools, text, runs, server } = await loaded();
    registerTools(server, [
      { name: 'delegate_task', description: '', schema: {}, failure: 'delegating', run: async () => { await apiRequest('/api/agents/a/delegate', 'POST', {}); return text('ok'); } },
      { name: 'send_message', description: '', schema: {}, failure: 'sending', run: async () => { await apiRequest('/api/agents/b/message', 'POST', {}); return text('sent'); } },
    ] as never);
    const [a, b] = await Promise.all([runs.get('delegate_task')!({} as never, {} as never), runs.get('send_message')!({} as never, {} as never)]);
    expect(a.content[0].text).toBe('ok');
    expect(b.content[0].text).toBe('sent');
    const byUrl = Object.fromEntries(sent.map(s => [s.url, s.headers['X-Tars-Tool']]));
    expect(byUrl).toEqual({
      'http://127.0.0.1:9/api/agents/a/delegate': 'delegate_task',
      'http://127.0.0.1:9/api/agents/b/message': 'send_message',
    });
    for (const s of sent) expect(s.headers['X-Tars-Client']).toBe('mcp');
  });

  it('2. a call made outside any tool carries none', async () => {
    const { apiRequest } = await loaded();
    await apiRequest('/api/agents');
    expect(sent[0].headers['X-Tars-Tool']).toBeUndefined();
  });

  it("3. the header is the tool's registered name, never what the agent passed", async () => {
    const { apiRequest, registerTools, text, runs, server } = await loaded();
    registerTools(server, [
      { name: 'task_status', description: '', schema: {}, failure: 'reading the task', run: async (args: { taskId: string }) => { await apiRequest(`/api/tasks/${args.taskId}`); return text('read'); } },
    ] as never);
    await runs.get('task_status')!({ taskId: 'zephyrine' } as never, {} as never);
    expect(sent[0].headers['X-Tars-Tool']).toBe('task_status');
  });
});
