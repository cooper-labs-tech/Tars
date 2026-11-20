import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

/**
 * The cross-chat reading option's door (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 5; PR F of 2.0.0): GET
 * /api/chats/list, which chat_list (mcp-orchestrator) calls. Off by default; on, for a project's chats only.
 *
 * How this can fail, written before the code:
 * 1. It answers with the setting off, or reads the setting once at start, so turning it off leaves the door open.
 * 2. It answers a caller that runs no chat (a worker, the shared token's caller with no agent) or names the project
 *    from an argument rather than from the caller's own token: a worker, or a runner of another project, reads
 *    chats it should not.
 * 3. The caller's chat is taken from the agent record's chatId, which an agent can claim, rather than from the chat
 *    the fleet confirms it runs.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const at = '2026-10-13T08:00:00.000Z';
const chat = (id: string, number: number, projectPath: string, runnerId: string) => ({
  id, projectPath, number, title: `T${number}`, titleSource: 'user', runnerId, sessionIds: [], pinned: false,
  snoozedUntil: null, settledAt: null, inbox: number === 1, createdAt: at, updatedAt: at, lastActivityAt: at,
});
const CHATS = [chat('a1', 1, '/work/a', 'lead-a'), chat('a2', 2, '/work/a', 'run-a2'), chat('b1', 1, '/work/b', 'lead-b')];
const fleet = new Map<string, Record<string, unknown>>([
  ['lead-a', { id: 'lead-a', role: 'orchestrator', projectPath: '/work/a', status: 'idle' }],
  ['run-a2', { id: 'run-a2', role: 'worker', kind: 'chat', chatId: 'a2', projectPath: '/work/a', status: 'idle' }],
  ['worker-a', { id: 'worker-a', role: 'worker', projectPath: '/work/a', status: 'idle' }],
  // Claims chat a2 in its record, but the fleet's chat a2 is run by run-a2.
  ['claims-a2', { id: 'claims-a2', role: 'worker', kind: 'chat', chatId: 'a2', projectPath: '/work/a', status: 'idle' }],
  ['lead-b', { id: 'lead-b', role: 'orchestrator', projectPath: '/work/b', status: 'idle' }],
]);

vi.mock('../../../../electron/services/chat-runners', () => ({
  allChats: () => CHATS,
  chatRunBy: (agent: { id: string }) => CHATS.find((c) => c.runnerId === agent.id),
  runnerOf: (c: { runnerId: string }) => fleet.get(c.runnerId),
  isLive: () => false,
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: fleet }));

let settings: { chatsReadEachOther?: boolean } = {};

async function list(caller?: string, query = '') {
  const routes: Array<{ method: string; pattern: unknown; handler: (...a: unknown[]) => unknown }> = [];
  const app = {
    routes,
    add(method: string, pattern: unknown, handler: (...a: unknown[]) => unknown) { routes.push({ method, pattern, handler }); },
    get(p: unknown, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
    post(p: unknown, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
    put(p: unknown, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
    delete(p: unknown, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
  };
  const ctx = { getAppSettings: () => settings, agentStatusEmitter: new EventEmitter() };
  const { registerChatReadRoutes } = await import('../../../../electron/services/api-routes/chat-read-routes');
  registerChatReadRoutes(app as never, ctx as never);
  const route = routes.find((r) => r.method === 'GET' && r.pattern === '/api/chats/list')!;
  const answers: Array<{ body: Record<string, unknown>; status?: number }> = [];
  const req = { method: 'GET', url: new URL(`http://x/api/chats/list${query}`), body: {}, callerAgentId: caller };
  await route.handler(req, (body: Record<string, unknown>, status?: number) => { answers.push({ body, status }); }, ctx);
  return answers[0];
}

beforeEach(() => { settings = { chatsReadEachOther: true }; });

describe('GET /api/chats/list', () => {
  it('1. is closed while the setting is off, read at each call', async () => {
    settings = { chatsReadEachOther: false };
    expect((await list('run-a2')).status).toBe(403);
    settings = { chatsReadEachOther: true };
    expect((await list('run-a2')).status ?? 200).toBe(200);
    settings = {};
    expect((await list('run-a2')).status).toBe(403);
  });

  it('2. answers a chat\'s agent only, and with its own project\'s chats whatever it asks', async () => {
    expect((await list(undefined)).status).toBe(403);
    expect((await list('worker-a')).status).toBe(403);
    const fromRunner = await list('run-a2', '?project=/work/b');
    expect(fromRunner.body.chats).toEqual([expect.objectContaining({ id: 'a1', number: 1 })]);
    const fromLead = await list('lead-b');
    expect(fromLead.body.chats).toEqual([]);
  });

  it('3. takes the caller\'s chat from the fleet, not from its record', async () => {
    expect((await list('claims-a2')).status).toBe(403);
  });
});
