import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

/**
 * What an orchestrator reads of its agents' resources (lot 3 item D: "get_agent and list_agents carry each agent's
 * memory and status since"; 1212's orchestrator could not tell which agents held the memory).
 *
 * How it fails, written before the code (28/10):
 * A1. list_agents gives no agent's memory nor since when it is in its status.
 * A2. get_agent gives not its tree's memory, CPU and processes (command lines masked).
 * A3. An agent whose figures cannot be read reads 0 rather than null.
 * And from the Audit's gate of #546 (H1, M1) and the orchestrator's decision (task t-2be3810b):
 * A4. An agent of one project reads another project's agent with get_agent, its processes, its full record: it must
 *     be refused as an unknown id is (404, `Agent not found`), naming nothing.
 * A5. list_agents with `all` gives another project's agents with their tasks, memory, since or who asked: only who
 *     they are (id, name, status, project, role).
 * A6. get_agent gives a process's command line, which carries what the masking misses (a password after a flag, a
 *     key with no known prefix): through the API a process is its program, pid, memory and CPU, no arguments.
 * And from the Audit's re-check at 5a250033 (H1 still open):
 * A7. The other routes that name an agent by its id answer another project's: /output (get_agent_output, its whole
 *     terminal), /wait (wait_for_agent, its last answer), /bootstrap (its project's roster) and /health. Each must
 *     refuse it as get_agent does (404, `Agent not found`), and still answer its own project and the owner's token.
 * And from the train's brief (item 4), with #523's records in:
 * A8. An orchestrator cannot tell an agent left processes running after its session: list_agents gives how many
 *     (processes and containers, 0 when none), get_agent their pids and containers and since when, never a command
 *     line (A6's rule).
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
const { fleet } = vi.hoisted(() => ({
  fleet: new Map<string, Record<string, unknown>>([
    ['a', { id: 'a', name: 'Harbor Worker', role: 'worker', projectPath: '/w/harbor', status: 'running', statusSince: '2026-10-28T09:30:00.000Z', skills: [], output: [] }],
    ['b', { id: 'b', name: 'Harbor Tester', role: 'worker', projectPath: '/w/harbor', status: 'idle', statusSince: '2026-10-28T09:00:00.000Z', skills: [], output: [],
      leftRunning: { pids: [701, 702], commands: ['pid 701: next dev', 'pid 702: node w.js --token Ab3dEf6hIj9kLm2n'], containers: ['harbor-db (3f2a)'], since: '2026-10-28T09:05:00.000Z' } }],
    ['c', { id: 'c', name: 'Cove Worker', role: 'worker', projectPath: '/w/cove', status: 'running', statusSince: '2026-10-28T09:10:00.000Z', currentTask: 'rotate the cove database password', skills: [], output: ['cove secrets'] }],
  ]),
}));
vi.mock('../../../../electron/core/agent-manager', async (orig) => ({ ...(await orig<object>()), agents: fleet, saveAgents: vi.fn() }));
vi.mock('../../../../electron/services/fleet-resources-runtime', () => ({
  agentResources: async () => new Map([
    ['a', { memMb: 770, cpuPct: 50.5, processes: [{ name: 'claude', memMb: 512, cpuPct: 40, command: 'claude --token ghp_AAAA[redacted]BBBB' }] }],
    ['b', { memMb: null, cpuPct: null, processes: [] }],
    ['c', { memMb: 300, cpuPct: 5, processes: [{ name: 'psql', pid: 31, memMb: 30, cpuPct: 1, command: 'psql postgres://cove:pw@db/cove' }] }],
  ]),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';

async function get(url: string, params: Record<string, string> = {}, callerAgentId?: string): Promise<Record<string, unknown>> {
  return (await call(url, params, callerAgentId)).body;
}

async function call(url: string, params: Record<string, string> = {}, callerAgentId?: string) {
  const routes: Array<{ method: string; pattern: unknown; handler: (...a: unknown[]) => unknown }> = [];
  const app = {
    routes,
    add(method: string, pattern: unknown, handler: (...a: unknown[]) => unknown) { routes.push({ method, pattern, handler }); },
    get(p: unknown, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
    post(p: unknown, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
    put(p: unknown, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
    delete(p: unknown, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
  };
  const ctx = { getAppSettings: () => ({}), agentStatusEmitter: new EventEmitter() };
  registerAgentRoutes(app as never, ctx as never);
  const u = new URL(`http://x${url}`);
  const route = routes.find(r => r.method === 'GET' && (r.pattern === u.pathname || (r.pattern instanceof RegExp && r.pattern.test(u.pathname))))!;
  let body: Record<string, unknown> = {};
  let status = 200;
  await route.handler({ method: 'GET', url: u, body: {}, params, headers: {}, callerAgentId },
    (b: Record<string, unknown>, code?: number) => { body = b; status = code ?? 200; }, ctx);
  return { body, status };
}

describe('an orchestrator reads its agents\' resources', () => {
  it('A1, A3. list_agents gives each agent\'s memory and since when it is in its status, null when unread', async () => {
    const { agents } = await get('/api/agents') as { agents: Array<Record<string, unknown>> };
    expect(agents.find(a => a.id === 'a')).toMatchObject({ memMb: 770, statusSince: '2026-10-28T09:30:00.000Z' });
    expect(agents.find(a => a.id === 'b')).toMatchObject({ memMb: null, statusSince: '2026-10-28T09:00:00.000Z' });
  });

  it('A2. get_agent gives its tree\'s memory, CPU and processes, masked', async () => {
    const { agent } = await get('/api/agents/a', { id: 'a' }) as { agent: Record<string, unknown> };
    expect(agent.resources).toEqual({ memMb: 770, cpuPct: 50.5, processes: [{ name: 'claude', memMb: 512, cpuPct: 40 }] });
  });
});

describe('what one project reads of another\'s agents', () => {
  it('A4. get_agent refuses another project\'s agent as an unknown one, full or not', async () => {
    for (const url of ['/api/agents/c', '/api/agents/c?full=true']) {
      const { body, status } = await call(url, { id: 'c' }, 'a');
      expect(status, url).toBe(404);
      expect(body, url).toEqual({ error: 'Agent not found' });
      expect(await call('/api/agents/nobody', { id: 'nobody' }, 'a')).toEqual({ body, status });
    }
    // Its own project's agent, as before.
    expect((await get('/api/agents/b', { id: 'b' }, 'a')).agent).toMatchObject({ id: 'b', resources: { memMb: null } });
  });

  it('A5. list_agents with all names another project\'s agents, nothing more', async () => {
    const { agents } = await get('/api/agents?all=true', {}, 'a') as { agents: Array<Record<string, unknown>> };
    expect(agents.find(x => x.id === 'c')).toEqual({ id: 'c', name: 'Cove Worker', status: 'running', projectPath: '/w/cove', role: 'worker' });
    expect(agents.find(x => x.id === 'b')).toMatchObject({ memMb: null, statusSince: '2026-10-28T09:00:00.000Z' });
    expect(JSON.stringify(agents)).not.toContain('rotate the cove');
  });

  it('A6. a process through the API is its program, pid, memory and CPU, no arguments', async () => {
    const { agent } = await get('/api/agents/c', { id: 'c' }) as { agent: { resources: { processes: unknown[] } } };
    expect(agent.resources.processes).toEqual([{ name: 'psql', pid: 31, memMb: 30, cpuPct: 1 }]);
    expect(JSON.stringify(agent)).not.toContain('cove:pw');
  });
});

describe('every route on an agent id keeps to the caller\'s project', () => {
  it('A7. /output, /wait, /bootstrap and /health refuse another project\'s agent as unknown', async () => {
    for (const tail of ['output', 'wait?timeout=1', 'bootstrap', 'health']) {
      const url = `/api/agents/c/${tail}`;
      expect(await call(url, { id: 'c' }, 'a'), url).toEqual({ body: { error: 'Agent not found' }, status: 404 });
    }
    // Their own project's agent, and any for the owner's token.
    for (const tail of ['output', 'bootstrap', 'health']) {
      expect((await call(`/api/agents/b/${tail}`, { id: 'b' }, 'a')).status, tail).toBe(200);
      expect((await call(`/api/agents/c/${tail}`, { id: 'c' })).status, tail).toBe(200);
    }
    expect(JSON.stringify((await call('/api/agents/c/output', { id: 'c' })).body)).toContain('cove secrets');
  });
});

describe('what an agent left running after its session', () => {
  it('A8. list_agents counts it, get_agent gives its pids, containers and since, never a command line', async () => {
    const { agents } = await get('/api/agents') as { agents: Array<Record<string, unknown>> };
    expect(agents.find(x => x.id === 'b')?.outlived).toBe(3);
    expect(agents.find(x => x.id === 'a')?.outlived).toBe(0);
    const { agent } = await get('/api/agents/b', { id: 'b' }) as { agent: { resources: Record<string, unknown> } };
    expect(agent.resources.outlived).toEqual({ since: '2026-10-28T09:05:00.000Z', pids: [701, 702], containers: ['harbor-db (3f2a)'] });
    expect(JSON.stringify(agent.resources)).not.toContain('Ab3dEf6hIj9kLm2n');
    expect((await get('/api/agents/a', { id: 'a' }) as { agent: { resources: Record<string, unknown> } }).agent.resources.outlived).toBeNull();
  });
});
