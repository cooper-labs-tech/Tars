import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Code panel's three channels follow the window's file rules
 * (utils/window-file-access.ts, 2.0.7): project:list-files,
 * project:search-files and project:search-content take a project Tars knows,
 * and read as the window's other channels read.
 *
 * How it fails, written before the code (25/11):
 * S1. A root that is no project Tars knows is taken: the home, ~/.gemini,
 *     ~/.tars-private, ~/.tars, the top of the disk; by list-files,
 *     search-files or search-content.
 * S2. A project Tars knows lets search-content return a line of a secret file
 *     it holds (credentials.json, oauth_creds.json, auth.json,
 *     app-settings.json): judged by isSecretFile, as every other read of the
 *     window is.
 * S3. A project with a file link to a secret, or a folder link to the home,
 *     lets search-content read through it, or the listing walk into it: no
 *     link is followed.
 * S4. A project that is the home or above it, written into ~/.tars/projects.json
 *     (which every agent can write), opens the home.
 * S5. A real project breaks: one added by hand, an agent's folder, an agent's
 *     worktree, or a folder inside one of them, is no longer listed, found or
 *     searched.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.7', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const agents = new Map<string, AgentStatus>();
function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings), getClaudeSkills: async () => [] };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

// The suite's throwaway home (__tests__/setup/home-isolation.ts): stand-in files only.
const home = os.homedir();
const TOKEN = 'FAKE-TOKEN-of-the-test';
const project = path.join(home, 'projects', 'atlas');
const agentFolder = path.join(home, 'work', 'agent-folder');
const worktree = path.join(home, 'work', 'agent-worktree');
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-search-roots-')));

function customProjects(list: string[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(list));
}

/** A link, or false where the system refuses one (a file link on Windows without the right). */
function link(target: string, at: string, type: 'file' | 'junction'): boolean {
  try {
    fs.rmSync(at, { force: true, recursive: false });
    fs.symlinkSync(target, at, type);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  handlers.clear();
  agents.clear();
  for (const d of [path.join(home, '.gemini'), PRIVATE_DIR, path.join(project, 'src'), path.join(agentFolder, 'src'), path.join(worktree, 'src')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: TOKEN, refresh_token: TOKEN }));
  fs.writeFileSync(path.join(PRIVATE_DIR, 'hermes-connection.json'), JSON.stringify({ token: TOKEN }));
  fs.writeFileSync(path.join(home, 'notes.md'), `a token note of the home ${TOKEN}`);
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const token = "a token in the code";\n');
  for (const name of ['credentials.json', 'oauth_creds.json', 'auth.json', 'app-settings.json']) {
    fs.writeFileSync(path.join(project, name), JSON.stringify({ token: TOKEN }));
  }
  fs.writeFileSync(path.join(agentFolder, 'src', 'agent.ts'), 'export const token = "agent";\n');
  fs.writeFileSync(path.join(worktree, 'src', 'tree.ts'), 'export const token = "worktree";\n');
  customProjects([project]);
  agents.set('a1', { id: 'a1', projectPath: agentFolder, worktreePath: worktree } as AgentStatus);
  registerIpcHandlers(deps());
});

afterAll(() => {
  fs.rmSync(box, { recursive: true, force: true });
});

const call = (channel: string, args: unknown) => handlers.get(channel)!({}, args) as Promise<Record<string, unknown>>;
const listFiles = (root: string) => call('project:list-files', { root }) as Promise<{ success: boolean; files?: string[] }>;
const searchFiles = (root: string, query: string) => call('project:search-files', { root, query }) as Promise<{ success: boolean; files?: string[] }>;
const searchContent = (root: string, query: string) => call('project:search-content', { root, query }) as Promise<{ success: boolean; hits?: Array<{ path: string; text: string }> }>;

describe('the Code panel\'s channels', () => {
  it('S1. take no root that is no project Tars knows', async () => {
    for (const root of [home, path.join(home, '.gemini'), PRIVATE_DIR, DATA_DIR, path.parse(home).root]) {
      for (const r of [await listFiles(root), await searchFiles(root, 'json'), await searchContent(root, 'token')]) {
        expect(r.success, root).toBe(false);
        expect(JSON.stringify(r)).not.toContain(TOKEN);
      }
    }
  });

  it('S2. never return a line of a secret file, in a project Tars knows', async () => {
    const r = await searchContent(project, 'token');
    expect(r.success).toBe(true);
    expect(r.hits?.map((h) => h.path)).toEqual(['src/app.ts']);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('S3. follow no link: a file link to a secret, a folder link to the home', async () => {
    const fileLink = link(path.join(home, '.gemini', 'oauth_creds.json'), path.join(project, 'src', 'settings.json'), 'file');
    const noteLink = link(path.join(home, 'notes.md'), path.join(project, 'README.md'), 'file');
    const dirLink = link(home, path.join(project, 'vendor'), 'junction');
    expect(fileLink || noteLink || dirLink).toBe(true);
    const r = await searchContent(project, 'token');
    expect(r.hits?.map((h) => h.path)).toEqual(['src/app.ts']);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const listed = await listFiles(project);
    expect(listed.files?.some((f) => f.startsWith('vendor/'))).toBe(false);
  });

  it('S4. a project that is the home or above it, written by an agent, opens nothing', async () => {
    customProjects([project, home, path.dirname(home)]);
    for (const root of [home, path.dirname(home)]) {
      const r = await searchContent(root, 'token');
      expect(r.success, root).toBe(false);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it('S5. still list, find and search a real project, an agent\'s folder and worktree, and a folder in them', async () => {
    expect((await listFiles(project)).files).toContain('src/app.ts');
    expect((await searchFiles(project, 'app.ts')).files).toEqual(['src/app.ts']);
    expect((await searchContent(agentFolder, 'token')).hits?.map((h) => h.path)).toEqual(['src/agent.ts']);
    expect((await searchContent(worktree, 'token')).hits?.map((h) => h.path)).toEqual(['src/tree.ts']);
    expect((await listFiles(path.join(project, 'src'))).files).toEqual(['app.ts']);
  });
});
