import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A chat speaks in its project's room as itself, though its runner is no member
 * of it (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0).
 *
 * How it fails, written before the code (the Audit's gate of #386; its mutant
 * H8 survived everything, since the API route refuses another project's room
 * before the store is asked):
 * 1. (L1) A chat's runner posts into another project's room: the store takes
 *    it, its own-project check gone, and that project's team is typed to.
 * 2. An agent whose record says it runs a chat, which the fleet does not
 *    confirm (chats.json and agents.json are in ~/.dorothy, agent-writable),
 *    posts as a chat, or is sent to with bus:sendNow as one (the Info: sendNow
 *    admitted by the record's kind where the post asks the fleet).
 * 3. The chat's post goes under its runner's name rather than the chat's.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bus-chat-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), BUS_FILE: path.join(tmp, 'bus.json'), dataPath: (f: string) => path.join(tmp, f) };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type AgentStatus = import('../../../electron/types').AgentStatus;
let store: typeof import('../../../electron/services/bus-store');
let delivery: typeof import('../../../electron/services/bus-delivery');
let manager: typeof import('../../../electron/core/agent-manager');
let inbox: typeof import('../../../electron/core/chat-inbox');

const TARS = '/work/tars';
const OTHER = '/work/other';
const put = (over: Partial<AgentStatus> & { id: string }) => {
  const agent = { name: over.id, status: 'idle', provider: 'claude', projectPath: TARS, skills: [], output: [], lastActivity: '', ...over } as AgentStatus;
  manager.agents.set(agent.id, agent);
  return agent;
};
const human = (roomId: string, text: string) => store.appendMessage({ roomId, authorKind: 'human', authorId: 'human', authorName: 'User', text });

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  store = await import('../../../electron/services/bus-store');
  delivery = await import('../../../electron/services/bus-delivery');
  inbox = await import('../../../electron/core/chat-inbox');
  manager.agents.clear();
  store.resetBusStore();
  fs.rmSync(path.join(tmp, 'bus.json'), { force: true });
  put({ id: 'lead', role: 'orchestrator' });
  put({ id: 'run3', role: 'worker', kind: 'chat', chatId: 'c3' });
  put({ id: 'lead-other', role: 'orchestrator', projectPath: OTHER });
  put({ id: 'run-other', role: 'worker', kind: 'chat', chatId: 'o2', projectPath: OTHER });
  // Claims a chat in its record; no chat names it.
  put({ id: 'claims', role: 'worker', kind: 'chat', chatId: 'c9' });
  const chats: Record<string, { id: string; projectPath: string; number: number; title: string }> = {
    run3: { id: 'c3', projectPath: TARS, number: 3, title: 'Release' },
    'run-other': { id: 'o2', projectPath: OTHER, number: 2, title: 'Elsewhere' },
  };
  // Projects with several chats: each chat is named by it.
  inbox.setChatLookups({ inbox: () => null, chatRunBy: (agentId) => chats[agentId], namedChatOf: (agentId) => chats[agentId] });
});
afterEach(() => inbox.setChatLookups(undefined));

describe("a chat in its project's room", () => {
  it('3. posts there as the chat', () => {
    human(`project:${TARS}`, 'hello');
    const posted = store.publishAgentMessage({ roomId: `project:${TARS}`, agentId: 'run3', text: 'from the release chat' });
    expect(posted).toMatchObject({ published: true });
    expect(posted.published && posted.message.authorName).toBe('the orchestrator of tars, chat #3 "Release"');
  });

  it("1. is refused in another project's room", () => {
    human(`project:${TARS}`, 'hello');
    const posted = store.publishAgentMessage({ roomId: `project:${TARS}`, agentId: 'run-other', text: 'from elsewhere' });
    expect(posted).toMatchObject({ published: false, reason: 'not_a_member' });
  });

  it('2. is no chat when the fleet does not confirm it, to post or to be sent to now', async () => {
    human(`project:${TARS}`, 'hello');
    expect(store.publishAgentMessage({ roomId: `project:${TARS}`, agentId: 'claims', text: 'as a chat' })).toMatchObject({ published: false, reason: 'not_a_member' });
    const now = await delivery.sendNow({ roomId: `project:${TARS}`, agentId: 'claims', text: 'to a claimed chat' });
    expect(now).toMatchObject({ success: false });
  });
});
