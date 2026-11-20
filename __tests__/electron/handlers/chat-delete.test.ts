import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Deleting a chat whose runner asks for work while it is being stopped (the
 * Audit's L6 on #379; ORCHESTRATOR-PER-CHAT.md 4.1, `chat_has_work`).
 *
 * How it fails, written before the fix (2026-10-13):
 * 1. The delete checks the runner's work, then stops it and removes it with
 *    the record: a request it filed while it was stopping stays at the worker,
 *    filed by a requester that no longer exists, whose answer nobody waits for.
 *    It must be checked again once the runner is stopped, and refused then.
 * 2. A delete with nothing out is refused, or leaves the runner or the record.
 *
 * The chats' handlers and store, the fleet and the removal are the real ones.
 * Replaced: electron, node-pty, and the stop, by one that files a request at a
 * worker in the runner's name as its CLI ends.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const stopping = vi.hoisted(() => ({ asks: undefined as undefined | (() => void) }));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
}));
vi.mock('../../../electron/core/agent-stop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/core/agent-stop')>()),
  stopAgent: vi.fn(async (agent: { status: string }) => {
    stopping.asks?.();
    agent.status = 'stopped';
    return true;
  }),
}));

import { agents } from '../../../electron/core/agent-manager';
import { registerChatHandlers } from '../../../electron/handlers/chat-handlers';
import type { AgentStatus } from '../../../electron/types';

describe("deleting a chat (the Audit's L6 on #379)", () => {
  it('1, 2. checks the runner again once it is stopped: work it asked for meanwhile keeps the chat and the runner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-delete-'));
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    agents.clear();
    const put = (id: string, fields: Partial<AgentStatus>): AgentStatus => {
      agents.set(id, {
        id, name: id, status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [],
        lastActivity: '2026-10-13T08:00:00.000Z', ...fields,
      } as AgentStatus);
      return agents.get(id)!;
    };
    put('lead', { role: 'orchestrator' });
    const worker = put('worker', { role: 'worker', taskQueue: [] });
    const store = registerChatHandlers({ agents, file: path.join(dir, 'chats.json') });
    const chat = (await handlers.get('chat:create')!({}, { projectPath: project, title: 'Release' })) as { id: string };
    put('runner', { role: 'worker', kind: 'chat', chatId: chat.id, teamOrchestratorId: 'lead' });
    expect(store.setRunner(chat.id, 'runner')).toMatchObject({ runnerId: 'runner' });

    // 1. It asks the worker for something as it stops: refused, and nothing is removed.
    stopping.asks = () => {
      worker.taskQueue = [{ ref: 't-0000aaaa', requesterAgentId: 'runner', queuedAt: '2026-10-13T08:00:00.000Z', state: 'queued' }];
    };
    expect(await handlers.get('chat:delete')!({}, { chatId: chat.id })).toMatchObject({ error: 'chat_has_work' });
    expect(agents.has('runner')).toBe(true);
    expect(store.get(chat.id)).toBeDefined();

    // 2. That work done, the delete goes through: the runner and the record go.
    stopping.asks = undefined;
    worker.taskQueue = [];
    expect(await handlers.get('chat:delete')!({}, { chatId: chat.id })).toMatchObject({ success: true });
    expect(agents.has('runner')).toBe(false);
    expect(store.get(chat.id)).toBeUndefined();
  });
});
