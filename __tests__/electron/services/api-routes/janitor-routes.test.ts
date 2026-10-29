import { describe, it, expect, vi } from 'vitest';

/**
 * An agent asks the disk janitor for a scan (lot 3 item H: "agents may ask for a scan, a read-only tool; approval
 * stays with the owner"): GET /api/janitor/scan, which disk_scan (mcp-orchestrator) calls.
 *
 * How it fails, written before the code (28/10):
 * 1. A caller with no agent (the shared token, none) gets the list.
 * 2. An agent can approve, or delete: no route under /api/ takes an approval, only the window's IPC.
 * 3. The scan answers something else than the janitor's items, each with its size and rule.
 */

const { scan } = vi.hoisted(() => ({ scan: vi.fn(async () => [{ id: 'abcdef0123456789', kind: 'npx-cache', label: '~/.npm/_npx/x', sizeBytes: 5, rule: 'r' }]) }));
vi.mock('../../../../electron/services/disk-janitor', () => ({ janitorScan: scan }));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: new Map([['a', { id: 'a', projectPath: '/p' }]]) }));

import { registerJanitorRoutes } from '../../../../electron/services/api-routes/janitor-routes';

function routes() {
  const list: Array<{ method: string; pattern: unknown; handler: (...a: unknown[]) => unknown }> = [];
  const app = {
    routes: list,
    add(method: string, pattern: unknown, handler: (...a: unknown[]) => unknown) { list.push({ method, pattern, handler }); },
    get(p: unknown, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
    post(p: unknown, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
    put(p: unknown, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
    delete(p: unknown, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
  };
  registerJanitorRoutes(app as never);
  return list;
}

async function get(caller?: string) {
  const route = routes().find(r => r.method === 'GET' && r.pattern === '/api/janitor/scan')!;
  let answer: { body: Record<string, unknown>; status?: number } | undefined;
  await route.handler({ method: 'GET', body: {}, params: {}, callerAgentId: caller }, (body: Record<string, unknown>, status?: number) => { answer = { body, status }; }, {});
  return answer!;
}

describe('GET /api/janitor/scan', () => {
  it('1. refuses a caller with no agent', async () => {
    expect((await get()).status).toBe(403);
    expect(scan).not.toHaveBeenCalled();
  });

  it('3. gives an agent the janitor\'s items, with their sizes and rules', async () => {
    const { body, status } = await get('a');
    expect(status ?? 200).toBe(200);
    expect(body).toEqual({ success: true, items: [{ id: 'abcdef0123456789', kind: 'npx-cache', label: '~/.npm/_npx/x', sizeBytes: 5, rule: 'r' }], approvedBy: 'the owner, in the window' });
  });

  it('2. takes no approval: only a read', () => {
    expect(routes().map(r => `${r.method} ${String(r.pattern)}`)).toEqual(['GET /api/janitor/scan']);
  });
});
