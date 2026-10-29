import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The relay route of the owner's words (2.0.6, option e; the QA's F2 on #569).
 *
 * How it can fail:
 * R1. A delivery the receiver's terminal refused still counts as made: every later relay of those words to that
 *     receiver is refused as a replay until Tars restarts.
 * R2. The receiver cannot read back the words relayed to it (the Audit's M1 on #569).
 */

const dispatched = vi.hoisted(() => ({ status: 409 as number | undefined, calls: 0 }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/tmp' } }));
vi.mock('../../../../electron/services/api-routes/agent-routes', () => ({
  performDispatch: vi.fn(async (_agent: unknown, _opts: unknown, _ctx: unknown, send: (data: unknown, status?: number) => void) => {
    dispatched.calls++;
    if (dispatched.status) send({ error: 'its terminal takes nothing now', code: 'refused' }, dispatched.status);
    else send({ success: true, mode: 'message' });
  }),
}));

import { agents } from '../../../../electron/core/agent-manager';
import { ownerWords } from '../../../../electron/services/owner-words';
import { registerOwnerWordsRoutes } from '../../../../electron/services/api-routes/owner-words-routes';
import type { RouteHandler, RouteContext } from '../../../../electron/services/api-routes/types';
import type { AgentStatus } from '../../../../electron/types';

const A = '/projects/alpha';
const B = '/projects/beta';
const routes: Array<{ method: string; pattern: string | RegExp; handler: RouteHandler }> = [];

function call(method: string, path: string, caller: string, body?: unknown): Promise<{ data: Record<string, unknown>; status: number }> {
  const route = routes.find((r) => r.method === method && (typeof r.pattern === 'string' ? r.pattern === path : r.pattern.test(path)))!;
  const m = typeof route.pattern === 'string' ? null : path.match(route.pattern);
  return new Promise((resolve) => {
    void route.handler(
      { method, path, body: body ?? {}, params: m?.[1] ? { id: m[1] } : {}, callerAgentId: caller } as never,
      (data, status) => resolve({ data: data as Record<string, unknown>, status: status ?? 200 }),
    );
  });
}

beforeEach(() => {
  agents.clear();
  for (const [id, name, projectPath] of [['lead-a', 'Alpha Lead', A], ['lead-b', 'Beta Lead', B]]) {
    agents.set(id, { id, name, projectPath, role: 'orchestrator', status: 'idle', provider: 'claude', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus);
  }
  routes.length = 0;
  const app = { routes: [], add: (method: string, pattern: string | RegExp, handler: RouteHandler) => routes.push({ method, pattern, handler }) } as never as {
    add: (m: string, p: string | RegExp, h: RouteHandler) => void; get: (p: string | RegExp, h: RouteHandler) => void; post: (p: string | RegExp, h: RouteHandler) => void;
  };
  app.get = (p, h) => app.add('GET', p, h);
  app.post = (p, h) => app.add('POST', p, h);
  registerOwnerWordsRoutes(app as never, { getAppSettings: () => ({}) } as unknown as RouteContext);
  dispatched.calls = 0;
});

describe('the relay route', () => {
  it('R1. a delivery refused by the receiver frees the relay: the same words go to it once the terminal takes them', async () => {
    const { id } = ownerWords.record({ text: 'ROUTE-WORDS merge it', via: 'Telegram', projectPath: A });
    dispatched.status = 409;
    expect(await call('POST', `/api/owner-words/${id}/relay`, 'lead-a', { to: 'lead-b' })).toMatchObject({ status: 409 });
    dispatched.status = undefined;
    expect(await call('POST', `/api/owner-words/${id}/relay`, 'lead-a', { to: 'lead-b' })).toMatchObject({ status: 200, data: { relayed: true, wordsId: id } });
    expect(dispatched.calls).toBe(2);
  });

  it('R2. the receiver reads back what was relayed to it, with who relayed it', async () => {
    const { id } = ownerWords.record({ text: 'ROUTE-WORDS-2 ship tonight', via: 'Telegram', projectPath: A });
    dispatched.status = undefined;
    await call('POST', `/api/owner-words/${id}/relay`, 'lead-a', { to: 'lead-b' });
    const listed = await call('GET', '/api/owner-words', 'lead-b');
    expect((listed.data.relayedToYou as Array<Record<string, unknown>>).filter((w) => w.id === id))
      .toEqual([expect.objectContaining({ text: 'ROUTE-WORDS-2 ship tonight', by: { id: 'lead-a', name: 'Alpha Lead' } })]);
  });
});
