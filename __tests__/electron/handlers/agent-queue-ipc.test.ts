/**
 * The window's hold on an agent's queue (2.0.5, lot 2; the frames of #535, "Notes for the backends"):
 * agentQueue:get, pause, resume, move, cancel, drop, and the agentQueue:changed event, through the real handlers.
 *
 * How it fails, written before the code:
 * W1 the owner cannot drop everything that waits at once; or a drop leaves an item, or tells its sender nothing;
 * W2 a cancel that comes after its item started (its turn taken, or typed in) answers "no queue holds this task",
 *    as for one never asked, instead of saying it started;
 * W3 a change of a queue (queued, moved, cancelled, dropped, paused, resumed, taken) is not told to the window, so
 *    its view goes stale; or a burst of changes is told many times over.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const { handlers, pushed } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  pushed: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => process.env.TMPDIR ?? '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); },
}));

const { registerAgentQueueHandlers } = await import('../../../electron/handlers/agent-queue-handlers');
const { oneTaskQueue } = await import('../../../electron/core/one-task');
const { agents } = await import('../../../electron/core/agent-manager');
registerAgentQueueHandlers();

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
const tick = () => new Promise((r) => setTimeout(r, 20));
const changes = () => pushed.filter((p) => p.channel === 'agentQueue:changed');

beforeEach(() => {
  pushed.length = 0;
  for (const t of oneTaskQueue.queued('w')) oneTaskQueue.cancel(t.ref);
  oneTaskQueue.resume('w');
  agents.set('w', { id: 'w', name: 'Worker', projectPath: '/p', status: 'running', skills: [], output: [], lastActivity: '' } as never);
  agents.set('lead', { id: 'lead', name: 'Lead', role: 'orchestrator', projectPath: '/p', status: 'idle', skills: [], output: [], lastActivity: '' } as never);
});

describe('the owner\'s hold on a queue', () => {
  it('W1: drops everything that waits, and the queue reads empty', async () => {
    oneTaskQueue.enqueue('w', { title: 'a', requesterId: 'lead', how: 'task' });
    oneTaskQueue.enqueue('w', { title: 'b', requesterId: 'lead', how: 'message' });
    const answer = await call('agentQueue:drop', 'w') as { success: boolean; dropped?: number; view?: { items: unknown[] } };
    expect(answer).toMatchObject({ success: true, dropped: 2 });
    expect(answer.view?.items).toEqual([]);
    expect(oneTaskQueue.queued('w')).toEqual([]);
  });

  it('W2: a cancel after its item started says it started', async () => {
    const t = oneTaskQueue.enqueue('w', { title: 'a', requesterId: 'lead', how: 'task' });
    expect(oneTaskQueue.takeTurn('w', t.ref, undefined)).toBe(true);
    const answer = await call('agentQueue:cancel', t.ref) as { success: boolean; error?: string; code?: string };
    expect(answer.success).toBe(false);
    expect(answer.code).toBe('already_started');
    expect(answer.error).toMatch(/started/);
    oneTaskQueue.runEnded('w');
    expect((await call('agentQueue:cancel', 't-ffffffff') as { code?: string }).code).toBe('not_found');
  });

  it('W3: each change is told to the window, once per burst, with the queue as it now reads', async () => {
    await tick();
    pushed.length = 0;
    const a = oneTaskQueue.enqueue('w', { title: 'a', how: 'task' });
    oneTaskQueue.enqueue('w', { title: 'b', how: 'task' });
    await tick();
    expect(changes()).toHaveLength(1);
    expect(changes()[0].payload).toMatchObject({ agentId: 'w', items: [{ title: 'a' }, { title: 'b' }] });
    await call('agentQueue:pause', 'w');
    await tick();
    expect(changes()).toHaveLength(2);
    expect(changes()[1].payload).toMatchObject({ agentId: 'w', paused: { why: 'paused by you' } });
    oneTaskQueue.cancel(a.ref);
    await tick();
    expect((changes()[2].payload as { items: unknown[] }).items).toHaveLength(1);
  });
});
