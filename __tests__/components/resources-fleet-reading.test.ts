import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred } from './hook-runtime';
import { useFleetResources, FLEET_READ_EVERY_MS } from '../../src/components/Resources/hooks';
import { worktreeTotal } from '../../src/components/Resources/FleetView';
import type { AgentResources, FleetResources } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Resources · agents and projects reads the fleet while it is shown (the QA's F6 on the 2.0.5 train, the Backend's
 * note): the main process reads the process table only when asked (one table every 2 s at most) and sends
 * resources:changed only while it measures the disk, so a view that read once at mount kept an agent started after it
 * "not read", and never showed the child it spawned.
 *
 * How it can fail, written before the change:
 * 1. the view reads the fleet once and never again: a later reading never reaches it;
 * 2. it goes on reading once the view is gone (a timer left behind);
 * 3. it asks faster than the main process reads (2 s), or piles a read on one still in flight;
 * 4. before any disk measure, a project whose agents have no worktree or an unmeasured one reads "0 B" of worktrees,
 *    when null means not measured (the contract), as its agents' cells say.
 */

const fleet = (readAt: number) => ({ readAt, diskMeasuredAt: null, measuring: null, projects: [] }) as unknown as FleetResources;

function agent(over: Partial<AgentResources>): AgentResources {
  return { id: 'a', name: 'A', status: 'idle', statusSince: null, memMb: null, cpuPct: null, processes: [], worktrees: [], tmp: null, outlived: null, ...over };
}

let read: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  read = vi.fn();
  (globalThis as { window?: unknown }).window = { electronAPI: { resources: { read, onChanged: () => () => {}, measureDisk: async () => ({ success: true }) } } };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe('the fleet is read while the view is shown', () => {
  it('a later reading reaches the view (1)', async () => {
    const first = fleet(1);
    const second = fleet(2);
    read.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const m = mount(() => useFleetResources());
    await settle();
    expect(m.result.state).toBe(first);
    vi.advanceTimersByTime(FLEET_READ_EVERY_MS);
    await settle();
    expect(m.result.state).toBe(second);
  });

  it('stops reading once the view is gone (2)', async () => {
    read.mockResolvedValue(fleet(1));
    const m = mount(() => useFleetResources());
    await settle();
    m.unmount();
    const calls = read.mock.calls.length;
    vi.advanceTimersByTime(FLEET_READ_EVERY_MS * 5);
    await settle();
    expect(read.mock.calls.length).toBe(calls);
  });

  it('never asks faster than the main process reads, nor over a read in flight (3)', async () => {
    expect(FLEET_READ_EVERY_MS).toBeGreaterThanOrEqual(2000);
    const slow = deferred<FleetResources>();
    read.mockReturnValueOnce(slow.promise);
    mount(() => useFleetResources());
    vi.advanceTimersByTime(FLEET_READ_EVERY_MS * 3);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    slow.resolve(fleet(1));
    await settle();
  });
});

describe('a project\'s worktrees before any measure (4)', () => {
  it('reads not measured, never 0 B, when its only worktree is unmeasured', () => {
    const reviewer = agent({ id: 'r', worktrees: [] });
    const builder = agent({ id: 'b', worktrees: [{ path: '/p/.worktrees/a', bytes: null }] });
    expect(worktreeTotal([reviewer, builder])).toBeNull();
  });

  it('adds what was measured, an agent with no worktree adding nothing', () => {
    const reviewer = agent({ id: 'r', worktrees: [] });
    const builder = agent({ id: 'b', worktrees: [{ path: '/p/.worktrees/a', bytes: 3 * 1024 * 1024 }] });
    expect(worktreeTotal([reviewer, builder])).toBe(3 * 1024 * 1024);
    expect(worktreeTotal([reviewer])).toBe(0);
  });
});
