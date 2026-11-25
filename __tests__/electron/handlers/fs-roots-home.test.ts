import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * No project root opens the home (security, every platform).
 *
 * fs:read-text-file and fs:write-text-file take the projects the user added
 * as roots; fs:read-project-files takes those, the agents' folders and the
 * folders Claude has seen; local-file:// takes the added projects. None of
 * them looked at what the project was: a project equal to the home, or a
 * folder above it (`/Users`, `/home`), made every file of the home readable,
 * and through fs:write-text-file writable (a shell profile, an SSH key).
 * fs:read-project-files refused the home by its exact string only. One
 * "Add project" in the UI, or one line in ~/.tars/projects.json, which
 * every agent can write.
 *
 * How it can fail, written before the fix (2026-09-28):
 * 1. fs:read-text-file reads a file of the home through a project that is the
 *    home, a folder above it, or the home with a trailing separator.
 * 2. fs:write-text-file writes one the same ways.
 * 3. fs:read-project-files reads one through such a project, or through an
 *    agent whose folder is the home or above it.
 * 4. local-file:// serves one through such a project.
 * 5. The same through a link to the home.
 * 6. A project under the home is refused: the guard breaks the Brain page.
 * 7. A project the target is not under is looked at on the disk anyway: one
 *    project on a share nobody answers for would freeze every read and write
 *    of every other project, on the main thread.
 * Added before its code after the Audit's L3 on #648 (2026-11-26):
 * 8. fs:read-project-files reads a file of a folder the project rule refuses
 *    (a folder of credentials, an application folder of the home, a dot
 *    folder of the home but the four CLI folders), held as a project in
 *    ~/.tars/projects.json or as an agent's folder; or, over-correcting, no
 *    longer reads ~/.agents or a project in iCloud Drive.
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
    getVersion: () => '1.9.1', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: (scheme: string, handler: unknown) => { protocols.set(scheme, handler as Protocol); }, registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type Protocol = (request: { url: string }) => Promise<Response>;
const handlers = new Map<string, Handler>();
const protocols = new Map<string, Protocol>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { setupProtocolHandler } from '../../../electron/core/window-manager';
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
const SECRET = 'secret-of-the-home.txt';
const project = path.join(home, 'projects', 'atlas');
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-roots-')));
const homeLink = path.join(box, 'to-home');

/** The home, spelled as a project can name it, and the folders above it. */
const homeCovers = () => [home, home + path.sep, path.dirname(home), path.parse(home).root];

function customProjects(list: string[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(list));
}

beforeEach(() => {
  handlers.clear();
  agents.clear();
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, SECRET), 'the home');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'a project file');
  // A folder link: a junction where the type is read (Windows), a symlink elsewhere.
  if (!fs.existsSync(homeLink)) fs.symlinkSync(home, homeLink, 'junction');
  registerIpcHandlers(deps());
});

afterAll(() => {
  fs.rmSync(box, { recursive: true, force: true });
});

const readText = (file: string) => handlers.get('fs:read-text-file')!({}, file) as Promise<{ content: string; error?: string }>;
const writeText = (file: string, content: string) => handlers.get('fs:write-text-file')!({}, { filePath: file, content }) as Promise<{ success: boolean; error?: string }>;
const readProject = (base: string, rel: string) =>
  handlers.get('fs:read-project-files')!({}, { paths: [base], relative: [rel] }) as Promise<{ files: Record<string, string> }>;

describe('fs:read-text-file and fs:write-text-file', () => {
  it('1, 2. refuse the home\'s files through the home or a folder above it', async () => {
    for (const root of homeCovers()) {
      customProjects([project, root]);
      const file = path.join(home, SECRET);
      expect((await readText(file)).content, `read through ${root}`).toBe('');
      expect((await writeText(file, 'overwritten')).success, `write through ${root}`).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('the home');
    }
  });

  it('5. refuse them through a link to the home', async () => {
    customProjects([project, homeLink]);
    const file = path.join(homeLink, SECRET);
    expect((await readText(file)).content).toBe('');
    expect((await writeText(file, 'overwritten')).success).toBe(false);
    expect(fs.readFileSync(path.join(home, SECRET), 'utf8')).toBe('the home');
  });

  it('6. still read and write a project under the home', async () => {
    customProjects([project, path.dirname(home)]);
    expect((await readText(path.join(project, 'CLAUDE.md'))).content).toBe('a project file');
    expect((await writeText(path.join(project, 'CLAUDE.md'), 'edited')).success).toBe(true);
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('edited');
  });
});

describe('fs:read-project-files', () => {
  it('3. refuses the home\'s files through a project that is the home or above it', async () => {
    for (const root of homeCovers()) {
      customProjects([root]);
      expect((await readProject(root, path.relative(root, path.join(home, SECRET)))).files, root).toEqual({});
      expect((await readProject(home, SECRET)).files, `${root}, base home`).toEqual({});
    }
  });

  it('3. refuses them through an agent whose folder is the home or above it', async () => {
    customProjects([]);
    agents.set('a1', { id: 'a1', projectPath: home, worktreePath: path.dirname(home) } as AgentStatus);
    expect((await readProject(home, SECRET)).files).toEqual({});
  });

  it('5. refuses them through a link to the home', async () => {
    customProjects([homeLink]);
    expect((await readProject(homeLink, SECRET)).files).toEqual({});
  });

  it('6. still reads a project under the home', async () => {
    customProjects([project, home]);
    expect(Object.values((await readProject(project, 'CLAUDE.md')).files)).toEqual(['a project file']);
  });

  it('8. reads nothing of a folder the project rule refuses, held as a project or as an agent\'s folder', async () => {
    const held = [path.join(home, '.config', 'gh'), path.join(home, 'Library', 'Application Support', 'gcloud'), path.join(home, '.azure')];
    for (const place of held) {
      fs.mkdirSync(place, { recursive: true });
      fs.writeFileSync(path.join(place, 'hosts.yml'), 'oauth_token: x');
    }
    customProjects(held.slice(0, 2));
    agents.set('a1', { id: 'a1', projectPath: held[2] } as AgentStatus);
    for (const place of held) expect((await readProject(place, 'hosts.yml')).files, place).toEqual({});
    // Still read: ~/.agents, and a project in iCloud Drive.
    const agentsDir = path.join(home, '.agents');
    const cloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'work');
    for (const dir of [agentsDir, cloud]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'kept');
    }
    customProjects([cloud]);
    expect(Object.values((await readProject(agentsDir, 'AGENTS.md')).files)).toEqual(['kept']);
    expect(Object.values((await readProject(cloud, 'AGENTS.md')).files)).toEqual(['kept']);
  });
});

// Not on Windows: there local-file:// serves no file at all, since the URL's
// pathname, `/C:/...`, resolves to `C:\C:\...`, under no root. Tars ships for
// macOS; this runs on macOS and Linux, where the protocol serves files.
describe.skipIf(process.platform === 'win32')('local-file://', () => {
  beforeEach(() => {
    protocols.clear();
    setupProtocolHandler();
  });
  const serve = async (file: string) => {
    const url = new URL('local-file://');
    url.pathname = file;
    return (await protocols.get('local-file')!({ url: url.href })).status;
  };

  it('4. refuses the home\'s files through a project that is the home or above it', async () => {
    for (const root of homeCovers()) {
      customProjects([root]);
      expect(await serve(path.join(home, SECRET)), root).toBe(403);
    }
  });

  it('5. refuses them through a link to the home', async () => {
    customProjects([homeLink]);
    expect(await serve(path.join(homeLink, SECRET))).toBe(403);
  });

  it('6. serves no project\'s file since 2.0.4, under the home or not', async () => {
    // local-file:// serves the vault's attachments, the project files and
    // Claude Code's memory folders, and nothing else (the Audit's Hole 2): what
    // it still serves is window-file-access.test.ts's W6.
    customProjects([project, home]);
    expect(await serve(path.join(project, 'CLAUDE.md'))).toBe(403);
  });
});

describe('a project root the target is not under', () => {
  const OFFLINE = path.join(path.parse(home).root, 'net', 'tars-offline-nas.invalid', 'proj');
  const nodeFs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;

  /** Runs `fn` with every fs call that takes a path recorded when the path is on the offline share. */
  async function touchesOffline(fn: () => Promise<unknown>): Promise<string[]> {
    const names = ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync', 'readdirSync', 'stat', 'lstat', 'access'];
    const saved = new Map(names.map(n => [n, nodeFs[n]]));
    const touched: string[] = [];
    for (const name of names) {
      const original = saved.get(name) as (...args: unknown[]) => unknown;
      nodeFs[name] = Object.assign((...args: unknown[]) => {
        if (String(args[0]).startsWith(OFFLINE)) touched.push(`${name} ${String(args[0])}`);
        return original(...args);
      }, original);
    }
    syncBuiltinESMExports();
    try {
      await fn();
    } finally {
      for (const [name, original] of saved) nodeFs[name] = original;
      syncBuiltinESMExports();
    }
    return touched;
  }

  it('7. is never looked at when reading and writing under another project', async () => {
    customProjects([OFFLINE, project]);
    const touched = await touchesOffline(async () => {
      expect((await readText(path.join(project, 'CLAUDE.md'))).content).toBe('a project file');
      expect((await writeText(path.join(project, 'CLAUDE.md'), 'a project file')).success).toBe(true);
      expect(Object.values((await readProject(project, 'CLAUDE.md')).files)).toEqual(['a project file']);
    });
    expect(touched).toEqual([]);
  });
});
