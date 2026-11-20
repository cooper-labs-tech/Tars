import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * AgentStatus.statusSince: when the agent's current status began (#159, the
 * Chat's direction A, "since 09:48" and "4m").
 *
 * How it fails, written before the code (2026-09-24):
 * 1. It is set only where somebody remembered: forty lines assign `status`,
 *    across the hooks, the routes, the bots and the handlers, and a status
 *    changed on a line that forgot says a "since" that belongs to the one
 *    before it.
 * 2. It moves when the status is written again with the same value: a Stop
 *    hook posting `idle` on an idle agent would restart "idle for 4m".
 * 3. It moves with lastActivity, which every repaint of the terminal touches:
 *    that is the field it replaces, for that reason.
 * 4. An agent's object replaced in the map (a create over an old id) starts
 *    its "since" again while its status has not changed.
 * 5. It goes missing where the renderer reads it: the agents:tick roster
 *    names its fields one by one, and a field not named there is not sent.
 * 6. The status itself stops being saved: agents.json must keep it as a plain
 *    field, as every other reader of the file expects.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-since-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.8.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
const pushed = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); },
}));

type AgentStatus = import('../../../electron/types').AgentStatus;
let manager: typeof import('../../../electron/core/agent-manager');

function agent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id, name: `Agent ${id}`, status: 'idle', projectPath: tmp, output: [], skills: [],
    lastActivity: new Date().toISOString(), provider: 'claude', ...over,
  } as AgentStatus;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-24T09:00:00.000Z') });
  pushed.length = 0;
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  manager.agents.clear();
});

afterEach(() => {
  manager.stopAgentAutosave();
  vi.useRealTimers();
});

describe('when an agent status began', () => {
  it('is stamped when the agent joins the fleet, and moves when its status changes, wherever that is written', () => {
    manager.agents.set('a', agent('a'));
    const a = manager.agents.get('a')!;
    expect(a.statusSince).toBe('2026-09-24T09:00:00.000Z');

    vi.setSystemTime(new Date('2026-09-24T09:48:00.000Z'));
    a.status = 'running';

    expect(a.statusSince).toBe('2026-09-24T09:48:00.000Z');
  });

  it('does not move when the same status is written again, nor with lastActivity', () => {
    manager.agents.set('a', agent('a', { status: 'running' }));
    const a = manager.agents.get('a')!;
    const since = a.statusSince;

    vi.setSystemTime(new Date('2026-09-24T09:04:00.000Z'));
    a.status = 'running';
    a.lastActivity = new Date().toISOString();

    expect(a.statusSince).toBe(since);
  });

  it('keeps its time when the object is replaced with the same status, and restarts it with another', () => {
    manager.agents.set('a', agent('a', { status: 'waiting' }));
    const since = manager.agents.get('a')!.statusSince;
    vi.setSystemTime(new Date('2026-09-24T09:10:00.000Z'));

    manager.agents.set('a', agent('a', { status: 'waiting' }));
    expect(manager.agents.get('a')!.statusSince).toBe(since);

    manager.agents.set('a', agent('a', { status: 'error' }));
    expect(manager.agents.get('a')!.statusSince).toBe('2026-09-24T09:10:00.000Z');
  });

  it('saves the status as a plain field, and statusSince beside it', () => {
    manager.loadAgents();
    manager.agents.set('a', agent('a'));
    manager.agents.get('a')!.status = 'running';

    const copy = JSON.parse(JSON.stringify(manager.agents.get('a')));
    expect(copy.status).toBe('running');
    expect(copy.statusSince).toBe('2026-09-24T09:00:00.000Z');
    expect({ ...manager.agents.get('a')! }.status).toBe('running');
  });

  it('reaches the renderer on agents:tick', async () => {
    manager.agents.set('a', agent('a'));
    vi.setSystemTime(new Date('2026-09-24T09:30:00.000Z'));
    manager.agents.get('a')!.status = 'waiting';
    const { scheduleTick } = await import('../../../electron/utils/agents-tick');

    scheduleTick();
    await vi.advanceTimersByTimeAsync(600);

    const tick = pushed.filter(p => p.channel === 'agents:tick').at(-1)!.payload as Array<{ id: string; statusSince?: string }>;
    expect(tick.find(t => t.id === 'a')?.statusSince).toBe('2026-09-24T09:30:00.000Z');
  });
});
