import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The name a project's room goes by in the Chat's list: its folder's.
 *
 * How it can fail, each case below:
 *  - on Windows the room is named by the whole path (`C:\...\1212-capital`),
 *    since a `\` is not a `/`, or by nothing for a path that ends in one;
 *  - a drive root is named by an empty string instead of its path;
 *  - darwin and linux change: a trailing `/` stops naming the folder before
 *    it, a root stops being named by its path, or a `\` starts splitting.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bus-title-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    DATA_DIR: tmp,
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    BUS_FILE: path.join(tmp, 'bus.json'),
    dataPath: (f: string) => path.join(tmp, f),
  };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type AgentStatus = import('../../../electron/types').AgentStatus;

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const runningOn = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value });

let store: typeof import('../../../electron/services/bus-store');
let manager: typeof import('../../../electron/core/agent-manager');

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  store = await import('../../../electron/services/bus-store');
  manager.agents.clear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  manager.agents.clear();
});

/** The title of the room of each project, in the order given. */
function titlesOf(projectPaths: string[]): string[] {
  projectPaths.forEach((projectPath, i) => {
    manager.agents.set(`a${i}`, {
      id: `a${i}`, name: `A${i}`, status: 'idle', provider: 'claude', projectPath, skills: [], output: [],
      lastActivity: new Date().toISOString(),
    } as unknown as AgentStatus);
  });
  const rooms = store.listRooms().filter(r => r.kind === 'project');
  return projectPaths.map(p => rooms.find(r => r.projectPath === p)!.title);
}

describe('the title of a project room', () => {
  it('win32: the folder, whichever separator the path uses, and a drive root by its path', () => {
    runningOn('win32');
    expect(titlesOf([
      'C:\\Users\\someone\\projects\\1212-capital', 'C:\\work\\tars\\', 'D:/work/orion', '\\\\srv\\share\\atlas', 'C:\\',
    ])).toEqual(['1212-capital', 'tars', 'orion', 'atlas', 'C:\\']);
  });

  it('darwin and linux: as before, the last folder, a trailing / included, a root by its path, a \\ an ordinary character', () => {
    for (const os of ['darwin', 'linux'] as const) {
      runningOn(os);
      manager.agents.clear();
      expect(titlesOf(['/Users/someone/tars', '/srv/orion/', '/', 'C:\\work\\atlas'])).toEqual(['tars', 'orion', '/', 'C:\\work\\atlas']);
    }
  });
});
