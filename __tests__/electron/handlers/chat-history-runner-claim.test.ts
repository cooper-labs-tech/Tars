import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A chat's conversation is read from the runner the fleet confirms, never from
 * the agent its record names (GATE-PR371-DELTA5, L1; chats.json is in
 * ~/.tars, which every agent may write, and #379 checks the record against
 * the fleet before anything is done for it: recordedRunner).
 *
 * How it fails:
 * 1. (E2) chat:history reads the sessions of the agent the record names: a
 *    record edited to name a worker shows that worker's conversation as the
 *    chat's.
 * 2. (E1) The follower does the same, live: that worker's lines are sent to
 *    every window as the chat's items.
 *
 * The chats' handlers and store, the transcript reader and the follower are
 * the real ones; the follower runs on its own one-second timer. Replaced:
 * electron, node-pty, the broadcast (recorded), and whether a CLI is live
 * (always, so that only the runner decides what is read).
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const told = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: (channel: string, payload: unknown) => { told.push({ channel, payload }); } }));
vi.mock('../../../electron/services/chat-runners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/chat-runners')>()),
  isLive: () => true,
}));

import { agents } from '../../../electron/core/agent-manager';
import { registerChatHandlers } from '../../../electron/handlers/chat-handlers';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';
import type { AgentStatus } from '../../../electron/types';

const WORKER_SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const userLine = (text: string) => JSON.stringify({ type: 'user', uuid: `u-${Math.random()}`, timestamp: '2026-10-13T08:00:00.000Z', message: { role: 'user', content: text } }) + '\n';

describe("a chat whose record names an agent the fleet does not confirm as its runner", () => {
  it('1, 2. reads and follows nothing of that agent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-claim-'));
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    agents.clear();
    const put = (id: string, fields: Partial<AgentStatus>) => agents.set(id, {
      id, name: id, status: 'running', provider: 'claude', projectPath: project, skills: [], output: [],
      lastActivity: '2026-10-13T08:00:00.000Z', ...fields,
    } as AgentStatus);
    put('lead', { role: 'orchestrator' });
    // A worker of the project, mid-session.
    put('w1', { role: 'worker', currentSessionId: WORKER_SESSION });
    const file = path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(project), `${WORKER_SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, userLine('THE WORKER OWN WORDS'));

    const store = registerChatHandlers({ agents, file: path.join(dir, 'chats.json') });
    const chat = (await handlers.get('chat:create')!({}, { projectPath: project, title: 'Edited' })) as { id: string };
    // The record edited to name the worker as the chat's runner.
    expect(store.setRunner(chat.id, 'w1')).toMatchObject({ runnerId: 'w1' });

    // 1. The history reads nothing of it.
    const history = (await handlers.get('chat:history')!({}, { chatId: chat.id })) as { items: Array<{ text: string }> };
    expect(JSON.stringify(history.items)).not.toContain('THE WORKER OWN WORDS');

    // 2. Nor does the follower, as the worker's transcript grows.
    told.length = 0;
    fs.appendFileSync(file, userLine('THE WORKER NEXT WORDS'));
    await new Promise((r) => setTimeout(r, 2_500));
    const items = told.filter((t) => t.channel === 'chat:events' && (t.payload as { type?: string }).type === 'item');
    expect(JSON.stringify(items)).not.toContain('THE WORKER');
  });
});
