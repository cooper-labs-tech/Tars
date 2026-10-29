import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What the window's chat sends is the owner's own words, recorded for that chat (2.0.6, option e; the QA's F1 on
 * #569: nothing failed if chat:send stopped recording them; the Audit's M2: recorded for the chat, not only the
 * project).
 *
 * How it can fail:
 * C1. chat:send records nothing, so the owner's words from the window can never be relayed.
 * C2. They are recorded for the project only, and reach every chat's runner of it.
 * C3. A send that failed is recorded as words the owner sent.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const sent = vi.hoisted(() => ({ answer: { success: true } as Record<string, unknown> }));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
}));
vi.mock('../../../electron/services/chat-runners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/chat-runners')>()),
  sendToChat: vi.fn(async () => sent.answer),
}));

import { agents } from '../../../electron/core/agent-manager';
import { registerChatHandlers } from '../../../electron/handlers/chat-handlers';
import { ownerWords } from '../../../electron/services/owner-words';
import type { AgentStatus } from '../../../electron/types';

let project: string;
let chatId: string;
const orch = () => ({ id: 'lead', projectPath: project, orchestrator: true, projectOrchestrator: true });

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-words-'));
  project = path.join(dir, 'project');
  fs.mkdirSync(project);
  agents.clear();
  agents.set('lead', {
    id: 'lead', name: 'Lead', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [], role: 'orchestrator',
    lastActivity: '2026-10-29T08:00:00.000Z',
  } as AgentStatus);
  registerChatHandlers({ agents, file: path.join(dir, 'chats.json') });
  chatId = ((await handlers.get('chat:create')!({}, { projectPath: project, title: 'Release' })) as { id: string }).id;
  sent.answer = { success: true };
});

describe("the window's chat:send", () => {
  it("C1, C2. records the owner's words for that chat, once the send is taken", async () => {
    await handlers.get('chat:send')!({}, { chatId, text: 'WINDOW-WORDS ship it' });
    const listed = ownerWords.listFor(orch()).filter((w) => w.text === 'WINDOW-WORDS ship it');
    expect(listed).toEqual([expect.objectContaining({ via: 'window', projectPath: project, chatId })]);
    expect(ownerWords.listFor({ id: 'run-y', projectPath: project, orchestrator: true, chatId: 'another-chat' })
      .filter((w) => w.text === 'WINDOW-WORDS ship it')).toEqual([]);
  });

  it('C3. a send that failed records nothing', async () => {
    sent.answer = { error: 'chats_unavailable', reason: 'not loaded' };
    await handlers.get('chat:send')!({}, { chatId, text: 'WINDOW-FAILED' });
    expect(ownerWords.listFor(orch()).filter((w) => w.text === 'WINDOW-FAILED')).toEqual([]);
  });
});
