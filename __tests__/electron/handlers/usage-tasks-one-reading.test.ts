/**
 * usage:tasks reads through oneReadingAtATime (#410), seen through the real handler.
 *
 * The helper is pinned by one-reading-at-a-time.test.ts. Its wiring in ipc-handlers.ts was pinned by nothing: with
 * the handler calling tasksReport directly (the QA's W2b on #410), every unit test passed, and the e2e specs check
 * only results.
 *
 * How it fails, written before the test (2026-10-15):
 * 1. Two asks at once for the same question each read the transcripts: the Usage page asks again at each new figure,
 *    before the last answer is in (62 asks in 10 minutes, the main process's heap at 1 to 2.2 GB).
 * 2. An ask for another question starts its reading while one is under way: two readings at once.
 * The reading is tasksReport, slowed, which counts its calls and how many run at once.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tmpHome, reading } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-usage-tasks-ipc-${process.pid}-${Date.now()}`,
  reading: { asked: [] as unknown[], running: 0, most: 0 },
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.2', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/services/task-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/task-watch')>()),
  tasksReport: async (query: unknown) => {
    reading.asked.push(query);
    reading.running += 1;
    reading.most = Math.max(reading.most, reading.running);
    await new Promise((resolve) => setTimeout(resolve, 50));
    reading.running -= 1;
    return { tasks: [], query };
  },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AppSettings } from '../../../electron/types';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}
registerIpcHandlers(deps());
const ask = (query: unknown) => handlers.get('usage:tasks')!({}, query);

beforeEach(() => {
  reading.asked.length = 0;
  reading.most = 0;
});

describe('usage:tasks, one reading at a time', () => {
  it('1. two asks at once for the same question make one reading, and both get its answer', async () => {
    const [first, second] = await Promise.all([ask({ sinceDays: 7 }), ask({ sinceDays: 7 })]);
    expect(reading.asked).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('2. an ask for another question waits for the reading under way', async () => {
    await Promise.all([ask({ sinceDays: 7 }), ask({ sinceDays: 30 })]);
    expect(reading.asked).toHaveLength(2);
    expect(reading.most).toBe(1);
  });
});
