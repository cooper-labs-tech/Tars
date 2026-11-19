import { describe, it, expect, vi } from 'vitest';

/**
 * An agent asks the disk janitor for a scan (lot 3 item H: "agents may ask for a scan, a read-only tool; approval
 * stays with the owner"): GET /api/janitor/scan, which disk_scan (mcp-orchestrator) calls.
 *
 * How it fails, written before the code (28/10):
 * 1. A caller with no agent (the shared token, none) gets the list.
 * 2. An agent can approve, or delete: no route under /api/ takes an approval, only the window's IPC.
 * 3. The scan answers something else than the janitor's items, each with its size and rule.
 * And with disk hygiene (2.0.7, written before its code; the routes' own cases are in e2e/disk-hygiene.spec.ts):
 * 4. The scan holds the caller past its wait (20 s, or `wait`, 110 at most): under load the whole scan outlasted the
 *    30 s an MCP call waits. It answers `running`, and the items of the last ended scan.
 * 5. A route takes an approval or deletes: the cleanup request (POST /api/janitor/request) only records, and the
 *    report (GET /api/disk/report) only reads.
 */

const ITEM = { id: 'abcdef0123456789', kind: 'npx-cache', label: '~/.npm/_npx/x', sizeBytes: 5, rule: 'r' };
const { scan, request } = vi.hoisted(() => ({
  scan: vi.fn(async (_asker: unknown, waitMs: number) => ({ running: false, progress: null, items: [{ id: 'abcdef0123456789', kind: 'npx-cache', label: '~/.npm/_npx/x', sizeBytes: 5, rule: 'r' }], at: 1, waitMs })),
  request: vi.fn(() => ({ ok: true, id: 'jr-1', items: 1, bytes: 5 })),
}));
vi.mock('../../../../electron/services/disk-janitor', () => ({ janitorScanFor: scan, janitorRequest: request, janitorReportFor: () => null }));
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

async function get(caller?: string, query = '') {
  const route = routes().find(r => r.method === 'GET' && r.pattern === '/api/janitor/scan')!;
  let answer: { body: Record<string, unknown>; status?: number } | undefined;
  await route.handler({ method: 'GET', body: {}, params: {}, callerAgentId: caller, url: new URL(`http://127.0.0.1/api/janitor/scan${query}`) }, (body: Record<string, unknown>, status?: number) => { answer = { body, status }; }, {});
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
    expect(body).toEqual({ success: true, running: false, items: [ITEM], scannedAt: 1, approvedBy: 'the owner, in the window' });
  });

  it('4. waits 20 s unless told, 110 s at most', async () => {
    scan.mockClear();
    await get('a');
    await get('a', '?wait=2');
    await get('a', '?wait=9999');
    expect(scan.mock.calls.map(c => c[1])).toEqual([20_000, 2_000, 110_000]);
  });

  it('2, 5. takes no approval: a scan and a report read, a request only records', () => {
    expect(routes().map(r => `${r.method} ${String(r.pattern)}`)).toEqual(['GET /api/janitor/scan', 'POST /api/janitor/request', 'GET /api/disk/report']);
  });
});
