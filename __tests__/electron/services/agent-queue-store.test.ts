import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The agent's queue kept across a stop and a restart of Tars, and who may act on it (2.0.5, lot 2, item I; the DB
 * brief lot2-agent-queue-2810.md): services/agent-queues.ts.
 *
 * How it fails, written before the code:
 * K1 the queue is kept where every agent can read it (~/.tars, which every agent is handed), or readable by others
 *    than the user; or an item Tars could not hand over again (no replay) is kept as if it could;
 * K2 a file that is not JSON, or of another shape, throws at launch, or restores half a queue silently;
 * K3 restored, a queue goes in at once instead of waiting paused; or its items come back out of order, or without
 *    being handed over again once resumed; or the ids it holds are not known before the requests are ended at launch
 *    (so their requesters are told they never ran);
 * K4 the view is out of order, or its dates are not ISO, or it does not say the queue is paused and why;
 * K5 someone acts on a queue who may not: a worker pauses another agent's queue, reads what others sent it, or moves
 *    or cancels an item it did not send; another project's agent acts at all; or the owner, the project's
 *    orchestrator or Tars are refused.
 */

let home: string;
let store: typeof import('../../../electron/services/agent-queues');
let line: typeof import('../../../electron/core/one-task');

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-queue-store-'));
  vi.resetModules();
  vi.doMock('../../../electron/constants', async (orig) => {
    const actual = await orig<typeof import('../../../electron/constants')>();
    return { ...actual, PRIVATE_DIR: path.join(home, '.tars-private'), privatePath: (...s: string[]) => path.join(home, '.tars-private', ...s), DATA_DIR: path.join(home, '.tars') };
  });
  line = await import('../../../electron/core/one-task');
  store = await import('../../../electron/services/agent-queues');
});
afterEach(() => {
  store.stopQueueKeeping();
  vi.doUnmock('../../../electron/constants');
  fs.rmSync(home, { recursive: true, force: true });
});

const FILE = () => path.join(home, '.tars-private', 'agent-queues.json');

describe('kept in ~/.tars-private', () => {
  it('K1: written at 0600 under ~/.tars-private on a change, with only what can be handed over again', () => {
    const q = line.createOneTaskQueue(0);
    store.keepQueue(q);
    q.enqueue('w', { title: 'with replay', how: 'task', replay: { kind: 'run-task', task: 'x' } }, 1, 't-00000001');
    q.enqueue('w', { title: 'no replay' }, 2, 't-00000002');
    const kept = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    expect(kept.items.map((i: { ref: string }) => i.ref)).toEqual(['t-00000001']);
    if (process.platform !== 'win32') expect(fs.statSync(FILE()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(home, '.tars', 'agent-queues.json'))).toBe(false);
  });

  it('K2: a file that is not JSON, or of another shape, restores nothing and throws nothing', () => {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    for (const text of ['{ not json', '[]', '{"items": 4}', '{"items": [{"ref": 5}]}']) {
      fs.writeFileSync(FILE(), text);
      const q = line.createOneTaskQueue(0);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(store.restoreQueues(q, () => {})).toEqual([]);
      expect(q.snapshot().items).toEqual([]);
      warn.mockRestore();
    }
  });
});

describe('restored at launch', () => {
  it('K3: paused, in order, handed over again once resumed, and their ids known before the requests are ended', () => {
    const before = line.createOneTaskQueue(0);
    store.keepQueue(before);
    before.enqueue('w', { title: 'c', how: 'task', replay: { kind: 'run-task', task: 'c' } }, 1, 't-0000000c');
    before.enqueue('w', { title: 'a', how: 'message', replay: { kind: 'dispatch', opts: { message: 'a' } } }, 2, 't-0000000a');
    before.enqueue('v', { title: 'other agent', how: 'task', replay: { kind: 'run-task', task: 'o' } }, 3, 't-0000000f');
    before.pause('v', 'stopped by Project Lead', 4);
    store.stopQueueKeeping();

    expect([...store.keptQueueRefs()].sort()).toEqual(['t-0000000a', 't-0000000c', 't-0000000f']);
    const after = line.createOneTaskQueue(100);
    const replayed: string[] = [];
    const restored = store.restoreQueues(after, (item) => replayed.push(item.ref), 200);
    expect(restored.map((i) => i.ref)).toEqual(['t-0000000c', 't-0000000a', 't-0000000f']);
    expect(replayed).toEqual(['t-0000000c', 't-0000000a', 't-0000000f']);
    expect(after.pausedOf('w')).toEqual({ since: 200, why: 'Tars restarted' });
    // A pause it had before keeps its reason.
    expect(after.pausedOf('v')).toEqual({ since: 4, why: 'stopped by Project Lead' });
    expect(after.takeTurn('w', 't-0000000c', undefined)).toBe(false);
  });
});

describe('the view', () => {
  it('K4: in order, ISO dates, paused and why', () => {
    const q = line.createOneTaskQueue(0);
    q.enqueue('w', { title: 'one', requesterId: 'lead', from: 'Project Lead', how: 'task' }, Date.parse('2026-10-28T10:00:00Z'), 't-00000001');
    q.enqueue('w', { title: 'two', requesterId: 'other', from: 'Other Worker', how: 'note' }, Date.parse('2026-10-28T10:01:00Z'), 't-00000002');
    q.pause('w', 'by the owner', Date.parse('2026-10-28T10:02:00Z'));
    expect(store.queueView(q, 'w')).toEqual({
      agentId: 'w',
      paused: { since: '2026-10-28T10:02:00.000Z', why: 'by the owner' },
      items: [
        { ref: 't-00000001', position: 1, requesterId: 'lead', from: 'Project Lead', how: 'task', title: 'one', queuedAt: '2026-10-28T10:00:00.000Z' },
        { ref: 't-00000002', position: 2, requesterId: 'other', from: 'Other Worker', how: 'note', title: 'two', queuedAt: '2026-10-28T10:01:00.000Z' },
      ],
    });
  });
});

describe('who may act on it', () => {
  const fleet = {
    lead: { id: 'lead', role: 'orchestrator', projectPath: '/p' },
    worker: { id: 'worker', role: 'worker', projectPath: '/p' },
    other: { id: 'other', role: 'worker', projectPath: '/p' },
    runner: { id: 'runner', role: 'orchestrator', kind: 'chat', projectPath: '/p' },
    stranger: { id: 'stranger', role: 'orchestrator', projectPath: '/q' },
  };
  const item = (requesterId?: string) => ({ ref: 't-00000001', agentId: 'worker', title: 'x', queuedAt: 0, ...(requesterId ? { requesterId } : {}) });

  it('K5: Tars, the owner and the project\'s orchestrator do everything; a worker only what it sent; another project nothing', () => {
    const target = fleet.worker;
    for (const caller of [{ kind: 'tars' as const }, { kind: 'owner' as const }, { kind: 'agent' as const, agent: fleet.lead }]) {
      for (const op of ['list', 'pause', 'resume', 'move', 'cancel'] as const) expect(store.queueRight(caller, target, op, item('other')), `${caller.kind} ${op}`).toEqual({ ok: true, all: true });
    }
    const other = { kind: 'agent' as const, agent: fleet.other };
    expect(store.queueRight(other, target, 'list')).toEqual({ ok: true, all: false });
    expect(store.queueRight(other, target, 'pause').ok).toBe(false);
    expect(store.queueRight(other, target, 'resume').ok).toBe(false);
    expect(store.queueRight(other, target, 'move', item('lead')).ok).toBe(false);
    expect(store.queueRight(other, target, 'cancel', item('lead')).ok).toBe(false);
    expect(store.queueRight(other, target, 'move', item('other'))).toEqual({ ok: true, all: false });
    expect(store.queueRight(other, target, 'cancel', item('other'))).toEqual({ ok: true, all: false });
    // A chat's runner is a requester like any other: what it sent.
    expect(store.queueRight({ kind: 'agent', agent: fleet.runner }, target, 'pause').ok).toBe(false);
    expect(store.queueRight({ kind: 'agent', agent: fleet.runner }, target, 'cancel', item('runner')).ok).toBe(true);
    // Another project: nothing, its own orchestrator included.
    for (const op of ['list', 'pause', 'resume', 'move', 'cancel'] as const) expect(store.queueRight({ kind: 'agent', agent: fleet.stranger }, target, op, item('stranger')).ok, op).toBe(false);
  });
});
