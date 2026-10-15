import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A room message still waiting for its agent when Tars stopped (RD-REDEMARRAGE.md, 2.3; JeanBrasse's yes of 2026-10-05).
 * The journal kept its row as `queued` (or `held`, behind a draft that died with the terminal), but the queue that
 * would have typed it lived in agent-watch's memory: after the restart the row read `queued` for ever, and the agent
 * never got the message.
 *
 * How it can fail, written before the code:
 * 21. A row left waiting is never typed again, or is typed into a terminal whose session has not registered, or
 *     mid-turn.
 * 22. It is typed twice: at two rests, or once from the carried rows and once more from a fresh send.
 * 23. A row that was delivered, dropped or not sent is typed again; or a row whose message is gone throws.
 * 24. The row does not turn `delivered` once typed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bus-carry-'));
const JOURNAL = path.join(tmp, 'bus.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), BUS_FILE: JOURNAL, dataPath: (f: string) => path.join(tmp, f) };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

let store: typeof import('../../../electron/services/bus-store');
let delivery: typeof import('../../../electron/services/bus-delivery');
let watch: typeof import('../../../electron/services/agent-watch');
let agentManager: typeof import('../../../electron/core/agent-manager');
let ptyManager: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');

const message = (id: string, text: string) => ({
  id, roomId: 'room-tars', threadId: 'th-1', authorKind: 'human', authorId: 'human', authorName: 'User',
  text, mentions: ['w'], createdAt: '2026-10-05T01:40:00.000Z',
});
const row = (messageId: string, state: string) => ({ messageId, targetAgentId: 'w', state, queuedAt: '2026-10-05T01:40:00.000Z' });

async function start(): Promise<{ written: string[]; agent: import('../../../electron/types').AgentStatus }> {
  vi.resetModules();
  agentManager = await import('../../../electron/core/agent-manager');
  ptyManager = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  store = await import('../../../electron/services/bus-store');
  delivery = await import('../../../electron/services/bus-delivery');
  agentManager.agents.clear();
  ptyManager.ptyProcesses.clear();
  watch.resetAgentWatch();
  store.loadBus();
  watch.setBusDeliveredHook((agentId, messageId) => { store.markDelivered(agentId, messageId); });
  delivery.carryWaitingDeliveries();
  watch.startAgentWatch();
  const written: string[] = [];
  ptyManager.ptyProcesses.set('pty-w2', { write: (d: string) => { written.push(d); } } as never);
  const agent = { id: 'w', name: 'Worker', status: 'running', projectPath: '/tars', skills: [], output: [], lastActivity: '', ptyId: 'pty-w2' } as unknown as import('../../../electron/types').AgentStatus;
  agentManager.agents.set('w', agent);
  return { written, agent };
}
const text = (w: string[]) => w.join('').replace(/\x1b\[20[01]~/g, '');
const fleet = (agent: { id: string }, status: string) => {
  (agent as { status: string }).status = status;
  events.emitAgentStatus(agent.id);
};

beforeEach(() => {
  fs.writeFileSync(JOURNAL, JSON.stringify({
    version: 1, savedAt: '2026-10-05T01:45:00.000Z', memberOverrides: {}, threads: [],
    messages: [message('m-queued', 'please rebase #280'), message('m-held', 'and run the gate'), message('m-done', 'already read'), message('m-dropped', 'gone'), message('m-not-sent', 'held by Tars')],
    deliveries: [row('m-queued', 'queued'), row('m-held', 'held'), row('m-done', 'delivered'), row('m-dropped', 'dropped'), row('m-not-sent', 'not_sent'), row('m-missing', 'queued')],
  }));
});

describe('a room message left waiting when Tars stopped', () => {
  it('21, 23, 24. is typed into the next session at its rest, once, and its row turns delivered; nothing else is', async () => {
    const { written, agent } = await start();

    fleet(agent, 'idle');
    await new Promise((r) => setTimeout(r, 50));
    expect(text(written), '21. at rest, but no session registered yet: nothing').toBe('');
    agent.currentSessionId = 'sess-2';
    agent.sessionPtyId = 'pty-w2';
    fleet(agent, 'running');
    expect(text(written), '21. mid-turn: nothing').toBe('');

    fleet(agent, 'idle');
    await vi.waitFor(() => expect(text(written)).toContain('please rebase #280'));
    await new Promise((r) => setTimeout(r, 450));
    fleet(agent, 'running');
    fleet(agent, 'idle');
    await vi.waitFor(() => expect(text(written)).toContain('and run the gate'));
    await new Promise((r) => setTimeout(r, 450));
    fleet(agent, 'running');
    fleet(agent, 'idle');
    await new Promise((r) => setTimeout(r, 50));

    const all = text(written);
    expect(all.match(/please rebase #280/g), '22. once').toHaveLength(1);
    expect(all.match(/and run the gate/g)).toHaveLength(1);
    expect(all).not.toMatch(/already read|gone|held by Tars/);
    expect(store.deliveriesOf('m-queued')[0].state).toBe('delivered');
    expect(store.deliveriesOf('m-held')[0].state).toBe('delivered');
    expect(store.deliveriesOf('m-not-sent')[0].state).toBe('not_sent');
  });
});
