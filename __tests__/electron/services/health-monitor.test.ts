import { describe, it, expect } from 'vitest';
import { SlowCalls, timeIpcHandlers, IpcChannels } from '../../../electron/services/health/monitor';
import { abruptEndPayload } from '../../../electron/services/health/abrupt-end';
import type { HealthSample } from '../../../electron/services/health/samples';

/**
 * What a health sample says of the IPC handlers, and what the report of an abrupt end says of the run it follows
 * (2.0.3, monitoring options 1 and 2).
 *
 * How it fails, written before the code:
 * The handlers, timed where they are registered
 * 1. Timing changes a handler: its answer is altered, or its error swallowed or replaced.
 * 2. A channel's slowest call is not the one kept (an average, the last one).
 * 3. The calls of an earlier window are counted again in the next sample.
 * 4. More than three are listed, or not the slowest first.
 * The abrupt end
 * 5. A sample from before that run started is taken for its last.
 * 6. The uptime stops at the run record's last write, hours before the end, when a later sample says it ran on.
 * 7. A run record that does not say its version gives a version anyway.
 * And from the Audit's Low 1 on #418
 * 8. A channel this Tars never registered is taken as one of its own (what leaves is checked against this list).
 */

type Handler = (event: unknown, ...args: unknown[]) => unknown;
function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return { handlers, handle(channel: string, fn: Handler) { handlers.set(channel, fn); } };
}

describe('the IPC handlers, timed where they are registered', () => {
  it('8. the channels registered are known, and only those', () => {
    const ipc = fakeIpc();
    const channels = new IpcChannels();
    timeIpcHandlers(ipc, new SlowCalls(), channels);
    ipc.handle('usage:tasks', () => 1);
    ipc.handle('diagnostic:send', () => 2);
    expect([...channels.known()].sort()).toEqual(['diagnostic:send', 'usage:tasks']);
  });

  it('1. a handler answers and fails as it did', async () => {
    const ipc = fakeIpc();
    const calls = new SlowCalls();
    timeIpcHandlers(ipc, calls);
    const boom = new Error('refused');
    ipc.handle('a:ok', (_e, x) => ({ got: x }));
    ipc.handle('a:fail', async () => { throw boom; });
    expect(await ipc.handlers.get('a:ok')!({}, 7)).toEqual({ got: 7 });
    await expect(ipc.handlers.get('a:fail')!({})).rejects.toBe(boom);
    expect(calls.take().map((c) => c.channel).sort()).toEqual(['a:fail', 'a:ok']);
  });

  it('2-4. the three slowest, by their slowest call, once', () => {
    const calls = new SlowCalls();
    for (const [channel, ms] of [['a', 5], ['a', 400], ['a', 10], ['b', 90], ['c', 120], ['d', 1]] as const) calls.note(channel, ms);
    expect(calls.take()).toEqual([{ channel: 'a', ms: 400 }, { channel: 'c', ms: 120 }, { channel: 'b', ms: 90 }]);
    expect(calls.take()).toEqual([]);
  });
});

const sample = (at: number, over: Partial<HealthSample> = {}): HealthSample => ({
  at, heapUsedMb: 120, heapTotalMb: 180, rssMb: 400, loopP50Ms: 11, loopP95Ms: 30, slowest: [], agents: 45, running: 3, page: '/usage', ...over,
});
const START = Date.UTC(2026, 9, 15, 8, 0, 0);

describe('the report of an abrupt end', () => {
  it('5-6. the last sample of that run, and its uptime to it', () => {
    const before = sample(START - 60_000, { page: '/agents' });
    const last = sample(START + 300 * 60_000);
    const payload = abruptEndPayload({ startedAt: START, lastWriteAt: START + 10 * 60_000, version: '2.0.2' }, [before, sample(START + 5 * 60_000), last], 'EXC_BREAKPOINT');
    expect(payload).toEqual({ previousVersion: '2.0.2', uptimeMinutes: 300, crashType: 'EXC_BREAKPOINT', lastSample: last });
  });

  it('5. no sample of that run: none, and the uptime from its record', () => {
    const payload = abruptEndPayload({ startedAt: START, lastWriteAt: START + 42 * 60_000, version: null }, [sample(START - 60_000)], null);
    expect(payload).toEqual({ previousVersion: null, uptimeMinutes: 42, crashType: null, lastSample: null });
  });
});
