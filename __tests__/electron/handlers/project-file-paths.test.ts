/**
 * The files of a project as the Code panel receives them: project:list-files,
 * project:search-files and project:search-content, through the real handlers.
 *
 * The panel builds its tree by splitting each path on `/`, and joins a path
 * back onto the project the way the project is written (src/lib/display-path.ts,
 * joinPath). The handlers returned paths with the platform's separator, so on
 * Windows `src\app\page.tsx` came back as one name, and the tree was flat.
 *
 * How it fails, written before the code:
 * 1. A file in a folder is listed with `\` between its folders on Windows.
 * 2. The search by file name returns the same.
 * 3. The search in contents returns the same, or no longer reads a file it
 *    found, now that the walk hands it a `/` path to join to the root.
 * 4. A file at the top of the project gets a separator, or loses its name.
 *
 * darwin and linux: the separator already is `/`, and a `\` there is a
 * character of the file's name, which the listing leaves where it is.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-project-files-${process.pid}-${Date.now()}`,
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
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AppSettings } from '../../../electron/types';

fs.mkdirSync(path.join(tmpHome, '.tars'), { recursive: true });
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

/** A project with a file at its top and two in folders, each holding the word `needle`. */
function project(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpHome), 'project-'));
  for (const rel of ['README.md', 'src/app/page.tsx', 'src/lib/needle.ts']) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `// a needle in ${rel}\n`);
  }
  return root;
}

const call = (channel: string, args: unknown) => handlers.get(channel)!({}, args);

describe('the files of a project, as the Code panel receives them', () => {
  it('1, 4. lists every file with `/` between its folders', async () => {
    const root = project();
    const r = await call('project:list-files', { root }) as { success: boolean; files: string[] };
    expect(r.success).toBe(true);
    expect(r.files).toEqual(['README.md', 'src/app/page.tsx', 'src/lib/needle.ts']);
  });

  it('2. finds a file by its name with `/` between its folders', async () => {
    const root = project();
    const r = await call('project:search-files', { root, query: 'NEEDLE' }) as { success: boolean; files: string[] };
    expect(r.files).toEqual(['src/lib/needle.ts']);
  });

  it('3. finds the word in every file, and names each with `/`', async () => {
    const root = project();
    const r = await call('project:search-content', { root, query: 'needle' }) as { success: boolean; hits: { path: string; line: number }[] };
    expect(r.hits.map(h => [h.path, h.line])).toEqual([['README.md', 1], ['src/app/page.tsx', 1], ['src/lib/needle.ts', 1]]);
  });
});
