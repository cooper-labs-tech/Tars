import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A chat's runner launched by a message keeps that message's sender for the launch (the QA's F7 on #569; the Audit's
 * L2): the delivery check retypes the task under it, never as Tars, if the launch's turn does not start.
 *
 * How it can fail:
 * F7. sendToChat launches the runner without the sender: its task would be retyped under Tars's line.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
}));

import { agents } from '../../../electron/core/agent-manager';
import { registerAgentLauncher, type AgentLaunchOptions } from '../../../electron/core/agent-launch';
import { registerChatHandlers } from '../../../electron/handlers/chat-handlers';
import { sendToChat } from '../../../electron/services/chat-runners';
import type { AgentStatus } from '../../../electron/types';

describe("a chat's runner launched by a message", () => {
  it("F7. is launched with that message's sender", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-launch-sender-'));
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    agents.clear();
    const put = (id: string, fields: Partial<AgentStatus>) => agents.set(id, {
      id, name: id, status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [],
      lastActivity: '2026-10-29T08:00:00.000Z', ...fields,
    } as AgentStatus);
    put('lead', { role: 'orchestrator' });
    const store = registerChatHandlers({ agents, file: path.join(dir, 'chats.json') });
    const chat = (await handlers.get('chat:create')!({}, { projectPath: project, title: 'Release' })) as { id: string };
    put('runner', { role: 'worker', kind: 'chat', chatId: chat.id, teamOrchestratorId: 'lead', status: 'stopped' });
    expect(store.setRunner(chat.id, 'runner')).toMatchObject({ runnerId: 'runner' });
    const launched: Array<{ id: string; options?: AgentLaunchOptions }> = [];
    registerAgentLauncher(async (id, _prompt, options) => { launched.push({ id, options }); return { success: true }; });

    await sendToChat(chat.id, 'LAUNCH-SENDER rebase onto main', { sender: { kind: 'channel', channel: 'Slack' } });

    expect(launched.map((l) => l.id)).toEqual(['runner']);
    expect(launched[0].options?.sender).toEqual({ kind: 'channel', channel: 'Slack' });
  });
});
