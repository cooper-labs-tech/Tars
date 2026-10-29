/**
 * POST /api/tasks/:ref/move, through the real route (2.0.5, lot 2; the Audit's re-check of #536 at 8dab4d39): the
 * rule of services/agent-queues.ts moveWithin, applied where a worker's call comes in.
 *
 * How it fails, written before the test:
 * Q1 a worker's move skips the rule at the route: its item goes to the head, ahead of what the orchestrator queued,
 *    or before another's item; or the route refuses a worker's move among its own items;
 * Q2 the project's orchestrator is held to the worker's rule, and cannot put an item where it wants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => process.env.TMPDIR ?? '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

const { registerTaskRoutes } = await import('../../../../electron/services/api-routes/task-routes');
const { oneTaskQueue } = await import('../../../../electron/core/one-task');
const { agents } = await import('../../../../electron/core/agent-manager');
import type { RouteApp, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus } from '../../../../electron/types';

type Route = { method: string; pattern: RegExp; handler: (req: RouteRequest, send: (data: unknown, status?: number) => void) => unknown };
const routes: Route[] = [];
const app = {
  get: (pattern: RegExp, handler: Route['handler']) => routes.push({ method: 'GET', pattern, handler }),
  post: (pattern: RegExp, handler: Route['handler']) => routes.push({ method: 'POST', pattern, handler }),
  put: vi.fn(), delete: vi.fn(),
} as unknown as RouteApp;
registerTaskRoutes(app);

async function move(ref: string, caller: string, before?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const pathname = `/api/tasks/${ref}/move`;
  const route = routes.find((r) => r.method === 'POST' && r.pattern.test(pathname))!;
  let got!: { status: number; data: Record<string, unknown> };
  await route.handler({
    method: 'POST', pathname, url: new URL(`http://127.0.0.1${pathname}`), body: before ? { before } : {},
    params: { id: ref }, callerAgentId: caller,
  } as unknown as RouteRequest, (data, status = 200) => { got = { status, data: data as Record<string, unknown> }; });
  return got;
}

const member = (id: string, role: string) => ({ id, name: id, role, status: 'running', projectPath: '/p', skills: [], output: [], lastActivity: '' }) as unknown as AgentStatus;
const order = () => oneTaskQueue.queued('w').map((t) => t.ref);

beforeEach(() => {
  for (const t of oneTaskQueue.queued('w')) oneTaskQueue.cancel(t.ref);
  agents.clear();
  for (const a of [member('w', 'worker'), member('lead', 'orchestrator'), member('me', 'worker')]) agents.set(a.id, a);
  // The line of w: the orchestrator's, mine, the orchestrator's, mine.
  oneTaskQueue.enqueue('w', { title: 'a', requesterId: 'lead' }, 1, 't-0000000a');
  oneTaskQueue.enqueue('w', { title: 'b', requesterId: 'me' }, 2, 't-0000000b');
  oneTaskQueue.enqueue('w', { title: 'c', requesterId: 'lead' }, 3, 't-0000000c');
  oneTaskQueue.enqueue('w', { title: 'd', requesterId: 'me' }, 4, 't-0000000d');
});

describe('a worker moves its item through the route', () => {
  it('Q1: never ahead of what it did not send, and among its own items when nothing of another\'s is between', async () => {
    // To the head: no further than just behind the orchestrator's last item ahead of it, which is where it is.
    const head = await move('t-0000000d', 'me');
    expect(head.status).toBe(200);
    expect(order()).toEqual(['t-0000000a', 't-0000000b', 't-0000000c', 't-0000000d']);
    // Before the orchestrator's item, or past it to its own: refused, and the line unchanged.
    expect((await move('t-0000000d', 'me', 't-0000000c')).status).toBe(403);
    expect((await move('t-0000000d', 'me', 't-0000000b')).status).toBe(403);
    expect((await move('t-0000000b', 'me', 't-0000000a')).status).toBe(403);
    expect(order()).toEqual(['t-0000000a', 't-0000000b', 't-0000000c', 't-0000000d']);
    // Its own two side by side: it reorders them, and to the head goes just behind the orchestrator's item.
    oneTaskQueue.cancel('t-0000000c');
    expect((await move('t-0000000d', 'me', 't-0000000b')).status).toBe(200);
    expect(order()).toEqual(['t-0000000a', 't-0000000d', 't-0000000b']);
    expect((await move('t-0000000b', 'me')).status).toBe(200);
    expect(order()).toEqual(['t-0000000a', 't-0000000b', 't-0000000d']);
  });

  it('Q2: the project\'s orchestrator puts any item anywhere', async () => {
    expect((await move('t-0000000d', 'lead')).status).toBe(200);
    expect(order()).toEqual(['t-0000000d', 't-0000000a', 't-0000000b', 't-0000000c']);
    expect((await move('t-0000000a', 'lead', 't-0000000c')).status).toBe(200);
    expect(order()).toEqual(['t-0000000d', 't-0000000b', 't-0000000a', 't-0000000c']);
  });
});
