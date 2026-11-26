import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What shell:reveal and app:openExternal answer the window (2.0.7), through the handlers as main registers them.
 *
 * How it fails, written before the code (2026-11-26):
 *  H1. (The Audit's M1 on #650) A folder the Projects page and Review list from Claude Code's own history
 *      (~/.claude/projects, a folder used with Claude Code outside Tars or by an agent since removed) refused: the
 *      button does nothing. It must be shown, as a project added by hand is.
 *  H2. A folder Tars does not know, nor Claude Code, shown.
 *  H3. app:openExternal answers success for a URL that is not https, or refuses an https one.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '2.0.7', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  // Stood in for: nothing is shown or opened on the machine the suite runs on.
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<{ success: boolean; error?: string }>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { DATA_DIR } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const agents = new Map<string, AgentStatus>();
function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, getClaudeSkills: async () => [] };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

// The suite's throwaway home (__tests__/setup/home-isolation.ts).
const home = os.homedir();
/** Claude Code's folder name for a path, written out here rather than imported from the app. */
const claudeFolder = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const reveal = (p: unknown) => handlers.get('shell:reveal')!({}, { path: p });
const openExternal = (url: unknown) => handlers.get('app:openExternal')!({}, url);

beforeEach(() => {
  handlers.clear();
  agents.clear();
  for (const d of ['projects', 'elsewhere', '.claude']) fs.rmSync(path.join(home, d), { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '[]');
  registerIpcHandlers(deps());
});

describe('shell:reveal', () => {
  it('H1. a folder Claude Code has worked in is shown, as the Projects page and Review list it', async () => {
    const seen = path.join(home, 'projects', 'seen-by-claude');
    fs.mkdirSync(seen, { recursive: true });
    const folder = path.join(home, '.claude', 'projects', claudeFolder(seen));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '0b6f2a4e-9c1d-4e8a-b7f3-2d5c8e1a9f04.jsonl'), `${JSON.stringify({
      type: 'user', sessionId: '0b6f2a4e-9c1d-4e8a-b7f3-2d5c8e1a9f04', cwd: seen, timestamp: '2026-11-26T01:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    })}\n`);
    expect(await reveal(seen)).toEqual({ success: true });
  });

  it('H2. a folder neither Tars nor Claude Code knows is refused', async () => {
    const stranger = path.join(home, 'elsewhere', 'stranger');
    fs.mkdirSync(stranger, { recursive: true });
    expect((await reveal(stranger)).success).toBe(false);
  });
});

describe('app:openExternal', () => {
  it('H3. https only', async () => {
    for (const url of ['http://example.org/', 'file:///tmp/notes.txt', 'tars-x://open', 42]) {
      expect((await openExternal(url)).success, String(url)).toBe(false);
    }
    expect(await openExternal('https://github.com/cooper-labs-tech/Tars/releases/latest')).toEqual({ success: true });
  });
});
