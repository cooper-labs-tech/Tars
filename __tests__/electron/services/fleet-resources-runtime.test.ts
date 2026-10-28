import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The fleet's resources in the app (fleet-resources-runtime.ts): every list_agents and get_agent reads the process
 * table, and so do the window's reads. The Audit's Low on #546: the two-second limit on `ps` was pinned by nothing (its
 * mutant, a table read at every call, survived).
 *
 * How it fails, written before the code (28/10):
 * R1. Each read runs `ps`: two reads within 2 s must share one table.
 * R2. A table is served past 2 s: a read 2 s after the last `ps` runs it again.
 */

const { ps } = vi.hoisted(() => ({ ps: vi.fn() }));
vi.mock('child_process', async (orig) => ({
  ...(await orig<object>()),
  execFile: (file: string, args: string[], _o: unknown, done: (err: Error | null, out: string) => void) => {
    ps(file, args);
    done(null, '  1     0  1024  0.0 /sbin/launchd\n');
  },
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/tmp' } }));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  ps.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe.skipIf(process.platform === 'win32')('the process table', () => {
  it('R1. two reads within 2 s share one ps', async () => {
    const { readFleetResources, agentResources } = await import('../../../electron/services/fleet-resources-runtime');
    await readFleetResources();
    vi.advanceTimersByTime(1_000);
    await agentResources();
    vi.advanceTimersByTime(999);
    await readFleetResources();
    expect(ps).toHaveBeenCalledTimes(1);
    expect(ps).toHaveBeenCalledWith('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu=,command=']);
  });

  it('R2. a read 2 s after the last ps runs it again', async () => {
    const { readFleetResources } = await import('../../../electron/services/fleet-resources-runtime');
    await readFleetResources();
    vi.advanceTimersByTime(2_000);
    await readFleetResources();
    expect(ps).toHaveBeenCalledTimes(2);
  });
});
