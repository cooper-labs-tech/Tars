/**
 * The window's side of the folders no agent owns (JeanBrasse's choice 16; the frames
 * of #315): system:disk, system:orphanFolders, system:removeOrphanFolders and
 * the progress event, through the real handlers.
 *
 * How it fails, written before the code (2026-10-06):
 * 1. The projects are not Tars's own (projects.json and its agents' projects),
 *    or an agent's worktree is offered for removal.
 * 2. The removal asks nothing of the window but is not told to it as it goes
 *    (no progress event), or answers without what was kept and why.
 * 3. The calls are not in the preload, or the renderer has no type for them.
 * 4. The disk is not the home's.
 * And from the Audit's gate of #334 (M2):
 * 5. An agent whose folder is its projectPath, inside a .worktrees, with no
 *    worktreePath, has its folder offered and removed while no process sits
 *    in it (idle with no terminal, stopped, asleep, Tars just started).
 * 6. (the Audit's recheck) The same for an agent's secondaryProjectPath.
 * And from the Audit's gate of #336 (M1):
 * 7. The removal is not tied to the rows the window showed and the person
 *    confirmed: called with no list, or with something that is not one, it
 *    removes what main finds.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const { tmpHome, pushed } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-orphans-ipc-${process.pid}-${Date.now()}`,
  pushed: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

fs.mkdirSync(path.join(tmpHome, '.dorothy'), { recursive: true });
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

const ROOT = path.join(__dirname, '../../..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function project(name: string): string {
  const p = path.join(fs.realpathSync(tmpHome), 'projects', name);
  fs.mkdirSync(p, { recursive: true });
  git(p, 'init', '-q', '-b', 'main');
  return p;
}

describe("the window's calls", () => {
  // The removal reads the working folder of every process on the machine (lsof) before it touches a folder, which
  // is what this case proves: 2.4 s of the case at a load of 70, past 5 s at 130 (QA's runs of 2.0.1). Its own 30 s,
  // then. Case 7 failed after it there only because this removal was still under way.
  it("1, 2. list and remove the orphans of Tars's projects, never an agent's worktree, telling each step", async () => {
    const added = project('added');
    const agentsOnly = project('agents-only');
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'projects.json'), JSON.stringify([added]));
    fs.mkdirSync(path.join(added, '.worktrees', 'old-one'), { recursive: true });
    fs.writeFileSync(path.join(added, '.worktrees', 'old-one', 'x.txt'), 'x');
    fs.mkdirSync(path.join(agentsOnly, '.worktrees', 'stale'), { recursive: true });
    const owned = path.join(agentsOnly, '.worktrees', 'agent-wt');
    fs.mkdirSync(owned, { recursive: true });
    agents.set('a1', { id: 'a1', name: 'A', status: 'idle', projectPath: agentsOnly, worktreePath: owned, skills: [], output: [] } as unknown as AgentStatus);

    const listing = await handlers.get('system:orphanFolders')!({}) as { folders: Array<{ path: string }>; count: number };
    expect(listing.folders.map(f => f.path).sort()).toEqual([
      path.join(added, '.worktrees', 'old-one'), path.join(agentsOnly, '.worktrees', 'stale'),
    ].sort());

    const report = await handlers.get('system:removeOrphanFolders')!({}, listing.folders.map(f => f.path)) as { removed: number; kept: unknown[] };
    if (process.platform === 'win32') {
      // Windows has no lsof and no /proc: whether a process works in a folder
      // cannot be read there, so every folder is kept, as when lsof fails on
      // macOS (processCwds), and each is still told as it goes.
      expect(report.removed).toBe(0);
      expect(report.kept.map(k => (k as { reason: string }).reason)).toEqual(['unknown-use', 'unknown-use']);
    } else {
      expect(report.removed).toBe(2);
      expect(report.kept).toEqual([]);
    }
    expect(fs.existsSync(owned)).toBe(true);
    const steps = pushed.filter(p => p.channel === 'system:orphanFolders:progress').map(p => p.payload as { done: number; total: number });
    expect(steps.map(s => [s.done, s.total])).toEqual([[1, 2], [2, 2]]);
  }, 30_000);

  it("5. never offers an agent's own project folder inside a .worktrees", async () => {
    const host = project('host');
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'projects.json'), JSON.stringify([host]));
    const folder = path.join(host, '.worktrees', 'agent-project');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'work'), 'mine\n');
    agents.clear();
    agents.set('a2', { id: 'a2', name: 'B', status: 'idle', projectPath: folder, skills: [], output: [] } as unknown as AgentStatus);

    const listing = await handlers.get('system:orphanFolders')!({}) as { folders: Array<{ path: string }> };
    expect(listing.folders.map(f => f.path)).not.toContain(folder);
    await handlers.get('system:removeOrphanFolders')!({}, [folder]);
    expect(fs.readFileSync(path.join(folder, 'work'), 'utf8')).toBe('mine\n');
  });

  it("6. never offers an agent's secondary project folder inside a .worktrees", async () => {
    const host = project('host2');
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'projects.json'), JSON.stringify([host]));
    const folder = path.join(host, '.worktrees', 'second-home');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'work'), 'mine\n');
    agents.clear();
    agents.set('a3', { id: 'a3', name: 'C', status: 'idle', projectPath: host, secondaryProjectPath: folder, skills: [], output: [] } as unknown as AgentStatus);

    const listing = await handlers.get('system:orphanFolders')!({}) as { folders: Array<{ path: string }> };
    expect(listing.folders.map(f => f.path)).not.toContain(folder);
    await handlers.get('system:removeOrphanFolders')!({}, [folder]);
    expect(fs.readFileSync(path.join(folder, 'work'), 'utf8')).toBe('mine\n');
  });

  it('7. removes nothing when the window names no folder, or sends something that is not a list of paths', async () => {
    const host = project('host3');
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'projects.json'), JSON.stringify([host]));
    const stray = path.join(host, '.worktrees', 'stray');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'x.txt'), 'x');
    agents.clear();

    for (const sent of [undefined, 'all', [42], { paths: [stray] }]) {
      expect(await handlers.get('system:removeOrphanFolders')!({}, sent), JSON.stringify(sent ?? null)).toEqual({ error: expect.stringContaining('list of paths') });
    }
    expect(await handlers.get('system:removeOrphanFolders')!({}, [])).toEqual({ removed: 0, freedBytes: 0, kept: [] });
    expect(fs.existsSync(path.join(stray, 'x.txt'))).toBe(true);
  });

  it("4. the disk is the home's, with the 30 GB floor", async () => {
    const disk = await handlers.get('system:disk')!({}) as { freeBytes: number; totalBytes: number; floorBytes: number };
    const s = fs.statfsSync(tmpHome);
    expect(disk.totalBytes).toBe(s.blocks * s.bsize);
    expect(disk.floorBytes).toBe(30 * 1024 ** 3);
  });

  it('3. the calls are in the preload, and typed for the renderer, together', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8');
    const types = fs.readFileSync(path.join(ROOT, 'src/types/electron.d.ts'), 'utf8');
    for (const channel of ['system:disk', 'system:orphanFolders']) {
      expect(preload).toContain(`ipcRenderer.invoke('${channel}')`);
    }
    expect(preload).toContain("ipcRenderer.invoke('system:removeOrphanFolders', paths)");
    expect(preload).toContain("'system:orphanFolders:progress'");
    for (const name of ['disk: () => Promise<DiskSpace | null>', 'orphanFolders: () => Promise<OrphanListing>',
      'removeOrphanFolders: (paths: string[]) => Promise<OrphanRemovalReport | { error: string }>',
      'onOrphanRemovalProgress: (callback: (progress: OrphanRemovalProgress) => void) => () => void']) {
      expect(types).toContain(name);
    }
  });
});
