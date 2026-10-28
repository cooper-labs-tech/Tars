import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Vault's change watcher and a project-files root that is a link (the Audit's Info at 5a7a1266 on #530).
 *
 * The listing refuses a ~/.tars/project-files that is itself a link (vault-project-tree.test.ts, T8). The watcher
 * started on the same path all the same, and followed it: planted as `-> ~`, it would watch the whole home folder,
 * recursively (on Linux, one inotify watch per folder), and tell the window the folder names of every change.
 *
 * Every way it can fail, written before the code (2026-10-28):
 *  W1. The watcher starts on a root that is a link, and a change in the folder it points at is told to the window.
 *  W2. With a real root, a change in a project folder is no longer told (the check refuses too much).
 */

type Handler = (event: unknown, params?: Record<string, unknown>) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const told = vi.hoisted(() => [] as Array<{ channel: string; data: unknown }>);
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, h: Handler) => { handlers.set(channel, h); } },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: (channel: string, data: unknown) => told.push({ channel, data }) }));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));

const root = () => path.join(os.homedir(), '.tars', 'project-files');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  told.length = 0;
  fs.rmSync(root(), { recursive: true, force: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function startWatch() {
  const { registerVaultProjectFilesHandlers } = await import('../../../electron/handlers/vault-project-files-handlers');
  registerVaultProjectFilesHandlers();
  await handlers.get('vault:project-folders')!({});
  await wait(300);
}

describe.skipIf(process.platform === 'win32')('the change watcher', () => {
  it('W1. does not watch a root that is a link, nor tell a change where it points', async () => {
    const home = fs.mkdtempSync(path.join(os.homedir(), 'linked-home-'));
    fs.mkdirSync(path.join(home, 'projectx-0123456789', 'reports'), { recursive: true });
    fs.mkdirSync(path.dirname(root()), { recursive: true });
    fs.symlinkSync(home, root());
    try {
      await startWatch();
      fs.writeFileSync(path.join(home, 'projectx-0123456789', 'reports', 'secret-name.md'), 'x');
      await wait(1_000);
      expect(told.filter(t => t.channel === 'vault:project-files:changed')).toEqual([]);
    } finally {
      fs.rmSync(root(), { force: true });
    }
  });

  it('W2. still tells a change in a project folder under a real root', async () => {
    fs.mkdirSync(path.join(root(), 'projecty-0123456789', 'reports'), { recursive: true });
    await startWatch();
    fs.writeFileSync(path.join(root(), 'projecty-0123456789', 'reports', 'r.md'), 'x');
    await expect.poll(() => told.filter(t => t.channel === 'vault:project-files:changed').length, { timeout: 5_000 }).toBeGreaterThan(0);
  });
});
