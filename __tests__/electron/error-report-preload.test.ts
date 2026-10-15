import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The bridge the renderer's Sentry SDK talks to main through.
 *
 * The window is sandboxed, so its preload cannot load @sentry/electron's own
 * preload: Tars's preload exposes the object that one would
 * (`window.__SENTRY_IPC__['sentry-ipc']`), with the renderer's errors passed
 * to main (IPCMode.Classic in main), where report.ts rebuilds them.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A function the renderer SDK calls is missing: it throws in the page, or
 *    falls back to a protocol main never registers.
 * 2. The renderer's scope reaches main: its user, extra, breadcrumbs and
 *    attachments would be merged into main's scope and ride on main's errors.
 *    So would its feedback, its logs, its metrics and its status pings.
 * 3. An SDK upgrade adds a function to its preload and Tars's bridge does not
 *    have it: the list is read from the installed SDK, not copied here.
 */

const exposed: Record<string, unknown> = {};
const sent: Array<[string, unknown[]]> = [];
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => { sent.push([channel, args]); }),
    on: vi.fn(), removeListener: vi.fn(),
    send: vi.fn((channel: string, ...args: unknown[]) => { sent.push([channel, args]); }),
  },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.1', on: vi.fn() },
}));

type Bridge = Record<string, (...args: unknown[]) => unknown>;
let bridge: Bridge;

beforeAll(async () => {
  await import('../../electron/preload');
  bridge = (exposed.__SENTRY_IPC__ as Record<string, Bridge> | undefined)?.['sentry-ipc'] as Bridge;
});

describe('the Sentry bridge in the preload', () => {
  it('3, 1. has every function the installed SDK\'s preload gives the renderer', () => {
    const sdkPreload = fs.readFileSync(path.join(require.resolve('@sentry/electron/preload'), '..', 'index.js'), 'utf-8');
    const names = [...sdkPreload.matchAll(/^\s+(send\w+): \(/gm)].map(m => m[1]).sort();
    expect(names.length, 'read no function from the SDK, so this proves nothing').toBeGreaterThan(3);
    expect(bridge, 'nothing exposed').toBeTruthy();
    expect(Object.keys(bridge).sort()).toEqual(names);
  });

  it('1. passes the renderer\'s start and its envelopes to main', () => {
    sent.length = 0;
    bridge.sendRendererStart();
    bridge.sendEnvelope('envelope bytes');
    expect(sent).toEqual([['sentry-ipc.start', []], ['sentry-ipc.envelope', ['envelope bytes']]]);
  });

  it('2. passes nothing else: no scope, feedback, log, metric or status', async () => {
    sent.length = 0;
    bridge.sendScope(JSON.stringify({ user: { email: 'demo@example.com' }, extra: { prompt: 'x' } }));
    await bridge.sendFeedback('feedback envelope');
    bridge.sendStructuredLog({ body: 'a log' });
    bridge.sendMetric({ name: 'm' });
    bridge.sendStatus({ status: 'alive' });
    expect(sent).toEqual([]);
  });
});
