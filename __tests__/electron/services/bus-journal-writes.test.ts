import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What one Chat message costs on disk.
 *
 * Every mutator in bus-store wrote the whole journal, and the delivery fan-out
 * calls two of them once per target, so publishing one message into a room of
 * six rewrote the entire file 13 times and then 7 to 8 times per message.
 * Measured on 2026-09-18 through bus:postMessage, on a journal the size of a
 * month of the super chat (343 messages, 628 KB): 11.4 ms a message, and 83 ms
 * at ten times that journal, all of it on the main thread. One write a message
 * instead: 1.7 ms and 11.5 ms.
 *
 * These tests count the writes rather than timing them, so they say the same
 * thing on any machine. They also pin what must not be traded for it: nothing
 * lost at the end of the turn, nothing lost at quit, a journal from the
 * version before this still readable, and never a half-written file.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bus-writes-'));
const JOURNAL = path.join(tmp, 'bus.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    DATA_DIR: tmp,
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    BUS_FILE: JOURNAL,
    dataPath: (f: string) => path.join(tmp, f),
  };
});

/** Every atomic write of the journal, in order. The store reaches disk through
 *  this one function, so counting here counts whole-file rewrites and nothing
 *  else. The real write still happens: these tests read the file back. */
const journalWrites: number[] = [];
vi.mock('../../../electron/utils/secret-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/utils/secret-file')>();
  return {
    ...actual,
    writeAtomicSync: (file: string, contents: string, mode?: number) => {
      if (file === JOURNAL) journalWrites.push(contents.length);
      return actual.writeAtomicSync(file, contents, mode);
    },
  };
});

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler); } },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type AgentStatus = import('../../../electron/types').AgentStatus;

let store: typeof import('../../../electron/services/bus-store');
let manager: typeof import('../../../electron/core/agent-manager');
let ptyManager: typeof import('../../../electron/core/pty-manager');
let watch: typeof import('../../../electron/services/agent-watch');

const ROOM = 'project:/tars';
const MEMBERS = ['a', 'b', 'c', 'd', 'e', 'f'];

function putAgent(id: string): AgentStatus {
  const agent = {
    id,
    name: id.toUpperCase(),
    status: 'idle',
    provider: 'claude',
    projectPath: '/tars',
    skills: [],
    output: [],
    ptyId: `pty-${id}`,
    currentSessionId: `sess-${id}`,
    lastActivity: new Date().toISOString(),
  } as AgentStatus;
  manager.agents.set(id, agent);
  ptyManager.ptyProcesses.set(agent.ptyId!, { write: () => undefined } as never);
  return agent;
}

/** Post as the Chat page does: the real IPC handler, the real fan out. */
async function postAsUser(text: string): Promise<{ success: boolean; deliveries?: unknown[] }> {
  const handler = ipcHandlers.get('bus:postMessage')!;
  return await handler(null, { roomId: ROOM, text }) as { success: boolean; deliveries?: unknown[] };
}

function journalOnDisk() {
  return JSON.parse(fs.readFileSync(JOURNAL, 'utf-8')) as {
    messages: { id: string }[]; deliveries: { messageId: string; targetAgentId: string; state: string }[];
  };
}

beforeEach(async () => {
  vi.resetModules();
  journalWrites.length = 0;
  manager = await import('../../../electron/core/agent-manager');
  ptyManager = await import('../../../electron/core/pty-manager');
  watch = await import('../../../electron/services/agent-watch');
  store = await import('../../../electron/services/bus-store');
  manager.agents.clear();
  ptyManager.ptyProcesses.clear();
  store.resetBusStore();
  fs.rmSync(JOURNAL, { force: true });
  fs.rmSync(`${JOURNAL}.tmp`, { force: true });
  watch.resetAgentWatch();
  watch.startAgentWatch();
  ipcHandlers.clear();
  const { registerBusHandlers } = await import('../../../electron/handlers/bus-handlers');
  registerBusHandlers();
  for (const id of MEMBERS) putAgent(id);
});

afterEach(() => {
  watch.stopAgentWatch();
  vi.useRealTimers();
});

describe('the journal is written once per message, not once per delivery row', () => {
  it('writes once for a publication into a room of six', async () => {
    const result = await postAsUser('all of you, look at this');
    expect(result.success).toBe(true);

    // One append, six delivery rows, six of them marked delivered: thirteen
    // mutations of the journal, one write.
    expect(result.deliveries).toHaveLength(MEMBERS.length);
    expect(journalWrites).toHaveLength(1);
  });

  it('grows with the messages and not with the size of the room', async () => {
    for (let n = 0; n < 5; n++) await postAsUser(`message ${n}`);

    expect(journalWrites).toHaveLength(5);
  });

  it('has every row of that publication on disk once the turn ends', async () => {
    const posted = await postAsUser('nothing may be dropped for the sake of one write');
    expect(posted.success).toBe(true);

    const onDisk = journalOnDisk();
    expect(onDisk.messages).toHaveLength(1);
    // A row per member, each one marked delivered: the states the deferred
    // write could have lost are the ones set last.
    expect(onDisk.deliveries).toHaveLength(MEMBERS.length);
    expect(onDisk.deliveries.map(d => d.targetAgentId).sort()).toEqual([...MEMBERS].sort());
    expect(new Set(onDisk.deliveries.map(d => d.state))).toEqual(new Set(['delivered']));
  });

  it('leaves no journal behind that cannot be parsed, and no temp file', async () => {
    // A leftover temp file from an interrupted run is overwritten, never read
    // and never appended to.
    fs.writeFileSync(`${JOURNAL}.tmp`, 'half a journal, from a process that died');
    await postAsUser('after a crash');

    expect(() => journalOnDisk()).not.toThrow();
    expect(fs.existsSync(`${JOURNAL}.tmp`)).toBe(false);
  });
});

describe('what must not be traded for that', () => {
  it('puts a pending write on disk the moment it is asked to, which is what quitting does', () => {
    // No await anywhere: the mutation happens and the run is still going, so
    // the deferred write has not fired. This is the state the app is in when
    // before-quit runs.
    store.appendMessage({
      roomId: ROOM, authorKind: 'human', authorId: 'human', authorName: 'User', text: 'said just before quitting',
    });
    expect(journalWrites).toHaveLength(0);
    expect(fs.existsSync(JOURNAL)).toBe(false);

    store.flushBus();

    expect(journalWrites).toHaveLength(1);
    expect(journalOnDisk().messages).toHaveLength(1);
  });

  it('is flushed by the quit handler itself', () => {
    // The wiring, not a copy of it: the body of the before-quit handler in
    // main.ts has to be what flushes the journal, or a quit mid-turn loses the
    // message and every test above still passes. It hands the step to
    // runShutdownSteps, which catches each one; shutdown-order.test.ts is what
    // holds it to running first.
    const main = fs.readFileSync(path.join(process.cwd(), 'electron/main.ts'), 'utf-8');
    const handler = main.slice(main.indexOf("app.on('before-quit'"));
    const body = handler.slice(0, handler.indexOf('\n});'));
    expect(body).toContain("['flushBus', flushBus]");
  });

  it('writes nothing more after a flush, rather than twice', () => {
    store.appendMessage({
      roomId: ROOM, authorKind: 'human', authorId: 'human', authorName: 'User', text: 'once',
    });
    store.flushBus();
    store.flushBus();

    expect(journalWrites).toHaveLength(1);
  });

  it('does not let a write from the fleet before this one land on the empty state', async () => {
    store.appendMessage({
      roomId: ROOM, authorKind: 'human', authorId: 'human', authorName: 'User', text: 'belongs to the old fleet',
    });
    store.flushBus();
    const before = fs.readFileSync(JOURNAL, 'utf-8');

    // Mutate again and reset without flushing: the deferred write is now for a
    // state that has been thrown away. What stops it is the `loaded` guard
    // that was already there, which resetBusStore clears; this is here so that
    // deferring the write cannot quietly outlive it.
    store.appendMessage({
      roomId: ROOM, authorKind: 'human', authorId: 'human', authorName: 'User', text: 'also the old fleet',
    });
    store.resetBusStore();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));

    expect(fs.readFileSync(JOURNAL, 'utf-8')).toBe(before);
  });

  it('reads a journal written by the version before this one', () => {
    // The shape that shipped: no memberOverrides, delivery rows without the
    // fields added since. Nothing here changes the format, and this is what
    // says so next time.
    fs.writeFileSync(JOURNAL, JSON.stringify({
      version: 1,
      savedAt: '2026-09-01T00:00:00.000Z',
      threads: [{ id: 't1', roomId: ROOM, anchorMessageId: 'm1', state: 'open', round: 1, agentMessageCount: 0, openedAt: '2026-09-01T00:00:00.000Z' }],
      messages: [{ id: 'm1', roomId: ROOM, threadId: 't1', authorKind: 'human', authorId: 'human', authorName: 'User', text: 'from before', mentions: [], createdAt: '2026-09-01T00:00:00.000Z' }],
      deliveries: [{ messageId: 'm1', targetAgentId: 'a', state: 'queued', queuedAt: '2026-09-01T00:00:00.000Z' }],
    }));

    store.resetBusStore();
    store.loadBus();

    expect(store.getThread('t1')?.state).toBe('open');
    expect(store.messagesOfThread('t1').map(m => m.text)).toEqual(['from before']);
    expect(store.deliveriesOf('m1').map(d => d.state)).toEqual(['queued']);
  });
});
