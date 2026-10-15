import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * The window in which the Chat journal is behind memory, and what may not
 * happen inside it.
 *
 * The journal is written once per turn of the event loop now, not once per
 * delivery row, which means there is a moment when the state in memory has a
 * row the file does not. Three things would turn that moment into a lost
 * write, and this file holds each one shut:
 *
 *  - the moment lasting longer than the synchronous run it belongs to, so that
 *    a timer, a socket or an IPC callback could run while the file is behind;
 *  - anything reading the journal off disk in between, which would read the
 *    state as it was and hand it back as the truth;
 *  - a mutator that changes the state and schedules nothing, whose change then
 *    waits for somebody else's write and is lost if nobody writes.
 *
 * The first two are measured against the real store. The third is a scan of
 * the module: its floor is what a scan can see, and the lists below are what a
 * person has to keep honest, which is why adding an export fails this file
 * until it is classified.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bus-window-'));
const JOURNAL = path.join(tmp, 'bus.json');
const STORE = path.join(process.cwd(), 'electron/services/bus-store.ts');

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

vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

let store: typeof import('../../../electron/services/bus-store');

/** One turn of the event loop, which is what the write is deferred to the end of. */
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

const queued = (messageId: string) => ({
  messageId,
  targetAgentId: 'a',
  state: 'queued' as const,
  queuedAt: '2026-09-18T00:00:00.000Z',
});

function journalOnDisk() {
  return JSON.parse(fs.readFileSync(JOURNAL, 'utf-8')) as {
    messages: { id: string }[];
    deliveries: { messageId: string }[];
  };
}

/** A journal as the app left it, so a re-read has something to hand back. */
function seedJournal() {
  fs.writeFileSync(JOURNAL, JSON.stringify({
    savedAt: '2026-09-17T00:00:00.000Z',
    memberOverrides: {},
    threads: [{ id: 't1', roomId: 'project:/tars', anchorMessageId: 'm1', state: 'open', round: 1, agentMessageCount: 0, openedAt: '2026-09-17T00:00:00.000Z' }],
    messages: [{ id: 'm1', roomId: 'project:/tars', threadId: 't1', authorKind: 'human', authorId: 'human', authorName: 'User', text: 'seeded', mentions: [], createdAt: '2026-09-17T00:00:00.000Z' }],
    deliveries: [],
  }, null, 2));
}

beforeEach(async () => {
  vi.resetModules();
  fs.rmSync(JOURNAL, { force: true });
  store = await import('../../../electron/services/bus-store');
  store.resetBusStore();
});

afterEach(() => {
  store.flushBus();
});

describe('the journal is behind memory for one synchronous run, and no longer', () => {
  it('has nothing on disk when the mutator returns, and everything at the end of the turn', async () => {
    store.loadBus();
    store.recordDelivery(queued('m-window'));

    // The window: the row is in memory and the file has not been written at
    // all. If this ever stops being true, the deferral has gone away and the
    // measurement it was made for goes with it.
    expect(store.deliveriesOf('m-window'), 'the row is not in memory either').toHaveLength(1);
    expect(fs.existsSync(JOURNAL), 'the journal was written inside the mutator').toBe(false);

    await nextTurn();

    expect(journalOnDisk().deliveries.map(d => d.messageId)).toEqual(['m-window']);
  });

  it('closes that window before any timer, socket or IPC callback can run', async () => {
    store.loadBus();
    // A timer armed before the mutation is the earliest callback that could
    // read a journal: a microtask runs before it, so the file is already
    // written when it does.
    const sawItWritten = new Promise<boolean>(resolve => setTimeout(() => resolve(fs.existsSync(JOURNAL)), 0));
    store.recordDelivery(queued('m-before-timer'));

    expect(await sawItWritten).toBe(true);
  });
});

describe('nothing reads the journal off disk while it is behind', () => {
  it('keeps the row a reader is asked for between the mutation and the write', async () => {
    seedJournal();
    store.loadBus();
    store.recordDelivery(queued('m-read-between'));

    // Every read path in the store calls loadBus on the way in. It must be the
    // no-op it is once the journal has been read, or it hands back the state
    // as the file has it and the row goes with the assignment.
    store.listRooms();
    store.getRoomSnapshot('project:/tars');
    store.notSentFor('a');
    expect(store.deliveriesOf('m-read-between'), 'a read path sent the state back to the disk').toHaveLength(1);

    await nextTurn();

    expect(journalOnDisk().deliveries.map(d => d.messageId)).toEqual(['m-read-between']);
    expect(journalOnDisk().messages.map(m => m.id), 'the seeded journal was lost').toEqual(['m1']);
  });

  it('is read from disk in one place, and by nothing outside the store', () => {
    const source = fs.readFileSync(STORE, 'utf-8');
    const reads = source.match(/readFileSync\(BUS_FILE/g) ?? [];
    expect(reads, 'the journal is read from disk in more than one place').toHaveLength(1);

    // And no other process reads it: the Kanban and orchestrator servers read
    // agents.json, the journal belongs to the main process alone. A reader
    // added elsewhere would see a file that is a turn behind.
    // Every MCP folder, the one the servers share included (mcp-shared, D4),
    // found rather than listed: a server or a shared module added later is
    // scanned without anyone editing this list.
    const mcp = fs.readdirSync(process.cwd())
      .filter(name => name.startsWith('mcp-') && fs.existsSync(path.join(process.cwd(), name, 'src')))
      .map(name => `${name}/src`);
    expect(mcp, 'the MCP folders were not found').toContain('mcp-shared/src');
    const roots = ['electron', 'src', ...mcp];
    const mentions: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'dist' && entry.name !== 'node_modules') walk(full);
        } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf-8');
          // Spelled with `/` on every platform, as the list below is.
          if (/BUS_FILE|['"`]bus\.json['"`]/.test(text)) mentions.push(path.relative(process.cwd(), full).split(path.sep).join('/'));
        }
      }
    };
    for (const root of roots) walk(path.join(process.cwd(), root));

    expect(mentions.sort()).toEqual([
      'electron/constants/index.ts',
      'electron/services/bus-store.ts',
    ]);
  });
});

/**
 * Every export of the store, classified. A write that reaches the state and
 * schedules nothing is a write that waits for somebody else's, so each export
 * has to be one of three things, and a new one fails this until it is said
 * which. What the scan can see is an assignment or a push rooted at `state`;
 * a field of a thread or a delivery already in hand is past it, which is why
 * the first list is kept by hand.
 */
const SCHEDULES_A_WRITE = [
  'appendMessage', 'appendSystemMessage', 'cancelQueuedDeliveries', 'closeThread',
  'markDelivered', 'markDropped', 'recordDelivery', 'setMembers',
];

const MUTATES_WITHOUT_WRITING: Record<string, 'only a writer in this file calls it' | 'fills the state from disk' | 'test hook'> = {
  // Pushes a thread and writes nothing: appendMessage calls it and writes for
  // it. Called from anywhere else, the thread would live in memory until the
  // next mutation, so the caller check below is the whole point of the entry.
  openThread: 'only a writer in this file calls it',
  loadBus: 'fills the state from disk',
  resetBusStore: 'test hook',
};

function exportedFunctions(): Map<string, string> {
  const source = fs.readFileSync(STORE, 'utf-8');
  const file = ts.createSourceFile(STORE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  file.forEachChild(node => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) return;
    const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) out.set(node.name.text, node.body.getText(file));
  });
  return out;
}

/**
 * An assignment or an array mutation whose root is `state`.
 *
 * The lookbehind is what keeps `t.state === 'open'` out of it: a comparison
 * against a thread's own `state` field is not an assignment to the journal,
 * and three readers matched before it was there.
 */
function touchesState(body: string): boolean {
  return /(?<![.\w])state\s*=(?!=)/.test(body)
    || /(?<![.\w])state\.[A-Za-z]+\s*=(?!=)/.test(body)
    || /(?<![.\w])state\.[A-Za-z]+(\[[^\]]*\])?\.(push|splice|pop|shift|unshift|sort)\(/.test(body)
    || /\bdelete\s+state\./.test(body);
}

describe('every export of the store writes, reads, or is internal to a writer', () => {
  const exports_ = exportedFunctions();

  it('has no export this file has not classified', () => {
    const classified = [...SCHEDULES_A_WRITE, ...Object.keys(MUTATES_WITHOUT_WRITING)];
    const readers = [...exports_.keys()].filter(name => !classified.includes(name));
    expect(
      [...exports_.keys()].sort(),
      'an export was added or renamed: put it in SCHEDULES_A_WRITE, in MUTATES_WITHOUT_WRITING with its reason, or leave it a reader and this test will check it mutates nothing',
    ).toEqual([...classified, ...readers].sort());
    expect(exports_.size).toBeGreaterThan(20);
  });

  it('schedules a write in each export that is meant to', () => {
    for (const name of SCHEDULES_A_WRITE) {
      expect(exports_.get(name), `${name} is not an export of the store any more`).toBeDefined();
      expect(exports_.get(name), `${name} changes the journal and schedules no write`).toContain('scheduleSaveBus()');
    }
  });

  it('touches the state in no export that is neither a writer nor listed', () => {
    const allowed = new Set([...SCHEDULES_A_WRITE, ...Object.keys(MUTATES_WITHOUT_WRITING)]);
    const offenders = [...exports_].filter(([name, body]) => !allowed.has(name) && touchesState(body)).map(([name]) => name);
    expect(offenders, 'these change the journal without scheduling a write').toEqual([]);
  });

  it('keeps the internal mutators internal', () => {
    const internal = Object.entries(MUTATES_WITHOUT_WRITING)
      .filter(([, why]) => why === 'only a writer in this file calls it')
      .map(([name]) => name);
    expect(internal.length).toBeGreaterThan(0);

    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'dist' && entry.name !== 'node_modules') walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && full !== STORE) {
          const text = fs.readFileSync(full, 'utf-8');
          for (const name of internal) {
            if (new RegExp(`\\b${name}\\s*\\(`).test(text)) callers.push(`${path.relative(process.cwd(), full)}: ${name}`);
          }
        }
      }
    };
    for (const root of ['electron', 'src']) walk(path.join(process.cwd(), root));

    expect(callers, 'called from outside the store, where nothing writes for it').toEqual([]);
  });
});
