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
    ['b', { id: 'b', name: 'Harbor Tester', role: 'worker', projectPath: '/w/harbor', status: 'idle', statusSince: '2026-10-28T09:00:00.000Z', skills: [], output: [] }],
  ]),
}));
vi.mock('../../../../electron/core/agent-manager', async (orig) => ({ ...(await orig<object>()), agents: fleet, saveAgents: vi.fn() }));
vi.mock('../../../../electron/services/fleet-resources-runtime', () => ({
  agentResources: async () => new Map([
    ['a', { memMb: 770, cpuPct: 50.5, processes: [{ name: 'claude', memMb: 512, cpuPct: 40, command: 'claude --token ghp_AAAA[redacted]BBBB' }] }],
    ['b', { memMb: null, cpuPct: null, processes: [] }],
  ]),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';

async function get(url: string, params: Record<string, string> = {}) {
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
  const route = routes.find(r => r.method === 'GET' && (r.pattern === u.pathname || (r.pattern instanceof RegExp && r.pattern.test(u.pathname) && String(r.pattern).includes('([^/]+)$'))))!;
  let body: Record<string, unknown> = {};
  await route.handler({ method: 'GET', url: u, body: {}, params, headers: {} }, (b: Record<string, unknown>) => { body = b; }, ctx);
  return body;
}

describe('an orchestrator reads its agents\' resources', () => {
  it('A1, A3. list_agents gives each agent\'s memory and since when it is in its status, null when unread', async () => {
    const { agents } = await get('/api/agents') as { agents: Array<Record<string, unknown>> };
    expect(agents.find(a => a.id === 'a')).toMatchObject({ memMb: 770, statusSince: '2026-10-28T09:30:00.000Z' });
    expect(agents.find(a => a.id === 'b')).toMatchObject({ memMb: null, statusSince: '2026-10-28T09:00:00.000Z' });
  });

  it('A2. get_agent gives its tree\'s memory, CPU and processes, masked', async () => {
    const { agent } = await get('/api/agents/a', { id: 'a' }) as { agent: Record<string, unknown> };
    expect(agent.resources).toEqual({ memMb: 770, cpuPct: 50.5, processes: [{ name: 'claude', memMb: 512, cpuPct: 40, command: 'claude --token ghp_AAAA[redacted]BBBB' }] });
  });
});
